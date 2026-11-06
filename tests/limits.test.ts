/**
 * Hosted admission limits (hosted-web phase 3): pause, turn budgets,
 * concurrency, and spend caps. The store layer is real but the input is
 * synthetic — no model call is staged.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-limits-test-"));
process.env.LH_DATA_DIR = dataRoot;
process.env.LH_HOSTED = "1";

const workspace = await import("../src/store/workspace.ts");
const { admitHostedChat, globalSpendToday, workspaceSpendToday } = await import("../src/server/limits.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");

after(() => {
	fs.rmSync(dataRoot, { recursive: true, force: true });
});

function request(ip = "203.0.113.10"): Request {
	return new Request("http://localhost/api/chat", {
		method: "POST",
		headers: { "x-forwarded-for": ip },
	});
}

function setLimits(overrides: Record<string, string | undefined> = {}): void {
	const base: Record<string, string> = {
		LH_HOSTED_TURNS_PER_HOUR: "100",
		LH_HOSTED_TURNS_PER_DAY: "1000",
		LH_HOSTED_TURNS_PER_IP_HOUR: "1000",
		LH_HOSTED_ACTIVE_TURNS: "100",
		LH_HOSTED_WORKSPACE_DAILY_USD: "1000",
		LH_HOSTED_GLOBAL_DAILY_USD: "1000",
		LH_HOSTED_PAUSED: "",
	};
	for (const [key, value] of Object.entries({ ...base, ...overrides })) {
		if (value === undefined || value === "") delete process.env[key];
		else process.env[key] = value;
	}
}

async function admitIn(ws: ReturnType<typeof workspace.createWorkspace>, ip: string) {
	return workspace.runInWorkspace(ws, () => admitHostedChat(request(ip)));
}

describe("hosted admission", () => {
	it("passes through when hosted mode is off", async () => {
		delete process.env.LH_HOSTED;
		try {
			assert.deepEqual(await admitHostedChat(request()), { ok: true });
		} finally {
			process.env.LH_HOSTED = "1";
		}
	});

	it("honors the pause switch", async () => {
		setLimits({ LH_HOSTED_PAUSED: "1" });
		const ws = workspace.createWorkspace();
		const result = await admitIn(ws, "203.0.113.11");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 503);
			assert.equal(result.body.code, "paused");
		}
	});

	it("refuses the turn after the hourly workspace budget", async () => {
		setLimits({ LH_HOSTED_TURNS_PER_HOUR: "1" });
		const ws = workspace.createWorkspace();
		assert.deepEqual(await admitIn(ws, "203.0.113.12"), { ok: true });
		const second = await admitIn(ws, "203.0.113.12");
		assert.equal(second.ok, false);
		if (!second.ok) assert.equal(second.body.code, "rate_limited");
	});

	it("refuses after the daily workspace budget", async () => {
		setLimits({ LH_HOSTED_TURNS_PER_HOUR: "100", LH_HOSTED_TURNS_PER_DAY: "1" });
		const ws = workspace.createWorkspace();
		assert.deepEqual(await admitIn(ws, "203.0.113.13"), { ok: true });
		const second = await admitIn(ws, "203.0.113.13");
		assert.equal(second.ok, false);
		if (!second.ok) assert.equal(second.body.code, "daily_limit");
	});

	it("limits a network independently of the workspace", async () => {
		setLimits({ LH_HOSTED_TURNS_PER_IP_HOUR: "1" });
		const ip = "203.0.113.14";
		assert.deepEqual(await admitIn(workspace.createWorkspace(), ip), { ok: true });
		const second = await admitIn(workspace.createWorkspace(), ip);
		assert.equal(second.ok, false);
		if (!second.ok) assert.equal(second.body.code, "ip_rate_limited");
	});

	it("refuses when the workspace already has the maximum concurrent turns", async () => {
		setLimits({ LH_HOSTED_ACTIVE_TURNS: "1" });
		const ws = workspace.createWorkspace();
		workspace.runInWorkspace(ws, () => beginTurn("chat_concurrency_fixture"));
		try {
			const result = await admitIn(ws, "203.0.113.15");
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.body.code, "too_many_turns");
		} finally {
			workspace.runInWorkspace(ws, () => endTurn("chat_concurrency_fixture"));
		}
	});

	it("enforces a zero workspace spend cap", async () => {
		setLimits({ LH_HOSTED_WORKSPACE_DAILY_USD: "0" });
		const ws = workspace.createWorkspace();
		assert.deepEqual(workspaceSpendToday(), { usd: 0, unpriced: 0 });
		const result = await admitIn(ws, "203.0.113.16");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.body.code, "workspace_spend_cap");
	});

	it("enforces a zero global spend cap", async () => {
		setLimits({ LH_HOSTED_GLOBAL_DAILY_USD: "0" });
		const ws = workspace.createWorkspace();
		assert.equal(globalSpendToday().usd, 0);
		const result = await admitIn(ws, "203.0.113.17");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 503);
			assert.equal(result.body.code, "global_spend_cap");
		}
	});
});

/**
 * Workspace isolation (hosted-web wave, 2026-11-06).
 *
 * Pins the promise that matters before anything is deployed: two visitor
 * workspaces cannot see each other's chats, jobs, settings, or graph paths,
 * and a forged cookie cannot name someone else's workspace.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-test-"));
process.env.LH_DATA_DIR = dataRoot;
process.env.LH_HOSTED = "1";
process.env.LH_WORKSPACE_SECRET = "test-workspace-secret-0123456789abcdef";

const workspace = await import("../src/store/workspace.ts");
const context = await import("../src/server/workspace-context.ts");
const { stores } = await import("../src/server/stores.ts");
const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");

after(() => {
	fs.rmSync(dataRoot, { recursive: true, force: true });
});

function signedHeaders(id: string): Headers {
	return new Headers({
		[context.WORKSPACE_HEADER]: id,
		[context.WORKSPACE_SIGNATURE_HEADER]: context.signWorkspaceId(id),
	});
}

describe("workspace storage isolation", () => {
	it("creates a self-contained directory family", () => {
		const ws = workspace.createWorkspace();
		assert.ok(workspace.isWorkspaceId(ws.id));
		for (const dir of [ws.chats, ws.graph, ws.jobs, ws.prompts]) {
			assert.equal(fs.statSync(dir).isDirectory(), true, dir);
		}
		assert.equal(fs.existsSync(path.join(ws.root, "meta.json")), true);
	});

	it("never leaks chats between workspaces", () => {
		const a = workspace.createWorkspace();
		const b = workspace.createWorkspace();
		const chatA = workspace.runInWorkspace(a, () => stores.chatStore.createChat("Alpha"));
		const chatB = workspace.runInWorkspace(b, () => stores.chatStore.createChat("Beta"));

		assert.equal(workspace.runInWorkspace(a, () => stores.chatStore.getChat(chatB.id)), null);
		assert.deepEqual(
			workspace.runInWorkspace(a, () => stores.chatStore.listChats().map((c) => c.title)),
			["Alpha"],
		);
		assert.deepEqual(
			workspace.runInWorkspace(b, () => stores.chatStore.listChats().map((c) => c.title)),
			["Beta"],
		);
		assert.notEqual(workspace.runInWorkspace(a, () => stores.chatStore.getChat(chatA.id)), null);
	});

	it("never leaks jobs between workspaces", () => {
		const a = workspace.createWorkspace();
		const b = workspace.createWorkspace();
		const chatA = workspace.runInWorkspace(a, () => stores.chatStore.createChat("Alpha"));
		const job = workspace.runInWorkspace(a, () =>
			stores.jobStore.createJob({ kind: "research", chatId: chatA.id, toolCallId: "call-a" }),
		);

		assert.equal(workspace.runInWorkspace(b, () => stores.jobStore.getJob(job.id)), null);
		assert.deepEqual(workspace.runInWorkspace(b, () => stores.jobStore.listJobs(chatA.id)), []);
	});

	it("never leaks settings between workspaces", () => {
		const a = workspace.createWorkspace();
		const b = workspace.createWorkspace();
		workspace.runInWorkspace(a, () =>
			stores.settingsStore.writeSettings({ version: 1, graph: { enabled: false } }),
		);

		assert.equal(
			workspace.runInWorkspace(a, () => stores.settingsStore.readSettings()?.graph?.enabled),
			false,
		);
		assert.equal(workspace.runInWorkspace(b, () => stores.settingsStore.readSettings()), null);
	});

	it("gives every workspace a distinct graph path", () => {
		const a = workspace.createWorkspace();
		const b = workspace.createWorkspace();
		assert.notEqual(a.ledgers.nodes, b.ledgers.nodes);
		assert.notEqual(a.positions, b.positions);
	});
});

describe("workspace request context", () => {
	it("enters the signed workspace named by the proxy headers", async () => {
		const ws = workspace.createWorkspace();
		const handler = context.withWorkspace(async (_req: Request) =>
			Response.json({ id: workspace.currentWorkspace().id }),
		);
		const response = await handler(
			new Request("http://localhost/api/test", { headers: signedHeaders(ws.id) }),
		);
		assert.deepEqual(await response.json(), { id: ws.id });
		assert.equal(response.headers.get("set-cookie"), null);
	});

	it("mints a fresh workspace when the signature is forged", async () => {
		const target = workspace.createWorkspace();
		const handler = context.withWorkspace(async (_req: Request) =>
			Response.json({ id: workspace.currentWorkspace().id }),
		);
		const forged = new Headers({
			[context.WORKSPACE_HEADER]: target.id,
			[context.WORKSPACE_SIGNATURE_HEADER]: "not-a-signature",
		});
		const response = await handler(new Request("http://localhost/api/test", { headers: forged }));
		const body = (await response.json()) as { id: string };
		assert.notEqual(body.id, target.id);
		assert.match(response.headers.get("set-cookie") ?? "", /lh_ws=/);
	});

	it("reuses a valid cookie and rejects a tampered one", () => {
		const fresh = context.resolveWorkspaceCookie(null);
		assert.equal(fresh.fresh, true);
		assert.ok(workspace.isWorkspaceId(fresh.paths.id));

		const cookie = `${context.WORKSPACE_COOKIE_NAME}=${encodeURIComponent(
			`${fresh.paths.id}.${fresh.signature}`,
		)}`;
		const reused = context.resolveWorkspaceCookie(cookie);
		assert.equal(reused.fresh, false);
		assert.equal(reused.paths.id, fresh.paths.id);

		const tampered = context.resolveWorkspaceCookie(
			`${context.WORKSPACE_COOKIE_NAME}=${encodeURIComponent(`${fresh.paths.id}.bad`)}`,
		);
		assert.equal(tampered.fresh, true);
		assert.notEqual(tampered.paths.id, fresh.paths.id);
	});

	it("closes learner file tools in hosted mode", async () => {
		const { fileAccessPolicy } = await import("../src/server/file-access.ts");
		assert.deepEqual(fileAccessPolicy(), { restricted: true, folders: [] });
	});

	it("leaves the historical default root untouched outside hosted mode", async () => {
		delete process.env.LH_HOSTED;
		try {
			const handler = context.withWorkspace(async (_req: Request) =>
				Response.json({ id: workspace.currentWorkspace().id }),
			);
			const response = await handler(new Request("http://localhost/api/test"));
			assert.deepEqual(await response.json(), { id: "default" });
		} finally {
			process.env.LH_HOSTED = "1";
		}
	});
});

describe("workspace proxy", () => {
	it("sets a cookie on first contact and not on a valid one", () => {
		const first = proxy(new NextRequest("http://localhost/api/settings", { method: "GET" }));
		assert.match(first.headers.get("set-cookie") ?? "", /lh_ws=/);

		const ws = workspace.createWorkspace();
		const cookie = `${context.WORKSPACE_COOKIE_NAME}=${encodeURIComponent(
			`${ws.id}.${context.signWorkspaceId(ws.id)}`,
		)}`;
		const reused = proxy(
			new NextRequest("http://localhost/api/settings", {
				method: "GET",
				headers: { cookie },
			}),
		);
		assert.equal(reused.headers.get("set-cookie"), null);
	});
});

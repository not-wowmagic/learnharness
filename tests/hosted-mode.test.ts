/**
 * Hosted-mode pins and gates (hosted-web wave, 2026-11-06).
 *
 * These pin the two properties that make a shared operator key safe:
 * model slots resolve from the deployment env (never from a visitor's
 * settings write), and credential-mutating route families are refused
 * before a handler runs.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import {
	hostedModelPins,
	parseHostedModelPin,
	withHostedModelPins,
} from "../src/core/hosted.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { hostedBlockedPath } from "../src/server/hosted.ts";
import { proxy } from "../proxy.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function setHostedEnv(extra: Record<string, string> = {}): void {
	process.env.LH_HOSTED = "1";
	delete process.env.LH_DESKTOP_SERVER;
	delete process.env.LH_DESKTOP_API_SECRET;
	for (const [key, value] of Object.entries(extra)) process.env[key] = value;
}

describe("hosted model pins", () => {
	it("parses provider:model-id, splitting on the first colon", () => {
		assert.deepEqual(parseHostedModelPin("openrouter:anthropic/claude-sonnet-4.5"), {
			model: { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" },
		});
		assert.deepEqual(parseHostedModelPin("ollama:llama3.3:70b"), {
			model: { provider: "ollama", id: "llama3.3:70b" },
		});
	});

	it("treats malformed pins as absent, never as a fallback model", () => {
		assert.equal(parseHostedModelPin(undefined), null);
		assert.equal(parseHostedModelPin(""), null);
		assert.equal(parseHostedModelPin("openrouter"), null);
		assert.equal(parseHostedModelPin(":model"), null);
		assert.equal(parseHostedModelPin("provider:"), null);
	});

	it("reads all three slots and only valid thinking levels", () => {
		setHostedEnv({
			LH_HOSTED_MODEL_STRONG: "openrouter:strong-model",
			LH_HOSTED_THINKING_STRONG: "high",
			LH_HOSTED_MODEL_CHEAP: "openrouter:cheap-model",
			LH_HOSTED_THINKING_CHEAP: "not-a-level",
			LH_HOSTED_MODEL_VISION: "openrouter:vision-model",
		});
		assert.deepEqual(hostedModelPins(process.env), {
			strong: { model: { provider: "openrouter", id: "strong-model" }, thinkingLevel: "high" },
			cheap: { model: { provider: "openrouter", id: "cheap-model" } },
			vision: { model: { provider: "openrouter", id: "vision-model" } },
		});
	});

	it("does nothing outside hosted mode", () => {
		delete process.env.LH_HOSTED;
		const record = { version: 1 as const, graph: { enabled: false } };
		assert.equal(withHostedModelPins(record), record);
	});

	it("overlays pinned slots and preserves visitor sections", () => {
		setHostedEnv({
			LH_HOSTED_MODEL_STRONG: "openrouter:pinned-strong",
			LH_HOSTED_MODEL_VISION: "openrouter:pinned-vision",
		});
		const result = withHostedModelPins({
			version: 1,
			graph: { enabled: false },
			models: {
				strong: { model: { provider: "user", id: "expensive-choice" } },
				cheap: { model: { provider: "user", id: "cheap-choice" } },
			},
		});
		assert.ok(result);
		assert.deepEqual(result.models?.strong, {
			model: { provider: "openrouter", id: "pinned-strong" },
		});
		assert.deepEqual(result.models?.vision, {
			model: { provider: "openrouter", id: "pinned-vision" },
		});
		// Unpinned slots survive; so does every non-model section.
		assert.deepEqual(result.models?.cheap, {
			model: { provider: "user", id: "cheap-choice" },
		});
		assert.deepEqual(result.graph, { enabled: false });
		// Hosted beta: the browser-driving demo tool is forced off.
		assert.equal(result.agent?.tools?.demo, false);
	});

	it("gives a first-boot workspace the pinned models", () => {
		setHostedEnv({
			LH_HOSTED_MODEL_STRONG: "openrouter:pinned",
			LH_HOSTED_MODEL_CHEAP: "openrouter:pinned",
			LH_HOSTED_MODEL_VISION: "openrouter:pinned",
		});
		const record = withHostedModelPins(null);
		assert.ok(record);
		const effective = resolveSettings(record);
		assert.equal(effective.models.strong?.provider, "openrouter");
		assert.equal(effective.models.strong?.id, "pinned");
		assert.equal(effective.models.cheap?.id, "pinned");
		assert.equal(effective.models.vision?.id, "pinned");
	});
});

describe("hosted route gates", () => {
	it("leaves desktop mode untouched", () => {
		delete process.env.LH_HOSTED;
		assert.equal(hostedBlockedPath("/api/keys", "PUT"), false);
		assert.equal(hostedBlockedPath("/api/custom-provider", "POST"), false);
	});

	it("refuses key mutation while leaving the hosted GET view reachable", () => {
		setHostedEnv();
		assert.equal(hostedBlockedPath("/api/keys", "GET"), false);
		assert.equal(hostedBlockedPath("/api/keys/OPENROUTER_API_KEY", "PUT"), true);
		assert.equal(hostedBlockedPath("/api/keys/OPENROUTER_API_KEY", "DELETE"), true);
	});

	it("refuses desktop-only credential and dictation surfaces", () => {
		setHostedEnv();
		assert.equal(hostedBlockedPath("/api/custom-provider", "POST"), true);
		assert.equal(hostedBlockedPath("/api/subscriptions", "GET"), true);
		assert.equal(hostedBlockedPath("/api/claude-code", "GET"), true);
		assert.equal(hostedBlockedPath("/api/stt/token", "GET"), true);
	});

	it("keeps prompt overrides readable but not writable", () => {
		setHostedEnv();
		assert.equal(hostedBlockedPath("/api/settings/prompts", "GET"), false);
		assert.equal(hostedBlockedPath("/api/settings/prompts/teacher/20-teaching.md", "PUT"), true);
	});

	it("does not obstruct ordinary settings or chat traffic", () => {
		setHostedEnv();
		assert.equal(hostedBlockedPath("/api/settings", "PUT"), false);
		assert.equal(hostedBlockedPath("/api/chat", "POST"), false);
		assert.equal(hostedBlockedPath("/api/chats/abc/stream", "GET"), false);
	});

	it("returns 403 from the proxy for blocked routes, and passes the rest", () => {
		setHostedEnv();
		const blocked = proxy(new NextRequest("http://localhost/api/keys", { method: "PUT" }));
		assert.equal(blocked.status, 403);
		const allowed = proxy(new NextRequest("http://localhost/api/settings", { method: "PUT" }));
		assert.equal(allowed.headers.get("x-middleware-next"), "1");
	});
});

describe("hosted route handlers", () => {
	it("returns an empty key inventory instead of the operator's masked keys", async () => {
		setHostedEnv();
		const { GET } = await import("../app/api/keys/route.ts");
		const body = await (await GET()).json();
		assert.deepEqual(body, { keys: [], providers: [] });
	});

	it("refuses model-section writes even when the proxy is bypassed", async () => {
		setHostedEnv();
		const { PUT } = await import("../app/api/settings/[section]/route.ts");
		const response = await PUT(
			new Request("http://localhost/api/settings/models", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ strong: { model: { provider: "x", id: "y" } } }),
			}),
			{ params: Promise.resolve({ section: "models" }) },
		);
		assert.equal(response.status, 403);
	});
});

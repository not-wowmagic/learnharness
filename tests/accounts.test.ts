/**
 * Account ownership choice (hosted-web phase 2). The Supabase adapter is
 * network-bound, so these pin the pure decision logic and config gate with
 * an injected store; the migration is exercised separately when the project
 * database is reachable.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-accounts-test-"));
process.env.LH_DATA_DIR = dataRoot;
process.env.LH_HOSTED = "1";

const workspace = await import("../src/store/workspace.ts");
const { chooseWorkspaceForUser } = await import("../src/server/accounts.ts");
const { accountsAvailable, supabaseConfig } = await import("../src/server/supabase.ts");
const { safeNextPath } = await import("../src/core/hosted.ts");

after(() => {
	fs.rmSync(dataRoot, { recursive: true, force: true });
});

function fakeStore(overrides: {
	existing?: string | null;
	claim?: (id: string) => boolean;
}) {
	const claims: string[] = [];
	const store = {
		async findOwnedWorkspace() {
			return overrides.existing ?? null;
		},
		async claimWorkspace(id: string) {
			claims.push(id);
			return overrides.claim ? overrides.claim(id) : true;
		},
		async touchWorkspace() {},
	};
	return { store, claims };
}

describe("post-auth redirect safety", () => {
	it("accepts same-origin paths and rejects open-redirect gadgets", () => {
		assert.equal(safeNextPath("/chat/abc?x=1"), "/chat/abc?x=1");
		assert.equal(safeNextPath("//evil.example"), "/");
		assert.equal(safeNextPath("/\\evil.example"), "/");
		assert.equal(safeNextPath("https://evil.example"), "/");
		assert.equal(safeNextPath(null), "/");
	});
});

describe("workspace choice after sign-in", () => {
	it("an existing owned workspace always wins and is not re-claimed", async () => {
		const current = workspace.createWorkspace();
		const existing = "11111111-1111-4111-8111-111111111111";
		const { store, claims } = fakeStore({ existing });
		const choice = await chooseWorkspaceForUser(store, current.id, "user-1");
		assert.deepEqual(choice, { id: existing, claimed: false, created: false });
		assert.deepEqual(claims, []);
	});

	it("claims the current anonymous workspace when the user owns none", async () => {
		const current = workspace.createWorkspace();
		const { store, claims } = fakeStore({
			claim: (id) => id === current.id,
		});
		const choice = await chooseWorkspaceForUser(store, current.id, "user-2");
		assert.deepEqual(choice, { id: current.id, claimed: true, created: false });
		assert.deepEqual(claims, [current.id]);
	});

	it("mints and claims a fresh workspace on a claim collision", async () => {
		const current = workspace.createWorkspace();
		const { store, claims } = fakeStore({
			claim: (id) => id !== current.id,
		});
		const choice = await chooseWorkspaceForUser(store, current.id, "user-3");
		assert.equal(choice.claimed, true);
		assert.equal(choice.created, true);
		assert.notEqual(choice.id, current.id);
		assert.deepEqual(claims, [current.id, choice.id]);
	});

	it("keeps the current workspace when accounts are unconfigured", async () => {
		const current = workspace.createWorkspace();
		const choice = await chooseWorkspaceForUser(null, current.id, "user-4");
		assert.deepEqual(choice, { id: current.id, claimed: false, created: false });
	});
});

describe("local ownership metadata", () => {
	it("records and clears the owner on the workspace meta file", () => {
		const ws = workspace.createWorkspace();
		assert.equal(workspace.setWorkspaceOwner(ws.id, "user-5"), true);
		const owned = JSON.parse(fs.readFileSync(path.join(ws.root, "meta.json"), "utf-8"));
		assert.equal(owned.ownerId, "user-5");
		assert.equal(workspace.setWorkspaceOwner(ws.id, null), true);
		const cleared = JSON.parse(fs.readFileSync(path.join(ws.root, "meta.json"), "utf-8"));
		assert.equal("ownerId" in cleared, false);
	});
});

describe("Supabase config gate", () => {
	it("requires all three values and a safe URL", () => {
		const base = {
			LH_HOSTED: "1",
			NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
			NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
			SUPABASE_SERVICE_ROLE_KEY: "service",
		};
		assert.deepEqual(supabaseConfig(base), {
			url: "https://example.supabase.co",
			anonKey: "anon",
			serviceKey: "service",
		});
		assert.equal(supabaseConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: undefined }), null);
		assert.equal(supabaseConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: "http://evil.example" }), null);
		assert.equal(accountsAvailable(base), true);
		assert.equal(accountsAvailable({ ...base, LH_HOSTED: undefined }), false);
	});
});

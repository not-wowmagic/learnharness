/**
 * Operator OpenCode Go provider (hosted-web): the deployment can pin
 * `opencode-go:deepseek-v4.1-flash` without the per-workspace custom
 * endpoint flow, and the model catalog exposes it as a keyed provider.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-opencode-test-"));
process.env.LH_DATA_DIR = dataRoot;
process.env.LH_HOSTED = "1";
process.env.OPENCODE_GO_API_KEY = "oc_sk_test_provider_key";
process.env.OPENCODE_GO_MODEL = "deepseek-v4.1-flash";
process.env.LH_HOSTED_MODEL_STRONG = "opencode-go:deepseek-v4.1-flash";
process.env.LH_HOSTED_MODEL_CHEAP = "opencode-go:deepseek-v4.1-flash";
process.env.LH_HOSTED_MODEL_VISION = "opencode-go:deepseek-v4.1-flash";

const { HOSTED_PROVIDER_ID, piModels } = await import("../src/agent/models.ts");
const { withHostedModelPins } = await import("../src/core/hosted.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { modelCatalog } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");

after(() => {
	fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("OpenCode Go operator provider", () => {
	it("registers the provider and its pinned model", () => {
		const models = piModels();
		assert.equal(models.getProvider(HOSTED_PROVIDER_ID)?.id, HOSTED_PROVIDER_ID);
		const model = models.getModel(HOSTED_PROVIDER_ID, "deepseek-v4.1-flash");
		assert.ok(model);
		assert.equal(model.provider, HOSTED_PROVIDER_ID);
		assert.deepEqual(model.input, ["text"]);
		assert.equal(typeof models.getProvider(HOSTED_PROVIDER_ID)?.headers?.["x-opencode-session"], "string");
	});

	it("resolves all three hosted slots to it", () => {
		const effective = resolveSettings(withHostedModelPins(null));
		for (const slot of ["strong", "cheap", "vision"] as const) {
			assert.equal(effective.models[slot]?.provider, HOSTED_PROVIDER_ID);
			assert.equal(effective.models[slot]?.id, "deepseek-v4.1-flash");
		}
	});

	it("appears once, keyed, and clears the key-presence gate", () => {
		const catalog = modelCatalog();
		const rows = catalog.providers.filter((p) => p.id === HOSTED_PROVIDER_ID);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.keyPresent, true);
		assert.ok(catalog.models.some((m) => m.provider === HOSTED_PROVIDER_ID && m.id === "deepseek-v4.1-flash"));
		assert.equal(providerKeyPresent(HOSTED_PROVIDER_ID), true);
	});
});

import { randomUUID } from "node:crypto";
import {
	clampThinkingLevel,
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	type Api,
	type CacheRetention,
	type Model,
	type Models,
	type MutableModels,
	type Provider,
	type ProviderHeaders,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { lazyApi, lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { createClaudeCodeProvider } from "./claude-code/provider.ts";
import { streamClaudeCode } from "./claude-code/stream.ts";
import { nativeSubscriptionId, nativeSubscriptionModel } from "./subscription-bridge.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/archive/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The initially resolved (config-or-settings, CLAMPED) thinking level.
	 *  Custom streams re-resolve the original preference per operation. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;
interface ProviderSource {
	sync(models: MutableModels): void;
	isCustom(id: string): boolean;
}
let providerSource: ProviderSource | undefined;

/** Configuration IO is injected by the server; the agent never imports stores. */
export function configureProviderSource(source: ProviderSource): void {
	// Server module re-evaluation can replace the source while this collection
	// survives. Retire only the previous source's routes, not built-ins.
	if (collection && providerSource) {
		for (const provider of collection.getProviders()) {
			if (providerSource.isCustom(provider.id)) collection.deleteProvider(provider.id);
		}
	}
	providerSource = source;
}

/** The operator's OpenCode Go provider (hosted-web phase 2/4): an
 *  OpenAI-compatible endpoint used when the deployment pins it. It is a
 *  normal registered provider, so slots, engines, and the cost-free
 *  accounting path all work without the per-workspace custom-endpoint flow. */
export const HOSTED_PROVIDER_ID = "opencode-go";

function hostedOpenCodeProvider(): Provider<Api> | null {
	const key =
		process.env.OPENCODE_GO_API_KEY?.trim() ||
		process.env.OPENCODE_API_KEY?.trim();
	if (!key) return null;
	const baseUrl = (
		process.env.OPENCODE_GO_BASE_URL?.trim() ||
		"https://opencode.ai/zen/go/v1"
	).replace(/\/+$/, "");
	const modelId =
		process.env.OPENCODE_GO_MODEL?.trim() || "deepseek-v4.1-flash";
	const contextWindow =
		Number(process.env.OPENCODE_GO_CONTEXT_WINDOW) || 128_000;
	const maxTokens = Number(process.env.OPENCODE_GO_MAX_TOKENS) || 8_192;
	const model: Model<Api> = {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: HOSTED_PROVIDER_ID,
		baseUrl,
		// The hosted beta sends text only and leaves reasoning effort unset:
		// deepseek-v4.1-flash is used as a plain chat/tool model.
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		type: "chat",
	};
	return createProvider<Api>({
		id: HOSTED_PROVIDER_ID,
		name: "OpenCode Go",
		baseUrl,
		// OpenCode Go refuses requests without a routing session. The static
		// value is a fallback; the engine overrides it per turn below.
		headers: { "x-opencode-session": randomUUID() },
		auth: {
			apiKey: {
				name: "OpenCode Go API key",
				resolve: async () => ({ auth: { apiKey: key }, source: "env" }),
			},
		},
		models: [model],
		api: openAICompletionsApi(),
	});
}

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) {
			// Keep the native Bedrock implementation reachable by standalone tracing.
			// Pi's default Node-only loader hides this import from bundlers. Only
			// replace its lazy forwarding; preserve the native factory's auth/catalog.
			collection.setProvider(provider.id === "amazon-bedrock"
				? { ...provider, ...lazyApi(() => import("@earendil-works/pi-ai/api/bedrock-converse-stream")) }
				: provider);
		}
		collection.setProvider(createClaudeCodeProvider(streamClaudeCode));
		const hosted = hostedOpenCodeProvider();
		if (hosted) collection.setProvider(hosted);
	}
	providerSource?.sync(collection);
	return collection;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle, cacheRetention?: () => CacheRetention | undefined): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	const registeredModel = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : nativeId ? nativeSubscriptionModel(spec.provider, spec.id) : models.getModel(spec.provider, spec.id);
	const custom = providerSource?.isCustom(spec.provider) ?? false;
	// Custom endpoint owners authorize image attempts independently of sparse
	// discovery metadata. Never promote the registered/catalog capabilities.
	const permitImages = (value: Model<Api>): Model<Api> => ({ ...value, input: ["text", "image"] });
	const model = custom && registeredModel ? permitImages(registeredModel) : registeredModel;
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const thinkingPreference = spec.thinkingLevel;
	const level = thinkingPreference
		? clampThinkingLevel(model, thinkingPreference)
		: defaultThinkingLevel(model);
	// A lesson's agent loop can stay alive through many tool calls. Remember
	// only that this is a custom route, never its configuration for that run.
	return {
		model,
		level,
		// The agent loop forwards state.thinkingLevel as `reasoning` (undefined
		// = off on pi-ai's scale). Built-ins keep the factory clamp; custom
		// requests re-resolve thinking against their current metadata below.
		streamFn: (requestModel, context, options) => {
			// Read the slot preference for every operation, not just engine creation.
			// Unset adds NOTHING: native defaults/env and explicit caller options survive.
			const retention = cacheRetention?.();
			// A fresh OpenCode routing session per model operation: the gateway
			// uses it to keep related calls together without sharing one id
			// across every visitor.
			const hostedSession = spec.provider === HOSTED_PROVIDER_ID ? randomUUID() : undefined;
			const requestOptions = {
				...options,
				...(retention !== undefined ? { cacheRetention: retention } : {}),
				reasoning: level === "off" ? undefined : level,
				...(hostedSession
					? {
							transformHeaders: (headers: ProviderHeaders): ProviderHeaders => ({
								...headers,
								"x-opencode-session": hostedSession,
							}),
						}
					: {}),
			};
			if (custom) {
				// Revalidate before EVERY upstream model operation, including later
				// tool-loop steps. Resolve thinking from the ORIGINAL preference (or
				// existing default order), not a previous metadata snapshot's clamp.
				// Pi retains the setup of an operation already in flight.
				const current = piModels();
				const currentModel = current.getModel(spec.provider, spec.id);
				if (!currentModel) return lazyStream(requestModel, async () => { throw new Error("The selected custom model is unavailable."); });
				const currentLevel = thinkingPreference
					? clampThinkingLevel(currentModel, thinkingPreference)
					: defaultThinkingLevel(currentModel);
				return current.streamSimple(permitImages(currentModel), context, { ...requestOptions, reasoning: currentLevel === "off" ? undefined : currentLevel });
			}
			const purpose = typeof background === "function" ? background : () => background;
			const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
			return stream(requestModel, context, requestOptions);
		},
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}

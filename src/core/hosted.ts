/**
 * Hosted-mode facts (hosted-web wave, 2026-11-06).
 *
 * The desktop app is BYOK all the way down: no factory models, and every
 * visitor supplies keys. The hosted version inverts that: ONE operator key
 * lives in the server environment and every visitor runs against the same
 * models. These helpers are pure so both the settings adapter and the
 * server/proxy can share one source of truth.
 *
 * Server enforcement is the point — the UI hiding is convenience. A visitor
 * must not be able to select a different (more expensive) model by writing
 * settings.json or calling the settings routes directly.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	CURRENT_SETTINGS_VERSION,
	MODEL_SLOTS,
	type ModelSlot,
	type ModelSlotName,
	type UserSettings,
} from "./settings.ts";

const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] satisfies ThinkingLevel[];

/** Live env read: hosted mode is a deployment fact, not a build constant. */
export function hostedEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.LH_HOSTED === "1";
}

/** Post-auth redirect target: same-origin paths only. `//evil.example` and
 *  scheme-relative forms are open-redirect gadgets, so they collapse to "/". */
export function safeNextPath(raw: string | null | undefined): string {
	if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
		return "/";
	}
	return raw;
}

/** Parse `provider:model-id` (split on the FIRST colon — model ids may
 *  contain further colons, e.g. Ollama tags). Malformed values are inert:
 *  a typo must never silently point the hosted app at a different model. */
export function parseHostedModelPin(raw: string | undefined): ModelSlot | null {
	const value = raw?.trim();
	if (!value) return null;
	const separator = value.indexOf(":");
	if (separator <= 0 || separator === value.length - 1) return null;
	const provider = value.slice(0, separator).trim();
	const id = value.slice(separator + 1).trim();
	if (!provider || !id) return null;
	return { model: { provider, id } };
}

/**
 * The pinned slots from `LH_HOSTED_MODEL_{STRONG,CHEAP,VISION}` and
 * `LH_HOSTED_THINKING_{STRONG,CHEAP,VISION}`. Returns null when no slot is
 * configured — the app then keeps its honest 503 "models not configured"
 * behavior instead of inventing a model.
 */
export function hostedModelPins(
	env: Record<string, string | undefined> = process.env,
): Partial<Record<ModelSlotName, ModelSlot>> | null {
	const pins: Partial<Record<ModelSlotName, ModelSlot>> = {};
	for (const slot of MODEL_SLOTS) {
		const upper = slot.toUpperCase();
		const pin = parseHostedModelPin(env[`LH_HOSTED_MODEL_${upper}`]);
		if (!pin?.model) continue;
		const rawLevel = env[`LH_HOSTED_THINKING_${upper}`]?.trim();
		const thinkingLevel =
			rawLevel && THINKING_LEVELS.includes(rawLevel)
				? (rawLevel as ThinkingLevel)
				: undefined;
		pins[slot] = {
			model: pin.model,
			...(thinkingLevel ? { thinkingLevel } : {}),
		};
	}
	return Object.keys(pins).length > 0 ? pins : null;
}

/**
 * Overlay the operator's pinned slots on a stored settings record. Pinned
 * slots always win; unpinned slots and every non-model section ride along.
 * A missing record becomes a minimal pinned record, so a brand-new hosted
 * workspace resolves a model on its first turn instead of refusing.
 */
export function withHostedModelPins(
	record: UserSettings | null,
	env: Record<string, string | undefined> = process.env,
): UserSettings | null {
	if (!hostedEnabled(env)) return record;
	const pins = hostedModelPins(env);
	if (!pins && !record) return null;
	const base = record ?? { version: CURRENT_SETTINGS_VERSION };
	const withHostedTools = {
		...base,
		// Demo generation drives a server-side browser; the hosted beta keeps
		// it off (SSRF + compute surface). The settings overlay wins over any
		// visitor toggle, and the Agent UI hides the demo row in hosted mode.
		agent: {
			...base.agent,
			// Per-role overrides could bypass the pinned slots (an expensive
			// background model). The hosted deployment resolves every role
			// from its slot only.
			models: {},
			tools: { ...(base.agent?.tools ?? {}), demo: false },
		},
	};
	if (!pins) return withHostedTools;
	return {
		...withHostedTools,
		models: { ...(base.models ?? {}), ...pins },
	};
}

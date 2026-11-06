/**
 * Hosted-mode server gates (hosted-web wave, 2026-11-06).
 *
 * Route families that are safe on a single-user desktop machine are not
 * safe once anyone can reach the server: key editing, custom endpoints,
 * native subscription credentials, dictation token minting, and prompt
 * override writes. `proxy.ts` rejects them centrally; the section routes
 * add their own guards where the proxy cannot see the body.
 */

import { hostedEnabled } from "../core/hosted.ts";
import type { ChatSettings } from "../core/contracts/chat.ts";

export function isHostedMode(): boolean {
	return hostedEnabled();
}

/**
 * Hosted mode pins the conversation pair to the strong slot. A per-session
 * override stored on an older record (or written before a deployment became
 * hosted) must not outlive that deployment and pick a costlier model.
 */
export function hostedConversationSettings(
	settings: ChatSettings | undefined,
): ChatSettings | undefined {
	return isHostedMode() ? undefined : settings;
}

const BLOCKED_PREFIXES = [
	"/api/custom-provider",
	"/api/subscriptions",
	"/api/claude-code",
	"/api/stt",
] as const;

function under(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * True when the hosted deployment must refuse this request before it reaches
 * a route handler. `/api/keys` is special-cased: GET is answered with an
 * empty hosted view by the route (masked operator keys must never leak),
 * while every mutation is refused here.
 */
export function hostedBlockedPath(pathname: string, method: string): boolean {
	if (!isHostedMode()) return false;

	if (under(pathname, "/api/keys")) {
		return method !== "GET" && method !== "HEAD";
	}
	if (BLOCKED_PREFIXES.some((prefix) => under(pathname, prefix))) {
		return true;
	}
	// Prompt overrides stay readable, never writable, in the hosted beta.
	if (under(pathname, "/api/settings/prompts")) {
		return method !== "GET" && method !== "HEAD";
	}
	return false;
}

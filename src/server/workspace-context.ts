/**
 * The hosted workspace request seam (hosted-web wave, 2026-11-06).
 *
 * `proxy.ts` resolves the signed `lh_ws` cookie (minting one on first
 * contact), forwards the workspace id + signature as private request
 * headers, and the wrapper below re-verifies the signature before entering
 * the AsyncLocalStorage context. A forged cookie/header cannot name another
 * visitor's directory.
 *
 * Non-hosted mode bypasses all of this: the handler runs unchanged against
 * the historical repo/desktop data root.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { hostedEnabled } from "../core/hosted.ts";
import {
	createWorkspace,
	isWorkspaceId,
	runInWorkspace,
	workspaceById,
	type WorkspacePaths,
} from "../store/workspace.ts";

export const WORKSPACE_COOKIE_NAME = "lh_ws";
export const WORKSPACE_HEADER = "x-lh-workspace";
export const WORKSPACE_SIGNATURE_HEADER = "x-lh-workspace-sig";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Hosted production must set a real secret; local hosted dev gets a fixed
 *  one so cookies survive a `next dev` restart. A missing production secret
 *  is a hard failure, not a silent per-process key that would orphan every
 *  visitor's data on restart. */
function workspaceSecret(): Buffer {
	const raw = process.env.LH_WORKSPACE_SECRET;
	if (raw && raw.length >= 32) return Buffer.from(raw);
	if (process.env.NODE_ENV === "production") {
		throw new Error(
			"LH_WORKSPACE_SECRET is required in hosted production (at least 32 characters).",
		);
	}
	return Buffer.from("lh-hosted-dev-workspace-secret-change-me");
}

export function signWorkspaceId(id: string): string {
	return createHmac("sha256", workspaceSecret()).update(id).digest("base64url");
}

export function workspaceSignatureValid(id: string, signature: string): boolean {
	if (!isWorkspaceId(id) || !signature) return false;
	const expected = Buffer.from(signWorkspaceId(id));
	const supplied = Buffer.from(signature);
	return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

/** The workspace named by the proxy's forwarded headers, or null. */
export function workspaceFromHeaders(headers: Headers): WorkspacePaths | null {
	const id = headers.get(WORKSPACE_HEADER);
	const signature = headers.get(WORKSPACE_SIGNATURE_HEADER);
	if (!id || !signature || !workspaceSignatureValid(id, signature)) return null;
	return workspaceById(id);
}

function cookieValue(id: string): string {
	return `${id}.${signWorkspaceId(id)}`;
}

function readCookie(cookieHeader: string | null, name: string): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		return decodeURIComponent(part.slice(separator + 1).trim());
	}
	return null;
}

/**
 * Proxy-side resolution: reuse a valid cookie, otherwise mint a workspace.
 * Returns the signature so the proxy can forward both values upstream.
 */
export function resolveWorkspaceCookie(cookieHeader: string | null): {
	paths: WorkspacePaths;
	signature: string;
	fresh: boolean;
} {
	const existing = readCookie(cookieHeader, WORKSPACE_COOKIE_NAME);
	if (existing) {
		const separator = existing.indexOf(".");
		const id = separator > 0 ? existing.slice(0, separator) : "";
		const signature = separator > 0 ? existing.slice(separator + 1) : "";
		if (workspaceSignatureValid(id, signature)) {
			const paths = workspaceById(id);
			if (paths) return { paths, signature, fresh: false };
		}
	}
	const paths = createWorkspace();
	return { paths, signature: signWorkspaceId(paths.id), fresh: true };
}

/** The Set-Cookie value the proxy sends when it mints/replaces a cookie. */
export function workspaceCookieHeader(id: string): string {
	const parts = [
		`${WORKSPACE_COOKIE_NAME}=${encodeURIComponent(cookieValue(id))}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
	];
	if (process.env.NODE_ENV === "production") parts.push("Secure");
	return parts.join("; ");
}

/** Browser-safe cookie attributes for `NextResponse.cookies.set`. */
export function workspaceCookieOptions(): {
	name: string;
	path: string;
	httpOnly: boolean;
	sameSite: "lax";
	secure: boolean;
	maxAge: number;
} {
	return {
		name: WORKSPACE_COOKIE_NAME,
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		maxAge: COOKIE_MAX_AGE_SECONDS,
	};
}

type RouteHandler<Args extends unknown[]> = (
	...args: Args
) => Response | Promise<Response>;

/**
 * Route-handler wrapper: enter the workspace context before any store call.
 * In hosted mode a missing/invalid proxy header (a direct hit that bypassed
 * the edge, or a test) gets a fresh workspace and a Set-Cookie response, so
 * the request can never fall back to the operator's own data root.
 */
export function withWorkspace<Args extends unknown[]>(
	handler: RouteHandler<Args>,
): (...args: Args) => Promise<Response> {
	return async (...args: Args): Promise<Response> => {
		if (!hostedEnabled()) return handler(...args);

		const request = args[0] instanceof Request ? args[0] : null;
		const active = request ? workspaceFromHeaders(request.headers) : null;
		if (active) return runInWorkspace(active, () => handler(...args));

		const fresh = createWorkspace();
		const response = await runInWorkspace(fresh, () => handler(...args));
		response.headers.append("Set-Cookie", workspaceCookieHeader(fresh.id));
		return response;
	};
}

/**
 * Server-component wrapper: read the proxy's forwarded headers and enter the
 * same context. A missing header mints a workspace for this render only;
 * the proxy normally guarantees the cookie on the first page request.
 */
export async function withWorkspacePage<T>(
	fn: () => T | Promise<T>,
): Promise<T> {
	if (!hostedEnabled()) return fn();
	const { headers } = await import("next/headers");
	const requestHeaders = await headers();
	const active = workspaceFromHeaders(requestHeaders) ?? createWorkspace();
	return runInWorkspace(active, fn);
}

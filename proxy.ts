import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { hostedBlockedPath, isHostedMode } from "./src/server/hosted.ts";
import {
	resolveWorkspaceCookie,
	workspaceCookieOptions,
	WORKSPACE_HEADER,
	WORKSPACE_SIGNATURE_HEADER,
} from "./src/server/workspace-context.ts";

/** Applies to API methods (including SSE and spending/settings routes) and,
 * in hosted mode, to every page render. No public callback or worker bypass:
 * internal jobs call server functions, and any legitimate self-HTTP request
 * must carry the private capability.
 *
 * Hosted mode adds two gates before any handler runs: desktop-only
 * credential surfaces are refused, and every request enters a signed
 * workspace (cookie minted on first contact, id + signature forwarded to the
 * server-side wrapper). */
export function proxy(request: NextRequest) {
	const api = request.nextUrl.pathname.startsWith("/api/");
	if (api && !desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	if (api && hostedBlockedPath(request.nextUrl.pathname, request.method)) {
		return NextResponse.json(
			{ error: "This feature is not available in the hosted version." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	if (isHostedMode()) {
		const workspace = resolveWorkspaceCookie(request.headers.get("cookie"));
		const requestHeaders = new Headers(request.headers);
		requestHeaders.set(WORKSPACE_HEADER, workspace.paths.id);
		requestHeaders.set(WORKSPACE_SIGNATURE_HEADER, workspace.signature);
		const response = NextResponse.next({ request: { headers: requestHeaders } });
		if (workspace.fresh) {
			response.cookies.set({
				...workspaceCookieOptions(),
				value: `${workspace.paths.id}.${workspace.signature}`,
			});
		}
		return response;
	}
	return NextResponse.next();
}

/** Pages need the workspace cookie too; static assets never do. */
export const config = {
	matcher: ["/((?!_next|favicon.ico|.*\\..*).*)"],
};

import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { hostedBlockedPath } from "./src/server/hosted.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 *
 * Hosted mode adds a second gate: desktop-only credential surfaces and
 * operator-key mutation are refused before any route handler sees them. */
export function proxy(request: NextRequest) {
	if (!desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	if (hostedBlockedPath(request.nextUrl.pathname, request.method)) {
		return NextResponse.json(
			{ error: "This feature is not available in the hosted version." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };

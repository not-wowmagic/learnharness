/**
 * Magic-link callback (hosted-web phase 2).
 *
 * Supabase Auth sends the browser here with either a PKCE `code` or a
 * `token_hash` (custom email templates). We establish the auth session,
 * then choose the visitor's workspace:
 *   1. an existing owned workspace (most recent) wins;
 *   2. otherwise the current anonymous workspace is claimed;
 *   3. a claim collision mints a fresh workspace.
 * The final `lh_ws` cookie is set here, so a new device lands on the right
 * local data directory after one sign-in.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import type { EmailOtpType } from "@supabase/supabase-js";
import { safeNextPath } from "@/src/core";
import {
	accountsAvailable,
	chooseWorkspaceForUser,
	createSupabaseServerClient,
	createWorkspace,
	ensureWorkspaceById,
	setWorkspaceOwner,
	signWorkspaceId,
	supabaseAccountStore,
	workspaceCookieOptions,
	workspaceFromHeaders,
} from "@/src/server";

export const dynamic = "force-dynamic";

function errorPage(message: string, status = 400): Response {
	const safe = message.replace(/[<>&"]/g, (char) =>
		({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[char] ?? char,
	);
	return new Response(
		`<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>` +
			`<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
			`<h1>Sign-in failed</h1><p>${safe}</p><p><a href="/">Return to LearnHarness</a></p></body></html>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
	);
}

export async function GET(request: Request) {
	const url = new URL(request.url);
	const next = safeNextPath(url.searchParams.get("next"));
	if (!accountsAvailable()) {
		return errorPage("Accounts are not configured on this deployment.", 503);
	}

	const supabase = await createSupabaseServerClient();
	if (!supabase) return errorPage("Supabase Auth is not configured.", 503);

	const code = url.searchParams.get("code");
	const tokenHash = url.searchParams.get("token_hash");
	const otpType = url.searchParams.get("type") as EmailOtpType | null;

	if (code) {
		const { error } = await supabase.auth.exchangeCodeForSession(code);
		if (error) return errorPage(`The sign-in link could not be used: ${error.message}`);
	} else if (tokenHash && otpType) {
		const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType });
		if (error) return errorPage(`The sign-in link could not be used: ${error.message}`);
	} else {
		return errorPage("The sign-in link is missing its code.", 400);
	}

	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return errorPage("The sign-in session could not be read.", 401);

	// The proxy forwarded the browser's current workspace (minting one when
	// this is the first contact). The callback always sets the final cookie.
	const current = workspaceFromHeaders(await headers()) ?? createWorkspace();
	const store = supabaseAccountStore();
	const choice = await chooseWorkspaceForUser(store, current.id, user.id);
	const paths = ensureWorkspaceById(choice.id) ?? current;

	setWorkspaceOwner(paths.id, user.id);
	await store?.touchWorkspace(paths.id);

	const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
	const origin = site && /^https?:\/\//.test(site) ? site : url.origin;
	const response = NextResponse.redirect(new URL(next, origin));
	response.cookies.set({
		...workspaceCookieOptions(),
		value: `${paths.id}.${signWorkspaceId(paths.id)}`,
	});
	return response;
}

/**
 * POST /api/auth/signout — clear the Supabase session cookies and the
 * workspace cookie (hosted-web phase 2). The next navigation mints a fresh
 * anonymous workspace; the signed-out user's owned workspace stays intact
 * on the server and returns on their next magic-link sign-in.
 */

import { NextResponse } from "next/server";
import {
	accountsAvailable,
	createSupabaseServerClient,
	workspaceCookieOptions,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	if (!accountsAvailable()) {
		return NextResponse.json({ error: "Accounts are not configured." }, { status: 404 });
	}
	const supabase = await createSupabaseServerClient();
	if (supabase) await supabase.auth.signOut();

	const response = NextResponse.json({ ok: true });
	response.cookies.set({
		...workspaceCookieOptions(),
		value: "",
		maxAge: 0,
	});
	return response;
}

"use client";

/**
 * Browser Supabase client for the Account surface (hosted-web phase 2).
 * `createBrowserClient` owns the PKCE verifier + session cookies that the
 * server callback reads; a module singleton keeps one auth listener set.
 */

import { createBrowserClient } from "@supabase/ssr";

let cached: ReturnType<typeof createBrowserClient> | null = null;

export function accountsConfigured(): boolean {
	return Boolean(
		process.env.NEXT_PUBLIC_SUPABASE_URL &&
			process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
	);
}

export function supabaseBrowser(): ReturnType<typeof createBrowserClient> | null {
	if (!accountsConfigured()) return null;
	cached ??= createBrowserClient(
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
	);
	return cached;
}

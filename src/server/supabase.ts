/**
 * Supabase configuration + the service-role client (hosted-web phase 2).
 *
 * Auth sessions are handled by @supabase/ssr cookie clients; ownership
 * lookups use the service role because the `workspaces` table has RLS on
 * with no anon/authenticated policies. Nothing here runs in the browser.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { hostedEnabled } from "../core/hosted.ts";

export interface SupabaseConfig {
	url: string;
	anonKey: string;
	serviceKey: string;
}

export function supabaseConfig(
	env: Record<string, string | undefined> = process.env,
): SupabaseConfig | null {
	const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
	const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
	const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
	if (!url || !anonKey || !serviceKey) return null;
	try {
		const parsed = new URL(url);
		const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
		if (parsed.protocol !== "https:" && !local) return null;
	} catch {
		return null;
	}
	return { url, anonKey, serviceKey };
}

/** Accounts exist only in a hosted deployment with all three env values. */
export function accountsAvailable(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return hostedEnabled(env) && supabaseConfig(env) !== null;
}

let cachedAdmin: SupabaseClient | null = null;

/** Service-role client — server only. Returns null when unconfigured. */
export function supabaseAdmin(
	env: Record<string, string | undefined> = process.env,
): SupabaseClient | null {
	const config = supabaseConfig(env);
	if (!config) return null;
	cachedAdmin ??= createClient(config.url, config.serviceKey, {
		auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
		global: { headers: { "x-application-name": "learnharness-hosted" } },
	});
	return cachedAdmin;
}

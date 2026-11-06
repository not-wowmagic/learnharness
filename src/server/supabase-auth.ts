/**
 * Supabase Auth cookie client for route handlers (hosted-web phase 2).
 *
 * @supabase/ssr stores the PKCE verifier + session in the app's cookies, so
 * the magic-link callback can exchange the code and the Account section can
 * read the signed-in user. Never import this from a Client Component.
 */

import { supabaseConfig } from "./supabase.ts";

export async function createSupabaseServerClient() {
	const config = supabaseConfig();
	if (!config) return null;
	// Lazy: this module is part of the server barrel, and next/headers must
	// only load inside a real request context.
	const [{ createServerClient }, { cookies }] = await Promise.all([
		import("@supabase/ssr"),
		import("next/headers"),
	]);
	const cookieStore = await cookies();
	return createServerClient(config.url, config.anonKey, {
		cookies: {
			getAll() {
				return cookieStore.getAll();
			},
			setAll(cookiesToSet) {
				try {
					for (const { name, value, options } of cookiesToSet) {
						cookieStore.set(name, value, options);
					}
				} catch {
					// Server Components cannot set cookies; the callback route can.
					// Reading a session still works, so this is not fatal there.
				}
			},
		},
	});
}

export async function supabaseUser(): Promise<{ id: string; email?: string } | null> {
	const client = await createSupabaseServerClient();
	if (!client) return null;
	const { data, error } = await client.auth.getUser();
	if (error || !data.user) return null;
	return { id: data.user.id, ...(data.user.email ? { email: data.user.email } : {}) };
}

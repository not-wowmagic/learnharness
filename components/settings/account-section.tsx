"use client";

/**
 * "Save your progress" (hosted-web phase 2). Anonymous workspaces are the
 * default; an email magic link claims the current workspace and restores it
 * on another device. Signing out clears both the auth session and `lh_ws`,
 * so the next visit starts a fresh anonymous workspace.
 */

import { useCallback, useEffect, useState } from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { accountsConfigured, supabaseBrowser } from "@/lib/supabase-browser";

export function AccountSection() {
	const [client] = useState(() => supabaseBrowser());
	const [user, setUser] = useState<User | null>(null);
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!client) return;
		let active = true;
		client.auth
			.getUser()
			.then(({ data }: { data: { user: User | null } }) => {
				if (active) setUser(data.user);
			})
			.catch(() => {
				/* signed out / transient read failure */
			});
		const { data } = client.auth.onAuthStateChange(
			(_event: AuthChangeEvent, session: Session | null) => {
				setUser(session?.user ?? null);
			},
		);
		return () => {
			active = false;
			data.subscription.unsubscribe();
		};
	}, [client]);

	const sendLink = useCallback(async () => {
		if (!client || busy) return;
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const { error: sendError } = await client.auth.signInWithOtp({
				email: email.trim(),
				options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
			});
			if (sendError) setError(sendError.message);
			else setMessage("Check your email for the sign-in link.");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not send the link.");
		} finally {
			setBusy(false);
		}
	}, [busy, client, email]);

	const signOut = useCallback(async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await client?.auth.signOut();
			await fetch("/api/auth/signout", { method: "POST" });
			window.location.assign("/");
		} catch {
			setError("Could not sign out.");
			setBusy(false);
		}
	}, [busy, client]);

	if (!accountsConfigured() || !client) {
		return (
			<div className="flex flex-col gap-3 p-6 text-sm text-muted-foreground">
				<p>Accounts are not configured on this deployment.</p>
				<p className="text-xs">
					Set <code>NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
					<code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, and{" "}
					<code>SUPABASE_SERVICE_ROLE_KEY</code> to enable magic-link sign-in.
				</p>
			</div>
		);
	}

	if (user) {
		return (
			<div className="flex flex-col gap-4 p-6">
				<div>
					<p className="font-ui text-sm text-foreground">Signed in</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{user.email ?? "Your account"}
					</p>
				</div>
				<p className="text-sm text-muted-foreground">
					This workspace is saved and will open on another device after you
					sign in with the same email.
				</p>
				<div className="flex items-center gap-3">
					<button
						type="button"
						disabled={busy}
						onClick={() => void signOut()}
						className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
					>
						{busy ? "Signing out…" : "Sign out"}
					</button>
					{error && <p className="text-xs text-red-400">{error}</p>}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-6">
			<div>
				<p className="font-ui text-sm text-foreground">Save your progress</p>
				<p className="mt-1 text-sm text-muted-foreground">
					This workspace lives in this browser. Add an email and we&apos;ll send
					a sign-in link so it follows you to another device.
				</p>
			</div>
			<form
				className="flex flex-wrap items-center gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void sendLink();
				}}
			>
				<input
					type="email"
					required
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					placeholder="you@example.com"
					aria-label="Email address"
					className="min-w-56 flex-1 rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-muted-foreground/50"
				/>
				<button
					type="submit"
					disabled={busy || email.trim() === ""}
					className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
				>
					{busy ? "Sending…" : "Send magic link"}
				</button>
			</form>
			{message && <p className="text-xs text-muted-foreground">{message}</p>}
			{error && <p className="text-xs text-red-400">{error}</p>}
			<p className="text-xs text-muted-foreground/70">
				Only the email is sent to Supabase. Your chats and knowledge graph stay
				on this server.
			</p>
		</div>
	);
}

/**
 * Workspace ownership (hosted-web phase 2).
 *
 * The local JSON stores own the learning data; Supabase owns only the
 * user ↔ workspace mapping, so a magic-link sign-in on a new device can
 * point the `lh_ws` cookie at the right local directory. The mapping
 * methods are injectable so the choice logic is testable without a live
 * database.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase.ts";
import { createWorkspace } from "../store/workspace.ts";

export interface AccountStore {
	/** The most recently active workspace owned by this auth user, or null. */
	findOwnedWorkspace(userId: string): Promise<string | null>;
	/** Claim an anonymous workspace. False when it belongs to someone else or
	 *  the write failed. */
	claimWorkspace(workspaceId: string, userId: string): Promise<boolean>;
	touchWorkspace(workspaceId: string): Promise<void>;
}

export function supabaseAccountStore(
	client: SupabaseClient | null = supabaseAdmin(),
): AccountStore | null {
	if (!client) return null;
	return {
		async findOwnedWorkspace(userId) {
			const { data, error } = await client
				.from("workspaces")
				.select("id")
				.eq("owner_id", userId)
				.order("last_seen_at", { ascending: false })
				.limit(1)
				.maybeSingle();
			if (error) {
				console.error("[accounts] owned workspace lookup failed:", error.message);
				return null;
			}
			return typeof data?.id === "string" ? data.id : null;
		},

		async claimWorkspace(workspaceId, userId) {
			// A workspace id is a UUID; refuse anything else before it reaches SQL.
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
				return false;
			}
			const { data: existing, error: readError } = await client
				.from("workspaces")
				.select("owner_id")
				.eq("id", workspaceId)
				.maybeSingle();
			if (readError) {
				console.error("[accounts] workspace ownership read failed:", readError.message);
				return false;
			}
			if (existing?.owner_id && existing.owner_id !== userId) return false;
			const { error } = await client.from("workspaces").upsert(
				{
					id: workspaceId,
					owner_id: userId,
					last_seen_at: new Date().toISOString(),
				},
				{ onConflict: "id" },
			);
			if (error) {
				console.error("[accounts] workspace claim failed:", error.message);
				return false;
			}
			return true;
		},

		async touchWorkspace(workspaceId) {
			const { error } = await client
				.from("workspaces")
				.update({ last_seen_at: new Date().toISOString() })
				.eq("id", workspaceId);
			if (error) console.error("[accounts] workspace touch failed:", error.message);
		},
	};
}

export interface WorkspaceChoice {
	id: string;
	/** The current anonymous workspace was claimed by this sign-in. */
	claimed: boolean;
	/** A fresh local workspace had to be minted (claim collision). */
	created: boolean;
}

/**
 * Choose where a signed-in user lands:
 *  1. an existing owned workspace (most recent) always wins;
 *  2. otherwise claim the current anonymous workspace;
 *  3. if that workspace already belongs to someone else, mint + claim a
 *     fresh one.
 * A null store (accounts unconfigured) keeps the current workspace.
 */
export async function chooseWorkspaceForUser(
	store: AccountStore | null,
	currentId: string,
	userId: string,
): Promise<WorkspaceChoice> {
	if (!store) return { id: currentId, claimed: false, created: false };

	const existing = await store.findOwnedWorkspace(userId);
	if (existing) return { id: existing, claimed: false, created: false };

	if (await store.claimWorkspace(currentId, userId)) {
		return { id: currentId, claimed: true, created: false };
	}

	const fresh = createWorkspace();
	if (await store.claimWorkspace(fresh.id, userId)) {
		return { id: fresh.id, claimed: true, created: true };
	}

	// The database is unreachable or racing: keep the local workspace rather
	// than sending the visitor into an empty directory with no owner row.
	return { id: currentId, claimed: false, created: false };
}

/**
 * Workspace-scoped storage paths (hosted-web wave, 2026-11-06).
 *
 * The desktop app has exactly one data root (`config.PATHS.data`). The
 * hosted app gives every visitor its own root under
 * `data/workspaces/<uuid>/`, so chats, graph ledgers, jobs, settings, and
 * prompt overrides can never be shared by accident.
 *
 * The request seam is an AsyncLocalStorage. Adapters call
 * `currentWorkspace()` per operation (never capture a path at module load),
 * and `withWorkspace` establishes the context around a route handler or
 * server component. Background agent work started inside that context
 * inherits it through Node's async hooks; lazy job recovery runs inside the
 * same request context.
 *
 * Outside hosted mode there is no context: `currentWorkspace()` resolves the
 * historical repo `data/` root byte-for-byte, so the desktop path and every
 * existing call site keep their behavior.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export interface WorkspacePaths {
	/** "default" outside hosted mode, otherwise the workspace UUID. */
	id: string;
	root: string;
	data: string;
	chats: string;
	graph: string;
	jobs: string;
	settings: string;
	prompts: string;
	debug: string;
	ledgers: {
		nodes: string;
		chains: string;
		sessions: string;
		coverage: string;
	};
	sources: string;
	sourceOrganization: string;
	positions: string;
	renderSettings: string;
	graphFormat: string;
}

interface WorkspaceMeta {
	id: string;
	createdAt: string;
	lastSeenAt: string;
	/** Auth user id once the workspace is claimed (phase 2). Anonymous
	 *  workspaces omit it and are eligible for the retention sweep. */
	ownerId?: string;
}

const storage = new AsyncLocalStorage<WorkspacePaths>();
const DEFAULT_WORKSPACE_ID = "default";

/** Build the path family for one data root. Pure apart from no I/O. */
export function workspacePathsFor(root: string, id: string): WorkspacePaths {
	const graph = path.join(root, "graph");
	return {
		id,
		root,
		data: root,
		chats: path.join(root, "chats"),
		graph,
		jobs: path.join(root, "jobs"),
		settings: path.join(root, "settings.json"),
		prompts: path.join(root, "prompts"),
		debug: path.join(root, "debug"),
		ledgers: {
			nodes: path.join(graph, "nodes.jsonl"),
			chains: path.join(graph, "chains.jsonl"),
			sessions: path.join(graph, "sessions.jsonl"),
			coverage: path.join(graph, "coverage.jsonl"),
		},
		sources: path.join(graph, "sources.json"),
		sourceOrganization: path.join(graph, "source-organization.json"),
		positions: path.join(graph, "positions.json"),
		renderSettings: path.join(graph, "render-settings.json"),
		graphFormat: path.join(graph, "format.json"),
	};
}

const defaultWorkspace = workspacePathsFor(PATHS.data, DEFAULT_WORKSPACE_ID);

/** The context's paths, or the historical desktop data root. */
export function currentWorkspace(): WorkspacePaths {
	return storage.getStore() ?? defaultWorkspace;
}

/** Run `fn` with `paths` as the active workspace for every nested call. */
export function runInWorkspace<T>(paths: WorkspacePaths, fn: () => T): T {
	return storage.run(paths, fn);
}

/** UUID v4 shape check — the only ids that may name a directory. */
export function isWorkspaceId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function metaPath(root: string): string {
	return path.join(root, "meta.json");
}

function readMeta(root: string): WorkspaceMeta | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(metaPath(root), "utf-8")) as Partial<WorkspaceMeta>;
		if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.lastSeenAt !== "string") return null;
		return {
			id: parsed.id,
			createdAt: parsed.createdAt,
			lastSeenAt: parsed.lastSeenAt,
			...(typeof parsed.ownerId === "string" ? { ownerId: parsed.ownerId } : {}),
		};
	} catch {
		return null;
	}
}

/** Purge retired graph ledgers for THIS root (the adapter-load sweep in
 *  graph.ts is default-root-only by construction). */
function purgeLegacyGraph(root: string): void {
	const graphDir = path.join(root, "graph");
	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const file = path.join(graphDir, legacy);
		try {
			if (fs.existsSync(file)) fs.rmSync(file);
		} catch {
			// Best-effort housekeeping; a live legacy file must not block boot.
		}
	}
}

/**
 * Create the directory family and its meta record. Idempotent: an existing
 * workspace keeps its `createdAt` and is only touched.
 */
export function ensureWorkspace(paths: WorkspacePaths): void {
	fs.mkdirSync(paths.chats, { recursive: true });
	fs.mkdirSync(paths.graph, { recursive: true });
	fs.mkdirSync(paths.jobs, { recursive: true });
	fs.mkdirSync(paths.prompts, { recursive: true });
	const now = new Date().toISOString();
	const meta = readMeta(paths.root);
	if (!meta) {
		const created: WorkspaceMeta = { id: paths.id, createdAt: now, lastSeenAt: now };
		writeFileAtomicSync(metaPath(paths.root), JSON.stringify(created, null, "\t"));
	}
	purgeLegacyGraph(paths.root);
	touchWorkspace(paths);
}

/** Last-seen updates are throttled: retention does not need per-request
 *  precision, and a write on every API call would be pure disk churn. */
const touchedAt = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export function touchWorkspace(paths: WorkspacePaths): void {
	const now = Date.now();
	const previous = touchedAt.get(paths.id) ?? 0;
	if (now - previous < TOUCH_INTERVAL_MS) return;
	touchedAt.set(paths.id, now);
	const meta = readMeta(paths.root) ?? {
		id: paths.id,
		createdAt: new Date(now).toISOString(),
		lastSeenAt: new Date(now).toISOString(),
	};
	meta.lastSeenAt = new Date(now).toISOString();
	writeFileAtomicSync(metaPath(paths.root), JSON.stringify(meta, null, "\t"));
}

/** Resolve a specific workspace id, creating its local directory family if
 *  the account claimed it on another device / after a retention pass. */
export function ensureWorkspaceById(id: string): WorkspacePaths | null {
	if (!isWorkspaceId(id)) return null;
	const paths = workspacePathsFor(path.join(PATHS.workspaces, id), id);
	ensureWorkspace(paths);
	return paths;
}

/** Record (or clear) local ownership metadata. The Supabase `workspaces`
 *  table is the cross-device source of truth; this keeps retention honest. */
export function setWorkspaceOwner(id: string, ownerId: string | null): boolean {
	if (!isWorkspaceId(id)) return false;
	const root = path.join(PATHS.workspaces, id);
	if (!fs.existsSync(root)) return false;
	const now = new Date().toISOString();
	const meta = readMeta(root) ?? { id, createdAt: now, lastSeenAt: now };
	if (ownerId) meta.ownerId = ownerId;
	else delete meta.ownerId;
	writeFileAtomicSync(metaPath(root), JSON.stringify(meta, null, "\t"));
	return true;
}

/** Mint a fresh workspace and its directory family. */
export function createWorkspace(): WorkspacePaths {
	const id = randomUUID();
	const paths = workspacePathsFor(path.join(PATHS.workspaces, id), id);
	ensureWorkspace(paths);
	pruneStaleWorkspaces();
	return paths;
}

/** Resolve an existing workspace by id, or null. */
export function workspaceById(id: string): WorkspacePaths | null {
	if (!isWorkspaceId(id)) return null;
	const root = path.join(PATHS.workspaces, id);
	if (!fs.existsSync(root)) return null;
	const paths = workspacePathsFor(root, id);
	// The hot path (every request) only needs the touch; full directory
	// repair is for first contact / a partially deleted workspace.
	if (fs.existsSync(path.join(root, "meta.json"))) touchWorkspace(paths);
	else ensureWorkspace(paths);
	return paths;
}

/** Every workspace on disk (used by retention and tests). */
export function listWorkspaces(): WorkspacePaths[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(PATHS.workspaces, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && isWorkspaceId(entry.name))
		.map((entry) => workspacePathsFor(path.join(PATHS.workspaces, entry.name), entry.name));
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Delete anonymous workspaces idle for longer than `maxAgeDays`. Runs at
 * most once an hour, opportunistically on workspace creation. Account-owned
 * workspaces (phase 2) will be exempt once ownership exists.
 */
export function pruneStaleWorkspaces(maxAgeDays = 30): number {
	const now = Date.now();
	if (now - lastPruneAt < PRUNE_INTERVAL_MS) return 0;
	lastPruneAt = now;
	const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
	let removed = 0;
	for (const paths of listWorkspaces()) {
		const meta = readMeta(paths.root);
		if (meta?.ownerId) continue; // account-owned workspaces are never swept
		const lastSeen = meta ? Date.parse(meta.lastSeenAt) : fs.statSync(paths.root).mtimeMs;
		if (!Number.isFinite(lastSeen) || lastSeen >= cutoff) continue;
		try {
			fs.rmSync(paths.root, { recursive: true, force: true });
			removed++;
		} catch {
			// A locked workspace retries on the next sweep.
		}
	}
	return removed;
}

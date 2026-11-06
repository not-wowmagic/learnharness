/**
 * Hosted admission limits (hosted-web phase 3).
 *
 * The operator pays for every model call, so the chat route admits a turn
 * only when the workspace is under its hourly/daily turn budget, the
 * process is under its concurrent-turn budget, and neither the workspace
 * nor the deployment is over its daily spend cap.
 *
 * All state is in-process (the hosted deployment is deliberately one
 * instance: background jobs, locks, and SSE coordination are process-local).
 * Buckets live on globalThis so Next's per-route module entries share them.
 * A restart clears the counters; spend is recomputed from durable usage
 * records, so the money caps survive restarts.
 */

import { isHostedMode } from "./hosted.ts";
import { callCost, jobCost, turnCost } from "./pricing.ts";
import { turnCost as foldTurnCost } from "../core/prices.ts";
import type { CallUsage } from "../core/contracts.ts";
import { stores } from "./stores.ts";
import { activeTurnsInWorkspace } from "./turn-liveness.ts";
import {
	currentWorkspace,
	listWorkspaces,
	runInWorkspace,
	workspaceDiskBytes,
} from "../store/workspace.ts";

interface LimitsGlobal {
	__lhHostedBuckets?: Map<string, number[]>;
	__lhHostedSpendCache?: Map<string, SpendResult & { at: number }>;
	__lhHostedPrunedAt?: number;
}

function globalState(): LimitsGlobal {
	return globalThis as typeof globalThis & LimitsGlobal;
}

function buckets(): Map<string, number[]> {
	const g = globalState();
	return (g.__lhHostedBuckets ??= new Map());
}

function spendCache(): Map<string, SpendResult & { at: number }> {
	const g = globalState();
	return (g.__lhHostedSpendCache ??= new Map());
}

const PRUNE_INTERVAL_MS = 10 * 60_000;
const BUCKET_RETENTION_MS = 24 * 60 * 60_000;
const SPEND_CACHE_MS = 30_000;

function prune(): void {
	const g = globalState();
	const now = Date.now();
	if (g.__lhHostedPrunedAt && now - g.__lhHostedPrunedAt < PRUNE_INTERVAL_MS) return;
	g.__lhHostedPrunedAt = now;
	for (const [key, timestamps] of buckets()) {
		const last = timestamps[timestamps.length - 1] ?? 0;
		if (now - last > BUCKET_RETENTION_MS) buckets().delete(key);
	}
	for (const [key, entry] of spendCache()) {
		if (now - entry.at > BUCKET_RETENTION_MS) spendCache().delete(key);
	}
}

function hit(key: string, limit: number, windowMs: number): boolean {
	prune();
	const now = Date.now();
	const recent = (buckets().get(key) ?? []).filter((at) => now - at < windowMs);
	if (recent.length >= limit) {
		buckets().set(key, recent);
		return false;
	}
	recent.push(now);
	buckets().set(key, recent);
	return true;
}

function envInt(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envUsd(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Per-workspace session cap (bounds sidebar scans and JSON count). */
export function hostedSessionCapReached(): boolean {
	if (!isHostedMode()) return false;
	return stores.chatStore.listChats().length >= envInt("LH_HOSTED_MAX_SESSIONS", 50);
}

/** Per-workspace disk cap; pass the incoming upload size for a preflight. */
export function hostedDiskCapReached(extraBytes = 0): boolean {
	if (!isHostedMode()) return false;
	const capMb = envUsd("LH_HOSTED_WORKSPACE_DISK_MB", 250);
	return workspaceDiskBytes() + Math.max(0, extraBytes) >= capMb * 1024 * 1024;
}

export function clientIp(request: Request): string {
	const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
	return (
		request.headers.get("cf-connecting-ip")?.trim() ||
		request.headers.get("x-real-ip")?.trim() ||
		forwarded ||
		"unknown"
	);
}

export interface SpendResult {
	usd: number;
	unpriced: number;
}

const DAY_MS = 24 * 60 * 60_000;

function dayKey(now: Date): string {
	return now.toISOString().slice(0, 10);
}

type UsageStage = { model?: unknown; steps?: unknown };

function extractionSpend(stages: Record<string, UsageStage> | undefined): SpendResult {
	let usd = 0;
	let unpriced = 0;
	for (const stage of Object.values(stages ?? {})) {
		if (!stage || typeof stage.model !== "string" || !Array.isArray(stage.steps) || stage.steps.length === 0) continue;
		const cost = foldTurnCost(
			{ model: stage.model, steps: stage.steps as CallUsage[] },
			callCost,
		);
		if (cost === null) unpriced++;
		else usd += cost;
	}
	return { usd, unpriced };
}

/** Today's model spend for the ACTIVE workspace (teaching turns + jobs +
 *  extraction runs). Reads durable usage records; cached briefly. */
export function workspaceSpendToday(now: Date = new Date()): SpendResult {
	const day = dayKey(now);
	const key = `ws:${currentWorkspace().id}:${day}`;
	const cached = spendCache().get(key);
	if (cached && Date.now() - cached.at < SPEND_CACHE_MS) {
		return { usd: cached.usd, unpriced: cached.unpriced };
	}

	let usd = 0;
	let unpriced = 0;
	for (const summary of stores.chatStore.listChats()) {
		const record = stores.chatStore.getChat(summary.id);
		if (!record) continue;

		for (const turn of record.turns ?? []) {
			if (turn.at.slice(0, 10) !== day) continue;
			const cost = turnCost(turn);
			if (cost === null) unpriced++;
			else usd += cost;
		}
		for (const extraction of record.extractions ?? []) {
			if (extraction.at.slice(0, 10) !== day) continue;
			const spend = extractionSpend(extraction.stages);
			usd += spend.usd;
			unpriced += spend.unpriced;
		}
		for (const job of stores.jobStore.listJobs(summary.id)) {
			if (job.createdAt.slice(0, 10) !== day) continue;
			const cost = jobCost(job);
			if (cost === null) continue;
			usd += cost;
		}
	}
	for (const source of stores.graphStore.readSources()) {
		for (const extraction of source.extractions ?? []) {
			if (extraction.at.slice(0, 10) !== day) continue;
			const spend = extractionSpend(extraction.stages);
			usd += spend.usd;
			unpriced += spend.unpriced;
		}
	}

	const result = { usd, unpriced };
	spendCache().set(key, { ...result, at: Date.now() });
	return result;
}

/** Today's spend across every hosted workspace (one-instance scan, cached). */
export function globalSpendToday(now: Date = new Date()): SpendResult {
	const day = dayKey(now);
	const key = `global:${day}`;
	const cached = spendCache().get(key);
	if (cached && Date.now() - cached.at < SPEND_CACHE_MS) {
		return { usd: cached.usd, unpriced: cached.unpriced };
	}

	let usd = 0;
	let unpriced = 0;
	for (const workspace of listWorkspaces()) {
		const spend = runInWorkspace(workspace, () => workspaceSpendToday(now));
		usd += spend.usd;
		unpriced += spend.unpriced;
	}
	const result = { usd, unpriced };
	spendCache().set(key, { ...result, at: Date.now() });
	return result;
}

export type ChatAdmission =
	| { ok: true }
	| {
			ok: false;
			status: number;
			body: { error: string; code: string; retryAfterSeconds?: number };
	  };

function refuse(
	status: number,
	code: string,
	error: string,
	retryAfterSeconds?: number,
): ChatAdmission {
	return {
		ok: false,
		status,
		body: { error, code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
	};
}

/**
 * The hosted turn gate. Non-hosted deployments pass through untouched.
 * Call before parsing/inference; a refused request has no durable effects.
 */
export async function admitHostedChat(request: Request): Promise<ChatAdmission> {
	if (!isHostedMode()) return { ok: true };

	if (process.env.LH_HOSTED_PAUSED === "1") {
		return refuse(503, "paused", "The hosted service is paused. Try again later.");
	}

	const workspace = currentWorkspace();
	const ip = clientIp(request);

	if (!hit(`turn:hour:${workspace.id}`, envInt("LH_HOSTED_TURNS_PER_HOUR", 20), 60 * 60_000)) {
		return refuse(429, "rate_limited", "Too many turns this hour. Try again shortly.", 60 * 60);
	}
	if (!hit(`turn:day:${workspace.id}`, envInt("LH_HOSTED_TURNS_PER_DAY", 100), DAY_MS)) {
		return refuse(429, "daily_limit", "This workspace reached its daily turn limit.", DAY_MS / 1000);
	}
	if (!hit(`ip:hour:${ip}`, envInt("LH_HOSTED_TURNS_PER_IP_HOUR", 60), 60 * 60_000)) {
		return refuse(429, "ip_rate_limited", "Too many turns from this network. Try again later.", 60 * 60);
	}
	if (activeTurnsInWorkspace(workspace.id) >= envInt("LH_HOSTED_ACTIVE_TURNS", 3)) {
		return refuse(429, "too_many_turns", "This workspace already has several turns running. Wait for one to finish.", 60);
	}

	const [workspaceSpend, globalSpend] = await Promise.all([
		workspaceSpendToday(),
		globalSpendToday(),
	]);
	if (workspaceSpend.usd >= envUsd("LH_HOSTED_WORKSPACE_DAILY_USD", 2)) {
		return refuse(429, "workspace_spend_cap", "This workspace reached its daily model budget.", DAY_MS / 1000);
	}
	if (globalSpend.usd >= envUsd("LH_HOSTED_GLOBAL_DAILY_USD", 20)) {
		return refuse(503, "global_spend_cap", "The hosted service reached its daily model budget. Try again tomorrow.", DAY_MS / 1000);
	}

	return { ok: true };
}

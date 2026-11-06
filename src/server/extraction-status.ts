/**
 * Workspace-filtered extraction status (hosted-web wave, 2026-11-06).
 *
 * The extraction pipeline's run registry is process-global (it coordinates
 * one FIFO audit/merge lock). In a hosted deployment, a visitor must only
 * see runs whose chat or notes source belongs to its workspace: the raw
 * registry also carries other tenants' chat ids, source paths, and timing.
 */

import {
	extractionStatuses,
	type RunningExtraction,
} from "../agent/subagents/extraction.ts";
import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";

export function workspaceExtractionStatuses(): RunningExtraction[] {
	// Both stores resolve through the active workspace context.
	const sourceIds = new Set(graphStore.readSources().map((source) => source.id));
	return extractionStatuses().filter((run) =>
		run.kind === "chat"
			? chatStore.getChat(run.chatId) !== null
			: sourceIds.has(run.chatId),
	);
}

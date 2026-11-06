/** Current optional learner-source preferences, wired by the server
 * composition root into the #157 policy seam. Mandatory #421 protection
 * stays in fs-shared; do NOT add a whole data/userData denial here. */
import os from "node:os";
import path from "node:path";
import type { FileAccessPolicy } from "../agent/tools/file-access.ts";
import { readFileAccessSettings } from "../store/settings.ts";
import { isHostedMode } from "./hosted.ts";

export function expandFolder(folder: string, home: string = os.homedir()): string {
	if (folder === "~") return home;
	if (folder.startsWith("~/")) return path.join(home, folder.slice(2));
	if (!path.isAbsolute(folder)) throw new Error("Invalid file-access folder for this server filesystem");
	return path.resolve(folder);
}

export function fileAccessPolicy(): FileAccessPolicy {
	// Hosted deployment: the server filesystem belongs to the operator and
	// every other visitor. Learner file tools get a closed policy; uploads
	// (notes import) are handled by server-owned routes, not by path reads.
	if (isHostedMode()) return { restricted: true, folders: [] };
	const result = readFileAccessSettings();
	if (!result.ok) return { restricted: true, folders: [], error: result.error };
	return { restricted: result.settings.restricted, folders: result.settings.folders.map((folder) => expandFolder(folder)) };
}

/** Safe UI diagnostic, no raw JSON/file contents. A corrupt record must
 * not make the restriction toggle appear safely OFF while reads are blocked. */
export function fileAccessConfigurationError(): string | null {
	if (isHostedMode()) return null; // closed by policy, not by a broken record
	const result = readFileAccessSettings();
	return result.ok ? null : result.error;
}

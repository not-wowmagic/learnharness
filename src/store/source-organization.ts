import fs from "node:fs";
import path from "node:path";
import { emptySourceOrganization, parseSourceOrganization } from "../core/source-organization.ts";
import { currentWorkspace } from "./workspace.ts";
import type { SourceOrganizationStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

export const sourceOrganizationStore: SourceOrganizationStore = {
	read() {
		assertGraphFormat();
		let raw: string;
		try { raw = fs.readFileSync(currentWorkspace().sourceOrganization, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySourceOrganization();
			throw error;
		}
		return parseSourceOrganization(JSON.parse(raw));
	},
	write(state) {
		assertGraphFormat();
		const valid = parseSourceOrganization(state);
		const file = currentWorkspace().sourceOrganization;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		ensureGraphFormat();
		writeFileAtomicSync(file, JSON.stringify(valid, null, "\t") + "\n");
		removeLeftoverTemps(file); // crash leftovers could still place deleted sources
		emit("sources-changed", {});
	},
};

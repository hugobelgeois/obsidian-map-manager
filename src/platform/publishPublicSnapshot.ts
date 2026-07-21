import { App, TFile } from "obsidian";
import { MapFileData, publicSnapshotPath } from "../data/mapData";
import { buildPublicSnapshot } from "../data/mapRedaction";
import { rewriteAssetPathsForSite } from "../data/publicAssetPaths";
import { renderNoteSnapshot } from "./renderNoteSnapshot";

/**
 * Redacts `data` (see `buildPublicSnapshot`), rewrites background/token image paths to
 * site-root-absolute references (see `rewriteAssetPathsForSite`), bakes linked-note content into it
 * (see `renderNoteSnapshot`), and writes/overwrites the result next to `mapFile` as
 * `<basename>.json` (see `publicSnapshotPath`) — the file `src/view/customScript.ts` fetches
 * client-side (by URL, derived from the same ` ```map ``` ` block reference) once that script is
 * running on the external site (installation/distribution of the script itself is not this
 * plugin's concern — see `src/view/customScript.ts`).
 */
export async function publishPublicSnapshot(app: App, mapFile: TFile, data: MapFileData): Promise<TFile> {
	const redacted = buildPublicSnapshot(data);
	const rewritten = rewriteAssetPathsForSite(redacted);
	const snapshot = await renderNoteSnapshot(app, rewritten);
	const json = JSON.stringify(snapshot, null, "\t");
	const path = publicSnapshotPath(mapFile.path);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, json);
		return existing;
	}
	return app.vault.create(path, json);
}

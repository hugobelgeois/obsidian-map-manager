import { PublicMapSnapshot, parseMapBlockSource, publicSnapshotPath } from "../data/mapData";
import { mountPublicMapViewer } from "./mountPublicMapViewer";

declare global {
	interface Window {
		/** Prefix for a vault-root-relative `<map>.json` URL — set this (e.g. from the host site) if the default ("/") doesn't match how the site serves vault files. Not used for `./`/`../`-relative map paths (see `resolveDataUrl`). Entirely optional — this script has no Obsidian-side configuration of its own. */
		MAP_MANAGER_VIEWER_BASE_URL?: string;
	}
}

const MOUNT_CLASS = "map-manager-viewer-mount";

/** Prefixes a vault-root-relative path with `window.MAP_MANAGER_VIEWER_BASE_URL` (default `"/"`), URI-encoded. */
function resolveVaultRootUrl(vaultPath: string): string {
	const base = window.MAP_MANAGER_VIEWER_BASE_URL || "/";
	const relative = vaultPath.replace(/^\/+/, "");
	return encodeURI(base.endsWith("/") ? `${base}${relative}` : `${base}/${relative}`);
}

/**
 * The current page's own folder, as a URL always ending in `/` — i.e. the current URL with its
 * last path segment dropped, whether or not that segment already had a trailing slash. Resolving
 * against `location.href` directly (`new URL(rel, location.href)`) would instead depend on the
 * site's routing style: a trailing-slash route (`/dossier/note/`, common with static site
 * generators) has no "filename" segment for the URL algorithm to strip, so `./Test.json` would
 * land one level too deep (`/dossier/note/Test.json`) instead of next to the note
 * (`/dossier/Test.json`). Stripping the last segment ourselves first makes `./`/`../` resolution
 * behave the same regardless of that trailing slash.
 */
function currentPageFolderUrl(): URL {
	const path = window.location.pathname.replace(/\/+$/, "");
	const idx = path.lastIndexOf("/");
	const folder = idx >= 0 ? path.slice(0, idx + 1) : "/";
	return new URL(folder, window.location.origin);
}

/**
 * `./Test.map` / `../Sibling/Test.map` are resolved relative to the *current note's own folder*
 * (see `currentPageFolderUrl`) — this assumes the site's URL structure mirrors the vault's folder
 * structure (confirmed for this site-export plugin), so "the note's folder" and "the page's
 * folder" are the same thing. Anything else (a bare filename, a `Folder/Test.map` path, or a
 * `[[wikilink]]`) is treated as vault-root-relative, matching how the in-Obsidian ` ```map``` `
 * embed resolves a non-bracketed path (`app.vault.getAbstractFileByPath`) — prefixed with
 * `window.MAP_MANAGER_VIEWER_BASE_URL`.
 */
function resolveDataUrl(mapPath: string): string {
	const jsonPath = publicSnapshotPath(mapPath);
	if (jsonPath.startsWith("./") || jsonPath.startsWith("../")) {
		return new URL(jsonPath, currentPageFolderUrl()).toString();
	}
	return resolveVaultRootUrl(jsonPath);
}

async function mountBlock(codeEl: Element): Promise<void> {
	const mapPath = parseMapBlockSource(codeEl.textContent ?? "");
	const host = codeEl.closest("pre") ?? codeEl;
	const container = document.createElement("div");
	container.className = MOUNT_CLASS;
	container.style.minHeight = "480px";
	host.replaceWith(container);

	if (!mapPath) {
		container.textContent = "Bloc de carte vide.";
		return;
	}
	try {
		const res = await fetch(resolveDataUrl(mapPath));
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const snapshot = (await res.json()) as PublicMapSnapshot;
		// Background/token image paths are already site-root-absolute (see `rewriteAssetPathsForSite`,
		// run at export time) — `mountPublicMapViewer`'s default asset resolution just works.
		mountPublicMapViewer(container, snapshot);
	} catch (e) {
		container.textContent = `Carte introuvable : ${mapPath}`;
		console.error("Map Manager viewer:", e);
	}
}

/**
 * Entry point matching the site's generic "Custom scripts" convention (a default-exported
 * function, called with no arguments once the page has mounted client-side): finds every
 * ` ```map``` ` code block rendered on the current page (passed through as-is by the markdown
 * pipeline, same syntax as the Obsidian embed) and replaces it with a mounted read-only viewer,
 * fetching that map's `<basename>.json` (see `publishPublicSnapshot`). Safe to call more than
 * once — a mounted block's `<pre>` is replaced, so it won't be matched again.
 */
export default function mountAllMapBlocks(): void {
	const blocks = document.querySelectorAll('code[class^="language-map"]');
	for (const block of Array.from(blocks)) {
		void mountBlock(block);
	}
}

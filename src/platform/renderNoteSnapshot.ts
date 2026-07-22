import { App, Component, FileSystemAdapter, MarkdownRenderer, TFile, resolveSubpath } from "obsidian";
import { CELLED_GRID_TYPES, MapFileData, PublicMapSnapshot, PublicTokenStat, TokenTemplate, ZoneType, splitLink } from "../data/mapData";
import { toSiteAssetPath } from "../data/publicAssetPaths";
import { formatFrontmatterValue, stripFrontmatter } from "../data/noteFormatting";

/** Every link reachable from a (already-redacted) map's surviving cells/markers/tokens. */
function collectLinks(data: MapFileData): Set<string> {
	const links = new Set<string>();
	for (const layer of data.layers) {
		for (const gridType of CELLED_GRID_TYPES) {
			for (const cell of Object.values(layer.cellsByGridType[gridType])) {
				for (const link of cell.links ?? []) links.add(link);
			}
		}
		for (const marker of layer.markers) {
			for (const link of marker.links ?? []) links.add(link);
		}
	}
	for (const token of data.tokens) {
		if (token.link) links.add(token.link);
	}
	return links;
}

/** Un-navigable version of Obsidian's rendered internal/external links — keeps the text, drops the ability to click through. */
function neutralizeLinks(container: HTMLElement): void {
	for (const anchor of Array.from(container.querySelectorAll("a"))) {
		const span = document.createElement("span");
		span.className = anchor.className.replace(/\b(internal-link|external-link)\b/g, "").trim();
		while (anchor.firstChild) span.appendChild(anchor.firstChild);
		anchor.replaceWith(span);
	}
}

/**
 * Defense in depth for content baked into a JSON file that ends up on a public website: a note's
 * Markdown can embed raw HTML (Obsidian renders it verbatim), so before freezing this container's
 * `innerHTML` into the export, strip anything that could execute in a visitor's browser — script/
 * style/embed-like elements, inline event handlers, and `javascript:` URLs.
 */
function sanitizeRenderedNote(container: HTMLElement): void {
	for (const el of Array.from(container.querySelectorAll("script, style, iframe, object, embed"))) el.remove();
	for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
		for (const attr of Array.from(el.attributes)) {
			const isEventHandler = attr.name.toLowerCase().startsWith("on");
			const isJsUrl = (attr.name === "href" || attr.name === "src") && /^\s*javascript:/i.test(attr.value);
			if (isEventHandler || isJsUrl) el.removeAttribute(attr.name);
		}
	}
}

/**
 * Turns a resolved `app://<token>/<absolute-fs-path>?<cache-bust>` resource URL (what every local
 * image/audio/video embed ends up with post-render, wikilink or plain `![]()` alike — both go
 * through `adapter.getResourcePath`, so there's no `.internal-embed` wrapper to rely on for plain
 * markdown images) back into a vault-relative path, by stripping the vault's own absolute base path
 * off the front. `null` if `src` isn't a local resource URL or doesn't fall under the vault.
 */
function vaultRelativePathFromResourceUrl(app: App, src: string): string | null {
	if (!src.startsWith("app://")) return null;
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) return null;
	let filePath: string;
	try {
		filePath = decodeURIComponent(new URL(src).pathname);
	} catch {
		return null;
	}
	if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
	const basePath = adapter.getBasePath().replace(/\\/g, "/");
	const normalized = filePath.replace(/\\/g, "/");
	if (!normalized.toLowerCase().startsWith(basePath.toLowerCase())) return null;
	return normalized.slice(basePath.length).replace(/^\//, "");
}

/**
 * Local image/audio/video embeds render as `<img src="app://...">` — a resource URL only valid
 * inside this Obsidian instance — so rewrite every such `src` to the same site-root-absolute path
 * used for backgrounds/tokens (`toSiteAssetPath`) before freezing the note's HTML into the export.
 */
function rewriteEmbeddedMedia(app: App, container: HTMLElement): void {
	for (const media of Array.from(
		container.querySelectorAll<HTMLImageElement | HTMLVideoElement | HTMLAudioElement | HTMLSourceElement>("img, video, audio, source")
	)) {
		const rel = vaultRelativePathFromResourceUrl(app, media.src);
		if (rel) media.src = toSiteAssetPath(rel);
	}
}

/** Resolves + renders one note link (with optional `#subpath`) to static, link-neutralized HTML. `null` if the note/section can't be found. */
async function renderNoteHtml(app: App, link: string): Promise<string | null> {
	const { path, subpath } = splitLink(link);
	const file = app.metadataCache.getFirstLinkpathDest(path, "") ?? app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return null;

	const raw = await app.vault.cachedRead(file);
	let markdown = stripFrontmatter(raw);
	if (subpath) {
		const cache = app.metadataCache.getFileCache(file);
		const result = cache ? resolveSubpath(cache, `#${subpath}`) : null;
		if (!result) return null;
		markdown = raw.slice(result.start.offset, result.end ? result.end.offset : raw.length);
	}

	const container = document.createElement("div");
	// Obsidian's standard class for rendered-markdown content (embeds, popovers, etc.) — kept on the
	// exported HTML itself (outerHTML, not just innerHTML) so the site-export plugin's own note
	// styling — which already targets this class for every other exported note — picks this up
	// too, instead of only our own approximate stylesheet (see publicViewerStyles.ts).
	container.className = "markdown-rendered";
	const component = new Component();
	component.load();
	try {
		await MarkdownRenderer.render(app, markdown, container, file.path, component);
	} finally {
		component.unload();
	}
	rewriteEmbeddedMedia(app, container);
	neutralizeLinks(container);
	sanitizeRenderedNote(container);
	return container.outerHTML;
}

/** Same resolution `InfoPanel.renderTokenStats` uses, frozen into plain values for a token with no vault access. */
function resolveTokenStats(app: App, data: MapFileData, tokenTemplates: TokenTemplate[]): Record<string, PublicTokenStat[]> {
	const stats: Record<string, PublicTokenStat[]> = {};
	for (const token of data.tokens) {
		if (!token.templateId) continue;
		const template = tokenTemplates.find((t) => t.id === token.templateId);
		if (!template || template.fields.length === 0) continue;

		let frontmatter: Record<string, unknown> | undefined;
		if (token.link) {
			const { path } = splitLink(token.link);
			const file = app.metadataCache.getFirstLinkpathDest(path, "") ?? app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		}
		stats[token.id] = template.fields.map((field) => ({ field, value: formatFrontmatterValue(frontmatter?.[field]) }));
	}
	return stats;
}

/**
 * Bakes every linked note's rendered content and every pion's stat-block values that survive
 * redaction into a `PublicMapSnapshot`, so the exported viewer never needs vault/metadataCache/
 * plugin-settings access. `redactedMap` must already have hidden content stripped — see
 * `buildPublicSnapshot`. `zoneTypes`/`tokenTemplates` come from live plugin settings (read once,
 * at publish time — see `PublicMapSnapshot`), since they're no longer part of `MapFileData` itself.
 */
export async function renderNoteSnapshot(
	app: App,
	redactedMap: MapFileData,
	zoneTypes: ZoneType[],
	tokenTemplates: TokenTemplate[]
): Promise<PublicMapSnapshot> {
	const notes: PublicMapSnapshot["notes"] = {};
	for (const link of collectLinks(redactedMap)) {
		const html = await renderNoteHtml(app, link);
		if (html !== null) notes[link] = { html };
	}
	return { map: redactedMap, notes, tokenStats: resolveTokenStats(app, redactedMap, tokenTemplates), zoneTypes };
}

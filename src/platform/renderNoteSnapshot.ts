import { App, Component, MarkdownRenderer, TFile, resolveSubpath } from "obsidian";
import { CELLED_GRID_TYPES, MapFileData, PublicMapSnapshot, PublicTokenStat, splitLink } from "../data/mapData";
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
	const component = new Component();
	component.load();
	try {
		await MarkdownRenderer.render(app, markdown, container, file.path, component);
	} finally {
		component.unload();
	}
	neutralizeLinks(container);
	sanitizeRenderedNote(container);
	return container.innerHTML;
}

/** Same resolution `InfoPanel.renderTokenStats` uses, frozen into plain values for a token with no vault access. */
function resolveTokenStats(app: App, data: MapFileData): Record<string, PublicTokenStat[]> {
	const stats: Record<string, PublicTokenStat[]> = {};
	for (const token of data.tokens) {
		if (!token.templateId) continue;
		const template = data.tokenTemplates.find((t) => t.id === token.templateId);
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
 * redaction into a `PublicMapSnapshot`, so the exported viewer never needs vault/metadataCache
 * access. `redactedMap` must already have hidden content stripped — see `buildPublicSnapshot`.
 */
export async function renderNoteSnapshot(app: App, redactedMap: MapFileData): Promise<PublicMapSnapshot> {
	const notes: PublicMapSnapshot["notes"] = {};
	for (const link of collectLinks(redactedMap)) {
		const html = await renderNoteHtml(app, link);
		if (html !== null) notes[link] = { html };
	}
	return { map: redactedMap, notes, tokenStats: resolveTokenStats(app, redactedMap) };
}

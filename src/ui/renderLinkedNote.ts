import { App, Component, MarkdownRenderer, TFile, resolveSubpath } from "obsidian";
import { splitLink } from "../data/mapData";
import { stripFrontmatter } from "../data/noteFormatting";

/**
 * Renders the vault note (or just the linked heading's section) at `link` (`path` or `path#heading`)
 * as read-only Markdown into `container`, wiring internal-link clicks to `openLinkText`. `component`
 * owns the render's lifecycle — the caller loads it and unloads it to tear the render down. Shared by
 * `InfoPanel`'s linked-note tabs and the gamepad `open-note` action sidebar (`MapCanvas`).
 */
export async function renderLinkedNote(app: App, container: HTMLElement, link: string, component: Component): Promise<void> {
	container.addClass("markdown-rendered");
	const { path, subpath } = splitLink(link);
	if (!path) {
		container.createDiv({ text: "Aucune note liée à cette action.", cls: "map-manager-view-error" });
		return;
	}
	const file = app.metadataCache.getFirstLinkpathDest(path, "") ?? app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		container.createDiv({ text: `Note introuvable : ${path}`, cls: "map-manager-view-error" });
		return;
	}

	const raw = await app.vault.cachedRead(file);
	let markdown = stripFrontmatter(raw);
	if (subpath) {
		const cache = app.metadataCache.getFileCache(file);
		const result = cache ? resolveSubpath(cache, `#${subpath}`) : null;
		if (result) {
			markdown = raw.slice(result.start.offset, result.end ? result.end.offset : raw.length);
		} else {
			container.createDiv({ text: `Section introuvable : ${subpath}`, cls: "map-manager-view-error" });
		}
	}

	await MarkdownRenderer.render(app, markdown, container, file.path, component);

	// MarkdownRenderer.render doesn't wire up navigation on its own outside a real leaf/view, so a link
	// inside the rendered note's own body needs explicit handling.
	container.addEventListener("click", (evt) => {
		const anchor = (evt.target as HTMLElement).closest("a.internal-link");
		if (!anchor) return;
		evt.preventDefault();
		const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
		if (href) void app.workspace.openLinkText(href, file.path, evt.ctrlKey || evt.metaKey);
	});
}

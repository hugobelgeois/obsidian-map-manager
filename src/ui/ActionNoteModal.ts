import { App, Component, MarkdownRenderer, Modal, TFile, resolveSubpath } from "obsidian";
import { splitLink } from "../data/mapData";
import { stripFrontmatter } from "../data/noteFormatting";

/**
 * Read-only popup shown by a `GamepadAction` whose effect is `{ kind: "open-note" }` — see
 * `MapCanvas.executeActionOption`. Renders the linked vault note (or just the linked heading's
 * section) as Markdown, same resolution as `InfoPanel.renderLinkContent`. No controls beyond the
 * modal's own close button.
 *
 * Known limitation: opens on the window that owns the source `MapCanvas` (the GM's), not on a
 * player-mirror popout.
 */
export class ActionNoteModal extends Modal {
	private component = new Component();

	constructor(app: App, private titleText: string, private link: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("map-manager-action-note-modal");
		contentEl.createEl("h2", { text: this.titleText });
		const body = contentEl.createDiv({ cls: "map-manager-action-note-body markdown-rendered" });
		void this.renderNote(body);
	}

	private async renderNote(container: HTMLElement): Promise<void> {
		const { path, subpath } = splitLink(this.link);
		if (!path) {
			container.createDiv({ text: "Aucune note liée à cette action.", cls: "map-manager-view-error" });
			return;
		}
		const file = this.app.metadataCache.getFirstLinkpathDest(path, "") ?? this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			container.createDiv({ text: `Note introuvable : ${path}`, cls: "map-manager-view-error" });
			return;
		}

		const raw = await this.app.vault.cachedRead(file);
		let markdown = stripFrontmatter(raw);
		if (subpath) {
			const cache = this.app.metadataCache.getFileCache(file);
			const result = cache ? resolveSubpath(cache, `#${subpath}`) : null;
			if (result) {
				markdown = raw.slice(result.start.offset, result.end ? result.end.offset : raw.length);
			} else {
				container.createDiv({ text: `Section introuvable : ${subpath}`, cls: "map-manager-view-error" });
			}
		}

		this.component.load();
		await MarkdownRenderer.render(this.app, markdown, container, file.path, this.component);

		container.addEventListener("click", (evt) => {
			const anchor = (evt.target as HTMLElement).closest("a.internal-link");
			if (!anchor) return;
			evt.preventDefault();
			const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
			if (href) void this.app.workspace.openLinkText(href, file.path, evt.ctrlKey || evt.metaKey);
		});
	}

	onClose(): void {
		this.component.unload();
		this.contentEl.empty();
	}
}

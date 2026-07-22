import { CellData, MapFileData, Marker, TOKEN_SIZES, Token, getTokenTabs, linkTabLabel } from "../data/mapData";
import { PublicViewController } from "./PublicViewController";

function findCell(data: MapFileData, key: string): CellData | undefined {
	if (data.gridType === "none") return undefined;
	for (let i = data.layers.length - 1; i >= 0; i--) {
		const layer = data.layers[i];
		const cell = layer?.cellsByGridType[data.gridType][key];
		if (cell) return cell;
	}
	return undefined;
}

function findMarker(data: MapFileData, id: string): Marker | undefined {
	for (const layer of data.layers) {
		const marker = layer.markers.find((m) => m.id === id);
		if (marker) return marker;
	}
	return undefined;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/**
 * Read-only counterpart to `InfoPanel`: shows a selected case/pion/tampon's stamp, label, linked
 * notes (already rendered to static, link-neutralized HTML by `renderNoteSnapshot` — never fetched
 * or navigated here) and a pion's stat-block. Zero Obsidian dependency, plain DOM only.
 */
export class PublicInfoPanel {
	el: HTMLElement;
	private unsubscribe: () => void;
	private activeLinkIndex = 0;
	private activeTokenTabId: string | null = null;
	private lastSelectionKey: string | null = null;

	constructor(container: HTMLElement, private controller: PublicViewController) {
		this.el = el("div", "map-manager-infopanel map-manager-public-infopanel");
		container.appendChild(this.el);
		this.render();
		this.unsubscribe = controller.onChange(() => this.render());
	}

	destroy(): void {
		this.unsubscribe();
		this.el.remove();
	}

	private render(): void {
		this.el.replaceChildren();
		const selection = this.controller.selected;
		if (!selection) {
			this.el.classList.remove("is-open");
			this.el.appendChild(el("div", "map-manager-infopanel-empty", "Cliquez sur une case ou un pion pour voir ses informations."));
			return;
		}
		this.el.classList.add("is-open");

		const selectionKey = JSON.stringify(selection);
		if (this.lastSelectionKey !== selectionKey) {
			this.activeLinkIndex = 0;
			this.activeTokenTabId = null;
			this.lastSelectionKey = selectionKey;
		}

		const data = this.controller.snapshot.map;
		if (selection.type === "token") {
			const token = data.tokens.find((t) => t.id === selection.id);
			if (!token) return;
			this.renderHeader("Pion");
			this.renderToken(token);
			return;
		}
		if (selection.type === "marker") {
			const marker = findMarker(data, selection.id);
			if (!marker) return;
			this.renderHeader("Tampon");
			this.renderSummaryAndLinks(marker.stamp, marker.label, marker.links);
			return;
		}
		const cell = findCell(data, selection.key);
		this.renderHeader(`Case ${selection.key}`);
		this.renderSummaryAndLinks(cell?.stamp, cell?.label, cell?.links);
	}

	private renderHeader(title: string): void {
		const header = el("div", "map-manager-infopanel-header");
		header.appendChild(el("h4", undefined, title));
		const closeBtn = el("button", "map-manager-btn map-manager-btn-icon", "✕") as HTMLButtonElement;
		closeBtn.onclick = () => this.controller.select(null);
		header.appendChild(closeBtn);
		this.el.appendChild(header);
	}

	private renderSummaryAndLinks(stamp: string | undefined, label: string | undefined, links: string[] | undefined): void {
		const summary = el("div", "map-manager-view-summary");
		if (stamp) summary.appendChild(el("span", "map-manager-view-stamp", stamp));
		if (label) summary.appendChild(el("span", "map-manager-view-label", label));
		if (!stamp && !label) summary.textContent = "Aucune information sur cette case.";
		this.el.appendChild(summary);

		this.renderLinks(links ?? []);
	}

	private renderLinks(links: string[]): void {
		if (links.length === 0) {
			this.el.appendChild(el("div", "map-manager-view-empty", "Aucune note liée à cette case."));
			return;
		}
		if (this.activeLinkIndex >= links.length) this.activeLinkIndex = 0;

		const tabs = el("div", "map-manager-view-tabs");
		links.forEach((link, i) => {
			const tab = el("button", "map-manager-tab", linkTabLabel(link)) as HTMLButtonElement;
			if (i === this.activeLinkIndex) tab.classList.add("is-active");
			tab.onclick = () => {
				this.activeLinkIndex = i;
				this.render();
			};
			tabs.appendChild(tab);
		});
		this.el.appendChild(tabs);

		const activeLink = links[this.activeLinkIndex];
		const content = el("div", "map-manager-view-content");
		const html = activeLink ? this.controller.snapshot.notes[activeLink]?.html : undefined;
		// eslint-disable-next-line @microsoft/sdl/no-inner-html -- pre-rendered and sanitized by renderNoteSnapshot.ts before export; nothing user-controlled reaches this assignment.
		if (html !== undefined) content.innerHTML = html;
		else content.appendChild(el("div", "map-manager-view-error", `Note introuvable : ${activeLink ?? ""}`));
		this.el.appendChild(content);
	}

	private renderToken(token: Token): void {
		const icon = el("div", "map-manager-view-summary");
		icon.appendChild(el("span", "map-manager-view-stamp", token.icon));
		if (token.label) icon.appendChild(el("span", "map-manager-view-label", token.label));
		this.el.appendChild(icon);

		const meta = el("div", "map-manager-field");
		const size = TOKEN_SIZES.includes(token.size ?? 1) ? (token.size ?? 1) : 1;
		meta.textContent = `${(token.category ?? "entity") === "player" ? "Joueur" : "Entité"} — ${size}×${size} case${size > 1 ? "s" : ""}`;
		this.el.appendChild(meta);

		this.renderTokenTabs(token);
	}

	private renderTokenStatsTable(stats: { field: string; value: string }[] | undefined): void {
		if (!stats || stats.length === 0) return;
		const table = el("div", "map-manager-token-stats");
		for (const stat of stats) {
			const row = el("div", "map-manager-token-stat-row");
			row.appendChild(el("span", "map-manager-token-stat-key", stat.field));
			row.appendChild(el("span", "map-manager-token-stat-value", stat.value));
			table.appendChild(row);
		}
		this.el.appendChild(table);
	}

	/**
	 * A token's Statistiques/Inventaire/Histoire (or customized) tabs, any category — read-only
	 * counterpart to `InfoPanel.renderTokenTabsReadOnly`. `token.tabs` is always concrete by the
	 * time it reaches this snapshot — `renderNoteSnapshot.materializeTokenTabs` resolves the
	 * template-based defaults at publish time, so no template lookup (the second `getTokenTabs`
	 * argument) is ever needed here — the exported site has no plugin settings to read one from.
	 */
	private renderTokenTabs(token: Token): void {
		const tabs = getTokenTabs(token, []);
		if (tabs.length === 0) return;
		if (!tabs.some((t) => t.id === this.activeTokenTabId)) this.activeTokenTabId = tabs[0]?.id ?? null;
		const activeTab = tabs.find((t) => t.id === this.activeTokenTabId) ?? tabs[0];
		if (!activeTab) return;

		// The stats table stays visible no matter which tab is active — it's the character's
		// vitals, not tab-specific content.
		this.renderTokenStatsTable(this.controller.snapshot.tokenStats[token.id]);

		const tabBar = el("div", "map-manager-view-tabs");
		for (const tab of tabs) {
			const btn = el("button", "map-manager-tab", tab.name) as HTMLButtonElement;
			if (tab.id === activeTab.id) btn.classList.add("is-active");
			btn.onclick = () => {
				this.activeTokenTabId = tab.id;
				this.render();
			};
			tabBar.appendChild(btn);
		}
		this.el.appendChild(tabBar);

		const content = el("div", "map-manager-view-content");
		const html = activeTab.link ? this.controller.snapshot.notes[activeTab.link]?.html : undefined;
		// eslint-disable-next-line @microsoft/sdl/no-inner-html -- pre-rendered and sanitized by renderNoteSnapshot.ts before export; nothing user-controlled reaches this assignment.
		if (html !== undefined) content.innerHTML = html;
		else content.appendChild(el("div", "map-manager-view-empty", "Aucune note liée à cet onglet."));
		this.el.appendChild(content);
	}
}

import { App, Component, MarkdownRenderer, TFile, resolveSubpath } from "obsidian";
import { MapController } from "../controller/MapController";
import {
	CellData,
	DEFAULT_TOKEN_COLOR,
	DEFAULT_VISION_ANGLE,
	DEFAULT_VISION_DIRECTION,
	DEFAULT_VISION_RADIUS,
	DEFAULT_VISION_RANGE,
	Marker,
	TOKEN_SIZES,
	Token,
	TokenTemplate,
	makeLink,
	splitLink,
} from "../data/mapData";
import { ensureFolder, sanitizeFileName } from "../utils";
import { FileSuggestModal, IMAGE_EXTENSIONS } from "./FileSuggestModal";
import { HeadingSuggestModal } from "./HeadingSuggestModal";

export interface InfoPanelDeps {
	assetsFolder: string;
}

const QUICK_STAMPS = ["⚔️", "🏰", "💰", "🐉", "🌲", "⛰️", "🌊", "🔥", "⭐", "📍", "💀", "🏠"];
const QUICK_TOKEN_ICONS = [
	"🧑",
	"👤",
	"🧍",
	"🚶",
	"🥷",
	"💂",
	"🧝",
	"🧙",
	"🧛",
	"🧟",
	"🗡️",
	"🛡️",
	"🏹",
	"🐺",
	"👹",
	"👑",
	"💀",
	"🐎",
	"❤️",
];

function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function linkTabLabel(link: string): string {
	const { path, subpath } = splitLink(link);
	const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
	return subpath ? `${basename} › ${subpath}` : basename;
}

function formatFrontmatterValue(value: unknown): string {
	if (value === undefined || value === null) return "—";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(formatFrontmatterValue).join(", ");
	return JSON.stringify(value);
}

export class InfoPanel {
	el: HTMLElement;
	private unsubscribe: () => void;
	private renderComponents: Component[] = [];
	private activeLinkIndex = 0;
	private lastRenderedKey: string | null = null;
	/**
	 * While a slider (or its paired number input) is being dragged/typed into, we still push
	 * every intermediate value to the controller (so the map updates live), but we must NOT
	 * rebuild this panel's DOM in response — that would destroy the very input the user has
	 * mid-gesture and the browser drops the drag right where it was.
	 */
	private suppressRerender = false;

	constructor(container: HTMLElement, private app: App, private deps: InfoPanelDeps, private controller: MapController) {
		this.el = container.createDiv({ cls: "map-manager-infopanel" });
		this.render();
		this.unsubscribe = this.controller.onChange(() => {
			if (this.suppressRerender) return;
			this.render();
		});
	}

	destroy(): void {
		this.unsubscribe();
		this.clearRenderComponents();
	}

	private clearRenderComponents(): void {
		for (const c of this.renderComponents) c.unload();
		this.renderComponents = [];
	}

	private render(): void {
		this.clearRenderComponents();
		this.el.empty();

		if (this.controller.selectedTokenId) {
			const found = this.controller.findToken(this.controller.selectedTokenId);
			if (found) {
				this.el.addClass("is-open");
				const header = this.el.createDiv({ cls: "map-manager-infopanel-header" });
				header.createEl("h4", { text: "Pion" });
				const closeBtn = header.createEl("button", { text: "✕", cls: "map-manager-btn map-manager-btn-icon" });
				closeBtn.onclick = () => this.controller.selectToken(null);

				this.renderTokenPanel(found);
				return;
			}
		}

		if (this.controller.selectedMarkerId) {
			const found = this.controller.findMarker(this.controller.selectedMarkerId);
			if (found) {
				this.el.addClass("is-open");
				const header = this.el.createDiv({ cls: "map-manager-infopanel-header" });
				header.createEl("h4", { text: "Tampon" });
				const closeBtn = header.createEl("button", { text: "✕", cls: "map-manager-btn map-manager-btn-icon" });
				closeBtn.onclick = () => this.controller.selectMarker(null);

				if (this.controller.mode === "edit") {
					this.renderMarkerEditPanel(found);
				} else {
					this.renderViewMode({ stamp: found.stamp, label: found.label, links: found.links });
				}
				return;
			}
		}

		const key = this.controller.selectedCellKey;
		const data = this.controller.getData();
		if (!key || data.gridType === "none") {
			this.el.removeClass("is-open");
			this.el.createDiv({ cls: "map-manager-infopanel-empty", text: "Cliquez sur une case ou un pion pour voir ou modifier ses informations." });
			return;
		}
		this.el.addClass("is-open");
		if (this.lastRenderedKey !== key) {
			this.activeLinkIndex = 0;
			this.lastRenderedKey = key;
		}

		const cell: CellData = this.controller.getActiveLayer().cellsByGridType[data.gridType][key] ?? {};

		const header = this.el.createDiv({ cls: "map-manager-infopanel-header" });
		header.createEl("h4", { text: `Case ${key}` });
		const closeBtn = header.createEl("button", { text: "✕", cls: "map-manager-btn map-manager-btn-icon" });
		closeBtn.onclick = () => this.controller.selectCell(null);

		if (this.controller.mode === "edit") {
			this.renderEditMode(key, cell, data.zoneTypes);
		} else {
			this.renderViewMode(cell);
		}
	}

	// ---- Cells ----

	private renderEditMode(key: string, cell: CellData, zoneTypes: { id: string; name: string }[]): void {
		// Zone type
		const zoneField = this.el.createDiv({ cls: "map-manager-field" });
		zoneField.createEl("label", { text: "Type de zone" });
		const select = zoneField.createEl("select");
		const noneOpt = select.createEl("option", { text: "— aucun —" });
		noneOpt.value = "";
		for (const z of zoneTypes) {
			const opt = select.createEl("option", { text: z.name });
			opt.value = z.id;
			if (cell.zoneTypeId === z.id) opt.selected = true;
		}
		select.onchange = () => this.updateCell(key, (c) => (c.zoneTypeId = select.value || undefined));

		// Vision blocker
		const blockerField = this.el.createDiv({ cls: "map-manager-field" });
		blockerField.createEl("label", { text: "Bloc visuel (brouillard de guerre)" });
		const blockerSelect = blockerField.createEl("select");
		const noneBlockerOpt = blockerSelect.createEl("option", { text: "Aucun" });
		noneBlockerOpt.value = "";
		const opaqueOpt = blockerSelect.createEl("option", { text: "Opaque (cache tout au-delà)" });
		opaqueOpt.value = "opaque";
		const dimOpt = blockerSelect.createEl("option", { text: "Partiel (visible en mode exploré)" });
		dimOpt.value = "dim";
		blockerSelect.value = cell.visionBlocker ?? "";
		blockerSelect.onchange = () =>
			this.updateCell(key, (c) => (c.visionBlocker = blockerSelect.value === "opaque" || blockerSelect.value === "dim" ? blockerSelect.value : undefined));

		// Stamp
		const stampField = this.el.createDiv({ cls: "map-manager-field" });
		stampField.createEl("label", { text: "Tampon" });
		const quickRow = stampField.createDiv({ cls: "map-manager-stamp-row" });
		for (const s of QUICK_STAMPS) {
			const btn = quickRow.createEl("button", { text: s, cls: "map-manager-stamp-btn" });
			if (cell.stamp === s) btn.addClass("is-active");
			btn.onclick = () => this.updateCell(key, (c) => (c.stamp = cell.stamp === s ? undefined : s));
		}

		// Label (displayed under the stamp on the map)
		const labelField = this.el.createDiv({ cls: "map-manager-field" });
		labelField.createEl("label", { text: "Nom (affiché sous le tampon)" });
		const labelInput = labelField.createEl("input", { type: "text" });
		labelInput.value = cell.label ?? "";
		labelInput.placeholder = "Nom court affiché sur la carte";
		labelInput.onchange = () => this.updateCell(key, (c) => (c.label = labelInput.value || undefined));

		// Links
		const linksField = this.el.createDiv({ cls: "map-manager-field" });
		linksField.createEl("label", { text: "Liens vers des notes" });
		const list = linksField.createDiv({ cls: "map-manager-links-list" });
		for (const link of cell.links ?? []) {
			const pill = list.createDiv({ cls: "map-manager-link-pill" });
			const a = pill.createEl("a", { text: linkTabLabel(link), href: "#" });
			a.onclick = (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(link, "", false);
			};
			const remove = pill.createEl("span", { text: "×", cls: "map-manager-link-remove" });
			remove.onclick = () => this.updateCell(key, (c) => (c.links = (c.links ?? []).filter((l) => l !== link)));
		}
		const addLinkBtn = linksField.createEl("button", { text: "Ajouter un lien", cls: "map-manager-btn" });
		addLinkBtn.onclick = () => this.pickLink((link) => this.updateCell(key, (c) => (c.links = [...(c.links ?? []), link])));

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const clearBtn = footer.createEl("button", { text: "Vider la case", cls: "map-manager-btn map-manager-btn-danger" });
		clearBtn.onclick = () =>
			this.updateCell(key, (c) => {
				c.zoneTypeId = undefined;
				c.stamp = undefined;
				c.label = undefined;
				c.links = undefined;
				c.visionBlocker = undefined;
			});
	}

	private renderViewMode(cell: CellData): void {
		const summary = this.el.createDiv({ cls: "map-manager-view-summary" });
		if (cell.stamp) summary.createSpan({ text: cell.stamp, cls: "map-manager-view-stamp" });
		if (cell.label) summary.createSpan({ text: cell.label, cls: "map-manager-view-label" });
		if (!cell.stamp && !cell.label) summary.setText("Aucune information sur cette case.");

		const links = cell.links ?? [];
		if (links.length === 0) {
			this.el.createDiv({ cls: "map-manager-view-empty", text: "Aucune note liée à cette case." });
			return;
		}

		if (this.activeLinkIndex >= links.length) this.activeLinkIndex = 0;

		const tabs = this.el.createDiv({ cls: "map-manager-view-tabs" });
		links.forEach((link, i) => {
			const tab = tabs.createEl("button", { text: linkTabLabel(link), cls: "map-manager-tab" });
			if (i === this.activeLinkIndex) tab.addClass("is-active");
			tab.onclick = () => {
				this.activeLinkIndex = i;
				this.render();
			};
		});

		const contentEl = this.el.createDiv({ cls: "map-manager-view-content" });
		const activeLink = links[this.activeLinkIndex];
		if (activeLink) void this.renderLinkContent(activeLink, contentEl);
	}

	private updateCell(key: string, mutator: (cell: CellData) => void): void {
		this.controller.updateCell(key, mutator);
	}

	// ---- Markers (free-floating stamps, grid type "none", edit mode only) ----

	private renderMarkerEditPanel(marker: Marker): void {
		const stampField = this.el.createDiv({ cls: "map-manager-field" });
		stampField.createEl("label", { text: "Tampon" });
		const quickRow = stampField.createDiv({ cls: "map-manager-stamp-row" });
		for (const s of QUICK_STAMPS) {
			const btn = quickRow.createEl("button", { text: s, cls: "map-manager-stamp-btn" });
			if (marker.stamp === s) btn.addClass("is-active");
			btn.onclick = () => this.controller.updateMarker(marker.id, (m) => (m.stamp = marker.stamp === s ? undefined : s));
		}

		const labelField = this.el.createDiv({ cls: "map-manager-field" });
		labelField.createEl("label", { text: "Nom (affiché sous le tampon)" });
		const labelInput = labelField.createEl("input", { type: "text" });
		labelInput.value = marker.label ?? "";
		labelInput.placeholder = "Nom court affiché sur la carte";
		labelInput.onchange = () => this.controller.updateMarker(marker.id, (m) => (m.label = labelInput.value || undefined));

		const linksField = this.el.createDiv({ cls: "map-manager-field" });
		linksField.createEl("label", { text: "Liens vers des notes" });
		const list = linksField.createDiv({ cls: "map-manager-links-list" });
		for (const link of marker.links ?? []) {
			const pill = list.createDiv({ cls: "map-manager-link-pill" });
			const a = pill.createEl("a", { text: linkTabLabel(link), href: "#" });
			a.onclick = (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(link, "", false);
			};
			const remove = pill.createEl("span", { text: "×", cls: "map-manager-link-remove" });
			remove.onclick = () => this.controller.updateMarker(marker.id, (m) => (m.links = (m.links ?? []).filter((l) => l !== link)));
		}
		const addLinkBtn = linksField.createEl("button", { text: "Ajouter un lien", cls: "map-manager-btn" });
		addLinkBtn.onclick = () => this.pickLink((link) => this.controller.updateMarker(marker.id, (m) => (m.links = [...(m.links ?? []), link])));

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", { text: "Supprimer le tampon", cls: "map-manager-btn map-manager-btn-danger" });
		deleteBtn.onclick = () => this.controller.removeMarker(marker.id);
	}

	// ---- Tokens (always editable, in both edit and view mode) ----

	private renderTokenPanel(token: Token): void {
		const data = this.controller.getData();

		const iconField = this.el.createDiv({ cls: "map-manager-field" });
		iconField.createEl("label", { text: "Icône" });
		const quickRow = iconField.createDiv({ cls: "map-manager-stamp-row" });
		for (const s of QUICK_TOKEN_ICONS) {
			const btn = quickRow.createEl("button", { text: s, cls: "map-manager-stamp-btn" });
			if (token.icon === s) btn.addClass("is-active");
			btn.onclick = () => this.controller.updateToken(token.id, (t) => (t.icon = token.icon === s ? "" : s));
		}

		const imageField = this.el.createDiv({ cls: "map-manager-field" });
		imageField.createEl("label", { text: "Image du pion (remplace l'icône)" });
		const chooseBtn = imageField.createEl("button", { text: "Image du vault", cls: "map-manager-btn" });
		chooseBtn.onclick = () => this.pickVaultTokenImage(token);
		const importBtn = imageField.createEl("button", { text: "Importer une image", cls: "map-manager-btn" });
		importBtn.onclick = () => this.importTokenImageFromDisk(token);
		if (token.image) {
			const clearBtn = imageField.createEl("button", { text: "Retirer l'image", cls: "map-manager-btn" });
			clearBtn.onclick = () => this.controller.updateToken(token.id, (t) => (t.image = undefined));
		}

		const nameField = this.el.createDiv({ cls: "map-manager-field" });
		nameField.createEl("label", { text: "Nom" });
		const nameInput = nameField.createEl("input", { type: "text" });
		nameInput.value = token.label ?? "";
		nameInput.placeholder = "Nom du personnage";
		nameInput.onchange = () => this.controller.updateToken(token.id, (t) => (t.label = nameInput.value || undefined));

		const category = token.category ?? "entity";
		const categoryField = this.el.createDiv({ cls: "map-manager-field" });
		categoryField.createEl("label", { text: "Catégorie" });
		const categorySelect = categoryField.createEl("select");
		const playerOpt = categorySelect.createEl("option", { text: "Joueur" });
		playerOpt.value = "player";
		const entityOpt = categorySelect.createEl("option", { text: "Entité" });
		entityOpt.value = "entity";
		categorySelect.value = category;
		categorySelect.onchange = () =>
			this.controller.updateToken(token.id, (t) => (t.category = categorySelect.value === "player" ? "player" : "entity"));

		if (category === "player") this.renderVisionFields(token);

		const sizeField = this.el.createDiv({ cls: "map-manager-field" });
		sizeField.createEl("label", { text: "Taille" });
		const sizeSelect = sizeField.createEl("select");
		for (const s of TOKEN_SIZES) {
			const opt = sizeSelect.createEl("option", { text: `${s}×${s} case${s > 1 ? "s" : ""}` });
			opt.value = String(s);
			if ((token.size ?? 1) === s) opt.selected = true;
		}
		sizeSelect.onchange = () => this.controller.updateToken(token.id, (t) => (t.size = Number(sizeSelect.value)));

		const colorField = this.el.createDiv({ cls: "map-manager-field" });
		colorField.createEl("label", { text: "Couleur du bord" });
		const colorInput = colorField.createEl("input", { type: "color" });
		colorInput.value = token.color ?? DEFAULT_TOKEN_COLOR;
		colorInput.onchange = () => this.controller.updateToken(token.id, (t) => (t.color = colorInput.value));

		const linkField = this.el.createDiv({ cls: "map-manager-field" });
		linkField.createEl("label", { text: "Note liée" });
		if (token.link) {
			const pill = linkField.createDiv({ cls: "map-manager-link-pill" });
			const a = pill.createEl("a", { text: linkTabLabel(token.link), href: "#" });
			const linkValue = token.link;
			a.onclick = (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(linkValue, "", false);
			};
			const remove = pill.createEl("span", { text: "×", cls: "map-manager-link-remove" });
			remove.onclick = () => this.controller.updateToken(token.id, (t) => (t.link = undefined));
		} else {
			const pickBtn = linkField.createEl("button", { text: "Lier une note", cls: "map-manager-btn" });
			pickBtn.onclick = () => {
				const files = this.app.vault.getMarkdownFiles();
				new FileSuggestModal(this.app, files, (file) => this.controller.updateToken(token.id, (t) => (t.link = makeLink(file.path))), "Lier une note...").open();
			};
		}

		const templateField = this.el.createDiv({ cls: "map-manager-field" });
		templateField.createEl("label", { text: "Modèle de statistiques" });
		const templateSelect = templateField.createEl("select");
		const noneOpt = templateSelect.createEl("option", { text: "— aucun —" });
		noneOpt.value = "";
		for (const t of data.tokenTemplates) {
			const opt = templateSelect.createEl("option", { text: t.name });
			opt.value = t.id;
			if (token.templateId === t.id) opt.selected = true;
		}
		templateSelect.onchange = () => this.controller.updateToken(token.id, (t) => (t.templateId = templateSelect.value || undefined));
		if (data.tokenTemplates.length === 0) {
			templateField.createDiv({ cls: "map-manager-view-empty", text: "Aucun modèle défini (Réglages du plugin)." });
		}

		this.renderTokenStats(token);
		if (token.link) {
			const contentEl = this.el.createDiv({ cls: "map-manager-view-content" });
			void this.renderLinkContent(token.link, contentEl);
		}

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", { text: "Supprimer le pion", cls: "map-manager-btn map-manager-btn-danger" });
		deleteBtn.onclick = () => this.controller.removeToken(token.id);
	}

	private pickVaultTokenImage(token: Token): void {
		const files = this.app.vault.getFiles().filter((f) => IMAGE_EXTENSIONS.includes(f.extension.toLowerCase()));
		new FileSuggestModal(
			this.app,
			files,
			(file: TFile) => this.controller.updateToken(token.id, (t) => (t.image = file.path)),
			"Choisir une image du vault..."
		).open();
	}

	private importTokenImageFromDisk(token: Token): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const buffer = await file.arrayBuffer();
			const folder = this.deps.assetsFolder || "Map Assets";
			await ensureFolder(this.app, folder);
			const path = `${folder}/${Date.now()}-${sanitizeFileName(file.name)}`;
			const created = await this.app.vault.createBinary(path, buffer);
			this.controller.updateToken(token.id, (t) => (t.image = created.path));
		};
		input.click();
	}

	private renderVisionFields(token: Token): void {
		const wrap = this.el.createDiv({ cls: "map-manager-field" });
		wrap.createEl("label", { text: "Vision (brouillard de guerre)" });
		const row = wrap.createDiv({ cls: "map-manager-vision-row" });

		const makeNumberInput = (labelText: string, value: number, onChange: (v: number) => void) => {
			const field = row.createDiv({ cls: "map-manager-field-inline" });
			field.createEl("label", { text: labelText });
			const input = field.createEl("input", { type: "number" });
			input.value = String(value);
			input.onchange = () => {
				const v = parseFloat(input.value);
				if (!Number.isNaN(v)) onChange(v);
			};
		};

		this.makeSliderField(row, "Angle (°)", token.visionAngle ?? DEFAULT_VISION_ANGLE, 1, 360, (v) =>
			this.controller.updateToken(token.id, (t) => (t.visionAngle = v))
		);
		this.makeSliderField(row, "Direction (°, 0=est, horaire)", token.visionDirection ?? DEFAULT_VISION_DIRECTION, 0, 360, (v) =>
			this.controller.updateToken(token.id, (t) => (t.visionDirection = ((v % 360) + 360) % 360))
		);
		makeNumberInput("Portée (cases)", token.visionRange ?? DEFAULT_VISION_RANGE, (v) =>
			this.controller.updateToken(token.id, (t) => (t.visionRange = Math.max(0, v)))
		);
		makeNumberInput("Rayon exploré (cases)", token.visionRadius ?? DEFAULT_VISION_RADIUS, (v) =>
			this.controller.updateToken(token.id, (t) => (t.visionRadius = Math.max(0, v)))
		);
	}

	/**
	 * A slider paired with a synced number input for typing an exact value. Intermediate drags
	 * push live updates to `onCommit` (so the map updates as you go) without ever rebuilding this
	 * panel mid-gesture — see `suppressRerender`.
	 */
	private makeSliderField(container: HTMLElement, labelText: string, value: number, min: number, max: number, onCommit: (v: number) => void): void {
		const field = container.createDiv({ cls: "map-manager-field-inline map-manager-slider-field" });
		field.createEl("label", { text: labelText });
		const slider = field.createEl("input", { type: "range", cls: "map-manager-vision-slider" });
		slider.min = String(min);
		slider.max = String(max);
		slider.value = String(value);
		const number = field.createEl("input", { type: "number", cls: "map-manager-vision-number" });
		number.min = String(min);
		number.max = String(max);
		number.value = String(value);

		// Coalesces the whole drag/typing gesture into a single undo step (see `MapController.beginHistoryGroup`).
		const beginGestureIfNeeded = () => {
			if (this.suppressRerender) return;
			this.suppressRerender = true;
			this.controller.beginHistoryGroup();
		};

		const release = () => {
			if (!this.suppressRerender) return;
			this.suppressRerender = false;
			this.controller.endHistoryGroup();
		};

		slider.oninput = () => {
			beginGestureIfNeeded();
			number.value = slider.value;
			onCommit(Number(slider.value));
		};
		slider.onchange = release;

		number.oninput = () => {
			const v = Number(number.value);
			if (Number.isNaN(v)) return;
			beginGestureIfNeeded();
			slider.value = String(Math.min(max, Math.max(min, v)));
			onCommit(v);
		};
		number.onchange = release;
	}

	private renderTokenStats(token: Token): void {
		if (!token.templateId) return;
		const data = this.controller.getData();
		const template: TokenTemplate | undefined = data.tokenTemplates.find((t) => t.id === token.templateId);
		if (!template || template.fields.length === 0) return;

		const table = this.el.createDiv({ cls: "map-manager-token-stats" });
		let frontmatter: Record<string, unknown> | undefined;
		if (token.link) {
			const { path } = splitLink(token.link);
			const file = this.app.metadataCache.getFirstLinkpathDest(path, "") ?? this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		}
		for (const field of template.fields) {
			const row = table.createDiv({ cls: "map-manager-token-stat-row" });
			row.createSpan({ text: field, cls: "map-manager-token-stat-key" });
			row.createSpan({ text: formatFrontmatterValue(frontmatter?.[field]), cls: "map-manager-token-stat-value" });
		}
	}

	// ---- Shared ----

	private pickLink(onPick: (link: string) => void): void {
		const files = this.app.vault.getMarkdownFiles();
		new FileSuggestModal(
			this.app,
			files,
			(file) => {
				const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
				if (headings.length === 0) {
					onPick(makeLink(file.path));
					return;
				}
				new HeadingSuggestModal(this.app, headings, (heading) => onPick(makeLink(file.path, heading?.heading))).open();
			},
			"Lier une note..."
		).open();
	}

	private async renderLinkContent(link: string, container: HTMLElement): Promise<void> {
		const { path, subpath } = splitLink(link);
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

		const component = new Component();
		component.load();
		this.renderComponents.push(component);
		await MarkdownRenderer.render(this.app, markdown, container, file.path, component);
	}
}

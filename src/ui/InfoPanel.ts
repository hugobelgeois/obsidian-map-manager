import { App, Component, MarkdownRenderer, TFile, resolveSubpath, setIcon, setTooltip } from "obsidian";
import { MapController } from "../controller/MapController";
import {
	CellData,
	DEFAULT_EYE_TIER_ANGLES,
	DEFAULT_SIDE_EYE_ANGLE,
	DEFAULT_TOKEN_COLOR,
	DEFAULT_TOKEN_ROTATION,
	DEFAULT_VISION_ANGLE,
	DEFAULT_VISION_RADIUS,
	DEFAULT_VISION_RANGE,
	Marker,
	TOKEN_SIZES,
	Token,
	TokenCategory,
	TokenTab,
	TokenTemplate,
	VisionBlockerType,
	findStatsTab,
	generateLocalId,
	getTokenTabs,
	linkTabLabel,
	makeLink,
	splitLink,
	tokenStatsSourceLink,
	WallSegment,
} from "../data/mapData";
import { formatFrontmatterValue, stripFrontmatter } from "../data/noteFormatting";
import { MapManagerSettings } from "../settings/types";
import { ensureFolder, sanitizeFileName } from "../utils";
import { FileSuggestModal, IMAGE_EXTENSIONS } from "./FileSuggestModal";
import { HeadingSuggestModal } from "./HeadingSuggestModal";

export interface InfoPanelDeps {
	assetsFolder: string;
	settings: MapManagerSettings;
	/** Persists a new panel width (px) after a resize-handle drag — see `MIN_PANEL_WIDTH`/`MAX_PANEL_WIDTH`. */
	onResizePanel?: (width: number) => void;
	/** Called whenever this panel scrolls — lets a player mirror's InfoPanel (see `setScrollTop`) follow along. Not a `MapController` field: pushing it through `notify()` on every scroll tick would rebuild every subscribed panel's whole DOM mid-scroll. */
	onScroll?: (scrollTop: number) => void;
}

const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 640;

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

export class InfoPanel {
	el: HTMLElement;
	private resizeHandleEl: HTMLElement;
	private unsubscribe: () => void;
	private renderComponents: Component[] = [];
	/**
	 * While a slider (or its paired number input) is being dragged/typed into, we still push
	 * every intermediate value to the controller (so the map updates live), but we must NOT
	 * rebuild this panel's DOM in response — that would destroy the very input the user has
	 * mid-gesture and the browser drops the drag right where it was.
	 */
	private suppressRerender = false;

	constructor(container: HTMLElement, private app: App, private deps: InfoPanelDeps, private controller: MapController) {
		this.resizeHandleEl = container.createDiv({ cls: "map-manager-infopanel-resize-handle" });
		this.el = container.createDiv({ cls: "map-manager-infopanel" });
		this.applyWidth();
		this.wireResizeHandle();
		this.el.addEventListener("scroll", this.onScroll);
		this.render();
		this.unsubscribe = this.controller.onChange(() => {
			if (this.suppressRerender) return;
			this.render();
		});
	}

	destroy(): void {
		this.unsubscribe();
		this.el.removeEventListener("scroll", this.onScroll);
		this.clearRenderComponents();
		this.resizeHandleEl.remove();
		this.el.remove();
	}

	private onScroll = (): void => {
		this.deps.onScroll?.(this.el.scrollTop);
	};

	/** Applied by a player mirror's InfoPanel to follow the GM's scroll — see `InfoPanelDeps.onScroll`. */
	setScrollTop(value: number): void {
		this.el.scrollTop = value;
	}

	private setOpen(open: boolean): void {
		this.el.toggleClass("is-open", open);
		this.resizeHandleEl.toggleClass("is-open", open);
	}

	private applyWidth(): void {
		const width = this.deps.settings.infoPanelWidth || 280;
		this.el.style.setProperty("--map-manager-infopanel-width", `${width}px`);
	}

	private wireResizeHandle(): void {
		this.resizeHandleEl.onpointerdown = (e: PointerEvent) => {
			e.preventDefault();
			const startX = e.clientX;
			const startWidth = this.deps.settings.infoPanelWidth || 280;
			this.resizeHandleEl.setPointerCapture(e.pointerId);

			const onMove = (moveEvent: PointerEvent) => {
				const delta = moveEvent.clientX - startX;
				const width = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidth - delta));
				this.deps.settings.infoPanelWidth = width;
				this.applyWidth();
			};
			const onUp = () => {
				this.resizeHandleEl.releasePointerCapture(e.pointerId);
				this.resizeHandleEl.removeEventListener("pointermove", onMove);
				this.resizeHandleEl.removeEventListener("pointerup", onUp);
				this.deps.onResizePanel?.(this.deps.settings.infoPanelWidth || 280);
			};
			this.resizeHandleEl.addEventListener("pointermove", onMove);
			this.resizeHandleEl.addEventListener("pointerup", onUp);
		};
	}

	private clearRenderComponents(): void {
		for (const c of this.renderComponents) c.unload();
		this.renderComponents = [];
	}

	/** Header shared by every selection type (token/marker/wall point/cell): a title, an "eye" toggle that mirrors this whole panel onto a player window (see `MapController.showInfoToPlayers`/`MapPlayerMirrorView`), and a close button. */
	private renderPanelHeader(title: string, onClose: () => void): void {
		const header = this.el.createDiv({ cls: "map-manager-infopanel-header" });
		header.createEl("h4", { text: title });
		const actions = header.createDiv({ cls: "map-manager-infopanel-header-actions" });
		const eyeBtn = actions.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
		setIcon(eyeBtn, this.controller.showInfoToPlayers ? "eye" : "eye-off");
		setTooltip(eyeBtn, this.controller.showInfoToPlayers ? "Masquer ce panneau sur la fenêtre joueur" : "Afficher ce panneau sur la fenêtre joueur");
		eyeBtn.toggleClass("is-active", this.controller.showInfoToPlayers);
		eyeBtn.onclick = () => this.controller.toggleShowInfoToPlayers();
		const closeBtn = actions.createEl("button", { text: "✕", cls: "map-manager-btn map-manager-btn-icon" });
		closeBtn.onclick = onClose;
	}

	private render(): void {
		this.applyWidth();
		this.clearRenderComponents();
		this.el.empty();

		// The "select" tool's mass-edit panel always wins over any stale single-selection while the
		// tool is active — even for a selection of exactly one object, kept simple as one dedicated
		// bulk panel rather than merging with the full single-item editors below.
		if (this.controller.activeTool === "select" && this.controller.massSelectionKind) {
			this.renderMassSelectionPanel();
			return;
		}

		if (this.controller.selectedTokenId) {
			const found = this.controller.findToken(this.controller.selectedTokenId);
			if (found) {
				this.setOpen(true);
				this.renderPanelHeader("Pion", () => this.controller.selectToken(null));

				this.renderTokenPanel(found);
				return;
			}
		}

		if (this.controller.selectedMarkerId) {
			const found = this.controller.findMarker(this.controller.selectedMarkerId);
			if (found) {
				this.setOpen(true);
				this.renderPanelHeader("Tampon", () => this.controller.selectMarker(null));

				if (this.controller.mode === "edit") {
					this.renderMarkerEditPanel(found);
				} else {
					this.renderViewMode({ stamp: found.stamp, label: found.label, links: found.links });
				}
				return;
			}
		}

		if (this.controller.selectedWallPointId) {
			const found = this.controller.findWallPoint(this.controller.selectedWallPointId);
			if (found) {
				this.setOpen(true);
				this.renderPanelHeader("Point de mur", () => this.controller.selectWallPoint(null));

				this.renderWallPointPanel(found.id);
				return;
			}
		}

		if (this.controller.selectedWallSegmentId) {
			const found = this.controller.getSelectedWallSegment();
			if (found) {
				this.setOpen(true);
				this.renderPanelHeader("Segment de mur", () => this.controller.selectWallSegment(null));

				this.renderWallSegmentPanel(found);
				return;
			}
		}

		const key = this.controller.selectedCellKey;
		const data = this.controller.getData();
		if (!key || data.gridType === "none") {
			this.setOpen(false);
			this.el.createDiv({ cls: "map-manager-infopanel-empty", text: "Cliquez sur une case ou un pion pour voir ou modifier ses informations." });
			return;
		}
		this.setOpen(true);

		const cell: CellData = this.controller.getActiveLayer().cellsByGridType[data.gridType][key] ?? {};

		this.renderPanelHeader(`Case ${key}`, () => this.controller.selectCell(null));

		if (this.controller.mode === "edit") {
			this.renderEditMode(key, cell, this.deps.settings.defaultZoneTypes);
		} else {
			this.renderViewMode(cell);
		}
	}

	// ---- Mass selection ("select" tool, edit mode only) ----

	/**
	 * Dispatches to one of the three bulk field sets. Every control in all three follows one rule so
	 * mixed/untouched values are preserved automatically (per-object, never overwritten just by being
	 * part of the selection): nothing is written to the controller except from an explicit
	 * `onclick`/`onchange` handler. Selects default to a leading "— ne pas changer —" option (same
	 * convention as the toolbar's brush zone-mode select); quick-pick buttons (icon/stamp) only show
	 * "active" when every selected object already shares that exact value, but clicking always just
	 * sets that one value for the whole selection.
	 */
	private renderMassSelectionPanel(): void {
		const kind = this.controller.massSelectionKind;
		if (!kind) return;
		this.setOpen(true);

		if (kind === "token") {
			const ids = this.controller.massSelectedTokenIds;
			const tokens = this.controller.getData().tokens.filter((t) => ids.has(t.id));
			if (tokens.length === 0) return;
			const s = tokens.length > 1 ? "s" : "";
			this.renderPanelHeader(`${tokens.length} pion${s} sélectionné${s}`, () => this.controller.clearMassSelection());
			this.renderMassTokenPanel(tokens);
			return;
		}

		if (kind === "wallSegment") {
			const count = this.controller.massSelectedWallSegmentIds.size;
			if (count === 0) return;
			const s = count > 1 ? "s" : "";
			this.renderPanelHeader(`${count} segment${s} de mur sélectionné${s}`, () => this.controller.clearMassSelection());
			this.renderMassWallSegmentPanel();
			return;
		}

		// "stamp": a grid cell on celled grid types, a Marker on grid type "none".
		const isNoneGrid = this.controller.getData().gridType === "none";
		const count = isNoneGrid ? this.controller.massSelectedMarkerIds.size : this.controller.massSelectedCellKeys.size;
		if (count === 0) return;
		const plural = count > 1 ? "s" : "";
		const title = isNoneGrid ? `${count} tampon${plural} sélectionné${plural}` : `${count} case${plural} sélectionnée${plural}`;
		this.renderPanelHeader(title, () => this.controller.clearMassSelection());
		this.renderMassStampPanel(isNoneGrid);
	}

	private renderMassTokenPanel(tokens: Token[]): void {
		const iconField = this.el.createDiv({ cls: "map-manager-field" });
		iconField.createEl("label", { text: "Icône" });
		const quickRow = iconField.createDiv({ cls: "map-manager-stamp-row" });
		for (const s of QUICK_TOKEN_ICONS) {
			const btn = quickRow.createEl("button", { text: s, cls: "map-manager-stamp-btn" });
			if (tokens.every((t) => t.icon === s)) btn.addClass("is-active");
			btn.onclick = () => this.controller.massUpdateTokens((t) => (t.icon = s));
		}

		const categoryField = this.el.createDiv({ cls: "map-manager-field" });
		categoryField.createEl("label", { text: "Catégorie" });
		const categorySelect = categoryField.createEl("select");
		const keepCategoryOpt = categorySelect.createEl("option", { text: "— ne pas changer —" });
		keepCategoryOpt.value = "";
		const playerOpt = categorySelect.createEl("option", { text: "Joueur" });
		playerOpt.value = "player";
		const entityOpt = categorySelect.createEl("option", { text: "Entité" });
		entityOpt.value = "entity";
		categorySelect.value = "";
		categorySelect.onchange = () => {
			const value = categorySelect.value;
			if (value === "player" || value === "entity") this.controller.massUpdateTokens((t) => (t.category = value));
		};

		const categories = new Set(tokens.map((t) => t.category ?? "entity"));
		if (categories.size === 1) {
			this.renderMassVisionFields(tokens, [...categories][0] as TokenCategory);
		} else {
			this.el.createDiv({
				cls: "map-manager-view-empty",
				text: "Sélection mixte (joueurs et entités) : changez d'abord la catégorie pour éditer la vision.",
			});
		}

		const sizeField = this.el.createDiv({ cls: "map-manager-field" });
		sizeField.createEl("label", { text: "Taille" });
		const sizeSelect = sizeField.createEl("select");
		const keepSizeOpt = sizeSelect.createEl("option", { text: "— ne pas changer —" });
		keepSizeOpt.value = "";
		for (const size of TOKEN_SIZES) {
			const opt = sizeSelect.createEl("option", { text: `${size}×${size} case${size > 1 ? "s" : ""}` });
			opt.value = String(size);
		}
		sizeSelect.value = "";
		sizeSelect.onchange = () => {
			const value = Number(sizeSelect.value);
			if (value > 0) this.controller.massUpdateTokens((t) => (t.size = value));
		};

		const colorField = this.el.createDiv({ cls: "map-manager-field" });
		colorField.createEl("label", { text: "Couleur du bord" });
		const colorInput = colorField.createEl("input", { type: "color" });
		colorInput.value = tokens[0]?.color ?? DEFAULT_TOKEN_COLOR;
		colorInput.onchange = () => this.controller.massUpdateTokens((t) => (t.color = colorInput.value));

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", {
			text: tokens.length > 1 ? "Supprimer les pions" : "Supprimer le pion",
			cls: "map-manager-btn map-manager-btn-danger",
		});
		deleteBtn.onclick = () => this.controller.massRemoveTokens();
	}

	/**
	 * Mirrors `renderVisionFields`, but every control writes via `massUpdateTokens` instead of a single
	 * token id, and each field's starting position is seeded from `tokens[0]` (only a visual default
	 * for where the slider/input starts — nothing is written until the user actually interacts with
	 * it, so an untouched field never overwrites a token whose value differed from the seed).
	 */
	private renderMassVisionFields(tokens: Token[], category: TokenCategory): void {
		const seed = tokens[0];
		if (!seed) return;
		const isPlayer = category === "player";
		const wrap = this.el.createDiv({ cls: "map-manager-field" });
		wrap.createEl("label", { text: isPlayer ? "Vision (brouillard de guerre)" : "Vision (zone visible par le MJ uniquement)" });
		const row = wrap.createDiv({ cls: "map-manager-vision-row" });

		if (isPlayer) {
			this.makeSliderField(row, "Angle (°)", seed.visionAngle ?? DEFAULT_VISION_ANGLE, 1, 360, (v) => this.controller.massUpdateTokens((t) => (t.visionAngle = v)), 10);
		} else {
			this.makeSliderField(
				row,
				"Angle des yeux (°)",
				seed.sideEyeAngle ?? DEFAULT_SIDE_EYE_ANGLE,
				0,
				180,
				(v) => this.controller.massUpdateTokens((t) => (t.sideEyeAngle = v)),
				10
			);
			this.makeSliderField(
				row,
				"Détection (°)",
				seed.detectionAngle ?? DEFAULT_EYE_TIER_ANGLES.detectionAngle,
				1,
				360,
				(v) => this.controller.massUpdateTokens((t) => (t.detectionAngle = v)),
				10
			);
			this.makeSliderField(
				row,
				"Binoculaire (°)",
				seed.binocularAngle ?? DEFAULT_EYE_TIER_ANGLES.binocularAngle,
				1,
				360,
				(v) => this.controller.massUpdateTokens((t) => (t.binocularAngle = v)),
				10
			);
			this.makeSliderField(
				row,
				"Monoculaire (°)",
				seed.monocularAngle ?? DEFAULT_EYE_TIER_ANGLES.monocularAngle,
				1,
				360,
				(v) => this.controller.massUpdateTokens((t) => (t.monocularAngle = v)),
				10
			);
		}

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
		makeNumberInput("Portée (cases)", seed.visionRange ?? DEFAULT_VISION_RANGE, (v) => this.controller.massUpdateTokens((t) => (t.visionRange = Math.max(0, v))));
		makeNumberInput(isPlayer ? "Rayon exploré (cases)" : "Rayon (cases)", seed.visionRadius ?? DEFAULT_VISION_RADIUS, (v) =>
			this.controller.massUpdateTokens((t) => (t.visionRadius = Math.max(0, v)))
		);
	}

	/** Bulk blocker-type editor for mass-selected wall *segments* — unlike the single-point editor, this never touches a whole connected shape, only exactly the segments in the selection. */
	private renderMassWallSegmentPanel(): void {
		const blockerField = this.el.createDiv({ cls: "map-manager-field" });
		blockerField.createEl("label", { text: "Bloc visuel (brouillard de guerre)" });
		const blockerSelect = blockerField.createEl("select");
		const keepOpt = blockerSelect.createEl("option", { text: "— ne pas changer —" });
		keepOpt.value = "";
		const opaqueOpt = blockerSelect.createEl("option", { text: "Opaque (cache tout au-delà)" });
		opaqueOpt.value = "opaque";
		const dimOpt = blockerSelect.createEl("option", { text: "Partiel (visible en mode exploré)" });
		dimOpt.value = "dim";
		blockerSelect.value = "";
		blockerSelect.onchange = () => {
			const value = blockerSelect.value;
			if (value === "opaque" || value === "dim") this.controller.massSetWallSegmentsBlockerType(value);
		};

		const count = this.controller.massSelectedWallSegmentIds.size;
		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", {
			text: count > 1 ? "Supprimer les segments" : "Supprimer le segment",
			cls: "map-manager-btn map-manager-btn-danger",
		});
		deleteBtn.onclick = () => this.controller.massRemoveWallSegments();
	}

	/** Bulk editor for mass-selected "stamps": grid cells on a celled grid type, or `Marker`s on grid type "none". */
	private renderMassStampPanel(isNoneGrid: boolean): void {
		if (!isNoneGrid) {
			const zoneField = this.el.createDiv({ cls: "map-manager-field" });
			zoneField.createEl("label", { text: "Type de zone" });
			const select = zoneField.createEl("select");
			const keepOpt = select.createEl("option", { text: "— ne pas changer —" });
			keepOpt.value = "__keep__";
			const noneOpt = select.createEl("option", { text: "— aucun —" });
			noneOpt.value = "__none__";
			for (const z of this.deps.settings.defaultZoneTypes) {
				const opt = select.createEl("option", { text: z.name });
				opt.value = z.id;
			}
			select.value = "__keep__";
			select.onchange = () => {
				const value = select.value;
				if (value === "__keep__") return;
				const zoneTypeId = value === "__none__" ? undefined : value;
				this.controller.massUpdateCells((c) => (c.zoneTypeId = zoneTypeId));
			};
		}

		const stampField = this.el.createDiv({ cls: "map-manager-field" });
		stampField.createEl("label", { text: "Tampon" });
		const quickRow = stampField.createDiv({ cls: "map-manager-stamp-row" });
		for (const s of QUICK_STAMPS) {
			const btn = quickRow.createEl("button", { text: s, cls: "map-manager-stamp-btn" });
			btn.onclick = () => {
				if (isNoneGrid) this.controller.massUpdateMarkers((m) => (m.stamp = s));
				else this.controller.massUpdateCells((c) => (c.stamp = s));
			};
		}

		const labelField = this.el.createDiv({ cls: "map-manager-field" });
		labelField.createEl("label", { text: "Nom (affiché sous le tampon)" });
		const labelRow = labelField.createDiv({ cls: "map-manager-field-inline" });
		const labelInput = labelRow.createEl("input", { type: "text" });
		labelInput.placeholder = "(valeurs différentes)";
		labelInput.onchange = () => {
			const value = labelInput.value;
			if (!value) return;
			if (isNoneGrid) this.controller.massUpdateMarkers((m) => (m.label = value));
			else this.controller.massUpdateCells((c) => (c.label = value));
		};
		const clearLabelBtn = labelRow.createEl("button", { text: "×", cls: "map-manager-btn map-manager-btn-icon" });
		clearLabelBtn.title = "Effacer le nom pour la sélection";
		clearLabelBtn.onclick = () => {
			if (isNoneGrid) this.controller.massUpdateMarkers((m) => (m.label = undefined));
			else this.controller.massUpdateCells((c) => (c.label = undefined));
		};

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		if (isNoneGrid) {
			const count = this.controller.massSelectedMarkerIds.size;
			const deleteBtn = footer.createEl("button", {
				text: count > 1 ? "Supprimer les tampons" : "Supprimer le tampon",
				cls: "map-manager-btn map-manager-btn-danger",
			});
			deleteBtn.onclick = () => this.controller.massRemoveMarkers();
		} else {
			const count = this.controller.massSelectedCellKeys.size;
			const clearBtn = footer.createEl("button", {
				text: count > 1 ? "Vider les cases" : "Vider la case",
				cls: "map-manager-btn map-manager-btn-danger",
			});
			clearBtn.onclick = () => this.controller.massClearCells();
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

		if (this.controller.activeInfoLinkIndex >= links.length) this.controller.activeInfoLinkIndex = 0;

		const tabs = this.el.createDiv({ cls: "map-manager-view-tabs" });
		links.forEach((link, i) => {
			const tab = tabs.createEl("button", { text: linkTabLabel(link), cls: "map-manager-tab" });
			if (i === this.controller.activeInfoLinkIndex) tab.addClass("is-active");
			tab.onclick = () => this.controller.setActiveInfoLinkIndex(i);
		});

		const contentEl = this.el.createDiv({ cls: "map-manager-view-content" });
		const activeLink = links[this.controller.activeInfoLinkIndex];
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

	// ---- Wall points (freeform vision-blocking lines, edit mode only) ----

	private renderWallPointPanel(pointId: string): void {
		const segments = this.controller.getSegmentsForPoint(pointId);

		const blockerField = this.el.createDiv({ cls: "map-manager-field" });
		blockerField.createEl("label", { text: "Bloc visuel (brouillard de guerre)" });
		const blockerSelect = blockerField.createEl("select");
		const opaqueOpt = blockerSelect.createEl("option", { text: "Opaque (cache tout au-delà)" });
		opaqueOpt.value = "opaque";
		const dimOpt = blockerSelect.createEl("option", { text: "Partiel (visible en mode exploré)" });
		dimOpt.value = "dim";
		// Segments connected to this point may not all share the same type; leave the control on its
		// first option in that case rather than misrepresenting a single value.
		const firstType = segments[0]?.blockerType;
		const allSame = segments.every((s) => s.blockerType === firstType);
		if (allSame && firstType) blockerSelect.value = firstType;
		blockerSelect.onchange = () => this.controller.setWallPointBlockerType(pointId, blockerSelect.value as VisionBlockerType);
		if (segments.length === 0) {
			blockerField.createDiv({ cls: "map-manager-infopanel-empty", text: "Ce point n'est relié à aucune ligne." });
		}

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", { text: "Supprimer le point", cls: "map-manager-btn map-manager-btn-danger" });
		deleteBtn.onclick = () => this.controller.removeWallPoint(pointId);
	}

	/** Unlike `renderWallPointPanel` (whole connected shape), edits exactly one segment — e.g. a single door-sized gap in an otherwise opaque wall. Reached by clicking directly on a wall's line rather than one of its endpoint handles. */
	private renderWallSegmentPanel(segment: WallSegment): void {
		const blockerField = this.el.createDiv({ cls: "map-manager-field" });
		blockerField.createEl("label", { text: "Bloc visuel (brouillard de guerre)" });
		const blockerSelect = blockerField.createEl("select");
		const opaqueOpt = blockerSelect.createEl("option", { text: "Opaque (cache tout au-delà)" });
		opaqueOpt.value = "opaque";
		const dimOpt = blockerSelect.createEl("option", { text: "Partiel (visible en mode exploré)" });
		dimOpt.value = "dim";
		blockerSelect.value = segment.blockerType;
		blockerSelect.onchange = () => this.controller.setWallSegmentBlockerType(segment.id, blockerSelect.value as VisionBlockerType);

		const hint = this.el.createDiv({ cls: "map-manager-infopanel-empty" });
		hint.setText("Double-cliquez sur ce segment pour y ajouter un point et modifier sa forme.");

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", { text: "Supprimer ce segment", cls: "map-manager-btn map-manager-btn-danger" });
		deleteBtn.onclick = () => this.controller.removeWallSegment(segment.id);
	}

	// ---- Tokens (full edit panel in edit mode; reduced read-mostly panel in view mode) ----

	private renderTokenPanel(token: Token): void {
		if (this.controller.mode === "view") {
			this.renderTokenViewPanel(token);
			return;
		}

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

		this.renderRotationField(token);
		this.renderVisionFields(token, category);

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

		const templateField = this.el.createDiv({ cls: "map-manager-field" });
		templateField.createEl("label", { text: "Modèle de statistiques" });
		const templateSelect = templateField.createEl("select");
		const noneOpt = templateSelect.createEl("option", { text: "— aucun —" });
		noneOpt.value = "";
		for (const t of this.deps.settings.defaultTokenTemplates) {
			const opt = templateSelect.createEl("option", { text: t.name });
			opt.value = t.id;
			if (token.templateId === t.id) opt.selected = true;
		}
		templateSelect.onchange = () => this.controller.updateToken(token.id, (t) => (t.templateId = templateSelect.value || undefined));
		if (this.deps.settings.defaultTokenTemplates.length === 0) {
			templateField.createDiv({ cls: "map-manager-view-empty", text: "Aucun modèle défini (Réglages du plugin)." });
		}

		this.renderTokenTabsEditor(token);

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", { text: "Supprimer le pion", cls: "map-manager-btn map-manager-btn-danger" });
		deleteBtn.onclick = () => this.controller.removeToken(token.id);
	}

	/**
	 * View mode ("Vue", still GM-facing — see `MapCanvas.drawTokenVisionZones`) only shows what's
	 * needed mid-session: rotation (any category — for a player this is also their vision cone's
	 * facing, see `castVisionRays`; for an entity it's what its own GM-only vision zone points, and
	 * that zone is exactly what's drawn continuously here instead of only-while-selected like edit
	 * mode) and tabs' read-only content (stats/inventory/story/... — see `renderTokenTabsReadOnly`,
	 * which applies to both categories). Everything else
	 * (icon/image/name/category/size/color/template picker/vision shape/delete) is edit-only.
	 */
	private renderTokenViewPanel(token: Token): void {
		this.renderRotationField(token);
		this.renderTokenTabsReadOnly(token);
	}

	// ---- Token tabs (Statistiques/Inventaire/Histoire by default, customizable per token, any category) ----

	/** Resolves the tab to preview below the tab strip, falling back to the first tab and normalizing the tracked id (`MapController.activeInfoTabId` is reset to `null` whenever the selection itself changes — see `MapController.selectToken`). */
	private resolveActiveTab(tabs: TokenTab[]): TokenTab | undefined {
		if (!tabs.some((t) => t.id === this.controller.activeInfoTabId)) this.controller.activeInfoTabId = tabs[0]?.id ?? null;
		return tabs.find((t) => t.id === this.controller.activeInfoTabId);
	}

	/** Materializes the (possibly still-lazy default) tab list onto the token, then applies `mutator` to the tab matching `tabId`. */
	private updateTokenTabs(token: Token, currentTabs: TokenTab[], tabId: string, mutator: (tab: TokenTab) => void): void {
		this.controller.updateToken(token.id, (t) => {
			const next = currentTabs.map((tab) => ({ ...tab }));
			const target = next.find((tab) => tab.id === tabId);
			if (target) mutator(target);
			t.tabs = next;
			t.link = undefined;
		});
	}

	private renderTokenTabsEditor(token: Token): void {
		const tabs = getTokenTabs(token, this.deps.settings.defaultTokenTemplates);
		const statsTabId = findStatsTab(tabs)?.id;

		const section = this.el.createDiv({ cls: "map-manager-field" });
		section.createEl("label", { text: "Onglets" });

		const list = section.createDiv({ cls: "map-manager-token-tabs-list" });
		for (const tab of tabs) {
			const row = list.createDiv({ cls: "map-manager-token-tab-row" });
			if (tab.id === this.controller.activeInfoTabId) row.addClass("is-active");

			const selectBtn = row.createEl("button", {
				text: tab.id === this.controller.activeInfoTabId ? "●" : "○",
				cls: "map-manager-btn map-manager-btn-icon",
			});
			selectBtn.title = "Afficher cet onglet ci-dessous";
			selectBtn.onclick = () => this.controller.setActiveInfoTab(tab.id);

			const nameInput = row.createEl("input", { type: "text", cls: "map-manager-token-tab-name" });
			nameInput.value = tab.name;
			nameInput.onchange = () => this.updateTokenTabs(token, tabs, tab.id, (t) => (t.name = nameInput.value || tab.name));

			if (tab.link) {
				const pill = row.createDiv({ cls: "map-manager-link-pill map-manager-token-tab-link" });
				const a = pill.createEl("a", { text: linkTabLabel(tab.link), href: "#" });
				const linkValue = tab.link;
				a.onclick = (e) => {
					e.preventDefault();
					void this.app.workspace.openLinkText(linkValue, "", false);
				};
				const remove = pill.createEl("span", { text: "×", cls: "map-manager-link-remove" });
				remove.onclick = () => this.updateTokenTabs(token, tabs, tab.id, (t) => (t.link = undefined));
			} else {
				const pickBtn = row.createEl("button", { text: "Lier une note", cls: "map-manager-btn" });
				pickBtn.onclick = () => this.pickLink((link) => this.updateTokenTabs(token, tabs, tab.id, (t) => (t.link = link)));
			}

			const removeBtn = row.createEl("button", { text: "🗑", cls: "map-manager-btn map-manager-btn-icon" });
			removeBtn.title = "Supprimer cet onglet";
			removeBtn.onclick = () => {
				const next = tabs.filter((t) => t.id !== tab.id);
				if (this.controller.activeInfoTabId === tab.id) this.controller.activeInfoTabId = next[0]?.id ?? null;
				this.controller.updateToken(token.id, (t) => {
					t.tabs = next;
					t.link = undefined;
				});
			};
		}

		const addBtn = section.createEl("button", { text: "Ajouter un onglet", cls: "map-manager-btn" });
		addBtn.onclick = () => {
			const newTab: TokenTab = { id: generateLocalId("tab"), name: `Onglet ${tabs.length + 1}` };
			this.controller.activeInfoTabId = newTab.id;
			this.controller.updateToken(token.id, (t) => {
				t.tabs = [...tabs, newTab];
				t.link = undefined;
			});
		};

		const activeTab = this.resolveActiveTab(tabs);
		if (!activeTab) return;

		if (activeTab.id === statsTabId) this.renderTokenStats(token);

		if (activeTab.link) {
			const contentEl = this.el.createDiv({ cls: "map-manager-view-content" });
			void this.renderLinkContent(activeTab.link, contentEl);
		}
	}

	private renderTokenTabsReadOnly(token: Token): void {
		const tabs = getTokenTabs(token, this.deps.settings.defaultTokenTemplates);
		if (tabs.length === 0) return;
		const activeTab = this.resolveActiveTab(tabs);
		if (!activeTab) return;

		// The stats table (from the "Statistiques" tab's note) stays visible no matter which tab
		// is active — it's the character's vitals, not tab-specific content.
		this.renderTokenStats(token);

		const tabBar = this.el.createDiv({ cls: "map-manager-view-tabs" });
		for (const tab of tabs) {
			const btn = tabBar.createEl("button", { text: tab.name, cls: "map-manager-tab" });
			if (tab.id === activeTab.id) btn.addClass("is-active");
			btn.onclick = () => this.controller.setActiveInfoTab(tab.id);
		}

		if (activeTab.link) {
			const contentEl = this.el.createDiv({ cls: "map-manager-view-content" });
			void this.renderLinkContent(activeTab.link, contentEl);
		} else {
			this.el.createDiv({ cls: "map-manager-view-empty", text: "Aucune note liée à cet onglet." });
		}
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

	/** The token's own facing arrow (any category — see `drawTokenFacingArrow`), independent of a player's vision cone direction. */
	private renderRotationField(token: Token): void {
		const wrap = this.el.createDiv({ cls: "map-manager-field" });
		this.makeRotationDialField(wrap, "Rotation (°, 0=est, horaire)", token.rotation ?? DEFAULT_TOKEN_ROTATION, (v) =>
			this.controller.updateToken(token.id, (t) => (t.rotation = v))
		);
	}

	/**
	 * Range/radius (see `visionRange`/`visionRadius` in `mapData.ts`) are shared fields for either
	 * category, but the cone shape itself diverges: a player gets the single `visionAngle` slider it
	 * always had, lighting up the fog for real (`castVisionRays`/`drawFog`) as well as showing a
	 * GM-only preview when selected in edit mode; an entity instead gets `renderEntityEyeFields`'s
	 * eye-angle + 3-tier controls, only ever a GM-only hint (`MapCanvas.drawTokenVisionZones`), never
	 * touching fog. Either way the direction itself is `token.rotation` (see `renderRotationField`)
	 * — the cone(s) just point wherever the token is facing, nothing to configure here beyond shape/reach.
	 */
	private renderVisionFields(token: Token, category: TokenCategory): void {
		const isPlayer = category === "player";
		const wrap = this.el.createDiv({ cls: "map-manager-field" });
		wrap.createEl("label", { text: isPlayer ? "Vision (brouillard de guerre)" : "Vision (zone visible par le MJ uniquement)" });
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

		if (isPlayer) {
			this.makeSliderField(
				row,
				"Angle (°)",
				token.visionAngle ?? DEFAULT_VISION_ANGLE,
				1,
				360,
				(v) => this.controller.updateToken(token.id, (t) => (t.visionAngle = v)),
				10
			);
		} else {
			this.renderEntityEyeFields(token, row);
		}

		makeNumberInput("Portée (cases)", token.visionRange ?? DEFAULT_VISION_RANGE, (v) =>
			this.controller.updateToken(token.id, (t) => (t.visionRange = Math.max(0, v)))
		);
		makeNumberInput(isPlayer ? "Rayon exploré (cases)" : "Rayon (cases)", token.visionRadius ?? DEFAULT_VISION_RADIUS, (v) =>
			this.controller.updateToken(token.id, (t) => (t.visionRadius = Math.max(0, v)))
		);
	}

	/**
	 * An entity's eye layout (see `Token.sideEyeAngle`/`resolveEyeCones` in `mapData.ts`): always two
	 * cones mirrored around the token's facing, spread apart by the "Angle des yeux" slider
	 * (`sideEyeAngle`) — `0` (its default) collapses them onto a single forward-facing cone; larger
	 * values spread them towards the sides, like a prey animal's eyes. Each of the 3 tiers
	 * (Détection/Binoculaire/Monoculaire) defaults to `DEFAULT_EYE_TIER_ANGLES` until individually
	 * overridden here.
	 */
	private renderEntityEyeFields(token: Token, row: HTMLElement): void {
		this.makeSliderField(
			row,
			"Angle des yeux (°)",
			token.sideEyeAngle ?? DEFAULT_SIDE_EYE_ANGLE,
			0,
			180,
			(v) => this.controller.updateToken(token.id, (t) => (t.sideEyeAngle = v)),
			10
		);
		this.makeSliderField(
			row,
			"Détection (°)",
			token.detectionAngle ?? DEFAULT_EYE_TIER_ANGLES.detectionAngle,
			1,
			360,
			(v) => this.controller.updateToken(token.id, (t) => (t.detectionAngle = v)),
			10
		);
		this.makeSliderField(
			row,
			"Binoculaire (°)",
			token.binocularAngle ?? DEFAULT_EYE_TIER_ANGLES.binocularAngle,
			1,
			360,
			(v) => this.controller.updateToken(token.id, (t) => (t.binocularAngle = v)),
			10
		);
		this.makeSliderField(
			row,
			"Monoculaire (°)",
			token.monocularAngle ?? DEFAULT_EYE_TIER_ANGLES.monocularAngle,
			1,
			360,
			(v) => this.controller.updateToken(token.id, (t) => (t.monocularAngle = v)),
			10
		);
	}

	/**
	 * A slider paired with a synced number input for typing an exact value. Intermediate drags
	 * push live updates to `onCommit` (so the map updates as you go) without ever rebuilding this
	 * panel mid-gesture — see `suppressRerender`. `step` (both the slider's drag increment and the
	 * number input's arrow-key increment — typing an exact value is unaffected either way) defaults
	 * to 1; every current caller is a vision/eye angle field and passes 10.
	 */
	private makeSliderField(container: HTMLElement, labelText: string, value: number, min: number, max: number, onCommit: (v: number) => void, step = 1): void {
		const field = container.createDiv({ cls: "map-manager-field-inline map-manager-slider-field" });
		field.createEl("label", { text: labelText });
		const slider = field.createEl("input", { type: "range", cls: "map-manager-vision-slider" });
		slider.min = String(min);
		slider.max = String(max);
		slider.step = String(step);
		slider.value = String(value);
		const number = field.createEl("input", { type: "number", cls: "map-manager-vision-number" });
		number.min = String(min);
		number.max = String(max);
		number.step = String(step);
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

	/**
	 * A "jog dial" for rotating a token: unlike `makeSliderField`, the slider's own thumb position
	 * is NOT the value it controls — it always starts centered at 0 and reads as how far to turn
	 * *from* wherever the rotation stood when the current drag began (captured once per gesture into
	 * `baseRotation`, gated the same way `beginGestureIfNeeded` already gates the history-group
	 * start). Turning further left/right keeps adding to that delta past ±180°, so the token rotates
	 * continuously from its current facing instead of the slider ever hitting the end of a fixed
	 * 0-360 range with the token still stuck at a different position — e.g. a token facing 10° would
	 * otherwise have almost no room to turn further left on a plain 0-360 slider. Released, the
	 * thumb snaps back to center so the next drag starts fresh. The paired number input is always
	 * the true absolute value (0-360) and can be typed into directly.
	 */
	private makeRotationDialField(container: HTMLElement, labelText: string, currentRotation: number, onCommit: (v: number) => void): void {
		const field = container.createDiv({ cls: "map-manager-field-inline map-manager-slider-field" });
		field.createEl("label", { text: labelText });
		const slider = field.createEl("input", { type: "range", cls: "map-manager-vision-slider" });
		slider.min = "-180";
		slider.max = "180";
		slider.value = "0";
		const number = field.createEl("input", { type: "number", cls: "map-manager-vision-number" });
		number.min = "0";
		number.max = "360";
		number.value = String(Math.round(((currentRotation % 360) + 360) % 360));

		// The rotation as of the last commit made *by this control*, kept up to date independently of
		// `currentRotation` (only ever the value from when this field was built): `InfoPanel` skips
		// rebuilding itself while a gesture is in progress (see `suppressRerender`) and doesn't force
		// a rebuild right after release either, so nothing ever refreshes `currentRotation` between
		// one drag ending and the next one starting — without this, `beginGestureIfNeeded` would keep
		// resetting `baseRotation` back to whatever the token's rotation was when the panel was last
		// rendered, undoing every gesture but the first.
		let latestRotation = currentRotation;
		let baseRotation = currentRotation;

		const beginGestureIfNeeded = () => {
			if (this.suppressRerender) return;
			this.suppressRerender = true;
			this.controller.beginHistoryGroup();
			baseRotation = latestRotation;
		};

		const release = () => {
			if (!this.suppressRerender) return;
			this.suppressRerender = false;
			this.controller.endHistoryGroup();
			slider.value = "0";
		};

		slider.oninput = () => {
			beginGestureIfNeeded();
			const next = ((baseRotation + Number(slider.value)) % 360 + 360) % 360;
			latestRotation = next;
			number.value = String(Math.round(next));
			onCommit(next);
		};
		slider.onchange = release;

		number.oninput = () => {
			const v = Number(number.value);
			if (Number.isNaN(v)) return;
			beginGestureIfNeeded();
			const next = ((v % 360) + 360) % 360;
			latestRotation = next;
			onCommit(next);
		};
		number.onchange = release;
	}

	private renderTokenStats(token: Token): void {
		if (!token.templateId) return;
		const template: TokenTemplate | undefined = this.deps.settings.defaultTokenTemplates.find((t) => t.id === token.templateId);
		if (!template || template.fields.length === 0) return;

		const table = this.el.createDiv({ cls: "map-manager-token-stats" });
		let frontmatter: Record<string, unknown> | undefined;
		const statsLink = tokenStatsSourceLink(token, this.deps.settings.defaultTokenTemplates);
		if (statsLink) {
			const { path } = splitLink(statsLink);
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
		container.addClass("markdown-rendered");
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

		// MarkdownRenderer.render doesn't wire up navigation on its own outside a real leaf/view —
		// same reason the "linked notes" pills above call `openLinkText` manually — so a link
		// inside the rendered note's own body needs the same explicit handling here.
		container.addEventListener("click", (evt) => {
			const anchor = (evt.target as HTMLElement).closest("a.internal-link");
			if (!anchor) return;
			evt.preventDefault();
			const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
			if (href) void this.app.workspace.openLinkText(href, file.path, evt.ctrlKey || evt.metaKey);
		});
	}
}

import { App, Component, MarkdownRenderer, Notice, TFile, resolveSubpath, setIcon, setTooltip } from "obsidian";
import { GamepadInfo, listConnectedGamepads } from "../controller/gamepadInput";
import { MapController } from "../controller/MapController";
import {
	CellData,
	Clock,
	configuredLightRadius,
	DEFAULT_EYE_TIER_ANGLES,
	DEFAULT_LIGHT_ACTION_DRAIN,
	DEFAULT_LIGHT_LIFE,
	DEFAULT_LIGHT_MOVE_DRAIN,
	DEFAULT_SIDE_EYE_ANGLE,
	DEFAULT_TOKEN_COLOR,
	DEFAULT_TOKEN_ROTATION,
	DEFAULT_VISION_RANGE,
	Marker,
	TOKEN_SIZES,
	Token,
	TokenCategory,
	TokenTab,
	TokenTemplate,
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
import { clamp } from "../grid/gridMath";
import { resizeImageToSquare } from "../platform/resizeImage";
import { MapManagerSettings, PLAYER_TEMPLATE_ID } from "../settings/types";
import { FileSuggestModal, IMAGE_EXTENSIONS } from "./FileSuggestModal";
import { HeadingSuggestModal } from "./HeadingSuggestModal";
import { WALL_BLOCKER_TYPE_OPTIONS, isWallBlockerTypeValue } from "./wallBlockerTypeOptions";

export interface InfoPanelDeps {
	assetsFolder: string;
	settings: MapManagerSettings;
	/** Persists a new panel width (px) after a resize-handle drag — see `MIN_PANEL_WIDTH`/`MAX_PANEL_WIDTH`. */
	onResizePanel?: (width: number) => void;
	/** Called whenever this panel scrolls — lets a player mirror's InfoPanel (see `setScrollTop`) follow along. Not a `MapController` field: pushing it through `notify()` on every scroll tick would rebuild every subscribed panel's whole DOM mid-scroll. */
	onScroll?: (scrollTop: number) => void;
	/**
	 * Set only by `MapPlayerMirrorView`'s own InfoPanel instance — the one real players actually see.
	 * When true, `render()` shows nothing but a selected token's stat block and tabs (`renderPlayerPanel`):
	 * no header/eye/close controls, no rotation/vision/light/category/... editing surface, regardless
	 * of the GM's own `controller.mode` — everything else in this file is GM tooling, even the
	 * reduced "Vue"-mode panel (`renderTokenViewPanel`, still GM-facing per its own doc comment).
	 */
	forPlayers?: boolean;
}

/** Sets a token's category, locking it onto the reserved "Joueur" template when switching to "player" — see `PLAYER_TEMPLATE_ID`. Shared by the single-token and mass-selection category pickers. */
function applyTokenCategory(t: Token, value: TokenCategory): void {
	t.category = value;
	if (value === "player") t.templateId = PLAYER_TEMPLATE_ID;
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
		// The list of connected gamepads (`renderGamepadField`) isn't `MapController` state — a browser/
		// OS-level connection event, not a map mutation — so it needs its own listener to refresh the
		// dropdown the moment a controller is plugged in/unplugged rather than waiting for some unrelated
		// map change to trigger the next `render()`. Not attached for a player-mirror panel (`forPlayers`),
		// which never shows this field to begin with (GM-only tooling, see `InfoPanelDeps.forPlayers`).
		if (!this.deps.forPlayers) window.addEventListener("gamepadconnected", this.onGamepadChange);
		if (!this.deps.forPlayers) window.addEventListener("gamepaddisconnected", this.onGamepadChange);
	}

	destroy(): void {
		this.unsubscribe();
		this.el.removeEventListener("scroll", this.onScroll);
		window.removeEventListener("gamepadconnected", this.onGamepadChange);
		window.removeEventListener("gamepaddisconnected", this.onGamepadChange);
		this.clearRenderComponents();
		this.resizeHandleEl.remove();
		this.el.remove();
	}

	private onGamepadChange = (): void => {
		if (this.suppressRerender) return;
		this.render();
	};

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

	/**
	 * Header shared by every selection type (token/marker/wall point/cell): a title, an optional "eye"
	 * toggle that mirrors this whole panel onto a player window (see
	 * `MapController.showInfoToPlayers`/`MapPlayerMirrorView`), and a close button. The eye toggle is
	 * scoped to pion/tampon/case panels (`showEyeToggle` default `true`) — dropped for wall
	 * point/segment panels (`showEyeToggle: false`), since wall geometry is never shown to players at
	 * all (see CLAUDE.md's "Public viewer" section).
	 */
	private renderPanelHeader(title: string, onClose: () => void, showEyeToggle = true): void {
		const header = this.el.createDiv({ cls: "map-manager-infopanel-header" });
		header.createEl("h4", { text: title });
		const actions = header.createDiv({ cls: "map-manager-infopanel-header-actions" });
		if (showEyeToggle) {
			const eyeBtn = actions.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
			setIcon(eyeBtn, this.controller.showInfoToPlayers ? "eye" : "eye-off");
			setTooltip(eyeBtn, this.controller.showInfoToPlayers ? "Masquer ce panneau sur la fenêtre joueur" : "Afficher ce panneau sur la fenêtre joueur");
			eyeBtn.toggleClass("is-active", this.controller.showInfoToPlayers);
			eyeBtn.onclick = () => this.controller.toggleShowInfoToPlayers();
		}
		const closeBtn = actions.createEl("button", { text: "✕", cls: "map-manager-btn map-manager-btn-icon" });
		closeBtn.onclick = onClose;
	}

	private render(): void {
		this.applyWidth();
		this.clearRenderComponents();
		this.el.empty();

		if (this.deps.forPlayers) {
			this.renderPlayerPanel();
			return;
		}

		// A locked mass selection (ctrl+click/shift-drag — see MapCanvas) always wins over any stale
		// single-selection, in either mode — kept simple as one dedicated bulk panel rather than
		// merging with the full single-item editors below, even for a selection of exactly one object.
		if (this.controller.massSelectionKind) {
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
				this.renderPanelHeader("Point de mur", () => this.controller.selectWallPoint(null), false);

				this.renderWallPointPanel(found.id);
				return;
			}
		}

		if (this.controller.selectedWallSegmentId) {
			const found = this.controller.getSelectedWallSegment();
			if (found) {
				this.setOpen(true);
				this.renderPanelHeader("Segment de mur", () => this.controller.selectWallSegment(null), false);

				this.renderWallSegmentPanel(found);
				return;
			}
		}

		if (this.controller.selectedClockId) {
			const found = this.controller.findClock(this.controller.selectedClockId);
			if (found) {
				this.setOpen(true);
				// No eye toggle: a clock is already always shown to players via `ClockBar` regardless of
				// `showInfoToPlayers` — that flag/button only governs whether *this* InfoPanel selection
				// mirrors onto the player window (see `renderPanelHeader`'s own doc comment), which is
				// meaningless here since `MapPlayerMirrorView`'s `forPlayers` InfoPanel never shows a
				// clock panel to begin with (see `renderPlayerPanel`).
				this.renderPanelHeader("Horloge", () => this.controller.selectClock(null), false);

				this.renderClockPanel(found);
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
			this.renderEditMode(key, cell);
		} else {
			this.renderViewMode(cell);
		}
	}

	/**
	 * The player-facing mirror's whole `render()` — see `InfoPanelDeps.forPlayers`'s own doc comment
	 * for why this bypasses every other branch above. A selected token shows only
	 * `renderTokenTabsReadOnly` (stat block + tabs, no header); anything else selected (or a "light"
	 * category token — never visible to players in the first place, see
	 * `MapCanvas.isLightTokenHiddenFromMirror`) collapses the panel shut instead of showing nothing
	 * inside an open one.
	 */
	private renderPlayerPanel(): void {
		const token = this.controller.selectedTokenId ? this.controller.findToken(this.controller.selectedTokenId) : undefined;
		if (!token || (token.category ?? "entity") === "light") {
			this.setOpen(false);
			return;
		}
		this.setOpen(true);
		this.renderTokenTabsReadOnly(token);
	}

	// ---- Mass selection (ctrl+click/shift-drag — see MapCanvas — either mode) ----

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
		const categories = new Set(tokens.map((t) => t.category ?? "entity"));
		// "light" tokens have nothing to configure beyond their radius — see `TokenCategory`'s own
		// doc comment — so a selection that's entirely light tokens skips straight from the category
		// picker to `renderLightRadiusField`, same as the single-token panel does.
		const allLight = categories.size === 1 && categories.has("light");

		const categoryField = this.el.createDiv({ cls: "map-manager-field" });
		categoryField.createEl("label", { text: "Catégorie" });
		const categorySelect = categoryField.createEl("select");
		const keepCategoryOpt = categorySelect.createEl("option", { text: "— ne pas changer —" });
		keepCategoryOpt.value = "";
		const playerOpt = categorySelect.createEl("option", { text: "Joueur" });
		playerOpt.value = "player";
		const entityOpt = categorySelect.createEl("option", { text: "Entité" });
		entityOpt.value = "entity";
		const lightOpt = categorySelect.createEl("option", { text: "Lumière" });
		lightOpt.value = "light";
		categorySelect.value = "";
		categorySelect.onchange = () => {
			const value = categorySelect.value;
			if (value === "player" || value === "entity" || value === "light") {
				this.controller.massUpdateTokens((t) => applyTokenCategory(t, value));
			}
		};

		const seed = tokens[0];
		const lightEditable = this.controller.mode === "edit";
		if (allLight) {
			if (seed && lightEditable) this.renderLightRadiusField(seed, (mutator) => this.controller.massUpdateTokens(mutator));
			const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
			const deleteBtn = footer.createEl("button", {
				text: tokens.length > 1 ? "Supprimer les pions" : "Supprimer le pion",
				cls: "map-manager-btn map-manager-btn-danger",
			});
			deleteBtn.onclick = () => this.controller.massRemoveTokens();
			return;
		}

		const iconField = this.el.createDiv({ cls: "map-manager-field" });
		iconField.createEl("label", { text: "Logo" });
		const quickRow = iconField.createDiv({ cls: "map-manager-stamp-row" });
		for (const s of QUICK_TOKEN_ICONS) {
			const btn = quickRow.createEl("button", { text: s, cls: "map-manager-stamp-btn" });
			if (tokens.every((t) => t.icon === s)) btn.addClass("is-active");
			btn.onclick = () => this.controller.massUpdateTokens((t) => (t.icon = s));
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

		// Light means the same thing for every category, so it's shown here regardless of whether the
		// selection mixes categories — but edit mode only, like the single-token panel (during play a
		// light is gamepad-driven, not menu-edited).
		if (seed && lightEditable) this.renderLightRadiusField(seed, (mutator) => this.controller.massUpdateTokens(mutator));

		// Vision (entity-only — see `renderMassVisionFields`). Nothing shown at all for a selection
		// that's entirely players — there's no vision concept left to edit for them.
		if (categories.size === 1 && categories.has("entity")) {
			this.renderMassVisionFields(tokens);
		} else if (categories.size > 1) {
			this.el.createDiv({
				cls: "map-manager-view-empty",
				text: "Sélection mixte : changez d'abord la catégorie pour éditer la vision.",
			});
		}

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", {
			text: tokens.length > 1 ? "Supprimer les pions" : "Supprimer le pion",
			cls: "map-manager-btn map-manager-btn-danger",
		});
		deleteBtn.onclick = () => this.controller.massRemoveTokens();
	}

	/**
	 * Mirrors `renderVisionFields` (entity-only — see its own doc comment), but every control writes
	 * via `massUpdateTokens` instead of a single token id, and each field's starting position is
	 * seeded from `tokens[0]` (only a visual default for where the slider/input starts — nothing is
	 * written until the user actually interacts with it, so an untouched field never overwrites a
	 * token whose value differed from the seed).
	 */
	private renderMassVisionFields(tokens: Token[]): void {
		const seed = tokens[0];
		if (!seed) return;
		const wrap = this.el.createDiv({ cls: "map-manager-field" });
		wrap.createEl("label", { text: "Vision (zone visible par le meneur de jeu uniquement)" });
		const row = wrap.createDiv({ cls: "map-manager-vision-row" });

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
	}

	/**
	 * Light editor (see `Token.lightRadius`/`lightLife`/`resolveLightRadius`/`castLightRays`) — a
	 * radius (in cells) within which this token's own light reveals every entity token around it and
	 * hides the fog, blocked by walls. For "player" tokens this is also the *only* source of their fog
	 * reveal (no directional vision cone), including what permanently marks `exploredCells` — see
	 * `FogRenderer.recomputeFrame`. Edit mode only (see `renderTokenPanel`) — during play a light is
	 * driven by the gamepad (drain on move/action, L1/R1), so "Vue" mode shows none of this.
	 *
	 * Every category gets the radius input (`lightRadius`). "player"/"light" tokens additionally get a
	 * "life" slider (`lightLife`, 0-100, doubling as the lit fraction of the radius — `0` means the
	 * light is out but the radius is kept) plus two drain toggles (`lightDrainOnMove`/`lightMoveDrain`,
	 * `lightDrainOnAction`/`lightActionDrain`) that burn the life down as the token moves/acts (see
	 * `MapController.drainLightForEvent`). The old `lightEnabled` on/off checkbox is gone — `lightLife`
	 * covers it.
	 *
	 * `seed` supplies the displayed starting values (only, same convention as `renderMassVisionFields`
	 * — nothing is written until a control is actually touched); `update` is either a single-token
	 * `updateToken` or a `massUpdateTokens` closure — each token in a mass update reads/writes its own
	 * fields, only `seed` (for what to initially display) is shared across the whole selection.
	 */
	private renderLightRadiusField(seed: Token, update: (mutator: (token: Token) => void) => void): void {
		const wrap = this.el.createDiv({ cls: "map-manager-field" });
		wrap.createEl("label", { text: "Lumière (cache le brouillard, bloquée par les murs)" });
		const row = wrap.createDiv({ cls: "map-manager-vision-row" });

		const radiusField = row.createDiv({ cls: "map-manager-field-inline" });
		radiusField.createEl("label", { text: "Rayon (cases)" });
		const input = radiusField.createEl("input", { type: "number" });
		input.value = String(configuredLightRadius(seed));
		input.onchange = () => {
			const v = parseFloat(input.value);
			if (Number.isNaN(v)) return;
			update((t) => (t.lightRadius = Math.max(0, v)));
		};

		const category = seed.category ?? "entity";
		if (category !== "player" && category !== "light") return;

		this.makeSliderField(row, "Vie (%)", seed.lightLife ?? DEFAULT_LIGHT_LIFE, 0, 100, (v) => update((t) => (t.lightLife = clamp(v, 0, 100))), 5);

		this.renderLightDrainRow(
			row,
			"Perte au mouvement",
			seed.lightDrainOnMove !== false,
			seed.lightMoveDrain ?? DEFAULT_LIGHT_MOVE_DRAIN,
			(on) => update((t) => (t.lightDrainOnMove = on)),
			(v) => update((t) => (t.lightMoveDrain = Math.max(0, v)))
		);
		this.renderLightDrainRow(
			row,
			"Perte à l'action",
			seed.lightDrainOnAction !== false,
			seed.lightActionDrain ?? DEFAULT_LIGHT_ACTION_DRAIN,
			(on) => update((t) => (t.lightDrainOnAction = on)),
			(v) => update((t) => (t.lightActionDrain = Math.max(0, v)))
		);
	}

	/** One drain toggle for `renderLightRadiusField`: a checkbox (`onToggle`) plus a "% of life per event" number input (`onValue`). */
	private renderLightDrainRow(
		row: HTMLElement,
		label: string,
		checked: boolean,
		drainValue: number,
		onToggle: (on: boolean) => void,
		onValue: (percent: number) => void
	): void {
		const field = row.createDiv({ cls: "map-manager-field-inline" });
		const checkLabel = field.createEl("label");
		const checkbox = checkLabel.createEl("input", { type: "checkbox" });
		checkbox.checked = checked;
		checkLabel.appendText(` ${label}`);
		checkbox.onchange = () => onToggle(checkbox.checked);

		const number = field.createEl("input", { type: "number" });
		number.min = "0";
		number.max = "100";
		number.value = String(drainValue);
		number.title = "% de vie retirés à chaque événement";
		number.onchange = () => {
			const v = parseFloat(number.value);
			if (!Number.isNaN(v)) onValue(v);
		};
	}

	/** Bulk blocker-type editor for mass-selected wall *segments* — unlike the single-point editor, this never touches a whole connected shape, only exactly the segments in the selection. */
	private renderMassWallSegmentPanel(): void {
		const blockerField = this.el.createDiv({ cls: "map-manager-field" });
		blockerField.createEl("label", { text: "Type de mur" });
		const blockerSelect = blockerField.createEl("select");
		const keepOpt = blockerSelect.createEl("option", { text: "— ne pas changer —" });
		keepOpt.value = "";
		for (const opt of WALL_BLOCKER_TYPE_OPTIONS) {
			const optEl = blockerSelect.createEl("option", { text: opt.label });
			optEl.value = opt.value;
		}
		blockerSelect.value = "";
		blockerSelect.onchange = () => {
			if (isWallBlockerTypeValue(blockerSelect.value)) this.controller.massSetWallSegmentsBlockerType(blockerSelect.value);
		};

		const count = this.controller.massSelectedWallSegmentIds.size;
		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", {
			text: count > 1 ? "Supprimer les segments" : "Supprimer le segment",
			cls: "map-manager-btn map-manager-btn-danger",
		});
		deleteBtn.onclick = () => this.controller.massRemoveWallSegments();
	}

	/**
	 * Bulk editor for mass-selected "stamps": grid cells on a celled grid type, or `Marker`s on grid
	 * type "none" — no zone-type field, same as the single-cell panel (`renderEditMode`'s own doc
	 * comment): zone type is exclusively painted with the toolbar's brush/fill tool.
	 */
	private renderMassStampPanel(isNoneGrid: boolean): void {
		const stampField = this.el.createDiv({ cls: "map-manager-field" });
		stampField.createEl("label", { text: "Logo" });
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

	/**
	 * This is now purely a tampon (stamp/label/links) editor — zone type is exclusively painted with
	 * the toolbar's "Pinceau" brush/fill tool (see `Toolbar.renderZonesGroup`), not edited here, so
	 * there's no `zoneTypeId` field. "Vider la case" still clears it along with everything else, since
	 * that's a blanket reset rather than a live zone-type editor.
	 */
	private renderEditMode(key: string, cell: CellData): void {
		// Stamp
		const stampField = this.el.createDiv({ cls: "map-manager-field" });
		stampField.createEl("label", { text: "Logo" });
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
		stampField.createEl("label", { text: "Logo" });
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
		blockerField.createEl("label", { text: "Type de mur" });
		const blockerSelect = blockerField.createEl("select");
		for (const opt of WALL_BLOCKER_TYPE_OPTIONS) {
			const optEl = blockerSelect.createEl("option", { text: opt.label });
			optEl.value = opt.value;
		}
		// Segments connected to this point may not all share the same type; leave the control on its
		// first option in that case rather than misrepresenting a single value.
		const firstType = segments[0]?.blockerType;
		const allSame = segments.every((s) => s.blockerType === firstType);
		if (allSame && firstType) blockerSelect.value = firstType;
		blockerSelect.onchange = () => {
			if (isWallBlockerTypeValue(blockerSelect.value)) this.controller.setWallPointBlockerType(pointId, blockerSelect.value);
		};
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
		blockerField.createEl("label", { text: "Type de mur" });
		const blockerSelect = blockerField.createEl("select");
		for (const opt of WALL_BLOCKER_TYPE_OPTIONS) {
			const optEl = blockerSelect.createEl("option", { text: opt.label });
			optEl.value = opt.value;
		}
		blockerSelect.value = segment.blockerType;
		blockerSelect.onchange = () => {
			if (isWallBlockerTypeValue(blockerSelect.value)) this.controller.setWallSegmentBlockerType(segment.id, blockerSelect.value);
		};

		const hint = this.el.createDiv({ cls: "map-manager-infopanel-empty" });
		hint.setText("Double-cliquez sur ce segment pour y ajouter un point et modifier sa forme.");

		this.renderWallClockTriggerSection(segment);

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", { text: "Supprimer ce segment", cls: "map-manager-btn map-manager-btn-danger" });
		deleteBtn.onclick = () => this.controller.removeWallSegment(segment.id);
	}

	/**
	 * Wires a wall segment to one or more `Clock`s via `WallClockTrigger` — only ever actually rolled
	 * when a player forces a crossing of this segment with the gamepad's interact-to-pass action (see
	 * `MapCanvas.handleGamepadMove`/`MapController.triggerWallClock`), i.e. only for "Passage"/"Passage
	 * vitré" walls (`WALL_BLOCKER_TYPE_OPTIONS`) — an "Opaque"/"Transparent" wall can never be crossed
	 * at all, so a trigger configured there would simply never fire.
	 */
	private renderWallClockTriggerSection(segment: WallSegment): void {
		const clocks = this.controller.getData().clocks;
		const section = this.el.createDiv({ cls: "map-manager-field" });
		section.createEl("label", { text: "Horloge(s) déclenchée(s) à l'interaction" });

		const hint = section.createDiv({ cls: "map-manager-view-empty" });
		hint.setText('Ne se déclenche que si un joueur force le passage (manette) sur un mur "passage" ou "passage vitré".');

		if (clocks.length === 0) {
			section.createDiv({ cls: "map-manager-view-empty", text: "Aucune horloge créée pour l'instant (voir la barre de drapeaux en haut de la carte)." });
			return;
		}

		const trigger = segment.clockTrigger;

		const chanceField = section.createDiv({ cls: "map-manager-field-inline" });
		chanceField.createEl("label", { text: "Chance (1-20, jet ≥ ce chiffre = rien)" });
		const chanceInput = chanceField.createEl("input", { type: "number" });
		chanceInput.min = "1";
		chanceInput.max = "20";
		chanceInput.value = String(trigger?.chance ?? 10);
		chanceInput.onchange = () => {
			const v = clamp(parseInt(chanceInput.value, 10) || 1, 1, 20);
			this.controller.updateWallSegmentClockTrigger(segment.id, (t) => (t.chance = v));
		};

		const list = section.createDiv({ cls: "map-manager-clock-trigger-list" });
		for (const clock of clocks) {
			const link = trigger?.links.find((l) => l.clockId === clock.id);
			const row = list.createDiv({ cls: "map-manager-clock-trigger-row" });

			const checkboxLabel = row.createEl("label", { cls: "map-manager-clock-trigger-checkbox" });
			const checkbox = checkboxLabel.createEl("input", { type: "checkbox" });
			checkbox.checked = !!link;
			checkboxLabel.appendText(` ${clock.name || "Horloge"}`);

			const deltaInput = row.createEl("input", { type: "number", cls: "map-manager-clock-trigger-delta" });
			deltaInput.value = String(link?.delta ?? 1);
			deltaInput.disabled = !link;
			deltaInput.title = "Cases cochées (positif) ou décochées (négatif)";

			checkbox.onchange = () => {
				const checked = checkbox.checked;
				this.controller.updateWallSegmentClockTrigger(segment.id, (t) => {
					if (checked) {
						if (!t.links.some((l) => l.clockId === clock.id)) t.links.push({ clockId: clock.id, delta: Number(deltaInput.value) || 1 });
					} else {
						t.links = t.links.filter((l) => l.clockId !== clock.id);
					}
				});
			};
			deltaInput.onchange = () => {
				const v = Number(deltaInput.value);
				if (Number.isNaN(v) || v === 0) return;
				this.controller.updateWallSegmentClockTrigger(segment.id, (t) => {
					const l = t.links.find((l) => l.clockId === clock.id);
					if (l) l.delta = v;
				});
			};
		}

		if (trigger && trigger.links.length > 0) {
			const clearBtn = section.createEl("button", { text: "Retirer le déclencheur", cls: "map-manager-btn" });
			clearBtn.onclick = () => this.controller.clearWallSegmentClockTrigger(segment.id);
		}
	}

	// ---- Clocks (map-level progress trackers, editable in both edit and view mode) ----

	/**
	 * The "Horloge" panel: an optional name, its two "visible sur la vue joueur" toggles (whole clock,
	 * and just the name), the "morceaux totaux" wedge count (see `Clock`'s own doc comment on why
	 * there's no more one-row-per-wedge add/remove), a chronological (index-order) list of each wedge's
	 * own note link plus its fill-boundary toggle (`clickClockSegment` — the only way progress is ever
	 * changed, same as clicking a wedge on `ClockBar` itself; there's no separate "morceaux actuels"
	 * field), and a delete footer. Shown identically in edit and view mode — same reasoning as
	 * `renderLightRadiusField`: a GM plausibly ticks a clock live mid-session, not just authors it
	 * ahead of time.
	 */
	private renderClockPanel(clock: Clock): void {
		const nameField = this.el.createDiv({ cls: "map-manager-field" });
		nameField.createEl("label", { text: "Nom (facultatif)" });
		const nameInput = nameField.createEl("input", { type: "text" });
		nameInput.value = clock.name;
		nameInput.placeholder = "Sans nom";
		nameInput.onchange = () => this.controller.updateClock(clock.id, (c) => (c.name = nameInput.value.trim()));

		const visibleField = this.el.createDiv({ cls: "map-manager-checkbox-field" });
		const visibleLabel = visibleField.createEl("label");
		const visibleCheckbox = visibleLabel.createEl("input", { type: "checkbox" });
		visibleCheckbox.checked = clock.visibleToPlayers !== false;
		visibleLabel.appendText(" Horloge visible sur la vue joueur");
		visibleCheckbox.onchange = () => this.controller.updateClock(clock.id, (c) => (c.visibleToPlayers = visibleCheckbox.checked));

		// Meaningless with no name to hide — only offered once one's actually set. Always shown (and
		// always effective) on the GM's own edit/embed windows regardless of this flag — see
		// `Clock.nameVisibleToPlayers`'s own doc comment; this only ever hides it on the mirror.
		if (clock.name.trim()) {
			const nameVisibleField = this.el.createDiv({ cls: "map-manager-checkbox-field" });
			const nameVisibleLabel = nameVisibleField.createEl("label");
			const nameVisibleCheckbox = nameVisibleLabel.createEl("input", { type: "checkbox" });
			nameVisibleCheckbox.checked = clock.nameVisibleToPlayers !== false;
			nameVisibleLabel.appendText(" Nom visible sur la vue joueur");
			nameVisibleCheckbox.onchange = () => this.controller.updateClock(clock.id, (c) => (c.nameVisibleToPlayers = nameVisibleCheckbox.checked));
		}

		const totalField = this.el.createDiv({ cls: "map-manager-field" });
		totalField.createEl("label", { text: "Morceaux totaux" });
		const totalInput = totalField.createEl("input", { type: "number" });
		totalInput.min = "1";
		totalInput.value = String(clock.segments.length);
		totalInput.onchange = () => {
			const v = parseInt(totalInput.value, 10);
			if (!Number.isNaN(v) && v > 0) this.controller.setClockTotalSegments(clock.id, v);
		};

		// No standalone "morceaux actuels" field any more — progress is only ever changed by clicking a
		// wedge (`clickClockSegment`, below), same as on `ClockBar` itself, or via a wall's clock trigger.
		const segmentsField = this.el.createDiv({ cls: "map-manager-field" });
		segmentsField.createEl("label", { text: "Notes liées, dans l'ordre chronologique des morceaux" });
		const list = segmentsField.createDiv({ cls: "map-manager-clock-segment-list" });
		clock.segments.forEach((segment, i) => {
			const filled = i < clock.currentSegments;
			const row = list.createDiv({ cls: "map-manager-clock-segment-row" });

			const toggleBtn = row.createEl("button", { text: filled ? "●" : "○", cls: "map-manager-btn map-manager-btn-icon" });
			setTooltip(toggleBtn, `Morceau ${i + 1}`);
			toggleBtn.onclick = () => this.controller.clickClockSegment(clock.id, i);

			if (segment.link) {
				const pill = row.createDiv({ cls: "map-manager-link-pill" });
				const a = pill.createEl("a", { text: linkTabLabel(segment.link), href: "#" });
				const linkValue = segment.link;
				a.onclick = (e) => {
					e.preventDefault();
					void this.app.workspace.openLinkText(linkValue, "", false);
				};
				const remove = pill.createEl("span", { text: "×", cls: "map-manager-link-remove" });
				remove.onclick = () =>
					this.controller.updateClock(clock.id, (c) => {
						const s = c.segments[i];
						if (s) s.link = undefined;
					});
			} else {
				const pickBtn = row.createEl("button", { text: "Lier une note", cls: "map-manager-btn" });
				pickBtn.onclick = () =>
					this.pickLink((link) =>
						this.controller.updateClock(clock.id, (c) => {
							const s = c.segments[i];
							if (s) s.link = link;
						})
					);
			}
		});

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", { text: "Supprimer l'horloge", cls: "map-manager-btn map-manager-btn-danger" });
		deleteBtn.onclick = () => this.controller.removeClock(clock.id);
	}

	// ---- Tokens (full edit panel in edit mode; reduced read-mostly panel in view mode) ----

	private renderTokenPanel(token: Token): void {
		if (this.controller.mode === "view") {
			this.renderTokenViewPanel(token);
			return;
		}

		const category = token.category ?? "entity";
		const categoryField = this.el.createDiv({ cls: "map-manager-field" });
		categoryField.createEl("label", { text: "Catégorie" });
		const categorySelect = categoryField.createEl("select");
		const playerOpt = categorySelect.createEl("option", { text: "Joueur" });
		playerOpt.value = "player";
		const entityOpt = categorySelect.createEl("option", { text: "Entité" });
		entityOpt.value = "entity";
		const lightOpt = categorySelect.createEl("option", { text: "Lumière" });
		lightOpt.value = "light";
		categorySelect.value = category;
		categorySelect.onchange = () => {
			const value = categorySelect.value === "player" || categorySelect.value === "light" ? categorySelect.value : "entity";
			this.controller.updateToken(token.id, (t) => applyTokenCategory(t, value));
		};

		// "light" is a pure light fixture with nothing to configure beyond its radius — see
		// `TokenCategory`'s own doc comment. Everything else below (icon/image/name/rotation/vision/
		// size/color/template/tabs) only makes sense for an actual character.
		if (category === "light") {
			this.renderLightRadiusField(token, (mutator) => this.controller.updateToken(token.id, mutator));
			const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
			const deleteBtn = footer.createEl("button", { text: "Supprimer le pion", cls: "map-manager-btn map-manager-btn-danger" });
			deleteBtn.onclick = () => this.controller.removeToken(token.id);
			return;
		}

		const iconField = this.el.createDiv({ cls: "map-manager-field" });
		iconField.createEl("label", { text: "Logo" });
		const quickRow = iconField.createDiv({ cls: "map-manager-stamp-row" });
		for (const s of QUICK_TOKEN_ICONS) {
			const btn = quickRow.createEl("button", { text: s, cls: "map-manager-stamp-btn" });
			if (token.icon === s) btn.addClass("is-active");
			btn.onclick = () => this.controller.updateToken(token.id, (t) => (t.icon = token.icon === s ? "" : s));
		}
		const imageRow = iconField.createDiv({ cls: "map-manager-field-inline" });
		const chooseBtn = imageRow.createEl("button", { text: "Image du vault", cls: "map-manager-btn" });
		chooseBtn.onclick = () => void this.pickVaultTokenImage(token);
		if (token.image) {
			const clearBtn = imageRow.createEl("button", { text: "Retirer l'image", cls: "map-manager-btn" });
			clearBtn.onclick = () => this.controller.updateToken(token.id, (t) => (t.image = undefined));
		}

		const nameField = this.el.createDiv({ cls: "map-manager-field" });
		nameField.createEl("label", { text: "Nom" });
		const nameInput = nameField.createEl("input", { type: "text" });
		nameInput.value = token.label ?? "";
		nameInput.placeholder = "Nom du personnage";
		nameInput.onchange = () => this.controller.updateToken(token.id, (t) => (t.label = nameInput.value || undefined));

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

		this.renderLightRadiusField(token, (mutator) => this.controller.updateToken(token.id, mutator));

		// Vision (rotation + eye-cone shape), entity-only — a player's fog reveal is their light above,
		// omnidirectional, no facing to configure.
		if (category === "entity") {
			this.renderRotationField(token);
			this.renderVisionFields(token);
		}

		const templateField = this.el.createDiv({ cls: "map-manager-field" });
		templateField.createEl("label", { text: "Modèle de statistiques" });
		if (category === "player") {
			// Always the "Joueur" template — locked, only editable from Settings (name/fields/tabs),
			// never a per-token choice — see `PLAYER_TEMPLATE_ID`.
			const playerTemplate = this.deps.settings.defaultTokenTemplates.find((t) => t.id === PLAYER_TEMPLATE_ID);
			const lockedSelect = templateField.createEl("select");
			lockedSelect.disabled = true;
			const opt = lockedSelect.createEl("option", { text: playerTemplate?.name ?? "Joueur" });
			opt.selected = true;
		} else {
			// Never offered to an "entity" token — reserved for players (see above). Defaults to the
			// first remaining template as long as nothing's been picked yet.
			const selectableTemplates = this.deps.settings.defaultTokenTemplates.filter((t) => !t.reserved);
			const templateSelect = templateField.createEl("select");
			const noneOpt = templateSelect.createEl("option", { text: "— aucun —" });
			noneOpt.value = "";
			for (const t of selectableTemplates) {
				const opt = templateSelect.createEl("option", { text: t.name });
				opt.value = t.id;
			}
			const effectiveId = token.templateId ?? selectableTemplates[0]?.id ?? "";
			templateSelect.value = effectiveId;
			templateSelect.onchange = () => this.controller.updateToken(token.id, (t) => (t.templateId = templateSelect.value || undefined));
		}
		if (category === "entity" && this.deps.settings.defaultTokenTemplates.every((t) => t.reserved)) {
			templateField.createDiv({ cls: "map-manager-view-empty", text: "Aucun modèle défini pour les entités (Réglages du plugin)." });
		}

		this.renderTokenTabsEditor(token);

		const footer = this.el.createDiv({ cls: "map-manager-infopanel-footer" });
		const deleteBtn = footer.createEl("button", { text: "Supprimer le pion", cls: "map-manager-btn map-manager-btn-danger" });
		deleteBtn.onclick = () => this.controller.removeToken(token.id);
	}

	/**
	 * View mode ("Vue", still GM-facing) only shows what's needed mid-session: a static logo+name
	 * header (`renderTokenLogoAndName`), rotation (entity-only — its own GM-only vision zone points
	 * wherever this faces, drawn continuously here instead of only-while-selected like edit mode; a
	 * player's fog reveal is their light, omnidirectional, with no facing to show), a gamepad picker
	 * (player-only — `renderGamepadField`, see its own doc comment), and tabs' read-only content
	 * (stats/inventory/story/... — see `renderTokenTabsReadOnly`, which applies to both categories).
	 * Everything else (icon/image/category/size/color/template picker/vision shape/delete) is
	 * edit-only, and so is the whole light setup (radius/life/drain) — during play a light is driven
	 * by the gamepad (drain on move/action, L1/R1), not this menu. A "light" token has neither a
	 * facing, a gamepad, nor tabs to begin with (see `TokenCategory`'s own doc comment), so it just
	 * gets a short note here.
	 */
	private renderTokenViewPanel(token: Token): void {
		const category = token.category ?? "entity";
		if (category === "light") {
			this.el.createDiv({ cls: "map-manager-view-empty", text: "Source de lumière — invisible pour les joueurs." });
			return;
		}
		this.renderTokenLogoAndName(token);
		if (category === "entity") this.renderRotationField(token);
		if (category === "player") this.renderGamepadField(token);
		this.renderTokenTabsReadOnly(token);
	}

	/**
	 * Assigns/unassigns a connected gamepad to drive `token` (a player token, cell-by-cell, blocked by
	 * walls — see `MapCanvas`'s `GamepadInputPoller`/`handleGamepadMove`). Vue mode only (see
	 * `renderTokenViewPanel`): gamepad-driven movement itself only runs in view mode, so offering the
	 * picker in edit mode would just be confusing (assign, then nothing happens until switching to
	 * "Vue"). `listConnectedGamepads` is re-read on every render — kept fresh live by the constructor's
	 * `gamepadconnected`/`gamepaddisconnected` listeners on top of the usual `MapController` change
	 * feed. `MapController.assignGamepad` itself enforces one gamepad per token (and vice versa), so
	 * picking a gamepad already assigned elsewhere here silently steals it from whichever token had it.
	 */
	private renderGamepadField(token: Token): void {
		const wrap = this.el.createDiv({ cls: "map-manager-field" });
		wrap.createEl("label", { text: "Manette" });
		const select = wrap.createEl("select");
		const noneOpt = select.createEl("option", { text: "— aucune —" });
		noneOpt.value = "";

		const pads: GamepadInfo[] = listConnectedGamepads();
		const assignedIndex = this.controller.gamepadForToken(token.id);
		// A gamepad the browser hasn't reported input from yet this page load simply isn't in
		// `listConnectedGamepads` (see its own doc comment) — keep an already-assigned one in the list
		// regardless, so the assignment doesn't visually vanish just because nobody's touched it since.
		if (assignedIndex !== null && !pads.some((p) => p.index === assignedIndex)) {
			pads.push({ index: assignedIndex, id: `Manette ${assignedIndex + 1}` });
		}
		for (const pad of pads) {
			const opt = select.createEl("option", { text: pad.id });
			opt.value = String(pad.index);
		}
		select.value = assignedIndex !== null ? String(assignedIndex) : "";
		select.onchange = () => {
			if (select.value === "") {
				if (assignedIndex !== null) this.controller.unassignGamepad(assignedIndex);
			} else {
				this.controller.assignGamepad(Number(select.value), token.id);
			}
		};

		if (pads.length === 0) {
			wrap.createDiv({ cls: "map-manager-view-empty", text: "Aucune manette détectée — appuyez sur un bouton de la manette pour la connecter." });
		}
	}

	/** Static (non-editable) logo + name header for a token, Vue MJ only — the editable equivalent lives in `renderTokenPanel`'s own "Logo"/"Nom" fields. */
	private renderTokenLogoAndName(token: Token): void {
		const row = this.el.createDiv({ cls: "map-manager-token-view-header" });
		if (token.image) {
			row.createEl("img", { cls: "map-manager-token-view-logo", attr: { src: this.app.vault.adapter.getResourcePath(token.image) } });
		} else if (token.icon) {
			row.createSpan({ cls: "map-manager-token-view-logo-icon", text: token.icon });
		}
		row.createSpan({ cls: "map-manager-token-view-name", text: token.label || "(sans nom)" });
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

	/**
	 * Loads `file` and writes a resized/cropped copy (see `resizeImageToSquare`,
	 * `settings.tokenImageSize`) rather than pointing `token.image` straight at the picked file — a
	 * large source image (a full-resolution character portrait, say) shouldn't get stored and
	 * reloaded at full resolution just to be drawn as a small icon.
	 */
	private async pickVaultTokenImage(token: Token): Promise<void> {
		const files = this.app.vault.getFiles().filter((f) => IMAGE_EXTENSIONS.includes(f.extension.toLowerCase()));
		new FileSuggestModal(
			this.app,
			files,
			(file: TFile) => {
				void (async () => {
					try {
						const resizedPath = await resizeImageToSquare(this.app, file.path, this.deps.settings.tokenImageSize, this.deps.assetsFolder);
						this.controller.updateToken(token.id, (t) => (t.image = resizedPath));
					} catch (e) {
						console.error("Map Manager: échec du redimensionnement de l'image du pion", e);
						new Notice(e instanceof Error ? e.message : "Échec du redimensionnement de l'image.");
					}
				})();
			},
			"Choisir une image du vault..."
		).open();
	}

	/** The token's own facing arrow (entity-only in the UI — see `drawTokenFacingArrow`). */
	private renderRotationField(token: Token): void {
		const wrap = this.el.createDiv({ cls: "map-manager-field" });
		this.makeRotationDialField(wrap, "Rotation (°, 0=est, horaire)", token.rotation ?? DEFAULT_TOKEN_ROTATION, (v) =>
			this.controller.updateToken(token.id, (t) => (t.rotation = v))
		);
	}

	/**
	 * Entity-only (see `renderTokenPanel`) — `renderEntityEyeFields`'s eye-angle + 3-tier controls,
	 * only ever a GM-only hint, never touching fog, plus `visionRange` (reach). The direction itself
	 * is `token.rotation` (see `renderRotationField`) — the cone(s) just point wherever the token is
	 * facing, nothing to configure here beyond shape/reach.
	 */
	private renderVisionFields(token: Token): void {
		const wrap = this.el.createDiv({ cls: "map-manager-field" });
		wrap.createEl("label", { text: "Vision (zone visible par le meneur de jeu uniquement)" });
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

		this.renderEntityEyeFields(token, row);
		makeNumberInput("Portée (cases)", token.visionRange ?? DEFAULT_VISION_RANGE, (v) => this.controller.updateToken(token.id, (t) => (t.visionRange = Math.max(0, v))));
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
		const step = this.deps.settings.tokenRotationStep || 10;
		const field = container.createDiv({ cls: "map-manager-field-inline map-manager-slider-field" });
		field.createEl("label", { text: labelText });
		const slider = field.createEl("input", { type: "range", cls: "map-manager-vision-slider" });
		slider.min = "-180";
		slider.max = "180";
		slider.step = String(step);
		slider.value = "0";
		const number = field.createEl("input", { type: "number", cls: "map-manager-vision-number" });
		number.min = "0";
		number.max = "360";
		number.step = String(step);
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

import { App, Notice, TFile, setIcon, setTooltip } from "obsidian";
import { MapController, PLAYER_MIRROR_CAMERA_MODES, PLAYER_MIRROR_CAMERA_MODE_LABELS, PlayerMirrorCameraMode } from "../controller/MapController";
import { GRID_TYPE_LABELS, GRID_TYPES, GridType, MapBackground, MapFileData, getActiveLayer } from "../data/mapData";
import { ABS_MAX_ZOOM, ABS_MIN_ZOOM, clamp, hexCorners } from "../grid/gridMath";
import { MapManagerSettings } from "../settings/types";
import { FileSuggestModal, IMAGE_EXTENSIONS } from "./FileSuggestModal";
import { WALL_BLOCKER_TYPE_OPTIONS, isWallBlockerTypeValue } from "./wallBlockerTypeOptions";

export interface ToolbarActions {
	recenter: () => void;
	/** Writes/updates the redacted `<basename>.json` next to the map file — see `publishPublicSnapshot`. */
	publish: () => void;
	/** Switches this window to "Vue" (GMs run live sessions from there) and pops open a read-only mirror of the map in a new OS window, for dragging onto a second monitor — see `openPlayerWindow`. */
	openPlayerWindow: () => void;
	/** Whether a player-mirror window for this map is currently open — see `openPlayerWindow.isPlayerWindowOpen`. Toolbar polls this on every render rather than caching it, since opening/closing that window doesn't itself touch `MapController`. */
	isPlayerWindowOpen: () => boolean;
	/** Extracts one layer into a brand-new standalone `.map` file — see `extractLayerToNewMap`. */
	extractLayer: (layerId: string) => void;
}

export interface ToolbarDeps {
	assetsFolder: string;
	settings: MapManagerSettings;
}

/** How far (in CSS px) the cursor can wander from the "Zones"/"Murs" tool panel before it auto-collapses — see `Toolbar.handleToolPanelMouseMove`. */
const TOOL_PANEL_HOVER_DISTANCE = 40;

function buildGridIcon(svg: SVGSVGElement, gridType: GridType): void {
	svg.setAttribute("viewBox", "0 0 20 20");
	svg.addClass("map-manager-grid-icon");
	if (gridType === "none") {
		svg.createSvg("rect", { attr: { x: "3", y: "3", width: "14", height: "14", "stroke-dasharray": "2.5,2.5" } });
		return;
	}
	if (gridType === "square") {
		svg.createSvg("rect", { attr: { x: "3", y: "3", width: "14", height: "14" } });
		return;
	}
	const orientation = gridType === "hex-pointy" ? "pointy" : "flat";
	const points = hexCorners(10, 10, 8, orientation)
		.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
		.join(" ");
	svg.createSvg("polygon", { attr: { points } });
}

/**
 * Boutons communs, dans l'ordre : Annuler/Rétablir (avant tout) ; puis, selon le mode, les groupes
 * propres à l'Édition (Calques, Image, Grillage, Zones, Murs) ou à la Vue (Calques, grillage,
 * Brouillard) ; puis, communs à nouveau, Recentrer, Vue Joueur (qui regroupe "Publier la vue" et ses
 * options une fois lancée), et enfin Info (aide-mémoire des raccourcis), collé tout à droite.
 *
 * Dropdowns (grille / calques / image / brouillard / vue joueur / info) sont mutuellement exclusifs et
 * partagent un seul gestionnaire de fermeture au clic extérieur.
 */
export class Toolbar {
	el: HTMLElement;
	private unsubscribe: () => void;
	private gridMenuOpen = false;
	private layersMenuOpen = false;
	private imageMenuOpen = false;
	private fogMenuOpen = false;
	private playerWindowMenuOpen = false;
	private infoMenuOpen = false;
	private openDropdownEl: HTMLElement | null = null;
	/**
	 * Unlike the click-toggled dropdowns above, the "Zones"/"Murs" tool panel (brush/fill/wall options)
	 * stays tied to `activeTool` itself — selecting the tool doesn't just open a menu, it also arms the
	 * canvas tool, so there's no click-outside-to-close without also deactivating the tool. Instead it
	 * auto-collapses once the cursor wanders too far (`handleToolPanelMouseMove`), purely a rendering
	 * concern: the tool stays active and every setting in the panel (brush radius, bucket tolerances,
	 * blocker type, ...) lives on the controller, so hiding the panel never touches any of it. `false`
	 * initially: nothing to hide before a tool is picked, and picking one re-opens it (see `render`).
	 */
	private toolPanelOpen = false;
	private toolPanelWasActive = false;
	/**
	 * The trigger button is tracked separately from the panel because the panel is `position: absolute`
	 * (see `.map-manager-dropdown-panel`) — it sits outside its wrapper's own layout box, so the wrapper's
	 * `getBoundingClientRect()` alone only covers the button, never the panel below it. Both are measured
	 * in `handleToolPanelMouseMove` so hovering anywhere over the actual panel content never counts as
	 * "too far", however far that puts the cursor from the button itself. `toolPanelPanelEl` is null
	 * whenever the panel isn't currently rendered (closed, or no such tool active).
	 */
	private toolPanelTriggerEl: HTMLElement | null = null;
	private toolPanelPanelEl: HTMLElement | null = null;

	constructor(container: HTMLElement, private app: App, private deps: ToolbarDeps, private controller: MapController, private actions: ToolbarActions) {
		this.el = container.createDiv({ cls: "map-manager-toolbar" });
		this.render();
		this.unsubscribe = this.controller.onChange(() => this.render());
		document.addEventListener("mousedown", this.handleDocumentClick, true);
		document.addEventListener("mousemove", this.handleToolPanelMouseMove);
	}

	destroy(): void {
		this.unsubscribe();
		document.removeEventListener("mousedown", this.handleDocumentClick, true);
		document.removeEventListener("mousemove", this.handleToolPanelMouseMove);
	}

	private closeMenus(): void {
		this.gridMenuOpen = false;
		this.layersMenuOpen = false;
		this.imageMenuOpen = false;
		this.fogMenuOpen = false;
		this.playerWindowMenuOpen = false;
		this.infoMenuOpen = false;
	}

	private handleDocumentClick = (e: MouseEvent): void => {
		if (!this.openDropdownEl) return;
		if (this.openDropdownEl.contains(e.target as Node)) return;
		this.closeMenus();
		this.render();
	};

	/**
	 * Closing and re-opening the "Zones"/"Murs" tool panel are deliberately asymmetric:
	 * - Open → close: forgiving. It only collapses once the cursor strays more than
	 *   `TOOL_PANEL_HOVER_DISTANCE` from *both* the trigger button and the panel itself, so it never
	 *   closes while the cursor is actually over the panel's contents, however far that puts it from the
	 *   button that opened it.
	 * - Closed → open: deliberate. It only comes back by hovering directly over the trigger button
	 *   (an exact hit test, no halo) — otherwise it would keep popping open just from the cursor passing
	 *   near the toolbar on its way to/from the canvas.
	 * `toolPanelTriggerEl` is null whenever no brush/fill/wall tool is active, so this is a no-op the
	 * rest of the time. Re-renders only on an actual open/closed transition, not on every mouse move.
	 */
	private handleToolPanelMouseMove = (e: MouseEvent): void => {
		if (!this.toolPanelTriggerEl) return;
		if (this.toolPanelOpen) {
			const distanceTo = (el: HTMLElement): number => {
				const rect = el.getBoundingClientRect();
				const dx = Math.max(rect.left - e.clientX, e.clientX - rect.right, 0);
				const dy = Math.max(rect.top - e.clientY, e.clientY - rect.bottom, 0);
				return Math.hypot(dx, dy);
			};
			const distance = this.toolPanelPanelEl
				? Math.min(distanceTo(this.toolPanelTriggerEl), distanceTo(this.toolPanelPanelEl))
				: distanceTo(this.toolPanelTriggerEl);
			if (distance > TOOL_PANEL_HOVER_DISTANCE) {
				this.toolPanelOpen = false;
				this.render();
			}
		} else {
			const rect = this.toolPanelTriggerEl.getBoundingClientRect();
			const hoveringTrigger = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
			if (hoveringTrigger) {
				this.toolPanelOpen = true;
				this.render();
			}
		}
	};

	private render(): void {
		this.el.empty();
		this.openDropdownEl = null;
		this.toolPanelTriggerEl = null;
		this.toolPanelPanelEl = null;
		// Freshly picking a brush/fill/wall tool always (re-)opens its panel, regardless of how it was
		// last left — only a live tool's panel can auto-collapse by distance (`handleToolPanelMouseMove`).
		const toolHasPanel = this.controller.activeTool === "brush" || this.controller.activeTool === "fill" || this.controller.activeTool === "wall";
		if (toolHasPanel && !this.toolPanelWasActive) this.toolPanelOpen = true;
		this.toolPanelWasActive = toolHasPanel;
		const data = this.controller.getData();
		const activeLayer = this.controller.getActiveLayer();

		const tabsGroup = this.el.createDiv({ cls: "map-manager-mode-tabs" });
		const editBtn = tabsGroup.createEl("button", { text: "Édition", cls: "map-manager-mode-tab" });
		const viewBtn = tabsGroup.createEl("button", { text: "Vue", cls: "map-manager-mode-tab" });
		editBtn.toggleClass("is-active", this.controller.mode === "edit");
		viewBtn.toggleClass("is-active", this.controller.mode === "view");
		editBtn.onclick = () => this.controller.setMode("edit");
		viewBtn.onclick = () => this.controller.setMode("view");

		const historyGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
		const undoBtn = historyGroup.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
		setIcon(undoBtn, "undo-2");
		setTooltip(undoBtn, "Annuler");
		undoBtn.disabled = !this.controller.canUndo();
		undoBtn.onclick = () => this.controller.undo();
		const redoBtn = historyGroup.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
		setIcon(redoBtn, "redo-2");
		setTooltip(redoBtn, "Rétablir");
		redoBtn.disabled = !this.controller.canRedo();
		redoBtn.onclick = () => this.controller.redo();

		if (this.controller.mode === "edit") {
			this.renderLayersDropdown(this.el, data);
			this.renderImageDropdown(this.el, activeLayer, data);
			this.renderGridDropdown(this.el, data);
			this.renderZonesGroup(this.el, data);
			this.renderMursGroup(this.el);
		}

		if (this.controller.mode === "view") {
			this.renderLayersDropdown(this.el, data);

			if (data.gridType !== "none") {
				const viewGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
				const cellsBtn = viewGroup.createEl("button", { text: this.controller.showCells ? "Masquer le grillage" : "Afficher le grillage", cls: "map-manager-btn" });
				cellsBtn.onclick = () => this.controller.toggleShowCells();
			}

			// Fog runs even in grid type "none" (on its hidden square substrate — see MapCanvas),
			// so the toggle/reset controls aren't restricted to celled grid types.
			this.renderFogDropdown(this.el, data);
		}

		const recenterGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
		const resetBtn = recenterGroup.createEl("button", { text: "Recentrer", cls: "map-manager-btn" });
		resetBtn.onclick = () => this.actions.recenter();

		this.renderPlayerWindowControl(recenterGroup);

		this.renderInfoDropdown(this.el);
	}

	/**
	 * While no player-mirror window is open yet, this is a plain button: clicking it just pops one
	 * open (`actions.openPlayerWindow`), same as before. Once one is open, clicking instead opens a
	 * dropdown of live options for it — opening a second window isn't useful, so the click's meaning
	 * changes rather than adding a separate menu button. See `MapController.showEntityVisionToPlayers`
	 * (hidden by default), `playerMirrorFogEnabled` (enabled by default), `playerMirrorCameraMode`
	 * (segmented control at the top — `renderCameraModeRow`, defaults to "mirror"), and
	 * `actions.publish` (regrouped here rather than its own standalone toolbar button — a GM publishing
	 * a snapshot is something done right around launching the player-facing view, not before).
	 */
	private renderPlayerWindowControl(container: HTMLElement): void {
		const isOpen = this.actions.isPlayerWindowOpen();

		if (!isOpen) {
			const btn = container.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
			setIcon(btn, "monitor");
			setTooltip(btn, "Ouvrir la vue joueur dans une nouvelle fenêtre (à glisser sur un second écran)");
			btn.onclick = () => this.actions.openPlayerWindow();
			return;
		}

		const wrapper = container.createDiv({ cls: "map-manager-dropdown map-manager-player-window-dropdown" });
		wrapper.toggleClass("is-open", this.playerWindowMenuOpen);
		if (this.playerWindowMenuOpen) this.openDropdownEl = wrapper;

		const trigger = wrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-dropdown-trigger" });
		setIcon(trigger, "monitor");
		trigger.addClass("is-active");
		setTooltip(trigger, "Vue joueur (options)");
		setIcon(trigger.createSpan({ cls: "map-manager-dropdown-chevron" }), "chevron-down");
		trigger.onclick = () => {
			const wasOpen = this.playerWindowMenuOpen;
			this.closeMenus();
			this.playerWindowMenuOpen = !wasOpen;
			this.render();
		};

		const panel = wrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-player-window-dropdown-panel" });
		panel.createDiv({ cls: "map-manager-dropdown-title", text: "Vue joueur" });

		this.renderCameraModeRow(panel);

		const visionBtn = panel.createEl("button", {
			text: this.controller.showEntityVisionToPlayers ? "Masquer la vision des pions entités" : "Afficher la vision des pions entités",
			cls: "map-manager-btn",
		});
		visionBtn.toggleClass("is-active", this.controller.showEntityVisionToPlayers);
		visionBtn.onclick = () => this.controller.toggleShowEntityVisionToPlayers();

		const fogBtn = panel.createEl("button", {
			text: this.controller.playerMirrorFogEnabled ? "Désactiver le brouillard" : "Activer le brouillard",
			cls: "map-manager-btn",
		});
		fogBtn.toggleClass("is-active", this.controller.playerMirrorFogEnabled);
		fogBtn.onclick = () => this.controller.togglePlayerMirrorFog();

		const publishBtn = panel.createEl("button", { text: "Publier la vue", cls: "map-manager-btn" });
		setTooltip(publishBtn, "Met à jour le .json pour le site externe.");
		publishBtn.onclick = () => this.actions.publish();
	}

	/** Segmented control picking `MapController.playerMirrorCameraMode` — see `PlayerMirrorCameraMode`. */
	private renderCameraModeRow(panel: HTMLElement): void {
		const row = panel.createDiv({ cls: "map-manager-camera-mode-row" });
		const tooltips: Record<PlayerMirrorCameraMode, string> = {
			mirror: "La caméra de la vue joueur suit celle de cette fenêtre.",
			freeze: "La caméra de la vue joueur ne bouge plus ; cette fenêtre peut bouger librement sans l'influencer.",
			center: "La caméra de la vue joueur est indépendante et cadre automatiquement les pions joueurs, en zoomant selon leurs déplacements.",
		};
		for (const mode of PLAYER_MIRROR_CAMERA_MODES) {
			const btn = row.createEl("button", { text: PLAYER_MIRROR_CAMERA_MODE_LABELS[mode], cls: "map-manager-btn" });
			btn.toggleClass("is-active", this.controller.playerMirrorCameraMode === mode);
			setTooltip(btn, tooltips[mode]);
			btn.onclick = () => this.controller.setPlayerMirrorCameraMode(mode);
		}
	}

	/**
	 * "Info" — aide-mémoire statique des raccourcis clavier/souris, toujours collé tout à droite de la
	 * barre (voir `styles.css`). Pas de configuration ici — juste une référence consultable, groupée
	 * par contexte.
	 */
	private renderInfoDropdown(container: HTMLElement): void {
		const wrapper = container.createDiv({ cls: "map-manager-dropdown map-manager-info-dropdown" });
		wrapper.toggleClass("is-open", this.infoMenuOpen);
		if (this.infoMenuOpen) this.openDropdownEl = wrapper;

		const trigger = wrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-dropdown-trigger" });
		setIcon(trigger, "info");
		setTooltip(trigger, "Raccourcis");
		trigger.onclick = () => {
			const wasOpen = this.infoMenuOpen;
			this.closeMenus();
			this.infoMenuOpen = !wasOpen;
			this.render();
		};

		const panel = wrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-info-dropdown-panel" });
		panel.createDiv({ cls: "map-manager-dropdown-title", text: "Raccourcis" });

		const section = (title: string, shortcuts: [string, string][]) => {
			panel.createDiv({ cls: "map-manager-info-section-title", text: title });
			const list = panel.createDiv({ cls: "map-manager-info-shortcut-list" });
			for (const [keys, desc] of shortcuts) {
				const row = list.createDiv({ cls: "map-manager-info-shortcut-row" });
				row.createSpan({ cls: "map-manager-info-shortcut-keys", text: keys });
				row.createSpan({ cls: "map-manager-info-shortcut-desc", text: desc });
			}
		};

		section("Général", [
			["Molette", "Zoom / dézoom"],
			["Glisser (clic molette ou clic gauche)", "Se déplacer sur la carte"],
			["Clic droit", "Ajouter un pion/tampon, ou coller"],
			["Clic gauche", "Afficher les détails d'un pion/tampon existant"],
			["Ctrl + clic gauche", "Sélectionner plusieurs pions/tampons, un par un"],
			["Shift + glisser (clic gauche)", "Sélectionner plusieurs pions/tampons par zone"],
			["Échap", "Désélectionner tout / annuler l'action en cours"],
		]);
		section("Édition", [
			["Clic droit (outil Murs)", "Annuler le dernier point posé"],
			["Double-clic sur un mur", "Ajouter un point pour le remodeler"],
		]);
		section("Vue MJ", [
			["Ctrl + glisser (clic gauche)", "Déplacer d'un coup les pions sélectionnés"],
			["Glisser sur la carte", "Tracer un chemin que les pions sélectionnés suivront"],
		]);
	}

	/** Clicking the active grid icon opens a dropdown of the other grid types below it; picking one applies and closes it. */
	private renderGridDropdown(container: HTMLElement, data: MapFileData): void {
		const wrapper = container.createDiv({ cls: "map-manager-dropdown map-manager-grid-dropdown" });
		wrapper.toggleClass("is-open", this.gridMenuOpen);
		if (this.gridMenuOpen) this.openDropdownEl = wrapper;

		const trigger = wrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-dropdown-trigger" });
		setTooltip(trigger, `Grille : ${GRID_TYPE_LABELS[data.gridType]}`);
		const svg = trigger.createSvg("svg");
		buildGridIcon(svg, data.gridType);
		setIcon(trigger.createSpan({ cls: "map-manager-dropdown-chevron" }), "chevron-down");
		trigger.onclick = () => {
			const wasOpen = this.gridMenuOpen;
			this.closeMenus();
			this.gridMenuOpen = !wasOpen;
			this.render();
		};

		const panel = wrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-grid-dropdown-panel" });
		for (const gt of GRID_TYPES) {
			if (gt === data.gridType) continue;
			const optBtn = panel.createEl("button", { cls: "map-manager-btn map-manager-grid-btn" });
			setTooltip(optBtn, GRID_TYPE_LABELS[gt]);
			const optSvg = optBtn.createSvg("svg");
			buildGridIcon(optSvg, gt);
			optBtn.onclick = () => {
				this.gridMenuOpen = false;
				this.controller.update((d) => (d.gridType = gt));
			};
		}
	}

	/** Layers dropdown mirrors the grid/image dropdowns: closed by default, opened via its trigger, closed on outside click. */
	private renderLayersDropdown(container: HTMLElement, data: MapFileData): void {
		const wrapper = container.createDiv({ cls: "map-manager-dropdown map-manager-layers-dropdown" });
		wrapper.toggleClass("is-open", this.layersMenuOpen);
		if (this.layersMenuOpen) this.openDropdownEl = wrapper;

		const trigger = wrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-dropdown-trigger" });
		setIcon(trigger, "layers");
		setTooltip(trigger, "Calques");
		setIcon(trigger.createSpan({ cls: "map-manager-dropdown-chevron" }), "chevron-down");
		trigger.onclick = () => {
			const wasOpen = this.layersMenuOpen;
			this.closeMenus();
			this.layersMenuOpen = !wasOpen;
			this.render();
		};

		const panel = wrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-layers-dropdown-panel" });
		panel.createDiv({ cls: "map-manager-dropdown-title", text: "Calques" });

		const editing = this.controller.mode === "edit";
		const list = panel.createDiv({ cls: "map-manager-layers-list" });
		// Top of the visual stack is shown first (matches typical layer-panel conventions).
		const layers = [...data.layers].reverse();
		layers.forEach((layer, displayIndex) => {
			const row = list.createDiv({ cls: "map-manager-layer-row" });
			if (layer.id === data.activeLayerId) row.addClass("is-active");

			const visBtn = row.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
			setIcon(visBtn, layer.visible ? "eye" : "eye-off");
			setTooltip(visBtn, layer.visible ? "Masquer le calque" : "Afficher le calque");
			visBtn.onclick = () => this.controller.toggleLayerVisibility(layer.id);

			if (editing) {
				const activeBtn = row.createEl("button", { text: layer.id === data.activeLayerId ? "●" : "○", cls: "map-manager-btn map-manager-btn-icon" });
				setTooltip(activeBtn, "Calque actif (modifiable)");
				activeBtn.onclick = () => this.controller.setActiveLayer(layer.id);

				const nameInput = row.createEl("input", { type: "text", cls: "map-manager-layer-name-input" });
				nameInput.value = layer.name;
				nameInput.onchange = () => this.controller.renameLayer(layer.id, nameInput.value);

				const upBtn = row.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
				setIcon(upBtn, "arrow-up");
				setTooltip(upBtn, "Monter le calque");
				upBtn.disabled = displayIndex === 0;
				upBtn.onclick = () => this.controller.moveLayer(layer.id, 1);

				const downBtn = row.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
				setIcon(downBtn, "arrow-down");
				setTooltip(downBtn, "Descendre le calque");
				downBtn.disabled = displayIndex === layers.length - 1;
				downBtn.onclick = () => this.controller.moveLayer(layer.id, -1);

				const extractBtn = row.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
				setIcon(extractBtn, "copy-plus");
				setTooltip(extractBtn, "Extraire ce calque vers une nouvelle carte");
				extractBtn.onclick = () => this.actions.extractLayer(layer.id);

				const deleteBtn = row.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-btn-danger" });
				setIcon(deleteBtn, "trash");
				setTooltip(deleteBtn, "Supprimer le calque");
				deleteBtn.disabled = data.layers.length <= 1;
				deleteBtn.onclick = () => this.controller.removeLayer(layer.id);
			} else {
				row.createSpan({ text: layer.name, cls: "map-manager-layer-name" });
			}
		});

		if (editing) {
			const addBtn = panel.createEl("button", { text: "Nouveau calque", cls: "map-manager-btn" });
			addBtn.onclick = () => this.controller.addLayer(`Calque ${data.layers.length + 1}`);
		}
	}

	/** Image settings dropdown: same open/close mechanics as the layers dropdown. Also carries "Zoom max" (a map-level, not per-layer, property — see `renderZoomMaxField`) since the résumé groups it under "Image du calque actif". */
	private renderImageDropdown(container: HTMLElement, activeLayer: ReturnType<MapController["getActiveLayer"]>, data: MapFileData): void {
		const wrapper = container.createDiv({ cls: "map-manager-dropdown map-manager-image-dropdown" });
		wrapper.toggleClass("is-open", this.imageMenuOpen);
		if (this.imageMenuOpen) this.openDropdownEl = wrapper;

		const trigger = wrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-dropdown-trigger" });
		setIcon(trigger, "image");
		setTooltip(trigger, `Image (${activeLayer.name})`);
		trigger.toggleClass("is-active", !!activeLayer.background);
		setIcon(trigger.createSpan({ cls: "map-manager-dropdown-chevron" }), "chevron-down");
		trigger.onclick = () => {
			const wasOpen = this.imageMenuOpen;
			this.closeMenus();
			this.imageMenuOpen = !wasOpen;
			this.render();
		};

		const panel = wrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-image-dropdown-panel" });
		panel.createDiv({ cls: "map-manager-dropdown-title", text: `Image (${activeLayer.name})` });
		const chooseBtn = panel.createEl("button", { text: "Image du vault", cls: "map-manager-btn" });
		chooseBtn.onclick = () => this.pickVaultImage();

		if (activeLayer.background) {
			const clearBtn = panel.createEl("button", { text: "Retirer l'image", cls: "map-manager-btn" });
			clearBtn.onclick = () => this.controller.update((d) => (getActiveLayer(d).background = undefined));
			this.renderBackgroundControls(panel);
		}

		this.renderZoomMaxField(panel, data);
	}

	private renderZoomMaxField(container: HTMLElement, data: MapFileData): void {
		const wrap = container.createDiv({ cls: "map-manager-field-inline" });
		wrap.createEl("label", { text: "Zoom max" });
		const input = wrap.createEl("input", { type: "number" });
		input.step = "0.01";
		input.value = String(data.maxZoom);
		input.onchange = () => {
			const v = parseFloat(input.value);
			if (!Number.isNaN(v)) this.controller.update((d) => (d.maxZoom = clamp(v, ABS_MIN_ZOOM, ABS_MAX_ZOOM)));
		};
	}

	/**
	 * Fog dropdown: icon-only trigger, panel holds the activate/deactivate toggle plus, while fog is
	 * on, the "Brouillard figé" toggle (`MapController.toggleFogFrozen`/`MapFileData.fogFrozen` — see
	 * its own doc comment) and a reset action.
	 */
	private renderFogDropdown(container: HTMLElement, data: MapFileData): void {
		const wrapper = container.createDiv({ cls: "map-manager-dropdown map-manager-fog-dropdown" });
		wrapper.toggleClass("is-open", this.fogMenuOpen);
		if (this.fogMenuOpen) this.openDropdownEl = wrapper;

		const trigger = wrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-dropdown-trigger" });
		setIcon(trigger, "cloud-fog");
		setTooltip(trigger, data.fogEnabled ? "Brouillard activé" : "Brouillard désactivé");
		trigger.toggleClass("is-active", data.fogEnabled);
		setIcon(trigger.createSpan({ cls: "map-manager-dropdown-chevron" }), "chevron-down");
		trigger.onclick = () => {
			const wasOpen = this.fogMenuOpen;
			this.closeMenus();
			this.fogMenuOpen = !wasOpen;
			this.render();
		};

		const panel = wrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-fog-dropdown-panel" });
		panel.createDiv({ cls: "map-manager-dropdown-title", text: "Brouillard de guerre" });
		const toggleBtn = panel.createEl("button", { text: data.fogEnabled ? "Désactiver le brouillard" : "Activer le brouillard", cls: "map-manager-btn" });
		toggleBtn.toggleClass("is-active", data.fogEnabled);
		toggleBtn.onclick = () => this.controller.toggleFog();
		if (data.fogEnabled) {
			const freezeBtn = panel.createEl("button", { text: "Brouillard figé", cls: "map-manager-btn" });
			freezeBtn.toggleClass("is-active", data.fogFrozen);
			setTooltip(freezeBtn, "La vision des joueurs ne débloque plus le brouillard tant que c'est activé.");
			freezeBtn.onclick = () => this.controller.toggleFogFrozen();

			const resetFogBtn = panel.createEl("button", { text: "Réinitialiser le brouillard", cls: "map-manager-btn" });
			resetFogBtn.onclick = () => this.controller.resetFog();
		}
	}

	/**
	 * "Zones" toolbar group (edit mode): a single "Pinceau" dropdown, mutually exclusive with "Murs"
	 * below via `activeTool` (open exactly while `activeTool` is "brush" or "fill", same pattern as the
	 * "Murs" wall-shape dropdown). Panel contents, in order: Remplissage (switches to the click-to-fill
	 * variant without leaving the dropdown), Rayon du pinceau, Type de zone, Afficher/masquer les zones.
	 */
	private renderZonesGroup(container: HTMLElement, data: MapFileData): void {
		const group = container.createDiv({ cls: "map-manager-toolbar-group" });

		const brushWrapper = group.createDiv({ cls: "map-manager-dropdown map-manager-brush-dropdown" });
		const brushBtn = brushWrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-dropdown-trigger" });
		setIcon(brushBtn, "paintbrush");
		setTooltip(brushBtn, "Pinceau");
		const brushOrFillActive = this.controller.activeTool === "brush" || this.controller.activeTool === "fill";
		brushBtn.toggleClass("is-active", brushOrFillActive);
		setIcon(brushBtn.createSpan({ cls: "map-manager-dropdown-chevron" }), "chevron-down");
		brushBtn.onclick = () => this.controller.setActiveTool("brush");

		if (!brushOrFillActive) return;
		this.toolPanelTriggerEl = brushWrapper;
		if (!this.toolPanelOpen) return;

		brushWrapper.addClass("is-open");
		const panel = brushWrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-brush-dropdown-panel" });
		this.toolPanelPanelEl = panel;

		const fillBtn = panel.createEl("button", { text: "Remplissage", cls: "map-manager-btn" });
		fillBtn.toggleClass("is-active", this.controller.activeTool === "fill");
		fillBtn.onclick = () => this.controller.setActiveTool("fill");

		if (this.controller.activeTool === "brush") {
			const radiusField = panel.createDiv({ cls: "map-manager-field-inline" });
			radiusField.createEl("label", { text: "Rayon du pinceau" });
			const radiusInput = radiusField.createEl("input", { type: "number" });
			radiusInput.min = "0";
			radiusInput.value = String(this.controller.brushRadius);
			radiusInput.onchange = () => {
				const v = parseInt(radiusInput.value, 10);
				if (!Number.isNaN(v)) this.controller.setBrushRadius(v);
			};
		}

		if (data.gridType !== "none") {
			const zoneField = panel.createDiv({ cls: "map-manager-field-inline" });
			zoneField.createEl("label", { text: "Type de zone" });
			const zoneSelect = zoneField.createEl("select");
			const clearZoneOpt = zoneSelect.createEl("option", { text: "Aucune" });
			clearZoneOpt.value = "clear";
			for (const z of this.deps.settings.defaultZoneTypes) {
				const opt = zoneSelect.createEl("option", { text: z.name });
				opt.value = z.id;
			}
			zoneSelect.value = this.controller.brushZoneMode;
			zoneSelect.onchange = () => this.controller.setBrushZoneMode(zoneSelect.value);
		}

		const showBtn = panel.createEl("button", { text: this.controller.showZones ? "Masquer les zones" : "Afficher les zones", cls: "map-manager-btn" });
		showBtn.toggleClass("is-active", this.controller.showZones);
		showBtn.onclick = () => this.controller.toggleShowZones();
	}

	/**
	 * "Murs" toolbar group (edit mode): manual point-by-point placement, a shape-insert dropdown
	 * (carré/triangle/carré sur coin/remplissage), the default blocker type for newly-drawn segments,
	 * and "Optimiser les murs". Mutually exclusive with "Zones" above via `activeTool`.
	 */
	private renderMursGroup(container: HTMLElement): void {
		const group = container.createDiv({ cls: "map-manager-toolbar-group" });

		// Wrapped in its own dropdown so the shape-insert panel (below) opens directly under this
		// button specifically — the button itself keeps its original meaning (activates manual,
		// point-by-point wall placement); shapes are a separate, additional way to get a wall.
		const wallWrapper = group.createDiv({ cls: "map-manager-dropdown map-manager-wall-shape-dropdown" });
		const wallBtn = wallWrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-dropdown-trigger" });
		setIcon(wallBtn, "spline");
		setTooltip(wallBtn, "Murs : placer les points manuellement");
		wallBtn.toggleClass("is-active", this.controller.activeTool === "wall");
		setIcon(wallBtn.createSpan({ cls: "map-manager-dropdown-chevron" }), "chevron-down");
		wallBtn.onclick = () => this.controller.setActiveTool("wall");

		if (this.controller.activeTool !== "wall") return;
		this.toolPanelTriggerEl = wallWrapper;
		if (!this.toolPanelOpen) return;

		wallWrapper.addClass("is-open");
		const panel = wallWrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-wall-shape-dropdown-panel" });
		this.toolPanelPanelEl = panel;
		panel.createDiv({ cls: "map-manager-dropdown-title", text: "Insérer une forme" });
		const shapeRow = panel.createDiv({ cls: "map-manager-wall-shape-row" });
		const shapeBtn = (shape: "square" | "triangle" | "losange", icon: string, tooltip: string) => {
			const btn = shapeRow.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
			setIcon(btn, icon);
			setTooltip(btn, tooltip);
			btn.toggleClass("is-active", this.controller.pendingWallShape === shape);
			btn.onclick = () => this.controller.startWallShapePlacement(shape);
		};
		shapeBtn("square", "square", "Carré / rectangle : cliquez un coin, puis le coin opposé");
		shapeBtn("triangle", "triangle", "Triangle : cliquez un coin, puis le coin opposé de sa zone");
		shapeBtn("losange", "diamond", "Carré sur coin (losange) : cliquez un coin, puis le coin opposé de sa zone");
		// "Seau à murs" needs no second corner like the shapes above — one click on the map is enough
		// to flood-fill the color under the cursor and wall off where it stops (see
		// `MapCanvas.runColorRegionWalls`), so it stays armed after each use instead of needing a
		// "first corner placed" half-state.
		const bucketBtn = shapeRow.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
		setIcon(bucketBtn, "paint-bucket");
		setTooltip(bucketBtn, "Remplissage : cliquez sur une couleur pour murer la zone qui l'entoure");
		bucketBtn.toggleClass("is-active", this.controller.pendingWallBucket);
		bucketBtn.onclick = () => this.controller.startWallBucketPlacement();
		if (this.controller.pendingWallShape) {
			const hintText = this.controller.getWallShapeFirstCorner()
				? "Cliquez pour poser le coin opposé (clic droit pour annuler)"
				: "Cliquez pour poser le premier coin (clic droit pour annuler)";
			panel.createDiv({ cls: "map-manager-wall-shape-hint", text: hintText });
		} else if (this.controller.pendingWallBucket) {
			panel.createDiv({
				cls: "map-manager-wall-shape-hint",
				text: "Cliquez sur la carte pour murer la zone de couleur sous le curseur (clic droit pour désactiver)",
			});
		}

		if (this.controller.pendingWallBucket) this.renderWallBucketTolerances(panel);

		const blockerField = panel.createDiv({ cls: "map-manager-field-inline" });
		blockerField.createEl("label", { text: "Type de mur" });
		const blockerSelect = blockerField.createEl("select");
		for (const opt of WALL_BLOCKER_TYPE_OPTIONS) {
			const optEl = blockerSelect.createEl("option", { text: opt.label });
			optEl.value = opt.value;
		}
		blockerSelect.value = this.controller.wallDrawBlockerType;
		blockerSelect.onchange = () => {
			if (isWallBlockerTypeValue(blockerSelect.value)) this.controller.setWallDrawBlockerType(blockerSelect.value);
		};

		// "Optimiser les murs" runs a one-off cleanup pass over the active layer's wall network
		// (orphan points, overlapping/duplicate segments, redundant straight-line points — see
		// `MapController.optimizeWalls`).
		const optimizeWallsBtn = panel.createEl("button", { text: "Optimiser les murs", cls: "map-manager-btn" });
		optimizeWallsBtn.onclick = () => {
			this.controller.optimizeWalls();
			new Notice("Murs optimisés.");
		};
	}

	/**
	 * The three "Seau à murs" tolerances (see `detectColorRegionWalls`), shown right under the bucket
	 * button whenever it's armed so they're tuned before the next click rather than after: percentages
	 * are edited as whole 0-100 numbers and converted to/from the controller's 0-1 fractions here, so
	 * the field itself never shows an odd value like "0.1".
	 */
	private renderWallBucketTolerances(panel: HTMLElement): void {
		const percentField = (label: string, tooltip: string, value: number, onChange: (fraction: number) => void) => {
			const field = panel.createDiv({ cls: "map-manager-field-inline" });
			const labelEl = field.createEl("label", { text: label });
			setTooltip(labelEl, tooltip);
			const input = field.createEl("input", { type: "number" });
			input.min = "0";
			input.max = "100";
			input.value = String(Math.round(value * 100));
			input.onchange = () => {
				const v = parseFloat(input.value);
				if (!Number.isNaN(v)) onChange(v / 100);
			};
		};
		percentField(
			"Tolérance de couleur (%)",
			"À quel point un pixel peut différer de la couleur cliquée tout en comptant comme la même couleur.",
			this.controller.wallBucketColorTolerancePercent,
			(v) => this.controller.setWallBucketColorTolerancePercent(v)
		);
		percentField(
			"Tolérance de mur (%)",
			"Part des pixels d'un bord qui doivent échouer au test de couleur pour qu'un mur y soit posé.",
			this.controller.wallBucketWallFailFraction,
			(v) => this.controller.setWallBucketWallFailFraction(v)
		);

		const reachField = panel.createDiv({ cls: "map-manager-field-inline" });
		const reachLabel = reachField.createEl("label", { text: "Tolérance d'éloignement de mur" });
		setTooltip(reachLabel, "Distance (en pixels) de part et d'autre du bord d'une case encore prise en compte — 1 par défaut, 10 vérifie jusqu'à 10 pixels de chaque côté du bord.");
		const reachInput = reachField.createEl("input", { type: "number" });
		reachInput.min = "0";
		reachInput.value = String(this.controller.wallBucketPixelReach);
		reachInput.onchange = () => {
			const v = parseInt(reachInput.value, 10);
			if (!Number.isNaN(v)) this.controller.setWallBucketPixelReach(v);
		};
	}

	private renderBackgroundControls(container: HTMLElement): void {
		const bg = this.controller.getActiveLayer().background;
		if (!bg) return;

		const makeNumberInput = (label: string, value: number, onChange: (v: number) => void) => {
			const wrap = container.createDiv({ cls: "map-manager-field-inline" });
			wrap.createEl("label", { text: label });
			const input = wrap.createEl("input", { type: "number" });
			input.value = String(value);
			input.step = "0.1";
			input.onchange = () => {
				const v = parseFloat(input.value);
				if (!Number.isNaN(v)) onChange(v);
			};
		};

		const updateBackground = (mutate: (bg: MapBackground) => void) => {
			this.controller.update((d) => {
				const layerBg = getActiveLayer(d).background;
				if (layerBg) mutate(layerBg);
			});
		};

		makeNumberInput("Centre X (cases)", bg.offsetX, (v) => updateBackground((b) => (b.offsetX = v)));
		makeNumberInput("Centre Y (cases)", bg.offsetY, (v) => updateBackground((b) => (b.offsetY = v)));
		makeNumberInput("Échelle", bg.scale, (v) => {
			if (v > 0) updateBackground((b) => (b.scale = v));
		});
	}

	/** Background offsets are anchored on the image's center, so (0,0) always means "centered on the grid origin". */
	private setBackgroundCentered(path: string): void {
		this.controller.update((d) => (getActiveLayer(d).background = { path, offsetX: 0, offsetY: 0, scale: 1 }));
	}

	private pickVaultImage(): void {
		const files = this.app.vault.getFiles().filter((f) => IMAGE_EXTENSIONS.includes(f.extension.toLowerCase()));
		new FileSuggestModal(
			this.app,
			files,
			(file: TFile) => this.setBackgroundCentered(file.path),
			"Choisir une image du vault..."
		).open();
	}
}

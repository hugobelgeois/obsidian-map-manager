import { App, Notice, TFile, setIcon, setTooltip } from "obsidian";
import { MapController } from "../controller/MapController";
import { GRID_TYPE_LABELS, GRID_TYPES, GridType, MapBackground, MapFileData, VisionBlockerType, getActiveLayer } from "../data/mapData";
import { ABS_MAX_ZOOM, ABS_MIN_ZOOM, clamp, hexCorners } from "../grid/gridMath";
import { detectMagicWalls } from "../platform/detectMagicWalls";
import { MapManagerSettings } from "../settings/types";
import { ensureFolder, sanitizeFileName } from "../utils";
import { FileSuggestModal, IMAGE_EXTENSIONS } from "./FileSuggestModal";
import { MagicWallsModal } from "./MagicWallsModal";

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

/** Dropdowns (grid type / layers / image / fog / zoom range) are mutually exclusive and share one outside-click-to-close handler. */
export class Toolbar {
	el: HTMLElement;
	private unsubscribe: () => void;
	private gridMenuOpen = false;
	private layersMenuOpen = false;
	private imageMenuOpen = false;
	private fogMenuOpen = false;
	private zoomMenuOpen = false;
	private playerWindowMenuOpen = false;
	private openDropdownEl: HTMLElement | null = null;
	/** True while "Murs magiques" is analyzing the active layer's background image (see `runMagicWalls`) — local UI state, not part of `MapController`, so it needs its own re-render. */
	private magicWallsRunning = false;
	/** The wall color picked with "Murs magiques"' eyedropper (see `pickMagicWallsColor`), or `null` to fall back to automatic color detection. Local UI state, like `magicWallsRunning` — session-only, resets if the toolbar itself is torn down. */
	private magicWallsColor: string | null = null;

	constructor(container: HTMLElement, private app: App, private deps: ToolbarDeps, private controller: MapController, private actions: ToolbarActions) {
		this.el = container.createDiv({ cls: "map-manager-toolbar" });
		this.render();
		this.unsubscribe = this.controller.onChange(() => this.render());
		document.addEventListener("mousedown", this.handleDocumentClick, true);
	}

	destroy(): void {
		this.unsubscribe();
		document.removeEventListener("mousedown", this.handleDocumentClick, true);
	}

	private closeMenus(): void {
		this.gridMenuOpen = false;
		this.layersMenuOpen = false;
		this.imageMenuOpen = false;
		this.fogMenuOpen = false;
		this.zoomMenuOpen = false;
		this.playerWindowMenuOpen = false;
	}

	private handleDocumentClick = (e: MouseEvent): void => {
		if (!this.openDropdownEl) return;
		if (this.openDropdownEl.contains(e.target as Node)) return;
		this.closeMenus();
		this.render();
	};

	private render(): void {
		this.el.empty();
		this.openDropdownEl = null;
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
			this.renderGridDropdown(this.el, data);
			this.renderToolControls(this.el, data);
			this.renderImageDropdown(this.el, activeLayer);
			this.renderZoomDropdown(this.el, data);
		}

		if (this.controller.mode === "view") {
			this.renderLayersDropdown(this.el, data);

			if (data.gridType !== "none") {
				const viewGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
				const cellsBtn = viewGroup.createEl("button", { text: this.controller.showCells ? "Masquer les cases" : "Afficher les cases", cls: "map-manager-btn" });
				cellsBtn.onclick = () => this.controller.toggleShowCells();
			}

			// Fog runs even in grid type "none" (on its hidden square substrate — see MapCanvas),
			// so the toggle/reset controls aren't restricted to celled grid types.
			this.renderFogDropdown(this.el, data);
		}

		// Publishing reads whatever fog/exploration state is currently on the map, so it's useful from
		// either mode — not just "Vue", where a GM runs live sessions.
		const publishGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
		const publishBtn = publishGroup.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
		setIcon(publishBtn, "upload");
		setTooltip(publishBtn, "Publier la vue (met à jour le .json pour le site externe)");
		publishBtn.onclick = () => this.actions.publish();

		const recenterGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
		const resetBtn = recenterGroup.createEl("button", { text: "Recentrer", cls: "map-manager-btn" });
		resetBtn.onclick = () => this.actions.recenter();

		this.renderPlayerWindowControl(recenterGroup);
	}

	/**
	 * While no player-mirror window is open yet, this is a plain button: clicking it just pops one
	 * open (`actions.openPlayerWindow`), same as before. Once one is open, clicking instead opens a
	 * dropdown of live options for it — opening a second window isn't useful, so the click's meaning
	 * changes rather than adding a separate menu button. See `MapController.showEntityVisionToPlayers`
	 * (hidden by default) and `playerMirrorFogEnabled` (enabled by default).
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

		const visionBtn = panel.createEl("button", {
			text: this.controller.showEntityVisionToPlayers ? "Masquer la vision des entités" : "Afficher la vision des entités",
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

	/** Image settings dropdown: same open/close mechanics as the layers dropdown. */
	private renderImageDropdown(container: HTMLElement, activeLayer: ReturnType<MapController["getActiveLayer"]>): void {
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
		const importBtn = panel.createEl("button", { text: "Importer une image", cls: "map-manager-btn" });
		importBtn.onclick = () => this.importImageFromDisk();

		if (activeLayer.background) {
			const clearBtn = panel.createEl("button", { text: "Retirer l'image", cls: "map-manager-btn" });
			clearBtn.onclick = () => this.controller.update((d) => (getActiveLayer(d).background = undefined));
			this.renderBackgroundControls(panel);
		}
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

	/** Zoom range dropdown: same open/close mechanics as the other toolbar dropdowns. */
	private renderZoomDropdown(container: HTMLElement, data: MapFileData): void {
		const wrapper = container.createDiv({ cls: "map-manager-dropdown map-manager-zoom-dropdown" });
		wrapper.toggleClass("is-open", this.zoomMenuOpen);
		if (this.zoomMenuOpen) this.openDropdownEl = wrapper;

		const trigger = wrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon map-manager-dropdown-trigger" });
		setIcon(trigger, "zoom-in");
		setTooltip(trigger, "Plage de zoom");
		setIcon(trigger.createSpan({ cls: "map-manager-dropdown-chevron" }), "chevron-down");
		trigger.onclick = () => {
			const wasOpen = this.zoomMenuOpen;
			this.closeMenus();
			this.zoomMenuOpen = !wasOpen;
			this.render();
		};

		const panel = wrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-zoom-dropdown-panel" });
		panel.createDiv({ cls: "map-manager-dropdown-title", text: "Plage de zoom" });

		const makeZoomInput = (label: string, value: number, onChange: (v: number) => void) => {
			const wrap = panel.createDiv({ cls: "map-manager-field-inline" });
			wrap.createEl("label", { text: label });
			const input = wrap.createEl("input", { type: "number" });
			input.step = "0.01";
			input.value = String(value);
			input.onchange = () => {
				const v = parseFloat(input.value);
				if (!Number.isNaN(v)) onChange(clamp(v, ABS_MIN_ZOOM, ABS_MAX_ZOOM));
			};
		};

		makeZoomInput("max", data.maxZoom, (v) => this.controller.update((d) => (d.maxZoom = v)));
	}

	/**
	 * Brush (paint while dragging) and fill (flood-fill a closed perimeter) tools, mutually exclusive,
	 * both painting the same zone type. A third "wall" tool draws freeform vision-blocking lines
	 * (see MapCanvas) independent of the grid — its own control just picks the default blocker type
	 * (opaque/dim) for newly-drawn segments.
	 */
	private renderToolControls(container: HTMLElement, data: MapFileData): void {
		const toolGroup = container.createDiv({ cls: "map-manager-toolbar-group" });
		const brushBtn = toolGroup.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
		setIcon(brushBtn, "paintbrush");
		setTooltip(brushBtn, "Pinceau");
		brushBtn.toggleClass("is-active", this.controller.activeTool === "brush");
		brushBtn.onclick = () => this.controller.setActiveTool("brush");
		const fillBtn = toolGroup.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
		setIcon(fillBtn, "paint-bucket");
		setTooltip(fillBtn, "Remplissage");
		fillBtn.toggleClass("is-active", this.controller.activeTool === "fill");
		fillBtn.onclick = () => this.controller.setActiveTool("fill");
		// Wrapped in its own dropdown so the shape-insert panel (below) opens directly under this
		// button specifically, not just somewhere in the toolbar row — the button itself keeps its
		// original meaning (activates manual, point-by-point wall placement); shapes are a separate,
		// additional way to get a wall, not something this icon represents.
		const wallWrapper = toolGroup.createDiv({ cls: "map-manager-dropdown map-manager-wall-shape-dropdown" });
		const wallBtn = wallWrapper.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
		setIcon(wallBtn, "spline");
		setTooltip(wallBtn, "Murs : placer les points manuellement");
		wallBtn.toggleClass("is-active", this.controller.activeTool === "wall");
		wallBtn.onclick = () => this.controller.setActiveTool("wall");

		const selectBtn = toolGroup.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
		setIcon(selectBtn, "mouse-pointer-2");
		setTooltip(selectBtn, "Sélection (actions groupées)");
		selectBtn.toggleClass("is-active", this.controller.activeTool === "select");
		selectBtn.onclick = () => this.controller.setActiveTool("select");

		if (this.controller.activeTool === "wall") {
			wallWrapper.addClass("is-open");
			const panel = wallWrapper.createDiv({ cls: "map-manager-dropdown-panel map-manager-wall-shape-dropdown-panel" });
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
			shapeBtn("losange", "diamond", "Losange : cliquez un coin, puis le coin opposé de sa zone");
			// "Seau à murs" needs no second corner like the shapes above — one click on the map is enough
			// to flood-fill the color under the cursor and wall off where it stops (see
			// `MapCanvas.runColorRegionWalls`), so it stays armed after each use instead of needing a
			// "first corner placed" half-state.
			const bucketBtn = shapeRow.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
			setIcon(bucketBtn, "paint-bucket");
			setTooltip(bucketBtn, "Seau à murs : cliquez sur une couleur pour murer la zone qui l'entoure");
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

			// "Optimiser les murs" runs a one-off cleanup pass over the active layer's wall network
			// (orphan points, overlapping/duplicate segments, redundant straight-line points — see
			// `MapController.optimizeWalls`). "Murs magiques" auto-detects wall linework from the
			// layer's background image instead of placing points by hand — see `runMagicWalls`. Its
			// color row lets the user override automatic color detection with an exact pick instead
			// (`pickMagicWallsColor`) — handy when the image's wall lines aren't the map's boldest,
			// highest-contrast stroke (a heavy border/frame, say), which would otherwise win the vote.
			panel.createDiv({ cls: "map-manager-dropdown-title", text: "Outils" });

			const colorRow = panel.createDiv({ cls: "map-manager-magic-walls-color-row" });
			colorRow.createSpan({ text: "Couleur des murs :" });
			const colorSwatch = colorRow.createDiv({ cls: "map-manager-magic-walls-color-swatch" });
			if (this.magicWallsColor) {
				colorSwatch.addClass("is-set");
				colorSwatch.style.setProperty("--map-manager-magic-walls-color", this.magicWallsColor);
				setTooltip(colorSwatch, this.magicWallsColor);
			} else {
				setTooltip(colorSwatch, "Détection automatique");
			}
			const pipetteBtn = colorRow.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
			setIcon(pipetteBtn, "pipette");
			setTooltip(pipetteBtn, "Choisir la couleur des murs à la pipette");
			pipetteBtn.onclick = () => void this.pickMagicWallsColor();
			if (this.magicWallsColor) {
				const clearColorBtn = colorRow.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
				setIcon(clearColorBtn, "x");
				setTooltip(clearColorBtn, "Revenir à la détection automatique");
				clearColorBtn.onclick = () => {
					this.magicWallsColor = null;
					this.render();
				};
			}

			const optimizeWallsBtn = panel.createEl("button", { text: "Optimiser les murs", cls: "map-manager-btn" });
			optimizeWallsBtn.onclick = () => {
				this.controller.optimizeWalls();
				new Notice("Murs optimisés.");
			};
			const magicWallsBtn = panel.createEl("button", { text: this.magicWallsRunning ? "Analyse en cours…" : "Murs magiques", cls: "map-manager-btn" });
			magicWallsBtn.disabled = this.magicWallsRunning;
			magicWallsBtn.onclick = () => void this.runMagicWalls();
		}

		if (this.controller.activeTool === "none") return;

		// The "select" tool's own controls live entirely in InfoPanel's mass-edit panel (matching every
		// other selection type) — nothing further to show in the toolbar row itself.
		if (this.controller.activeTool === "select") return;

		if (this.controller.activeTool === "wall") {
			const blockerSelect = toolGroup.createEl("select");
			const opaqueOpt = blockerSelect.createEl("option", { text: "Opaque (cache tout au-delà)" });
			opaqueOpt.value = "opaque";
			const dimOpt = blockerSelect.createEl("option", { text: "Partiel (visible en mode exploré)" });
			dimOpt.value = "dim";
			blockerSelect.value = this.controller.wallDrawBlockerType;
			blockerSelect.onchange = () => this.controller.setWallDrawBlockerType(blockerSelect.value as VisionBlockerType);
			return;
		}

		if (this.controller.activeTool === "brush") {
			const radiusField = toolGroup.createDiv({ cls: "map-manager-field-inline" });
			radiusField.createEl("label", { text: "Rayon" });
			const radiusInput = radiusField.createEl("input", { type: "number" });
			radiusInput.min = "0";
			radiusInput.value = String(this.controller.brushRadius);
			radiusInput.onchange = () => {
				const v = parseInt(radiusInput.value, 10);
				if (!Number.isNaN(v)) this.controller.setBrushRadius(v);
			};
		}

		if (data.gridType !== "none") {
			const zoneSelect = toolGroup.createEl("select");
			const keepZoneOpt = zoneSelect.createEl("option", { text: "Zone : ne pas changer" });
			keepZoneOpt.value = "keep";
			const clearZoneOpt = zoneSelect.createEl("option", { text: "Zone : aucune" });
			clearZoneOpt.value = "clear";
			for (const z of this.deps.settings.defaultZoneTypes) {
				const opt = zoneSelect.createEl("option", { text: `Zone : ${z.name}` });
				opt.value = z.id;
			}
			zoneSelect.value = this.controller.brushZoneMode;
			zoneSelect.onchange = () => this.controller.setBrushZoneMode(zoneSelect.value);
		}
	}

	/**
	 * "Murs magiques": runs `detectMagicWalls` against the active layer's background image — using
	 * `magicWallsColor` (the eyedropper pick) if set, else automatic detection — and, if it found a
	 * candidate wall network, opens `MagicWallsModal` for the user to confirm before anything is
	 * actually written to the map (`MapController.applyMagicWalls`). Guard conditions (no background
	 * image, grid type "none", grid too fine for the image, an invalid picked color) are all just
	 * thrown `Error`s from `detectMagicWalls` with an already user-facing French message — shown as-is.
	 */
	private async runMagicWalls(): Promise<void> {
		if (this.magicWallsRunning) return;
		this.magicWallsRunning = true;
		this.render();
		try {
			const activeLayer = this.controller.getActiveLayer();
			const result = await detectMagicWalls(this.app, this.controller.getData(), activeLayer, this.controller.wallDrawBlockerType, this.magicWallsColor ?? undefined);
			if (!result) {
				new Notice("Aucun mur détecté sur l'image de ce calque.");
				return;
			}
			new MagicWallsModal(this.app, result, () => {
				this.controller.applyMagicWalls(result.wallPoints, result.wallSegments);
				const count = result.wallSegments.length;
				new Notice(`${count} mur${count > 1 ? "s" : ""} magique${count > 1 ? "s" : ""} ajouté${count > 1 ? "s" : ""}.`);
			}).open();
		} catch (e) {
			console.error("Map Manager: échec de la détection des murs magiques", e);
			new Notice(e instanceof Error ? e.message : "Échec de la détection des murs magiques.");
		} finally {
			this.magicWallsRunning = false;
			this.render();
		}
	}

	/**
	 * Opens the browser's native `EyeDropper` (Chromium/Electron desktop only — not yet part of
	 * TypeScript's DOM lib, hence the local type cast rather than a global ambient declaration) so
	 * the user can sample the wall color directly off the map canvas (or anywhere else on screen) for
	 * "Murs magiques" to target instead of guessing it automatically. Silently does nothing if the
	 * user presses Escape (`open()` rejects) — that's a cancel, not an error.
	 */
	private async pickMagicWallsColor(): Promise<void> {
		type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };
		const ctor = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
		if (!ctor) {
			new Notice("La pipette n'est pas disponible sur cette plateforme.");
			return;
		}
		try {
			const result = await new ctor().open();
			this.magicWallsColor = result.sRGBHex;
			this.render();
		} catch {
			// Cancelled (Escape) — nothing to do.
		}
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

	private importImageFromDisk(): void {
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
			this.setBackgroundCentered(created.path);
		};
		input.click();
	}
}

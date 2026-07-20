import { App, Notice, TFile, setIcon, setTooltip } from "obsidian";
import { MapController } from "../controller/MapController";
import { GRID_TYPE_LABELS, GRID_TYPES, GridType, MapBackground, MapFileData, getActiveLayer } from "../data/mapData";
import { ABS_MAX_ZOOM, ABS_MIN_ZOOM, clamp, hexCorners } from "../grid/gridMath";
import { ensureFolder, sanitizeFileName } from "../utils";
import { FileSuggestModal, IMAGE_EXTENSIONS } from "./FileSuggestModal";

export interface ToolbarActions {
	recenter: () => void;
	getCenterCellKey: () => string;
	getCenterWorld: () => { x: number; y: number };
}

export interface ToolbarDeps {
	assetsFolder: string;
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

/** No chess-pawn glyph ships with Lucide, so it's hand-drawn here in the same stroke style as Obsidian's bundled icons. */
function buildPawnIcon(svg: SVGSVGElement): void {
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.addClass("svg-icon");
	svg.createSvg("circle", { attr: { cx: "12", cy: "6", r: "3" } });
	svg.createSvg("path", { attr: { d: "M9 9.5c-1.1 1.8-1.4 3.6-0.7 5.5h7.4c0.7-1.9 0.4-3.7-0.7-5.5" } });
	svg.createSvg("path", { attr: { d: "M8.5 15h7" } });
	svg.createSvg("path", { attr: { d: "M6 19h12" } });
	svg.createSvg("path", { attr: { d: "M7.5 15 6 19" } });
	svg.createSvg("path", { attr: { d: "M16.5 15 18 19" } });
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
	private openDropdownEl: HTMLElement | null = null;

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
			if (data.gridType === "none") {
				const markerGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
				const newMarkerBtn = markerGroup.createEl("button", { text: "Nouveau tampon", cls: "map-manager-btn" });
				newMarkerBtn.onclick = () => this.addMarkerAtCenter();
			}
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

			const tokenGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
			const newTokenBtn = tokenGroup.createEl("button", { cls: "map-manager-btn map-manager-btn-icon" });
			buildPawnIcon(newTokenBtn.createSvg("svg"));
			setTooltip(newTokenBtn, "Nouveau pion");
			newTokenBtn.onclick = () => this.addTokenAtCenter();

			if (data.gridType !== "none") {
				this.renderFogDropdown(this.el, data);
			}
		}

		const recenterGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
		const resetBtn = recenterGroup.createEl("button", { text: "Recentrer", cls: "map-manager-btn" });
		resetBtn.onclick = () => this.actions.recenter();
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

	/** Fog dropdown: icon-only trigger, panel holds the activate/deactivate toggle plus a reset action while fog is on. */
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

		makeZoomInput("min", data.minZoom, (v) => this.controller.update((d) => (d.minZoom = v)));
		makeZoomInput("max", data.maxZoom, (v) => this.controller.update((d) => (d.maxZoom = v)));
	}

	/**
	 * Brush (paint while dragging) and fill (flood-fill a closed perimeter) tools, mutually exclusive.
	 * Both apply the same zone/blocker settings. In grid type "none" there's no visible zone to paint,
	 * so only the blocker control shows — it still paints the hidden square substrate used for fog.
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
		if (this.controller.activeTool === "none") return;

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
			for (const z of data.zoneTypes) {
				const opt = zoneSelect.createEl("option", { text: `Zone : ${z.name}` });
				opt.value = z.id;
			}
			zoneSelect.value = this.controller.brushZoneMode;
			zoneSelect.onchange = () => this.controller.setBrushZoneMode(zoneSelect.value);
		}

		const blockerSelect = toolGroup.createEl("select");
		const keepBlockerOpt = blockerSelect.createEl("option", { text: "Bloc visuel : ne pas changer" });
		keepBlockerOpt.value = "keep";
		const opaqueBlockerOpt = blockerSelect.createEl("option", { text: "Bloc visuel : opaque" });
		opaqueBlockerOpt.value = "opaque";
		const dimBlockerOpt = blockerSelect.createEl("option", { text: "Bloc visuel : partiel" });
		dimBlockerOpt.value = "dim";
		const offBlockerOpt = blockerSelect.createEl("option", { text: "Bloc visuel : aucun" });
		offBlockerOpt.value = "off";
		blockerSelect.value = this.controller.brushBlockerMode;
		blockerSelect.onchange = () => this.controller.setBrushBlockerMode(blockerSelect.value as "keep" | "opaque" | "dim" | "off");
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

	private addTokenAtCenter(): void {
		if (this.controller.getData().gridType === "none") {
			const center = this.actions.getCenterWorld();
			const token = this.controller.addFreeToken(center.x, center.y);
			this.controller.selectToken(token.id);
			return;
		}
		const key = this.actions.getCenterCellKey();
		const token = this.controller.addToken(key);
		if (!token) {
			new Notice("Impossible de placer un pion ici : la case est déjà occupée sur ce calque. Déplacez la vue et réessayez.");
			return;
		}
		this.controller.selectToken(token.id);
	}

	private addMarkerAtCenter(): void {
		const center = this.actions.getCenterWorld();
		const marker = this.controller.addMarker(center.x, center.y);
		this.controller.selectMarker(marker.id);
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

import { App, Notice, TFile, setTooltip } from "obsidian";
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

export class Toolbar {
	el: HTMLElement;
	private unsubscribe: () => void;

	constructor(container: HTMLElement, private app: App, private deps: ToolbarDeps, private controller: MapController, private actions: ToolbarActions) {
		this.el = container.createDiv({ cls: "map-manager-toolbar" });
		this.render();
		this.unsubscribe = this.controller.onChange(() => this.render());
	}

	destroy(): void {
		this.unsubscribe();
	}

	private render(): void {
		this.el.empty();
		const data = this.controller.getData();
		const activeLayer = this.controller.getActiveLayer();

		const modeGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
		const editBtn = modeGroup.createEl("button", { text: "Édition", cls: "map-manager-btn" });
		const viewBtn = modeGroup.createEl("button", { text: "Vue", cls: "map-manager-btn" });
		editBtn.toggleClass("is-active", this.controller.mode === "edit");
		viewBtn.toggleClass("is-active", this.controller.mode === "view");
		editBtn.onclick = () => this.controller.setMode("edit");
		viewBtn.onclick = () => this.controller.setMode("view");

		if (this.controller.mode === "edit") {
			const gridGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
			for (const gt of GRID_TYPES) {
				const btn = gridGroup.createEl("button", { cls: "map-manager-btn map-manager-grid-btn" });
				setTooltip(btn, GRID_TYPE_LABELS[gt]);
				if (data.gridType === gt) btn.addClass("is-active");
				const svg = btn.createSvg("svg");
				buildGridIcon(svg, gt);
				btn.onclick = () => this.controller.update((d) => (d.gridType = gt));
			}

			this.renderToolControls(this.el, data);
			if (data.gridType === "none") {
				const markerGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
				const newMarkerBtn = markerGroup.createEl("button", { text: "Nouveau tampon", cls: "map-manager-btn" });
				newMarkerBtn.onclick = () => this.addMarkerAtCenter();
			}

			const imgGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
			imgGroup.createSpan({ text: `Image (${activeLayer.name})`, cls: "map-manager-toolbar-label" });
			const chooseBtn = imgGroup.createEl("button", { text: "Image du vault", cls: "map-manager-btn" });
			chooseBtn.onclick = () => this.pickVaultImage();
			const importBtn = imgGroup.createEl("button", { text: "Importer une image", cls: "map-manager-btn" });
			importBtn.onclick = () => this.importImageFromDisk();

			if (activeLayer.background) {
				const clearBtn = imgGroup.createEl("button", { text: "Retirer l'image", cls: "map-manager-btn" });
				clearBtn.onclick = () => this.controller.update((d) => (getActiveLayer(d).background = undefined));
				this.renderBackgroundControls(imgGroup);
			}

			this.renderZoomRangeControls(this.el);
		}

		if (this.controller.mode === "view") {
			if (data.gridType !== "none") {
				const viewGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
				const cellsBtn = viewGroup.createEl("button", { text: this.controller.showCells ? "Masquer les cases" : "Afficher les cases", cls: "map-manager-btn" });
				cellsBtn.onclick = () => this.controller.toggleShowCells();
			}

			const tokenGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
			const newTokenBtn = tokenGroup.createEl("button", { text: "Nouveau pion", cls: "map-manager-btn" });
			newTokenBtn.onclick = () => this.addTokenAtCenter();

			if (data.gridType !== "none") {
				const fogGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
				const fogBtn = fogGroup.createEl("button", { text: data.fogEnabled ? "Désactiver le brouillard" : "Activer le brouillard", cls: "map-manager-btn" });
				fogBtn.toggleClass("is-active", data.fogEnabled);
				fogBtn.onclick = () => this.controller.toggleFog();
				if (data.fogEnabled) {
					const resetFogBtn = fogGroup.createEl("button", { text: "Réinitialiser le brouillard", cls: "map-manager-btn" });
					resetFogBtn.onclick = () => this.controller.resetFog();
				}
			}
		}

		const historyGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
		const undoBtn = historyGroup.createEl("button", { text: "Annuler", cls: "map-manager-btn" });
		undoBtn.disabled = !this.controller.canUndo();
		undoBtn.onclick = () => this.controller.undo();
		const redoBtn = historyGroup.createEl("button", { text: "Rétablir", cls: "map-manager-btn" });
		redoBtn.disabled = !this.controller.canRedo();
		redoBtn.onclick = () => this.controller.redo();

		const zoomGroup = this.el.createDiv({ cls: "map-manager-toolbar-group" });
		const resetBtn = zoomGroup.createEl("button", { text: "Recentrer", cls: "map-manager-btn" });
		resetBtn.onclick = () => this.actions.recenter();
	}

	/**
	 * Brush (paint while dragging) and fill (flood-fill a closed perimeter) tools, mutually exclusive.
	 * Both apply the same zone/blocker settings. In grid type "none" there's no visible zone to paint,
	 * so only the blocker control shows — it still paints the hidden square substrate used for fog.
	 */
	private renderToolControls(container: HTMLElement, data: MapFileData): void {
		const toolGroup = container.createDiv({ cls: "map-manager-toolbar-group" });
		const brushBtn = toolGroup.createEl("button", { text: "Pinceau", cls: "map-manager-btn" });
		brushBtn.toggleClass("is-active", this.controller.activeTool === "brush");
		brushBtn.onclick = () => this.controller.setActiveTool("brush");
		const fillBtn = toolGroup.createEl("button", { text: "Remplissage", cls: "map-manager-btn" });
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

	private renderZoomRangeControls(container: HTMLElement): void {
		const data = this.controller.getData();
		const zoomGroup = container.createDiv({ cls: "map-manager-toolbar-group" });
		zoomGroup.createSpan({ text: "Zoom", cls: "map-manager-toolbar-label" });

		const makeZoomInput = (label: string, value: number, onChange: (v: number) => void) => {
			const wrap = zoomGroup.createDiv({ cls: "map-manager-field-inline" });
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

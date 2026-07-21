import { CellData, Marker, Token, hexKey, isCellEmpty, parseCellKey, squareKey } from "../data/mapData";
import { cellCenter, cellVisualWidth, effectiveCellSize, fogBucketSize, footprintCenter, isWorldPointExplored } from "../grid/fog";
import {
	ViewTransform,
	clamp,
	getVisibleHexCells,
	getVisibleSquareCells,
	hexCorners,
	hexWorldToCell,
	screenToWorld,
	squareWorldToCell,
	worldToScreen,
} from "../grid/gridMath";
import { drawFogMemoryMask, drawLinkBadge, drawMarker, drawStampAndLabel, drawToken, drawZoneFill } from "../render/drawing";
import { PublicViewController } from "./PublicViewController";

const MIN_CELL_PIXELS = 12;
const TOKEN_SIZE_RATIO = 0.475;
const DRAG_THRESHOLD = 4;
/** Fixed screen-pixel blur radius for the fog buffer (see `renderFogLayer`) — independent of zoom, softens the bucket grid's blocky edges. */
const FOG_BLUR_SCREEN_PX = 20;
/** Fixed screen-pixel overdraw margin on the offscreen fog buffer — comfortably larger than `FOG_BLUR_SCREEN_PX` so the blur has real data to read at the viewport's edge. */
const FOG_OVERDRAW_PX = FOG_BLUR_SCREEN_PX * 3;

export interface PublicMapCanvasOptions {
	/** Maps a stored image path (background/token image) to a URL the browser can actually load. Defaults to `defaultResolveAssetUrl`. */
	resolveAssetUrl?: (path: string) => string;
}

/**
 * Default asset resolution: takes just the *basename* of the stored path (dropping any
 * subfolder) and serves it from the site root — matching the site-export plugin's actual asset
 * layout, which copies vault attachments into `static/` flattened (a file at vault path
 * `Images/geography.jpg` ends up at `/geography.jpg`, not `/Images/geography.jpg`). Override via
 * `PublicMapCanvasOptions.resolveAssetUrl` if that convention ever changes.
 */
export function defaultResolveAssetUrl(path: string): string {
	const basename = path.split("/").pop() || path;
	return encodeURI(`/${basename}`);
}

interface ImageEntry {
	path: string;
	img: HTMLImageElement | null;
}

interface Bounds {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Read-only counterpart to `MapCanvas`: pan/zoom/click-to-select only — no dragging, no context
 * menu, no tools. Zero Obsidian dependency (plain DOM + Canvas2D), so it can run standalone on the
 * exported site. Draws from a `PublicMapSnapshot` that already has everything fog-hidden stripped
 * out (see `mapRedaction.ts`) — nothing here decides visibility, it only renders what it's given.
 */
export class PublicMapCanvas {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private resizeObserver: ResizeObserver;
	private transform: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
	private viewportW = 0;
	private viewportH = 0;

	/** Offscreen buffers the fog memory mask is composited on before blitting — see `renderFogLayer`. */
	private fogCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogCtx: CanvasRenderingContext2D;
	private fogBlurCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogBlurCtx: CanvasRenderingContext2D;

	private bgImages: Map<string, ImageEntry> = new Map();
	private tokenImages: Map<string, ImageEntry> = new Map();
	private hasAutoFramed = false;

	private dragging = false;
	private dragMoved = false;
	private pointerDownAt = { x: 0, y: 0 };
	private lastPointer = { x: 0, y: 0 };

	private readonly resolveAssetUrl: (path: string) => string;
	private readonly exploredSet: Set<string>;
	private unsubscribe: () => void;

	constructor(private container: HTMLElement, private controller: PublicViewController, options: PublicMapCanvasOptions = {}) {
		this.resolveAssetUrl = options.resolveAssetUrl ?? defaultResolveAssetUrl;
		this.exploredSet = new Set(controller.snapshot.map.exploredCells);

		this.canvas = document.createElement("canvas");
		this.canvas.className = "map-manager-public-canvas";
		this.canvas.style.display = "block";
		this.canvas.style.width = "100%";
		this.canvas.style.height = "100%";
		this.canvas.style.touchAction = "none";
		container.appendChild(this.canvas);
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas 2D context unavailable");
		this.ctx = ctx;

		const fogCtx = this.fogCanvas.getContext("2d");
		if (!fogCtx) throw new Error("Canvas 2D context unavailable");
		this.fogCtx = fogCtx;
		const fogBlurCtx = this.fogBlurCanvas.getContext("2d");
		if (!fogBlurCtx) throw new Error("Canvas 2D context unavailable");
		this.fogBlurCtx = fogBlurCtx;

		this.canvas.addEventListener("pointerdown", this.onPointerDown);
		this.canvas.addEventListener("pointermove", this.onPointerMove);
		this.canvas.addEventListener("pointerup", this.onPointerUp);
		this.canvas.addEventListener("pointercancel", this.onPointerCancel);
		this.canvas.addEventListener("wheel", this.onWheel, { passive: false });

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(container);

		this.unsubscribe = this.controller.onChange(() => this.render());

		this.applyFraming();
		this.resize();
	}

	destroy(): void {
		this.resizeObserver.disconnect();
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.unsubscribe();
		this.canvas.remove();
	}

	recenter(): void {
		this.applyFraming();
		this.hasAutoFramed = true;
		this.render();
	}

	/** Zooms in/out (`factor` > 1 zooms in) around the viewport's center — used by `PublicToolbar`'s +/− buttons. */
	zoomBy(factor: number): void {
		const data = this.controller.snapshot.map;
		const cx = this.viewportW / 2;
		const cy = this.viewportH / 2;
		const worldBefore = screenToWorld(cx, cy, this.transform);
		this.transform.zoom = clamp(this.transform.zoom * factor, this.getEffectiveMinZoom(), data.maxZoom);
		const screenAfter = worldToScreen(worldBefore.x, worldBefore.y, this.transform);
		this.transform.panX += cx - screenAfter.x;
		this.transform.panY += cy - screenAfter.y;
		this.render();
	}

	private resize(): void {
		const rect = this.container.getBoundingClientRect();
		this.viewportW = rect.width;
		this.viewportH = rect.height;
		const dpr = window.devicePixelRatio || 1;
		this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
		this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
		if (!this.hasAutoFramed) this.applyFraming();
		this.render();
	}

	// ---- Framing ----

	private applyFraming(): void {
		if (this.viewportW === 0 || this.viewportH === 0) return;
		const data = this.controller.snapshot.map;
		const bounds = this.computeVisibleImageBounds();
		if (bounds && bounds.w > 0 && bounds.h > 0) {
			const zoom = clamp(Math.min(this.viewportW / bounds.w, this.viewportH / bounds.h), data.minZoom, data.maxZoom);
			this.transform = {
				zoom,
				panX: this.viewportW / 2 - (bounds.x + bounds.w / 2) * zoom,
				panY: this.viewportH / 2 - (bounds.y + bounds.h / 2) * zoom,
			};
		} else {
			this.transform = { zoom: 1, panX: this.viewportW / 2, panY: this.viewportH / 2 };
		}
	}

	private computeVisibleImageBounds(): Bounds | null {
		const data = this.controller.snapshot.map;
		const cellSize = effectiveCellSize(data);
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let found = false;
		for (const layer of data.layers) {
			if (!layer.visible || !layer.background) continue;
			const entry = this.bgImages.get(layer.id);
			if (!entry?.img) continue;
			const w = entry.img.naturalWidth * layer.background.scale;
			const h = entry.img.naturalHeight * layer.background.scale;
			const x = layer.background.offsetX * cellSize - w / 2;
			const y = layer.background.offsetY * cellSize - h / 2;
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x + w);
			maxY = Math.max(maxY, y + h);
			found = true;
		}
		if (!found) return null;
		return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
	}

	private getEffectiveMinZoom(): number {
		const data = this.controller.snapshot.map;
		if (this.viewportW === 0 || this.viewportH === 0) return data.minZoom;
		const bounds = this.computeVisibleImageBounds();
		if (!bounds || bounds.w <= 0 || bounds.h <= 0) return data.minZoom;
		const fitZoom = Math.min(this.viewportW / bounds.w, this.viewportH / bounds.h);
		return clamp(fitZoom, data.minZoom, data.maxZoom);
	}

	private clampPanToBounds(bounds: Bounds): void {
		const { zoom } = this.transform;
		const imgW = bounds.w * zoom;
		const imgH = bounds.h * zoom;

		if (imgW <= this.viewportW) {
			this.transform.panX = this.viewportW / 2 - (bounds.x + bounds.w / 2) * zoom;
		} else {
			const panMin = this.viewportW - (bounds.x + bounds.w) * zoom;
			const panMax = -bounds.x * zoom;
			this.transform.panX = clamp(this.transform.panX, panMin, panMax);
		}

		if (imgH <= this.viewportH) {
			this.transform.panY = this.viewportH / 2 - (bounds.y + bounds.h / 2) * zoom;
		} else {
			const panMin = this.viewportH - (bounds.y + bounds.h) * zoom;
			const panMax = -bounds.y * zoom;
			this.transform.panY = clamp(this.transform.panY, panMin, panMax);
		}
	}

	// ---- Asset loading ----

	private ensureImagesLoaded(): void {
		const data = this.controller.snapshot.map;
		for (const layer of data.layers) {
			if (!layer.background) continue;
			const existing = this.bgImages.get(layer.id);
			if (existing && existing.path === layer.background.path) continue;
			const entry: ImageEntry = { path: layer.background.path, img: null };
			this.bgImages.set(layer.id, entry);
			const img = new Image();
			img.onload = () => {
				entry.img = img;
				this.hasAutoFramed = false;
				this.render();
			};
			img.src = this.resolveAssetUrl(layer.background.path);
		}
		for (const token of data.tokens) {
			if (!token.image) continue;
			const cached = this.tokenImages.get(token.id);
			if (cached && cached.path === token.image) continue;
			const entry: ImageEntry = { path: token.image, img: null };
			this.tokenImages.set(token.id, entry);
			const img = new Image();
			img.onload = () => {
				entry.img = img;
				this.render();
			};
			img.src = this.resolveAssetUrl(token.image);
		}
	}

	// ---- Geometry helpers ----

	private cellKeyAt(worldX: number, worldY: number): string {
		const data = this.controller.snapshot.map;
		const size = effectiveCellSize(data);
		if (data.gridType === "square" || data.gridType === "none") {
			const c = squareWorldToCell(worldX, worldY, size);
			return squareKey(c.a, c.b);
		}
		const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
		const c = hexWorldToCell(worldX, worldY, size, orientation);
		return hexKey(c.a, c.b);
	}

	private cellAt(key: string): CellData | undefined {
		const data = this.controller.snapshot.map;
		if (data.gridType === "none") return undefined;
		for (let i = data.layers.length - 1; i >= 0; i--) {
			const layer = data.layers[i];
			if (!layer?.visible) continue;
			const cell = layer.cellsByGridType[data.gridType][key];
			if (cell && !isCellEmpty(cell)) return cell;
		}
		return undefined;
	}

	private findTokenAtScreenPoint(px: number, py: number): Token | null {
		const world = screenToWorld(px, py, this.transform);
		const data = this.controller.snapshot.map;
		const radius = cellVisualWidth(data) * TOKEN_SIZE_RATIO;
		for (let i = data.tokens.length - 1; i >= 0; i--) {
			const token = data.tokens[i];
			if (!token) continue;
			const center = footprintCenter(data, token);
			const r = radius * (token.size ?? 1);
			if (Math.hypot(world.x - center.x, world.y - center.y) <= r) return token;
		}
		return null;
	}

	private findMarkerAtScreenPoint(px: number, py: number): Marker | null {
		const world = screenToWorld(px, py, this.transform);
		const data = this.controller.snapshot.map;
		const radius = cellVisualWidth(data) * TOKEN_SIZE_RATIO;
		for (let li = data.layers.length - 1; li >= 0; li--) {
			const layer = data.layers[li];
			if (!layer?.visible) continue;
			for (let i = layer.markers.length - 1; i >= 0; i--) {
				const marker = layer.markers[i];
				if (marker && Math.hypot(world.x - marker.x, world.y - marker.y) <= radius) return marker;
			}
		}
		return null;
	}

	// ---- Input ----

	private onPointerDown = (e: PointerEvent): void => {
		this.dragging = true;
		this.dragMoved = false;
		this.pointerDownAt = { x: e.clientX, y: e.clientY };
		this.lastPointer = { x: e.clientX, y: e.clientY };
		this.canvas.setPointerCapture(e.pointerId);
	};

	private onPointerMove = (e: PointerEvent): void => {
		if (!this.dragging) return;
		const dx = e.clientX - this.lastPointer.x;
		const dy = e.clientY - this.lastPointer.y;
		this.lastPointer = { x: e.clientX, y: e.clientY };
		if (!this.dragMoved && Math.hypot(e.clientX - this.pointerDownAt.x, e.clientY - this.pointerDownAt.y) > DRAG_THRESHOLD) {
			this.dragMoved = true;
		}
		if (this.dragMoved) {
			this.transform.panX += dx;
			this.transform.panY += dy;
			this.render();
		}
	};

	private onPointerUp = (e: PointerEvent): void => {
		this.dragging = false;
		if (this.dragMoved) return;
		const rect = this.canvas.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;

		const token = this.findTokenAtScreenPoint(px, py);
		if (token) {
			this.controller.select({ type: "token", id: token.id });
			return;
		}
		const data = this.controller.snapshot.map;
		if (data.gridType === "none") {
			const marker = this.findMarkerAtScreenPoint(px, py);
			this.controller.select(marker ? { type: "marker", id: marker.id } : null);
			return;
		}
		const world = screenToWorld(px, py, this.transform);
		const key = this.cellKeyAt(world.x, world.y);
		this.controller.select(this.cellAt(key) ? { type: "cell", key } : null);
	};

	private onPointerCancel = (): void => {
		this.dragging = false;
		this.dragMoved = false;
	};

	private onWheel = (e: WheelEvent): void => {
		e.preventDefault();
		const rect = this.canvas.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		const worldBefore = screenToWorld(px, py, this.transform);
		const factor = Math.exp(-e.deltaY * 0.001);
		const data = this.controller.snapshot.map;
		this.transform.zoom = clamp(this.transform.zoom * factor, this.getEffectiveMinZoom(), data.maxZoom);
		const screenAfter = worldToScreen(worldBefore.x, worldBefore.y, this.transform);
		this.transform.panX += px - screenAfter.x;
		this.transform.panY += py - screenAfter.y;
		this.render();
	};

	// ---- Rendering ----

	render(): void {
		if (this.viewportW === 0 || this.viewportH === 0) return;
		this.ensureImagesLoaded();

		const data = this.controller.snapshot.map;
		if (!this.hasAutoFramed) {
			const bounds = this.computeVisibleImageBounds();
			if (bounds && bounds.w > 0 && bounds.h > 0) {
				this.applyFraming();
				this.hasAutoFramed = true;
			}
		}

		const imageBounds = this.computeVisibleImageBounds();
		this.transform.zoom = clamp(this.transform.zoom, this.getEffectiveMinZoom(), data.maxZoom);
		if (imageBounds) this.clampPanToBounds(imageBounds);

		const dpr = window.devicePixelRatio || 1;
		const ctx = this.ctx;
		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, this.viewportW, this.viewportH);
		ctx.translate(this.transform.panX, this.transform.panY);
		ctx.scale(this.transform.zoom, this.transform.zoom);

		this.drawBackgrounds(ctx);

		const cellSize = effectiveCellSize(data);
		const cellsVisible = data.gridType !== "none" && cellVisualWidth(data) * this.transform.zoom >= MIN_CELL_PIXELS;
		if (cellsVisible) this.drawGridAndCells(ctx, cellSize);
		if (data.gridType === "none") this.drawMarkers(ctx);

		if (data.fogEnabled) {
			const viewportRect = this.visibleWorldRect();
			const fogRect = this.renderFogLayer(dpr, viewportRect);
			ctx.drawImage(this.fogBlurCanvas, fogRect.minX, fogRect.minY, fogRect.maxX - fogRect.minX, fogRect.maxY - fogRect.minY);
		}

		this.drawTokens(ctx, data.tokens);
		this.drawSelectionHighlight(ctx, cellSize);

		ctx.restore();
	}

	private visibleWorldRect(): { minX: number; minY: number; maxX: number; maxY: number } {
		const tl = screenToWorld(0, 0, this.transform);
		const br = screenToWorld(this.viewportW, this.viewportH, this.transform);
		return { minX: Math.min(tl.x, br.x), minY: Math.min(tl.y, br.y), maxX: Math.max(tl.x, br.x), maxY: Math.max(tl.y, br.y) };
	}

	/**
	 * Draws the fog memory mask into an offscreen buffer, then blurs it (a fixed number of real
	 * screen pixels, independent of zoom) into a second buffer — softening the bucket grid's blocky
	 * edges to match the polished look of the live Obsidian fog rendering. Returns the world rect
	 * the blurred buffer covers, for `render()` to blit back at (mirrors `MapCanvas.renderFogLayer`,
	 * minus the vision-fan compositing this read-only viewer doesn't need).
	 */
	private renderFogLayer(dpr: number, viewportRect: { minX: number; minY: number; maxX: number; maxY: number }): {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	} {
		const data = this.controller.snapshot.map;
		const zoom = this.transform.zoom;
		const overdrawWorld = FOG_OVERDRAW_PX / zoom;
		const fogRect = {
			minX: viewportRect.minX - overdrawWorld,
			minY: viewportRect.minY - overdrawWorld,
			maxX: viewportRect.maxX + overdrawWorld,
			maxY: viewportRect.maxY + overdrawWorld,
		};

		const cssW = this.viewportW + 2 * FOG_OVERDRAW_PX;
		const cssH = this.viewportH + 2 * FOG_OVERDRAW_PX;
		const w = Math.max(1, Math.round(cssW * dpr));
		const h = Math.max(1, Math.round(cssH * dpr));
		if (this.fogCanvas.width !== w || this.fogCanvas.height !== h) {
			this.fogCanvas.width = w;
			this.fogCanvas.height = h;
		}
		if (this.fogBlurCanvas.width !== w || this.fogBlurCanvas.height !== h) {
			this.fogBlurCanvas.width = w;
			this.fogBlurCanvas.height = h;
		}

		const fctx = this.fogCtx;
		fctx.save();
		fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		fctx.clearRect(0, 0, cssW, cssH);
		fctx.translate(this.transform.panX + zoom * overdrawWorld, this.transform.panY + zoom * overdrawWorld);
		fctx.scale(zoom, zoom);
		const bucketSize = fogBucketSize(data);
		drawFogMemoryMask(fctx, fogRect, bucketSize, (x, y) => isWorldPointExplored(this.exploredSet, data, x, y));
		fctx.restore();

		const bctx = this.fogBlurCtx;
		bctx.save();
		bctx.setTransform(1, 0, 0, 1, 0, 0);
		bctx.clearRect(0, 0, w, h);
		bctx.filter = `blur(${FOG_BLUR_SCREEN_PX * dpr}px)`;
		bctx.drawImage(this.fogCanvas, 0, 0);
		bctx.restore();

		return fogRect;
	}

	private drawBackgrounds(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.snapshot.map;
		const cellSize = effectiveCellSize(data);
		for (const layer of data.layers) {
			if (!layer.visible || !layer.background) continue;
			const entry = this.bgImages.get(layer.id);
			if (!entry?.img) continue;
			const bg = layer.background;
			const w = entry.img.naturalWidth * bg.scale;
			const h = entry.img.naturalHeight * bg.scale;
			ctx.drawImage(entry.img, bg.offsetX * cellSize - w / 2, bg.offsetY * cellSize - h / 2, w, h);
		}
	}

	private drawGridAndCells(ctx: CanvasRenderingContext2D, cellSize: number): void {
		const data = this.controller.snapshot.map;
		if (data.gridType === "none") return;
		const gridColor = "rgba(127,127,127,0.4)";
		const visibleLayers = data.layers.filter((l) => l.visible);
		ctx.lineWidth = Math.max(0.5, 1 / this.transform.zoom);

		if (data.gridType === "square") {
			const cells = getVisibleSquareCells(this.transform, cellSize, this.viewportW, this.viewportH);
			for (const c of cells) {
				const key = squareKey(c.a, c.b);
				const x = c.a * cellSize;
				const y = c.b * cellSize;
				for (const layer of visibleLayers) {
					const cell = layer.cellsByGridType[data.gridType][key];
					if (cell?.zoneTypeId) drawZoneFill(ctx, data.zoneTypes, cell.zoneTypeId, () => ctx.rect(x, y, cellSize, cellSize));
				}
				ctx.strokeStyle = gridColor;
				ctx.strokeRect(x, y, cellSize, cellSize);
				for (const layer of visibleLayers) {
					const cell = layer.cellsByGridType[data.gridType][key];
					if (cell?.stamp || cell?.label) drawStampAndLabel(ctx, x + cellSize / 2, y + cellSize / 2, cellSize, this.transform.zoom, cell.stamp, cell.label);
					if (cell?.links?.length) drawLinkBadge(ctx, x + cellSize * 0.15, y + cellSize * 0.05, cellSize);
				}
			}
			return;
		}

		const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
		const cells = getVisibleHexCells(this.transform, cellSize, orientation, this.viewportW, this.viewportH);
		for (const c of cells) {
			const key = hexKey(c.a, c.b);
			const center = cellCenter(data, key);
			const corners = hexCorners(center.x, center.y, cellSize, orientation);
			ctx.beginPath();
			corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
			ctx.closePath();
			for (const layer of visibleLayers) {
				const cell = layer.cellsByGridType[data.gridType][key];
				if (cell?.zoneTypeId) drawZoneFill(ctx, data.zoneTypes, cell.zoneTypeId, () => {});
			}
			ctx.strokeStyle = gridColor;
			ctx.stroke();
			for (const layer of visibleLayers) {
				const cell = layer.cellsByGridType[data.gridType][key];
				if (cell?.stamp || cell?.label) drawStampAndLabel(ctx, center.x, center.y, cellSize, this.transform.zoom, cell.stamp, cell.label);
				if (cell?.links?.length) drawLinkBadge(ctx, center.x - cellSize * 0.35, center.y - cellSize * 0.55, cellSize);
			}
		}
	}

	private drawMarkers(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.snapshot.map;
		const size = cellVisualWidth(data);
		for (const layer of data.layers) {
			if (!layer.visible) continue;
			for (const marker of layer.markers) drawMarker(ctx, marker, size, this.transform.zoom);
		}
	}

	private drawTokens(ctx: CanvasRenderingContext2D, tokens: Token[]): void {
		const data = this.controller.snapshot.map;
		const radius = cellVisualWidth(data) * TOKEN_SIZE_RATIO;
		for (const token of tokens) {
			const center = footprintCenter(data, token);
			const imageEntry = token.image ? this.tokenImages.get(token.id) : undefined;
			const image = imageEntry && imageEntry.path === token.image ? imageEntry.img : null;
			const selected = this.controller.selected?.type === "token" && this.controller.selected.id === token.id;
			drawToken(ctx, center.x, center.y, radius * (token.size ?? 1), token, { selected, zoom: this.transform.zoom, image });
		}
	}

	private drawSelectionHighlight(ctx: CanvasRenderingContext2D, cellSize: number): void {
		const selection = this.controller.selected;
		if (!selection || selection.type !== "cell") return;
		const data = this.controller.snapshot.map;
		if (data.gridType === "none") return;
		const { a, b } = parseCellKey(selection.key);
		ctx.save();
		ctx.lineWidth = Math.max(1.5, 3 / this.transform.zoom);
		ctx.strokeStyle = "#4f9eff";
		if (data.gridType === "square") {
			ctx.strokeRect(a * cellSize, b * cellSize, cellSize, cellSize);
		} else {
			const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
			const center = cellCenter(data, selection.key);
			const corners = hexCorners(center.x, center.y, cellSize, orientation);
			ctx.beginPath();
			corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
			ctx.closePath();
			ctx.stroke();
		}
		ctx.restore();
	}
}

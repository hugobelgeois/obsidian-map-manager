import { App, Menu, Notice } from "obsidian";
import { MapController } from "../controller/MapController";
import { MapManagerSettings } from "../settings/types";
import {
	DEFAULT_TOKEN_COLOR,
	DEFAULT_VISION_ANGLE,
	DEFAULT_VISION_DIRECTION,
	DEFAULT_VISION_RADIUS,
	DEFAULT_VISION_RANGE,
	Marker,
	Token,
	VisionBlockerType,
	WallPoint,
	hexKey,
	isCellEmpty,
	parseCellKey,
	squareKey,
} from "../data/mapData";
import {
	Point,
	SQUARE_CELL_SCALE,
	SnapCandidate,
	ViewTransform,
	clamp,
	getVisibleHexCells,
	getVisibleSquareCells,
	hexCellToWorldCenter,
	hexCorners,
	hexGridSnapCandidates,
	hexWorldToCell,
	raySegmentDistance,
	screenToWorld,
	segmentIntersection,
	squareFootprintAnchor,
	squareGridSnapCandidates,
	squareWorldToCell,
	wallShapeCorners,
	worldToScreen,
} from "../grid/gridMath";

const DRAG_THRESHOLD = 4;
/** Radius as a fraction of (cellVisualWidth * token.size): 0.475 → a diameter equal to 95% of the cell's width. */
const TOKEN_SIZE_RATIO = 0.475;
/** Below this on-screen cell size (in px), the grid/cell overlay auto-hides until zoomed back in. */
const MIN_CELL_PIXELS = 12;
/** Below this on-screen font size (in px), a cell's label hides and its stamp grows to fill the space instead. */
const MIN_LABEL_PIXELS = 9;

/** Fog opacity for ground that has never been in a player's vision. */
const FOG_OPACITY_UNEXPLORED = 1;
/** Fog opacity for ground that has been seen before, isn't currently lit, or sits beyond a "dim" blocker. */
const FOG_OPACITY_EXPLORED = 0.55;

/**
 * Rays cast per player token when tracing vision (ray/path tracing, not grid tracing) — fixed
 * angular resolution independent of zoom, grid type, or cell size. 180 gives a 2° step, smooth
 * enough for cone edges without the cost scaling with how many cells are on screen.
 */
const FOG_RAY_COUNT = 180;
/**
 * Size, in cell-widths, of the square buckets used only to persist "ever explored" ground.
 * Still coarser than the actual grid (and independent of grid type/shape) — exploration memory
 * doesn't need cell-level precision — but small enough to hug walls/blockers reasonably closely.
 * Lower = more precise (and more stored keys/cheaper-but-more-frequent bucket scan cells); this
 * was 3 and felt too blocky/imprecise.
 */
const FOG_BUCKET_SCALE = 1.25;
/**
 * Hard cap on how many fog-memory buckets get scanned per axis in one frame — see
 * `fogIterationBucketSize`. Keeps the scan (and its Path2D) bounded even when zoomed out so far
 * that the visible world rect would otherwise need far more of the fine `FOG_BUCKET_SCALE` grid.
 */
const FOG_MAX_BUCKETS_PER_AXIS = 160;
/**
 * Tremble amplitudes in fixed *screen* pixels (divided by zoom at use, see `drawFog`/`castRaysForToken`)
 * rather than a fraction of a world-space length — otherwise the wobble shrinks away right along with
 * everything else when zoomed out, which reads as "the animation stops". The memory (explored/
 * unexplored) frontier's amplitude is deliberately larger than the vision fan's.
 */
const FOG_TREMBLE_SCREEN_PX = 4;
const FOG_MEMORY_TREMBLE_SCREEN_PX = 10;
/** Angular speed (rad/s) of the tremble's sine wave. */
const FOG_TREMBLE_SPEED = 1.6;
/** Fixed screen-pixel blur radius for the fog buffer (see `drawFog`) — independent of zoom or the LOD tile size. */
const FOG_BLUR_SCREEN_PX = 22;
/** Fixed screen-pixel overdraw margin on the offscreen fog buffer — see `renderFogLayer`. Comfortably larger than `FOG_BLUR_SCREEN_PX`. */
const FOG_OVERDRAW_PX = FOG_BLUR_SCREEN_PX * 3;
/** Fog animations (the tremble, and the render loop driving it) are force-disabled at or past this zoom — see `fogAnimationsActive`. */
const FOG_ANIMATION_MIN_ZOOM = 0.5;

/** Axial neighbor offsets (orientation-agnostic — pointy vs. flat only changes pixel<->hex conversion, not adjacency). */
const HEX_NEIGHBOR_OFFSETS: Array<{ dq: number; dr: number }> = [
	{ dq: 1, dr: 0 },
	{ dq: 1, dr: -1 },
	{ dq: 0, dr: -1 },
	{ dq: -1, dr: 0 },
	{ dq: -1, dr: 1 },
	{ dq: 0, dr: 1 },
];
/** Safety cap on the fill tool's flood fill, so an unenclosed area (no closed perimeter) can't hang the browser. */
const FILL_LIMIT = 4000;

/** World-unit radius (as a fraction of `cellVisualWidth`) for clicking an existing wall point. */
const WALL_POINT_HIT_RATIO = 0.2;
/** Fixed screen-pixel radius within which a placed wall point snaps to a grid corner/midpoint/edge. */
const WALL_SNAP_SCREEN_PX = 14;

/** Mixes a #rrggbb color toward white by `ratio` (0 = unchanged, 1 = white). Used for the selected-token border. */
function lightenColor(hex: string, ratio: number): string {
	const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
	if (!match || !match[1] || !match[2] || !match[3]) return hex;
	const mix = (channel: string) => Math.round(parseInt(channel, 16) + (255 - parseInt(channel, 16)) * ratio);
	return `rgb(${mix(match[1])}, ${mix(match[2])}, ${mix(match[3])})`;
}

/** Signed difference between two angles in degrees, normalized to [-180, 180]. */
function angleDiffDeg(a: number, b: number): number {
	let diff = (a - b) % 360;
	if (diff > 180) diff -= 360;
	if (diff < -180) diff += 360;
	return diff;
}

/** Stable per-token phase offset (radians) so several tokens' fog tremble doesn't move in lockstep. */
function tremblePhase(tokenId: string): number {
	let hash = 0;
	for (let i = 0; i < tokenId.length; i++) hash = (hash * 31 + tokenId.charCodeAt(i)) | 0;
	return (hash % 1000) / 1000;
}

interface DraggingToken {
	token: Token;
	currentWorld: { x: number; y: number };
}

interface DraggingMarker {
	marker: Marker;
	currentWorld: { x: number; y: number };
}

interface DraggingWallPoint {
	point: WallPoint;
	currentWorld: { x: number; y: number };
}

interface BackgroundEntry {
	path: string;
	img: HTMLImageElement | null;
}

/** A `WallSegment` with its two endpoints resolved to world coordinates, for ray casting/flood-fill. */
interface ResolvedWallSegment {
	a: Point;
	b: Point;
	type: VisionBlockerType;
}

/** One ray's traced reach, in pixels from the token center, at a fixed angle (see `FOG_RAY_COUNT`). */
interface RaySample {
	/** Distance to the first blocker of any kind (or the vision's natural edge if none). */
	clearEnd: number;
	/** Distance to the first *opaque* blocker (or the natural edge) — reaches past a "dim" blocker. */
	dimEnd: number;
}

/** A player token's traced vision for the current frame: 0..360° rays fanning out from its center. */
interface PlayerVisionRays {
	center: { x: number; y: number };
	rays: RaySample[];
	/** Stable per-token phase for the *cosmetic* fan-edge tremble (see `appendVisionFan`) — never affects `rays` itself. */
	phase: number;
}

export class MapCanvas {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private resizeObserver: ResizeObserver;
	private transform: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
	private viewportW = 0;
	private viewportH = 0;

	private bgImages: Map<string, BackgroundEntry> = new Map();
	/** Keyed by token id (not path), since several tokens could share the same image. */
	private tokenImages: Map<string, BackgroundEntry> = new Map();
	/** True once the initial "center on the image, zoomed out to fit it" framing has run. */
	private hasAutoFramed = false;

	/** Every player token's traced vision rays, recomputed once per `render()` and reused by both `drawFog` and `drawTokens`. */
	private frameVisionCache: PlayerVisionRays[] = [];

	/** Offscreen buffer fog is composited on before being drawn onto the main canvas as one image — see the constructor comment. */
	private fogCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogCtx: CanvasRenderingContext2D;
	/** Second pass: `fogCanvas`'s crisp content, blurred under a plain (unscaled) transform — see `renderFogLayer`. */
	private fogBlurCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogBlurCtx: CanvasRenderingContext2D;
	/** Non-null while the fog-tremble animation loop (settings.fogAnimations) is actively re-rendering every frame. */
	private animationFrameId: number | null = null;

	private dragging = false;
	private dragMoved = false;
	private draggingToken: DraggingToken | null = null;
	private draggingMarker: DraggingMarker | null = null;
	private draggingWallPoint: DraggingWallPoint | null = null;
	/** True while the brush tool is actively painting cells under a held-down drag. */
	private painting = false;
	private lastPaintedKey: string | null = null;
	/** Cells already painted during the current brush stroke, to avoid re-applying (and re-history-grouping) the same cell twice. */
	private paintedInStroke: Set<string> = new Set();
	/** True once a click has been fully handled by a tool (e.g. fill) in onPointerDown, so onPointerUp shouldn't also run the normal click/pan logic. */
	private toolConsumedClick = false;
	private pointerDownAt = { x: 0, y: 0 };
	private lastPointer = { x: 0, y: 0 };

	/** Live (possibly snapped) target for the wall tool's in-progress chain — see `drawWallPreview`. Recomputed on every pointer move regardless of `dragging` (a click, not a drag, places each wall point). */
	private wallPreview: { x: number; y: number } | null = null;

	private unsubscribe: () => void;

	private onContextMenu = (e: MouseEvent) => {
		if (this.controller.activeTool === "wall") {
			e.preventDefault();
			if (this.controller.pendingWallShape) {
				this.controller.cancelWallShapeStep();
			} else {
				this.controller.undoLastWallPoint();
			}
			return;
		}

		const rect = this.canvas.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;

		const menu = new Menu();
		let hasItem = false;
		// Markers are freeform (grid type "none" only, see `Marker`), so only offer to place one there.
		if (this.controller.mode === "edit" && this.controller.getData().gridType === "none") {
			menu.addItem((item) => item.setTitle("Placer un tampon ici").setIcon("map-pin").onClick(() => this.addMarkerAt(px, py)));
			hasItem = true;
		}
		if (this.controller.mode === "view") {
			menu.addItem((item) => item.setTitle("Placer un pion ici").setIcon("user").onClick(() => this.addTokenAt(px, py)));
			hasItem = true;
		}
		// Nothing to offer (e.g. edit mode on a celled grid) — let the browser's own context menu show.
		if (!hasItem) return;
		e.preventDefault();
		menu.showAtMouseEvent(e);
	};

	private onPointerDown = (e: PointerEvent) => {
		// Right-click is handled entirely by `onContextMenu` (undo last wall point) while the wall
		// tool is active — skip the normal drag/click machinery below for it.
		if (e.button === 2 && this.controller.activeTool === "wall") return;

		const rect = this.canvas.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;

		this.dragging = true;
		this.dragMoved = false;
		this.pointerDownAt = { x: e.clientX, y: e.clientY };
		this.lastPointer = { x: e.clientX, y: e.clientY };
		this.canvas.setPointerCapture(e.pointerId);

		// Tokens are only interactive in view mode; edit mode is for the map's structure (grid, zones, layers, markers, brush/fill).
		if (this.controller.mode === "view") {
			const hit = this.findTokenAtScreenPoint(px, py);
			if (hit) {
				this.draggingToken = { token: hit, currentWorld: screenToWorld(px, py, this.transform) };
			}
			return;
		}

		const data = this.controller.getData();
		if (data.gridType === "none") {
			const hit = this.findMarkerAtScreenPoint(px, py);
			if (hit) {
				this.draggingMarker = { marker: hit, currentWorld: screenToWorld(px, py, this.transform) };
				return;
			}
		}

		// Wall points are draggable/selectable regardless of the active tool (like tokens/markers
		// above), unless the wall tool itself is active — in that case the click instead goes through
		// `resolveWallPlacement`/`commitWallPoint` below, which does its own hit-test as part of
		// closing a shape onto an existing point.
		if (this.controller.activeTool !== "wall") {
			const hitPoint = this.findWallPointAtScreenPoint(px, py);
			if (hitPoint) {
				this.draggingWallPoint = { point: hitPoint, currentWorld: screenToWorld(px, py, this.transform) };
				return;
			}
		}

		if (this.controller.activeTool === "brush") {
			this.painting = true;
			this.paintedInStroke = new Set();
			const world = screenToWorld(px, py, this.transform);
			const key = this.cellKeyAt(world.x, world.y);
			this.lastPaintedKey = key;
			this.controller.beginHistoryGroup();
			this.paintBrushAt(key);
		} else if (this.controller.activeTool === "fill") {
			const world = screenToWorld(px, py, this.transform);
			const key = this.cellKeyAt(world.x, world.y);
			this.fillFrom(key);
			this.toolConsumedClick = true;
		} else if (this.controller.activeTool === "wall") {
			const placement = this.resolveWallPlacement(px, py);
			if (this.controller.pendingWallShape) {
				this.controller.placeWallShapeCorner(placement.x, placement.y);
			} else {
				this.controller.commitWallPoint(placement.x, placement.y, placement.existingPointId);
			}
			this.toolConsumedClick = true;
		}
	};

	private onPointerMove = (e: PointerEvent) => {
		// Unlike brush/drag gestures, wall points/shape corners are placed one click at a time — the
		// live preview of the next one must track the pointer even while no button is held
		// (`!this.dragging`).
		if (this.controller.activeTool === "wall" && (this.controller.getWallChainTailId() || this.controller.getWallShapeFirstCorner())) {
			const rect = this.canvas.getBoundingClientRect();
			this.wallPreview = this.resolveWallPlacement(e.clientX - rect.left, e.clientY - rect.top);
			this.render();
		}

		if (!this.dragging) return;
		const dx = e.clientX - this.lastPointer.x;
		const dy = e.clientY - this.lastPointer.y;
		if (!this.dragMoved) {
			const totalDx = e.clientX - this.pointerDownAt.x;
			const totalDy = e.clientY - this.pointerDownAt.y;
			if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) this.dragMoved = true;
		}
		this.lastPointer = { x: e.clientX, y: e.clientY };

		if (this.toolConsumedClick) return;

		const rect = this.canvas.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;

		if (this.painting) {
			const world = screenToWorld(px, py, this.transform);
			const key = this.cellKeyAt(world.x, world.y);
			if (key !== this.lastPaintedKey) {
				this.lastPaintedKey = key;
				this.paintBrushAt(key);
			}
			return;
		}

		if (!this.dragMoved) return;

		if (this.draggingToken) {
			this.draggingToken.currentWorld = screenToWorld(px, py, this.transform);
			this.render();
		} else if (this.draggingMarker) {
			this.draggingMarker.currentWorld = screenToWorld(px, py, this.transform);
			this.render();
		} else if (this.draggingWallPoint) {
			this.draggingWallPoint.currentWorld = this.snapWorldToGrid(screenToWorld(px, py, this.transform));
			this.render();
		} else {
			this.transform.panX += dx;
			this.transform.panY += dy;
			this.render();
		}
	};

	private onPointerUp = (e: PointerEvent) => {
		if (!this.dragging) return;
		this.dragging = false;
		if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);

		if (this.toolConsumedClick) {
			this.toolConsumedClick = false;
			return;
		}

		if (this.painting) {
			this.painting = false;
			this.lastPaintedKey = null;
			this.paintedInStroke = new Set();
			this.controller.endHistoryGroup();
			return;
		}

		if (this.draggingToken) {
			const drag = this.draggingToken;
			this.draggingToken = null;
			if (this.dragMoved) {
				if (this.controller.getData().gridType === "none") {
					this.controller.moveTokenFree(drag.token.id, drag.currentWorld.x, drag.currentWorld.y);
				} else {
					const targetKey = this.dropAnchorKey(drag.token, drag.currentWorld.x, drag.currentWorld.y);
					const moved = this.controller.moveToken(drag.token.id, targetKey);
					if (!moved) new Notice("Case déjà occupée par un pion.");
				}
				this.render();
			} else {
				this.controller.selectToken(drag.token.id);
			}
			return;
		}

		if (this.draggingMarker) {
			const drag = this.draggingMarker;
			this.draggingMarker = null;
			if (this.dragMoved) {
				this.controller.moveMarker(drag.marker.id, drag.currentWorld.x, drag.currentWorld.y);
				this.render();
			} else {
				this.controller.selectMarker(drag.marker.id);
			}
			return;
		}

		if (this.draggingWallPoint) {
			const drag = this.draggingWallPoint;
			this.draggingWallPoint = null;
			if (this.dragMoved) {
				this.controller.moveWallPoint(drag.point.id, drag.currentWorld.x, drag.currentWorld.y);
				this.render();
			} else {
				this.controller.selectWallPoint(drag.point.id);
			}
			return;
		}

		if (!this.dragMoved) this.handleClick(e);
	};

	private onPointerCancel = () => {
		this.dragging = false;
		this.draggingToken = null;
		this.draggingMarker = null;
		this.draggingWallPoint = null;
		if (this.painting) this.controller.endHistoryGroup();
		this.painting = false;
		this.lastPaintedKey = null;
		this.paintedInStroke = new Set();
		this.toolConsumedClick = false;
	};

	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		const rect = this.canvas.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		const worldBefore = screenToWorld(px, py, this.transform);
		const factor = Math.exp(-e.deltaY * 0.001);
		this.transform.zoom = clamp(this.transform.zoom * factor, this.getEffectiveMinZoom(), this.controller.getData().maxZoom);
		const screenAfter = worldToScreen(worldBefore.x, worldBefore.y, this.transform);
		this.transform.panX += px - screenAfter.x;
		this.transform.panY += py - screenAfter.y;
		this.render();
	};

	constructor(private container: HTMLElement, private controller: MapController, private app: App, private settings: MapManagerSettings) {
		this.canvas = container.createEl("canvas", { cls: "map-manager-canvas" });
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas 2D context unavailable");
		this.ctx = ctx;

		// Fog is composited on its own offscreen buffer (see `renderFogLayer`) rather than painted
		// directly onto the main canvas: `destination-out` erases whatever is already on the surface
		// it's drawn to, and the main canvas already has the background/grid/zones on it by the time
		// fog is drawn — punching a hole there would erase the map itself, not just a fog overlay.
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
		this.canvas.addEventListener("contextmenu", this.onContextMenu);

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(container);

		this.unsubscribe = this.controller.onChange(() => this.render());

		// Synchronous fallback (no background image loaded yet); render() re-frames for real
		// once an image finishes loading, via the `hasAutoFramed` check below.
		this.applyFraming();
		this.resize();
	}

	/** Centers the view and zooms out just enough to fit every visible background image. */
	private applyFraming(): void {
		if (this.viewportW === 0 || this.viewportH === 0) return;
		const data = this.controller.getData();
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

	/** Manually re-centers the view (toolbar "Recentrer" button). */
	recenter(): void {
		this.applyFraming();
		this.hasAutoFramed = true;
		this.render();
	}

	/**
	 * Union of all visible layers' background images, in world (pixel) space.
	 * Used in view mode to keep the map from zooming out past the image and to
	 * clip the grid/cell overlay to the image.
	 */
	private computeVisibleImageBounds(): { x: number; y: number; w: number; h: number } | null {
		const data = this.controller.getData();
		const cellSize = this.effectiveCellSize();
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
			// offsetX/Y are the image's center, in cells; convert to a world-space top-left corner.
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
		const data = this.controller.getData();
		if (this.controller.mode !== "view" || this.viewportW === 0 || this.viewportH === 0) return data.minZoom;
		const bounds = this.computeVisibleImageBounds();
		if (!bounds || bounds.w <= 0 || bounds.h <= 0) return data.minZoom;
		const fitZoom = Math.min(this.viewportW / bounds.w, this.viewportH / bounds.h);
		return clamp(fitZoom, data.minZoom, data.maxZoom);
	}

	/** Keeps the viewport from panning past the edges of the image (view mode only). */
	private clampPanToBounds(bounds: { x: number; y: number; w: number; h: number }): void {
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

	destroy(): void {
		if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
		this.resizeObserver.disconnect();
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.canvas.removeEventListener("contextmenu", this.onContextMenu);
		this.unsubscribe();
		this.canvas.remove();
	}

	private resize(): void {
		const dpr = window.devicePixelRatio || 1;
		const w = this.container.clientWidth;
		const h = this.container.clientHeight;
		if (w === 0 || h === 0) return;
		this.viewportW = w;
		this.viewportH = h;
		this.canvas.width = Math.round(w * dpr);
		this.canvas.height = Math.round(h * dpr);
		this.canvas.style.width = `${w}px`;
		this.canvas.style.height = `${h}px`;
		this.render();
	}

	// ---- Coordinate helpers ----

	/**
	 * Pixel size used for a cell's own geometry (grid lines, hit-testing, background offsets,
	 * token sizing...). Square grids are scaled up by `SQUARE_CELL_SCALE` so that, for the same
	 * stored `cellSize`, a square cell's edge matches a hex cell's flat-to-flat width — keeping
	 * everything (tokens included) visually consistent across a grid-type switch. Grid type "none"
	 * has no visible cells but still uses square math for its hidden fog substrate (see `updateCell`).
	 */
	private effectiveCellSize(): number {
		const data = this.controller.getData();
		return data.gridType === "square" || data.gridType === "none" ? data.cellSize * SQUARE_CELL_SCALE : data.cellSize;
	}

	/**
	 * A cell's actual on-screen width, for both grid types: a square's edge (already scaled by
	 * `effectiveCellSize`) and a hex's flat-to-flat width both equal `cellSize * SQUARE_CELL_SCALE`
	 * — hex functions just take the raw circumradius (`cellSize`) as their size parameter, so this
	 * needs its own scale-up rather than reusing `effectiveCellSize`. Used for anything sized
	 * "relative to the cell" regardless of grid type (tokens, vision range).
	 */
	private cellVisualWidth(): number {
		return this.controller.getData().cellSize * SQUARE_CELL_SCALE;
	}

	/** Grid type "none" is treated as "square" here — it has no visible cells, but fog still uses this square substrate. */
	private cellKeyAt(worldX: number, worldY: number): string {
		const data = this.controller.getData();
		if (data.gridType === "square" || data.gridType === "none") {
			const c = squareWorldToCell(worldX, worldY, this.effectiveCellSize());
			return squareKey(c.a, c.b);
		}
		const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
		const c = hexWorldToCell(worldX, worldY, this.effectiveCellSize(), orientation);
		return hexKey(c.a, c.b);
	}

	/** Anchor cell for a dropped token: accounts for its footprint so its visual center lands under the pointer. */
	private dropAnchorKey(token: Token, worldX: number, worldY: number): string {
		const data = this.controller.getData();
		const size = token.size ?? 1;
		if (data.gridType === "square" && size > 1) {
			const { a, b } = squareFootprintAnchor(worldX, worldY, this.effectiveCellSize(), size);
			return squareKey(a, b);
		}
		return this.cellKeyAt(worldX, worldY);
	}

	private cellCenter(key: string): { x: number; y: number } {
		const data = this.controller.getData();
		const { a, b } = parseCellKey(key);
		const cellSize = this.effectiveCellSize();
		if (data.gridType === "square") {
			return { x: a * cellSize + cellSize / 2, y: b * cellSize + cellSize / 2 };
		}
		const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
		return hexCellToWorldCenter(a, b, cellSize, orientation);
	}

	// ---- Brush / fill tools ----

	/** All cell keys within `controller.brushRadius` cells of `centerKey` (a filled circle for square grids, a hex disc for hex grids). */
	private cellsWithinBrush(centerKey: string): string[] {
		const data = this.controller.getData();
		const radius = this.controller.brushRadius;
		if (radius <= 0) return [centerKey];
		const { a: ca, b: cb } = parseCellKey(centerKey);
		const keys: string[] = [];
		if (data.gridType === "hex-pointy" || data.gridType === "hex-flat") {
			for (let dq = -radius; dq <= radius; dq++) {
				const drMin = Math.max(-radius, -dq - radius);
				const drMax = Math.min(radius, -dq + radius);
				for (let dr = drMin; dr <= drMax; dr++) keys.push(hexKey(ca + dq, cb + dr));
			}
		} else {
			for (let da = -radius; da <= radius; da++) {
				for (let db = -radius; db <= radius; db++) {
					if (da * da + db * db <= radius * radius + 0.001) keys.push(squareKey(ca + da, cb + db));
				}
			}
		}
		return keys;
	}

	private paintBrushAt(centerKey: string): void {
		for (const key of this.cellsWithinBrush(centerKey)) {
			if (this.paintedInStroke.has(key)) continue;
			this.paintedInStroke.add(key);
			this.controller.paintCell(key);
		}
	}

	/** Adjacent cell keys (4-connected for square, 6-connected for hex), used by the fill tool's flood fill. */
	private neighborKeys(key: string): string[] {
		const data = this.controller.getData();
		const { a, b } = parseCellKey(key);
		if (data.gridType === "hex-pointy" || data.gridType === "hex-flat") {
			return HEX_NEIGHBOR_OFFSETS.map((o) => hexKey(a + o.dq, b + o.dr));
		}
		return [squareKey(a + 1, b), squareKey(a - 1, b), squareKey(a, b + 1), squareKey(a, b - 1)];
	}

	/** The active layer's zone type at `cellKey` (undefined = no zone), for the fill tool's same-zone matching. */
	private zoneAt(cellKey: string): string | undefined {
		const data = this.controller.getData();
		const gridType = data.gridType === "none" ? "square" : data.gridType;
		return this.controller.getActiveLayer().cellsByGridType[gridType][cellKey]?.zoneTypeId;
	}

	/** Whether a wall segment crosses the straight line between two adjacent cells' centers — used by `fillFrom` to stop the flood at a wall, like a blocker cell used to. */
	private edgeBlocked(fromKey: string, toKey: string, wallSegments: ResolvedWallSegment[]): boolean {
		const a = this.cellCenter(fromKey);
		const b = this.cellCenter(toKey);
		return wallSegments.some((seg) => segmentIntersection(a, b, seg.a, seg.b) !== null);
	}

	/**
	 * Floods outward from `startKey` like a paint bucket: only cells sharing the start cell's exact
	 * zone type (including "no zone") are matched and repainted, and any wall segment crossing
	 * between two cell centers always stops it. So filling empty ground stays inside a closed
	 * perimeter of walls/other zones, while filling an already-zoned cell replaces that whole zone
	 * (and only that zone) with the brush's settings.
	 */
	private fillFrom(startKey: string): void {
		const targetZone = this.zoneAt(startKey);
		const wallSegments = this.resolveWallSegments();
		const visited = new Set<string>([startKey]);
		const queue: string[] = [startKey];
		this.controller.beginHistoryGroup();
		this.controller.paintCell(startKey);
		let count = 1;
		while (queue.length > 0 && count < FILL_LIMIT) {
			const key = queue.shift();
			if (!key) break;
			for (const n of this.neighborKeys(key)) {
				if (visited.has(n) || this.edgeBlocked(key, n, wallSegments) || this.zoneAt(n) !== targetZone) continue;
				visited.add(n);
				this.controller.paintCell(n);
				count++;
				queue.push(n);
				if (count >= FILL_LIMIT) break;
			}
		}
		this.controller.endHistoryGroup();
		if (count >= FILL_LIMIT) new Notice("Remplissage arrêté : le périmètre n'est pas fermé (ou est trop grand).");
		this.render();
	}

	private findTokenAtScreenPoint(px: number, py: number): Token | null {
		const world = screenToWorld(px, py, this.transform);
		const data = this.controller.getData();
		const fogActive = this.fogCurrentlyVisible();
		const tokens = data.tokens;
		for (let i = tokens.length - 1; i >= 0; i--) {
			const token = tokens[i];
			if (!token) continue;
			const center = this.footprintCenter(token);
			if (Math.hypot(world.x - center.x, world.y - center.y) > this.tokenRadius(token)) continue;
			const isPlayer = (token.category ?? "entity") === "player";
			if (fogActive && !isPlayer && !this.isLitByCache(this.frameVisionCache, center.x, center.y, false)) continue;
			return token;
		}
		return null;
	}

	private markerHitRadius(): number {
		return this.cellVisualWidth() * TOKEN_SIZE_RATIO;
	}

	private findMarkerAtScreenPoint(px: number, py: number): Marker | null {
		const world = screenToWorld(px, py, this.transform);
		const data = this.controller.getData();
		const radius = this.markerHitRadius();
		for (let li = data.layers.length - 1; li >= 0; li--) {
			const layer = data.layers[li];
			if (!layer?.visible) continue;
			const markers = layer.markers;
			for (let i = markers.length - 1; i >= 0; i--) {
				const marker = markers[i];
				if (!marker) continue;
				if (Math.hypot(world.x - marker.x, world.y - marker.y) <= radius) return marker;
			}
		}
		return null;
	}

	// ---- Walls (freeform vision-blocking lines, independent of grid type) ----

	private wallPointHitRadius(): number {
		return this.cellVisualWidth() * WALL_POINT_HIT_RATIO;
	}

	private findWallPointAtScreenPoint(px: number, py: number): WallPoint | null {
		const world = screenToWorld(px, py, this.transform);
		const data = this.controller.getData();
		const radius = this.wallPointHitRadius();
		for (let li = data.layers.length - 1; li >= 0; li--) {
			const layer = data.layers[li];
			if (!layer?.visible) continue;
			const points = layer.wallPoints;
			for (let i = points.length - 1; i >= 0; i--) {
				const point = points[i];
				if (!point) continue;
				if (Math.hypot(world.x - point.x, world.y - point.y) <= radius) return point;
			}
		}
		return null;
	}

	/** Snaps a world point onto a nearby grid corner/edge-midpoint/edge (see `squareGridSnapCandidates`/`hexGridSnapCandidates`), or returns it unchanged if none is close enough (or there's no grid). Used both when placing a new wall point and when dragging an existing one. */
	private snapWorldToGrid(world: { x: number; y: number }): { x: number; y: number } {
		const data = this.controller.getData();
		if (data.gridType === "none") return world;

		const cellSize = this.effectiveCellSize();
		const candidates =
			data.gridType === "square"
				? squareGridSnapCandidates(world.x, world.y, cellSize)
				: hexGridSnapCandidates(world.x, world.y, cellSize, data.gridType === "hex-pointy" ? "pointy" : "flat");
		const snapRadius = WALL_SNAP_SCREEN_PX / this.transform.zoom;
		let best: SnapCandidate | null = null;
		let bestDist = Infinity;
		for (const c of candidates) {
			const dist = Math.hypot(world.x - c.x, world.y - c.y);
			if (dist > snapRadius) continue;
			if (!best || c.priority < best.priority || (c.priority === best.priority && dist < bestDist)) {
				best = c;
				bestDist = dist;
			}
		}
		return best ? { x: best.x, y: best.y } : world;
	}

	/**
	 * Resolves where a wall-tool click at `(px, py)` should actually place its point: snapping onto
	 * an existing point first (closes a shape / continues from a shared node), else onto the grid
	 * via `snapWorldToGrid`, else the raw clicked position.
	 */
	private resolveWallPlacement(px: number, py: number): { x: number; y: number; existingPointId?: string } {
		const hit = this.findWallPointAtScreenPoint(px, py);
		if (hit) return { x: hit.x, y: hit.y, existingPointId: hit.id };
		return this.snapWorldToGrid(screenToWorld(px, py, this.transform));
	}

	/** Every `WallSegment` (across visible layers) resolved to world-space endpoints, for ray casting and the fill tool's flood boundary. */
	private resolveWallSegments(): ResolvedWallSegment[] {
		const data = this.controller.getData();
		const result: ResolvedWallSegment[] = [];
		for (const layer of data.layers) {
			if (!layer.visible) continue;
			const pointsById = new Map(layer.wallPoints.map((p) => [p.id, p]));
			for (const segment of layer.wallSegments) {
				const a = pointsById.get(segment.aId);
				const b = pointsById.get(segment.bId);
				if (!a || !b) continue;
				result.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, type: segment.blockerType });
			}
		}
		return result;
	}

	private handleClick(e: PointerEvent): void {
		// Token/marker clicks are already resolved via draggingToken/draggingMarker in onPointerDown/onPointerUp;
		// reaching here means the click landed on empty grid space.
		if (this.controller.getData().gridType === "none") {
			this.controller.selectCell(null);
			return;
		}
		const rect = this.canvas.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		const world = screenToWorld(px, py, this.transform);
		const key = this.cellKeyAt(world.x, world.y);

		if (!this.cellsCurrentlyVisible()) {
			this.controller.selectCell(null);
			return;
		}

		if (this.controller.mode === "view") {
			const data = this.controller.getData();
			if (data.gridType === "none") return;
			const cell = this.controller.getActiveLayer().cellsByGridType[data.gridType][key];
			if (isCellEmpty(cell)) {
				this.controller.selectCell(null);
				return;
			}
		}

		this.controller.selectCell(this.controller.selectedCellKey === key ? null : key);
	}

	/** Places a marker at a specific screen point (edit-mode right-click menu) rather than the viewport center. */
	private addMarkerAt(px: number, py: number): void {
		const world = screenToWorld(px, py, this.transform);
		const marker = this.controller.addMarker(world.x, world.y);
		this.controller.selectMarker(marker.id);
	}

	/** Places a token at a specific screen point (view-mode right-click menu) rather than the viewport center. */
	private addTokenAt(px: number, py: number): void {
		const world = screenToWorld(px, py, this.transform);
		if (this.controller.getData().gridType === "none") {
			const token = this.controller.addFreeToken(world.x, world.y);
			this.controller.selectToken(token.id);
			return;
		}
		const key = this.cellKeyAt(world.x, world.y);
		const token = this.controller.addToken(key);
		if (!token) {
			new Notice("Impossible de placer un pion ici : la case est déjà occupée sur ce calque. Déplacez la vue et réessayez.");
			return;
		}
		this.controller.selectToken(token.id);
	}

	// ---- Backgrounds (one image per layer) ----

	private ensureBackgroundsLoaded(): void {
		const data = this.controller.getData();
		const layerIds = new Set(data.layers.map((l) => l.id));
		for (const id of Array.from(this.bgImages.keys())) {
			if (!layerIds.has(id)) this.bgImages.delete(id);
		}
		for (const layer of data.layers) {
			if (!layer.background) {
				this.bgImages.delete(layer.id);
				continue;
			}
			const cached = this.bgImages.get(layer.id);
			if (cached && cached.path === layer.background.path) continue;
			const entry: BackgroundEntry = { path: layer.background.path, img: null };
			this.bgImages.set(layer.id, entry);
			const img = new Image();
			img.onload = () => {
				entry.img = img;
				this.render();
			};
			img.src = this.app.vault.adapter.getResourcePath(layer.background.path);
		}
	}

	// ---- Token images (custom image per token, overrides the icon once loaded) ----

	private ensureTokenImagesLoaded(): void {
		const data = this.controller.getData();
		const tokenById = new Map(data.tokens.map((t) => [t.id, t]));
		for (const id of Array.from(this.tokenImages.keys())) {
			const token = tokenById.get(id);
			if (!token || !token.image) this.tokenImages.delete(id);
		}
		for (const token of data.tokens) {
			if (!token.image) continue;
			const cached = this.tokenImages.get(token.id);
			if (cached && cached.path === token.image) continue;
			const entry: BackgroundEntry = { path: token.image, img: null };
			this.tokenImages.set(token.id, entry);
			const img = new Image();
			img.onload = () => {
				entry.img = img;
				this.render();
			};
			img.src = this.app.vault.adapter.getResourcePath(token.image);
		}
	}

	private drawBackgrounds(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		const cellSize = this.effectiveCellSize();
		for (const layer of data.layers) {
			if (!layer.visible || !layer.background) continue;
			const entry = this.bgImages.get(layer.id);
			if (!entry?.img) continue;
			const bg = layer.background;
			const w = entry.img.naturalWidth * bg.scale;
			const h = entry.img.naturalHeight * bg.scale;
			// bg.offsetX/Y are the image's center, in grid cells; convert to a world-space top-left corner.
			ctx.drawImage(entry.img, bg.offsetX * cellSize - w / 2, bg.offsetY * cellSize - h / 2, w, h);
		}
	}

	private cellsCurrentlyVisible(): boolean {
		if (this.controller.getData().gridType === "none") return false;
		const fitsOnScreen = this.cellVisualWidth() * this.transform.zoom >= MIN_CELL_PIXELS;
		return fitsOnScreen && (this.controller.mode === "edit" || this.controller.showCells);
	}

	/**
	 * Fog only respects the manual "Masquer les cases" toggle, not the zoom-based auto-hide —
	 * otherwise zooming out past `MIN_CELL_PIXELS` would reveal the whole map through the fog.
	 */
	/**
	 * Fog is independent of the "Masquer les cases" toggle — that's for grid lines/zone content only.
	 * Still runs in grid type "none" (on the hidden square substrate — see `updateCell`), since fog
	 * doesn't depend on a visible grid, only on vision blockers and player tokens.
	 */
	private fogCurrentlyVisible(): boolean {
		const data = this.controller.getData();
		return data.fogEnabled && this.controller.mode === "view";
	}

	/**
	 * Whether the fog tremble should actually run right now: the opt-in setting has to be on, and
	 * zoom can't be out past `FOG_ANIMATION_MIN_ZOOM` — the animation loop forcing a render every
	 * frame while zoomed out that far is the one combination that's shown fog visibly breaking near
	 * the edges, so it's disabled there as a hard safety net regardless of the exact cause.
	 */
	private fogAnimationsActive(): boolean {
		return this.settings.fogAnimations && this.transform.zoom >= FOG_ANIMATION_MIN_ZOOM;
	}

	/**
	 * Keeps a `requestAnimationFrame` loop running for as long as (and only while) fog is visible
	 * and animations are actually active (see `fogAnimationsActive`), so the vision edge's subtle
	 * tremble (see `appendVisionFan`) keeps redrawing; otherwise fog is static and this never fires,
	 * costing nothing when the setting is off (its default) or zoomed out too far.
	 */
	private syncFogAnimationLoop(): void {
		const shouldAnimate = this.fogAnimationsActive() && this.fogCurrentlyVisible();
		if (shouldAnimate && this.animationFrameId === null) {
			const tick = () => {
				this.animationFrameId = requestAnimationFrame(tick);
				this.render();
			};
			this.animationFrameId = requestAnimationFrame(tick);
		} else if (!shouldAnimate && this.animationFrameId !== null) {
			cancelAnimationFrame(this.animationFrameId);
			this.animationFrameId = null;
		}
	}

	private updateCursor(): void {
		const tool = this.controller.mode === "edit" ? this.controller.activeTool : "none";
		this.canvas.toggleClass("is-brush-tool", tool === "brush");
		this.canvas.toggleClass("is-fill-tool", tool === "fill");
		this.canvas.toggleClass("is-wall-tool", tool === "wall");
	}

	render(): void {
		if (this.viewportW === 0 || this.viewportH === 0) return;
		this.updateCursor();
		this.ensureBackgroundsLoaded();
		this.ensureTokenImagesLoaded();

		if (!this.hasAutoFramed) {
			const loadedBounds = this.computeVisibleImageBounds();
			if (loadedBounds && loadedBounds.w > 0 && loadedBounds.h > 0) {
				this.applyFraming();
				this.hasAutoFramed = true;
			}
		}

		const imageBounds = this.controller.mode === "view" ? this.computeVisibleImageBounds() : null;
		const minZoom = this.getEffectiveMinZoom();
		this.transform.zoom = clamp(this.transform.zoom, minZoom, this.controller.getData().maxZoom);
		if (imageBounds) this.clampPanToBounds(imageBounds);

		const dpr = window.devicePixelRatio || 1;
		const ctx = this.ctx;
		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, this.viewportW, this.viewportH);

		ctx.translate(this.transform.panX, this.transform.panY);
		ctx.scale(this.transform.zoom, this.transform.zoom);

		this.drawBackgrounds(ctx);

		const cellsVisible = this.cellsCurrentlyVisible();
		if (cellsVisible) {
			if (imageBounds) {
				ctx.save();
				ctx.beginPath();
				ctx.rect(imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h);
				ctx.clip();
				this.drawGridAndCells(ctx);
				ctx.restore();
			} else {
				this.drawGridAndCells(ctx);
			}
		}

		const noGrid = this.controller.getData().gridType === "none";
		if (noGrid) this.drawMarkers(ctx);
		this.drawWalls(ctx);

		if (this.fogCurrentlyVisible()) {
			const wallSegments = this.resolveWallSegments();
			this.frameVisionCache = this.controller
				.getData()
				.tokens.filter((t) => (t.category ?? "entity") === "player")
				.map((t) => this.castRaysForToken(t, wallSegments));
		} else {
			this.frameVisionCache = [];
		}

		if (this.fogCurrentlyVisible()) {
			const viewportRect = this.visibleWorldRect();
			const fogRect = this.renderFogLayer(dpr, viewportRect);
			ctx.save();
			if (imageBounds) {
				ctx.beginPath();
				ctx.rect(imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h);
				ctx.clip();
			}
			// Drawn under the *same* world transform the buffer was rendered with (no switch to a
			// device-pixel transform) — the destination rect is just the exact world rect the fog
			// buffer covers (which extends a bit past the viewport — see `renderFogLayer`), so
			// there's no separate clip-across-transform-change behavior to rely on. `fogBlurCanvas`
			// (not `fogCanvas`) is the finished, already-blurred result — see `renderFogLayer`.
			ctx.drawImage(this.fogBlurCanvas, fogRect.minX, fogRect.minY, fogRect.maxX - fogRect.minX, fogRect.maxY - fogRect.minY);
			ctx.restore();
		}

		this.drawTokens(ctx);
		if (cellsVisible || noGrid || this.controller.selectedWallPointId) this.drawSelection(ctx);
		this.drawWallPreview(ctx);

		ctx.restore();
		this.syncFogAnimationLoop();
	}

	private drawGridAndCells(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		if (data.gridType === "none") return;
		const cellSize = this.effectiveCellSize();
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
					if (cell?.zoneTypeId) this.fillZone(ctx, data.zoneTypes, cell.zoneTypeId, () => ctx.rect(x, y, cellSize, cellSize));
				}
				ctx.strokeStyle = gridColor;
				ctx.strokeRect(x, y, cellSize, cellSize);
				for (const layer of visibleLayers) {
					const cell = layer.cellsByGridType[data.gridType][key];
					if (cell?.stamp || cell?.label) this.drawStampAndLabel(ctx, x + cellSize / 2, y + cellSize / 2, cellSize, cell.stamp, cell.label);
					if (cell?.links?.length) this.drawLinkBadge(ctx, x + cellSize * 0.12, y + cellSize * 0.12, cellSize);
				}
			}
		} else {
			const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
			const cells = getVisibleHexCells(this.transform, cellSize, orientation, this.viewportW, this.viewportH);
			for (const c of cells) {
				const key = hexKey(c.a, c.b);
				const center = hexCellToWorldCenter(c.a, c.b, cellSize, orientation);
				const corners = hexCorners(center.x, center.y, cellSize, orientation);
				const drawPath = () => {
					corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
					ctx.closePath();
				};
				for (const layer of visibleLayers) {
					const cell = layer.cellsByGridType[data.gridType][key];
					if (cell?.zoneTypeId) this.fillZone(ctx, data.zoneTypes, cell.zoneTypeId, drawPath);
				}
				ctx.beginPath();
				drawPath();
				ctx.strokeStyle = gridColor;
				ctx.stroke();
				for (const layer of visibleLayers) {
					const cell = layer.cellsByGridType[data.gridType][key];
					if (cell?.stamp || cell?.label) this.drawStampAndLabel(ctx, center.x, center.y, cellSize, cell.stamp, cell.label);
					if (cell?.links?.length) this.drawLinkBadge(ctx, center.x - cellSize * 0.35, center.y - cellSize * 0.55, cellSize);
				}
			}
		}
	}

	// ---- Fog of war (ray/path tracing — not tied to the visible grid) ----

	/**
	 * Traces `FOG_RAY_COUNT` rays outward from a player token's center (its omnidirectional radius
	 * plus its directional cone, whichever reaches further at a given angle) against `wallSegments`
	 * (see `resolveWallSegments`, computed once per frame and shared across every token). Each ray
	 * analytically finds every wall segment it crosses within its reach, sorted by distance, rather
	 * than marching in fixed steps and sampling a per-cell blocker — blocking no longer depends on
	 * grid cell size/shape at all, only on the authored wall geometry.
	 *
	 * These reaches are the *true* vision extent: they gate what counts as lit for gameplay
	 * (`isLitByCache`) and what gets permanently written to fog memory (`markExplored`). The
	 * tremble animation must never perturb them — an earlier version wobbled `reach` here, which
	 * meant every outward wobble peak got permanently baked into explored memory (since a bucket
	 * once marked explored stays marked), slowly and permanently growing the explored area for as
	 * long as the animation ran, worse the more zoomed out (a larger wobble/reach ratio) — a lasting
	 * corruption, not a rendering glitch, hence surviving after the zoom/animation stopped. The
	 * tremble is now applied only in `appendVisionFan`, purely to the drawn shape.
	 */
	private castRaysForToken(token: Token, wallSegments: ResolvedWallSegment[]): PlayerVisionRays {
		const center = this.footprintCenter(token);
		const radiusPx = (token.visionRadius ?? DEFAULT_VISION_RADIUS) * this.cellVisualWidth();
		const rangePx = (token.visionRange ?? DEFAULT_VISION_RANGE) * this.cellVisualWidth();
		const halfAngle = (token.visionAngle ?? DEFAULT_VISION_ANGLE) / 2;
		const direction = token.visionDirection ?? DEFAULT_VISION_DIRECTION;
		const phase = tremblePhase(token.id);

		const rays: RaySample[] = [];
		for (let i = 0; i < FOG_RAY_COUNT; i++) {
			const angle = (360 / FOG_RAY_COUNT) * i;
			const inCone = rangePx > 0 && (halfAngle >= 180 || Math.abs(angleDiffDeg(angle, direction)) <= halfAngle);
			const reach = inCone ? Math.max(radiusPx, rangePx) : radiusPx;
			if (reach <= 0) {
				rays.push({ clearEnd: 0, dimEnd: 0 });
				continue;
			}
			const rad = (angle * Math.PI) / 180;
			const dx = Math.cos(rad);
			const dy = Math.sin(rad);

			const hits: { dist: number; type: VisionBlockerType }[] = [];
			for (const seg of wallSegments) {
				const dist = raySegmentDistance(center, dx, dy, reach, seg.a, seg.b);
				if (dist !== null) hits.push({ dist, type: seg.type });
			}
			hits.sort((h1, h2) => h1.dist - h2.dist);

			let clearEnd = reach;
			let dimEnd = reach;
			let dimHit = false;
			for (const hit of hits) {
				if (hit.type === "opaque") {
					dimEnd = hit.dist;
					if (!dimHit) clearEnd = hit.dist;
					break;
				}
				if (!dimHit) {
					dimHit = true;
					clearEnd = hit.dist;
				}
			}
			rays.push({ clearEnd, dimEnd });
		}
		return { center, rays, phase };
	}

	/**
	 * Appends one token's vision fan (a closed polygon through its ray endpoints) to `path`. The
	 * tremble (`animate`) is applied only to this drawn shape, never to `rays` themselves — see the
	 * comment on `castRaysForToken` for why baking it into the actual reach caused lasting corruption.
	 */
	private appendVisionFan(path: Path2D, vision: PlayerVisionRays, useDim: boolean, animate: boolean, time: number): void {
		const { center, rays, phase } = vision;
		let started = false;
		for (let i = 0; i < rays.length; i++) {
			const ray = rays[i];
			if (!ray) continue;
			const angle = (360 / rays.length) * i;
			const rad = (angle * Math.PI) / 180;
			let dist = useDim ? ray.dimEnd : ray.clearEnd;
			if (animate && dist > 0) {
				// Fixed screen-pixel amplitude (divided by zoom) so it stays equally visible at any
				// zoom, capped to a fraction of `dist` so it can't push the drawn point past the
				// center (dividing a fixed px amount by a shrinking zoom is unbounded on its own).
				const wobblePx = Math.min(FOG_TREMBLE_SCREEN_PX / this.transform.zoom, dist * 0.3);
				dist += wobblePx * Math.sin(time * FOG_TREMBLE_SPEED + angle * 0.11 + phase);
			}
			const x = center.x + Math.cos(rad) * dist;
			const y = center.y + Math.sin(rad) * dist;
			if (!started) {
				path.moveTo(x, y);
				started = true;
			} else {
				path.lineTo(x, y);
			}
		}
		if (started) path.closePath();
	}

	/** Whether `worldX,worldY` falls within any cached token's traced reach (dim reach if `useDim`, else clear-only). */
	private isLitByCache(cache: PlayerVisionRays[], worldX: number, worldY: number, useDim: boolean): boolean {
		for (const { center, rays } of cache) {
			const dx = worldX - center.x;
			const dy = worldY - center.y;
			const dist = Math.hypot(dx, dy);
			let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
			if (angle < 0) angle += 360;
			const idx = Math.round(angle / (360 / rays.length)) % rays.length;
			const ray = rays[idx];
			if (ray && dist <= (useDim ? ray.dimEnd : ray.clearEnd)) return true;
		}
		return false;
	}

	/** World-space rectangle currently on screen, used to bound the fog-memory bucket scan. */
	private visibleWorldRect(): { minX: number; minY: number; maxX: number; maxY: number } {
		const tl = screenToWorld(0, 0, this.transform);
		const br = screenToWorld(this.viewportW, this.viewportH, this.transform);
		return { minX: Math.min(tl.x, br.x), minY: Math.min(tl.y, br.y), maxX: Math.max(tl.x, br.x), maxY: Math.max(tl.y, br.y) };
	}

	private fogBucketSize(): number {
		return this.cellVisualWidth() * FOG_BUCKET_SCALE;
	}

	/**
	 * Bucket size actually iterated over to paint the "ever explored" memory layer — coarsened well
	 * past `fogBucketSize()` once the on-screen world rect would otherwise need more than
	 * `FOG_MAX_BUCKETS_PER_AXIS` buckets per axis. Zooming out a lot makes the *visible* world area
	 * huge while `fogBucketSize()` stays fixed (it's in world units), so without this cap the scan —
	 * and the Path2D it builds — grows unbounded and the fog visibly breaks up near the edges. Each
	 * coarse tile still looks up a single underlying `fogBucketSize()` cell's explored state (see
	 * `drawFog`), which is a fine approximation once tiles are this far zoomed out anyway.
	 */
	private fogIterationBucketSize(rect: { minX: number; minY: number; maxX: number; maxY: number }): number {
		const base = this.fogBucketSize();
		const spanCells = Math.max((rect.maxX - rect.minX) / base, (rect.maxY - rect.minY) / base);
		const scale = Math.max(1, Math.ceil(spanCells / FOG_MAX_BUCKETS_PER_AXIS));
		return base * scale;
	}

	/**
	 * Prepares the offscreen fog buffer and draws into it; returns the world rect the buffer ends
	 * up covering (`render()` blits it back with that same rect — see the comment there).
	 *
	 * The buffer is deliberately sized a bit *larger* than the viewport, not just pixel-for-pixel:
	 * the blur pass below only has real pixels to sample from within the buffer it's applied to —
	 * right at the buffer's own edge, it samples "off the edge" as transparent, fading the fog out
	 * there even though the underlying shape (which does extend further, via `drawFog`'s own
	 * margin) logically continues. `FOG_OVERDRAW_PX` gives the blur real data to read within the
	 * buffer at what would otherwise be the viewport's border.
	 *
	 * That overdraw is a *fixed screen-pixel* amount, and so is the buffer's own pixel size —
	 * neither depends on zoom. An earlier version sized the buffer from `tile * zoom` (the LOD
	 * bucket size in device pixels), which meant the buffer's width/height changed continuously
	 * while zooming and had to be reallocated (`canvas.width = ...`, which drops the buffer's
	 * content) on most frames of a zoom gesture. The buffer now only needs resizing when the
	 * viewport's own DOM size changes, exactly like the main canvas.
	 *
	 * `drawFog` itself draws crisp, unfiltered shapes into `fogCanvas` under the world (pan/zoom)
	 * transform; the blur is applied *here*, as a second pass copying that crisp content into
	 * `fogBlurCanvas` under a plain, unscaled transform. Combining `ctx.filter`'s blur radius with
	 * an active `ctx.scale()` leaves it ambiguous (to the code reader, and evidently in practice)
	 * whether the requested px length is itself affected by that scale — keeping the two passes
	 * separate means the blur radius here is always exactly `FOG_BLUR_SCREEN_PX` real buffer pixels,
	 * with nothing left to that ambiguity.
	 */
	private renderFogLayer(
		dpr: number,
		viewportRect: { minX: number; minY: number; maxX: number; maxY: number }
	): { minX: number; minY: number; maxX: number; maxY: number } {
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
		// Same pan/zoom as the main canvas, shifted so `fogRect`'s top-left lands at the buffer's
		// origin instead of the viewport's — i.e. the buffer is the same view, just re-centered
		// over a larger area.
		fctx.translate(this.transform.panX + zoom * overdrawWorld, this.transform.panY + zoom * overdrawWorld);
		fctx.scale(zoom, zoom);
		this.drawFog(fctx, fogRect);
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

	/**
	 * Renders fog as: a coarse "ever explored" memory layer (square buckets, independent of grid
	 * type/shape — see `FOG_BUCKET_SCALE`), with each player's traced vision fan punched out on top
	 * (fully lit within `clearEnd`, dimmed-but-visible out to `dimEnd`). No per-grid-cell shape work.
	 * Draws onto the offscreen fog buffer (see `renderFogLayer`), never the main canvas directly.
	 */
	private drawFog(ctx: CanvasRenderingContext2D, rect: { minX: number; minY: number; maxX: number; maxY: number }): void {
		const exploredSet = this.controller.getExploredSet();
		const cache = this.frameVisionCache;
		const baseBucket = this.fogBucketSize();
		const tile = this.fogIterationBucketSize(rect);
		const animate = this.fogAnimationsActive();
		const time = animate ? performance.now() / 1000 : 0;
		// A fixed screen-pixel amplitude, converted to world units by the current zoom, so the
		// tremble stays equally visible at any zoom instead of shrinking away when zoomed out (a
		// world-space amplitude like "a fraction of the tile size" shrinks on screen right along
		// with everything else once zoom drops, which read as "the animation stops"). Capped to a
		// fraction of `tile` so it can never exceed a sane range at extreme zoom.
		//
		// This is a *single* offset applied uniformly to every tile's drawn position (not each
		// tile's own size — see `jitterX`/`jitterY` below), and it never touches which world point
		// is sampled for the persisted-memory lookup a few lines down. Perturbing each tile's own
		// rect individually (an earlier version of this) could size a tile down to zero or negative
		// at extreme/changing zoom, which is what actually broke near the edges; a shared shift can't
		// do that, and keeping the memory lookup itself un-jittered means resetting fog has no
		// bearing on the animation — it's purely cosmetic now.
		const jitterAmplitude = animate ? Math.min(FOG_MEMORY_TREMBLE_SCREEN_PX / this.transform.zoom, tile * 0.4) : 0;
		const jitterX = jitterAmplitude * Math.sin(time * FOG_TREMBLE_SPEED * 0.7);
		const jitterY = jitterAmplitude * Math.cos(time * FOG_TREMBLE_SPEED * 0.9);
		// Generous, independent of the tile loop below: the whole visible area (plus this margin)
		// is unconditionally covered by the single base `fillRect` further down, so no bucket-count
		// cap or rounding in the loop can ever leave a gap at the screen edges — at worst the loop's
		// own bounds are a little off and a sliver near the very edge is mis-classified as
		// unexplored (invisible in practice), never left fully unfogged.
		const margin = tile * 2;

		const bx0 = Math.floor((rect.minX - margin) / tile);
		const bx1 = Math.ceil((rect.maxX + margin) / tile);
		const by0 = Math.floor((rect.minY - margin) / tile);
		const by1 = Math.ceil((rect.maxY + margin) / tile);

		const exploredPath = new Path2D();
		let hasExplored = false;
		const newlyExplored: string[] = [];

		for (let by = by0; by <= by1; by++) {
			for (let bx = bx0; bx <= bx1; bx++) {
				const worldX = bx * tile + tile / 2;
				const worldY = by * tile + tile / 2;
				// Persisted memory always keys off the fine `baseBucket` grid regardless of how
				// coarse `tile` got — a single sample at the tile's center is close enough once
				// tiles are this much bigger than a base bucket anyway.
				const key = `${Math.floor(worldX / baseBucket)},${Math.floor(worldY / baseBucket)}`;
				const already = exploredSet.has(key);
				const litNow = !already && this.isLitByCache(cache, worldX, worldY, true);
				if (litNow) newlyExplored.push(key);
				if (already || litNow) {
					hasExplored = true;
					// Every tile of the explored/unexplored frontier shifts together a little
					// (rather than only the vision fan near a token), so the whole fog boundary
					// feels alive — each tile keeps its exact size, just its drawn position moves.
					exploredPath.rect(bx * tile + jitterX, by * tile + jitterY, tile, tile);
				}
			}
		}

		ctx.save();
		// Drawn crisp, with no `ctx.filter` here — the blur is applied afterward, as a separate pass
		// under an unscaled transform (see `renderFogLayer`), rather than mixed with `ctx.scale()` in
		// this call. Whether a canvas filter's px length is itself affected by the current transform
		// is exactly the kind of thing that's easy to get backwards, and this sidesteps needing to
		// know for sure: a blur radius specified with no scale active is unambiguous.

		// Base layer: the entire visible area (plus margin) starts fully fogged, via one rect —
		// see the `margin` comment above for why this can't be a per-tile loop.
		ctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_UNEXPLORED})`;
		ctx.fillRect(rect.minX - margin, rect.minY - margin, rect.maxX - rect.minX + margin * 2, rect.maxY - rect.minY + margin * 2);

		if (hasExplored) {
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = "rgba(0, 0, 0, 1)";
			ctx.fill(exploredPath);
			ctx.globalCompositeOperation = "source-over";
			ctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_EXPLORED})`;
			ctx.fill(exploredPath);
		}

		if (cache.length > 0) {
			const dimFan = new Path2D();
			const clearFan = new Path2D();
			for (const vision of cache) {
				this.appendVisionFan(dimFan, vision, true, animate, time);
				this.appendVisionFan(clearFan, vision, false, animate, time);
			}
			// Punch the full (dim) reach to transparent, repaint it at "explored" opacity, then punch
			// the inner (clear) reach again so it ends up fully see-through.
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = "rgba(0, 0, 0, 1)";
			ctx.fill(dimFan);
			ctx.globalCompositeOperation = "source-over";
			ctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_EXPLORED})`;
			ctx.fill(dimFan);
			// `destination-out` only erases by the fill's alpha channel, not its color — must be fully
			// opaque here or the clear zone is left with a residual tint instead of being see-through.
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = "rgba(0, 0, 0, 1)";
			ctx.fill(clearFan);
		}
		ctx.restore();

		if (newlyExplored.length > 0) this.controller.markExplored(newlyExplored);
	}

	private drawTokens(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		const fogActive = this.fogCurrentlyVisible();
		for (const token of data.tokens) {
			if (this.draggingToken?.token.id === token.id) continue;
			const isPlayer = (token.category ?? "entity") === "player";
			const center = this.footprintCenter(token);
			if (fogActive && !isPlayer && !this.isLitByCache(this.frameVisionCache, center.x, center.y, false)) continue;
			this.drawToken(ctx, center.x, center.y, token, token.id === this.controller.selectedTokenId);
		}
		if (this.draggingToken) {
			const { token, currentWorld } = this.draggingToken;
			this.drawToken(ctx, currentWorld.x, currentWorld.y, token, true);
		}
	}

	/**
	 * Center of a token's footprint. On square grids, a token with size > 1 occupies a
	 * size×size block growing down and right from its anchor cell, so it never overlaps
	 * any cell outside that block. Hex grids have no such block concept, so the token is
	 * simply centered (and enlarged) on its single anchor cell.
	 */
	private footprintCenter(token: Token): { x: number; y: number } {
		const data = this.controller.getData();
		if (data.gridType === "none") return { x: token.x ?? 0, y: token.y ?? 0 };
		const size = token.size ?? 1;
		const cellKey = token.cellKey ?? squareKey(0, 0);
		if (data.gridType !== "square" || size <= 1) return this.cellCenter(cellKey);
		const { a, b } = parseCellKey(cellKey);
		const cellSize = this.effectiveCellSize();
		return {
			x: a * cellSize + (size * cellSize) / 2,
			y: b * cellSize + (size * cellSize) / 2,
		};
	}

	private tokenRadius(token: Token): number {
		return this.cellVisualWidth() * (token.size ?? 1) * TOKEN_SIZE_RATIO;
	}

	private drawToken(ctx: CanvasRenderingContext2D, cx: number, cy: number, token: Token, selected: boolean): void {
		const r = this.tokenRadius(token);
		const diameter = r * 2;
		const imageEntry = token.image ? this.tokenImages.get(token.id) : undefined;
		const image = imageEntry && imageEntry.path === token.image ? imageEntry.img : null;

		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		if (image) {
			ctx.save();
			ctx.clip();
			ctx.drawImage(image, cx - r, cy - r, diameter, diameter);
			ctx.restore();
		} else {
			ctx.fillStyle = "rgba(250,250,250,0.92)";
			ctx.fill();
		}
		const baseColor = token.color ?? DEFAULT_TOKEN_COLOR;
		ctx.lineWidth = selected ? Math.max(2.5, 4 / this.transform.zoom) : Math.max(1.5, 2.5 / this.transform.zoom);
		ctx.strokeStyle = selected ? lightenColor(baseColor, 0.55) : baseColor;
		ctx.stroke();

		if (!image) {
			ctx.textAlign = "center";
			ctx.fillStyle = "#000000";
			ctx.textBaseline = token.label ? "bottom" : "middle";
			ctx.font = `${Math.max(10, diameter * 0.42)}px sans-serif`;
			ctx.fillText(token.icon, cx, token.label ? cy + diameter * 0.06 : cy);
		}
		if (token.label) {
			ctx.textBaseline = "top";
			ctx.font = `bold ${Math.max(10, diameter * 0.22)}px sans-serif`;
			ctx.fillText(this.fitText(ctx, token.label, diameter * 0.85), cx, cy + diameter * 0.08);
		}
	}

	private drawMarkers(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		const size = this.cellVisualWidth();
		for (const layer of data.layers) {
			if (!layer.visible) continue;
			for (const marker of layer.markers) {
				if (this.draggingMarker?.marker.id === marker.id) continue;
				this.drawStampAndLabel(ctx, marker.x, marker.y, size, marker.stamp, marker.label);
				if (marker.links?.length) this.drawLinkBadge(ctx, marker.x - size * 0.35, marker.y - size * 0.55, size);
			}
		}
		if (this.draggingMarker) {
			const { marker, currentWorld } = this.draggingMarker;
			this.drawStampAndLabel(ctx, currentWorld.x, currentWorld.y, size, marker.stamp, marker.label);
		}
	}

	/** A wall point's drawn position — the live drag target while it's being dragged, else its committed position. */
	private wallPointPosition(point: WallPoint): { x: number; y: number } {
		if (this.draggingWallPoint?.point.id === point.id) return this.draggingWallPoint.currentWorld;
		return { x: point.x, y: point.y };
	}

	/**
	 * Committed wall segments (solid red for "opaque", dashed amber for "dim" — same colors the old
	 * per-cell blocker badges used) plus each point's handle, drawn whenever the grid/cell overlay
	 * would be (matches the old badges' visibility). Point handles only show while actively placing
	 * walls or with one selected — otherwise just the lines, so authored walls read as map geometry.
	 */
	private drawWalls(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		if (!this.cellsCurrentlyVisible() && data.gridType !== "none") return;
		const showHandles = this.controller.mode === "edit" && (this.controller.activeTool === "wall" || this.controller.selectedWallPointId !== null);
		const pointRadius = Math.max(2, this.wallPointHitRadius() * 0.35);
		for (const layer of data.layers) {
			if (!layer.visible) continue;
			const pointsById = new Map(layer.wallPoints.map((p) => [p.id, p]));
			for (const segment of layer.wallSegments) {
				const a = pointsById.get(segment.aId);
				const b = pointsById.get(segment.bId);
				if (!a || !b) continue;
				const aPos = this.wallPointPosition(a);
				const bPos = this.wallPointPosition(b);
				ctx.save();
				ctx.strokeStyle = segment.blockerType === "opaque" ? "#c0392b" : "#d99a2b";
				ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
				if (segment.blockerType === "dim") ctx.setLineDash([Math.max(3, 6 / this.transform.zoom), Math.max(3, 6 / this.transform.zoom)]);
				ctx.beginPath();
				ctx.moveTo(aPos.x, aPos.y);
				ctx.lineTo(bPos.x, bPos.y);
				ctx.stroke();
				ctx.restore();
			}
			if (showHandles) {
				for (const point of layer.wallPoints) {
					const pos = this.wallPointPosition(point);
					ctx.beginPath();
					ctx.arc(pos.x, pos.y, pointRadius, 0, Math.PI * 2);
					ctx.fillStyle = point.id === this.controller.selectedWallPointId ? "#e0a020" : "#c0392b";
					ctx.fill();
				}
			}
		}
	}

	/**
	 * Dashed preview of whatever the next wall-tool click would commit: either the chain's tail point
	 * connected to the live (possibly snapped) pointer position, or — while a shape is armed and its
	 * first corner already placed — the whole shape's outline spanning that corner and the pointer.
	 */
	private drawWallPreview(ctx: CanvasRenderingContext2D): void {
		if (this.controller.mode !== "edit" || this.controller.activeTool !== "wall" || !this.wallPreview) return;

		const pendingShape = this.controller.pendingWallShape;
		const firstCorner = pendingShape ? this.controller.getWallShapeFirstCorner() : null;
		if (pendingShape && firstCorner) {
			const corners = wallShapeCorners(pendingShape, firstCorner, this.wallPreview);
			ctx.save();
			ctx.strokeStyle = "#e0a020";
			ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
			ctx.setLineDash([Math.max(3, 6 / this.transform.zoom), Math.max(3, 6 / this.transform.zoom)]);
			ctx.beginPath();
			corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
			ctx.closePath();
			ctx.stroke();
			ctx.restore();
			return;
		}

		const tailId = pendingShape ? null : this.controller.getWallChainTailId();
		if (!tailId) return;
		const tail = this.controller.findWallPoint(tailId);
		if (!tail) return;
		ctx.save();
		ctx.strokeStyle = "#e0a020";
		ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
		ctx.setLineDash([Math.max(3, 6 / this.transform.zoom), Math.max(3, 6 / this.transform.zoom)]);
		ctx.beginPath();
		ctx.moveTo(tail.x, tail.y);
		ctx.lineTo(this.wallPreview.x, this.wallPreview.y);
		ctx.stroke();
		ctx.restore();
	}

	private fillZone(ctx: CanvasRenderingContext2D, zoneTypes: { id: string; color: string }[], zoneTypeId: string, drawPath: () => void): void {
		const zone = zoneTypes.find((z) => z.id === zoneTypeId);
		if (!zone) return;
		ctx.beginPath();
		drawPath();
		ctx.fillStyle = zone.color;
		ctx.globalAlpha = 0.45;
		ctx.fill();
		ctx.globalAlpha = 1;
	}

	private drawStampAndLabel(ctx: CanvasRenderingContext2D, cx: number, cy: number, cellSize: number, stamp: string | undefined, label: string | undefined): void {
		const labelFontSize = Math.max(10, cellSize * 0.28);
		// Too zoomed out for the label to stay legible: hide it and let the stamp use the bigger, label-less size instead.
		const labelVisible = !!label && labelFontSize * this.transform.zoom >= MIN_LABEL_PIXELS;
		const stampFontSize = Math.max(10, cellSize * (stamp && labelVisible ? 0.65 : 0.85));
		ctx.textAlign = "center";
		ctx.fillStyle = "#000000";

		if (stamp && labelVisible) {
			ctx.textBaseline = "bottom";
			ctx.font = `${stampFontSize}px sans-serif`;
			ctx.fillText(stamp, cx, cy + stampFontSize * 0.32);
			ctx.textBaseline = "top";
			ctx.font = `bold ${labelFontSize}px sans-serif`;
			ctx.fillText(this.fitText(ctx, label, cellSize * 0.92), cx, cy + stampFontSize * 0.34);
		} else if (stamp) {
			ctx.textBaseline = "middle";
			ctx.font = `${stampFontSize}px sans-serif`;
			ctx.fillText(stamp, cx, cy);
		} else if (labelVisible && label) {
			ctx.textBaseline = "middle";
			ctx.font = `bold ${labelFontSize}px sans-serif`;
			ctx.fillText(this.fitText(ctx, label, cellSize * 0.92), cx, cy);
		}
	}

	private fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
		if (ctx.measureText(text).width <= maxWidth) return text;
		let truncated = text;
		while (truncated.length > 1 && ctx.measureText(`${truncated}…`).width > maxWidth) {
			truncated = truncated.slice(0, -1);
		}
		return `${truncated}…`;
	}

	private drawLinkBadge(ctx: CanvasRenderingContext2D, x: number, y: number, cellSize: number): void {
		const r = Math.max(2, cellSize * 0.08);
		ctx.beginPath();
		ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
		ctx.fillStyle = "#3b82f6";
		ctx.fill();
	}

	private drawSelection(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		const selectedWallPoint = this.controller.getSelectedWallPoint();
		if (selectedWallPoint) {
			const pos = this.wallPointPosition(selectedWallPoint);
			ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
			ctx.strokeStyle = "#e0a020";
			ctx.beginPath();
			ctx.arc(pos.x, pos.y, this.wallPointHitRadius(), 0, Math.PI * 2);
			ctx.stroke();
			return;
		}
		if (data.gridType === "none") {
			const marker = this.controller.getSelectedMarker();
			if (!marker) return;
			ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
			ctx.strokeStyle = "#e0a020";
			ctx.beginPath();
			ctx.arc(marker.x, marker.y, this.markerHitRadius(), 0, Math.PI * 2);
			ctx.stroke();
			return;
		}
		const key = this.controller.selectedCellKey;
		if (!key) return;
		const { a, b } = parseCellKey(key);
		const cellSize = this.effectiveCellSize();
		ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
		ctx.strokeStyle = "#e0a020";
		ctx.beginPath();
		if (data.gridType === "square") {
			ctx.rect(a * cellSize, b * cellSize, cellSize, cellSize);
		} else {
			const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
			const center = hexCellToWorldCenter(a, b, cellSize, orientation);
			const corners = hexCorners(center.x, center.y, cellSize, orientation);
			corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
			ctx.closePath();
		}
		ctx.stroke();
	}
}

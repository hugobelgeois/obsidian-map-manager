import { App, Menu, Notice } from "obsidian";
import { MapController, MapMode, MassSelectionKind } from "../controller/MapController";
import { FogAnimationMode, MapManagerSettings } from "../settings/types";
import { DEFAULT_TOKEN_COLOR, DEFAULT_VISION_RADIUS, Marker, Token, WallPoint, WallSegment, hexKey, isCellEmpty, parseCellKey, resolveEyeCones, resolveLightRadius, squareKey } from "../data/mapData";
import { drawTokenFacingArrow } from "./drawing";
import { detectColorRegionWalls } from "../platform/detectColorRegionWalls";
import { ColorRegionWallsModal } from "../ui/ColorRegionWallsModal";
import {
	ABS_MIN_ZOOM,
	Point,
	SnapCandidate,
	ViewTransform,
	clamp,
	directionAtArcLength,
	getVisibleHexCells,
	getVisibleSquareCells,
	hexCellToWorldCenter,
	hexCorners,
	hexGridSnapCandidates,
	hexWorldToCell,
	pointAtArcLength,
	polylineCumulativeLengths,
	projectOntoSegment,
	screenToWorld,
	segmentIntersection,
	squareFootprintAnchor,
	squareGridSnapCandidates,
	squareWorldToCell,
	truncatePolyline,
	wallShapeCorners,
	worldToScreen,
} from "../grid/gridMath";
import {
	ResolvedWallSegment,
	VisionRays,
	castEntityConeRays,
	castLightRays,
	castVisionRays,
	cellCenter as fogCellCenter,
	cellVisualWidth as fogCellVisualWidth,
	effectiveCellSize as fogEffectiveCellSize,
	fogBucketSize as fogFogBucketSize,
	footprintCenter as fogFootprintCenter,
	footprintCellKeys,
	isPointLit,
	isWorldPointExplored as fogIsWorldPointExplored,
	occupiedFootprintCells,
	resolveWallSegments as fogResolveWallSegments,
} from "../grid/fog";

const DRAG_THRESHOLD = 4;
/** How long a "ping" ring (see `triggerPing`) expands and fades before disappearing, in ms. */
const PING_DURATION_MS = 1200;
/** Animated token movement (view mode "Animation" toggle — see `drawingPath`/`pathAnimation`): a new sampled point is only appended to the in-progress path once the pointer has moved at least this fraction of a cell since the last one, keeping the point count (and thus the per-frame arc-length work) bounded without visibly faceting the drawn curve. */
const PATH_SAMPLE_SPACING_RATIO = 0.15;
/** Animated token movement: constant tween speed, in cells per second. */
const PATH_ANIMATION_CELLS_PER_SEC = 3.5;
/** Animated token movement: how many cells short of the drawn path's own end each successive follower (in "closest to the path's start" order) stops, so they end up queued single-file rather than stacked on the same spot. */
const PATH_FOLLOW_GAP_CELLS = 1;
/** Animated token movement collision resolution (`nearestFreeCell`): the BFS gives up and leaves a token where it collided past this many visited cells — generous enough for any realistically packed map without ever searching unboundedly. */
const COLLISION_SEARCH_LIMIT = 400;
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
/**
 * World-unit wavelength of the "advanced" memory-frontier tremble's spatial noise (see
 * `organicJitter2D`) — roughly the size of one independently-drifting "zone" of fog. Tiles much
 * closer together than this move almost identically (no seam at their shared edge); tiles farther
 * apart than this drift increasingly out of sync.
 */
const FOG_ORGANIC_WAVELENGTH = 260;
/** Fixed screen-pixel blur radius for the fog buffer (see `drawFog`) — independent of zoom or the LOD tile size. */
const FOG_BLUR_SCREEN_PX = 22;
/** Fixed screen-pixel overdraw margin on the offscreen fog buffer — see `renderFogLayer`. Comfortably larger than `FOG_BLUR_SCREEN_PX`. */
const FOG_OVERDRAW_PX = FOG_BLUR_SCREEN_PX * 3;
/**
 * How far (fixed screen px) `drawFog` pulls a revealed shape's own edge inward before the blur runs,
 * wherever that edge borders unrevealed territory — see `dimInset`/`erosionInset` there. A CSS
 * `blur()` doesn't cut off sharply right at `FOG_BLUR_SCREEN_PX`, it only falls off *fast* past it, so
 * this needs real headroom past that nominal radius, not just a few px of slack.
 */
const FOG_LEAK_INSET_PX = FOG_BLUR_SCREEN_PX * 2.5;
/** Fog animations (the tremble, and the render loop driving it) are force-disabled at or past this zoom — see `activeFogAnimationMode`. */
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
/** Fixed screen-pixel tolerance for clicking on/near an existing wall segment's line — selecting it, or double-clicking to insert a mid-point (see `findWallSegmentAtScreenPoint`). */
const WALL_SEGMENT_HIT_SCREEN_PX = 8;

/** Mixes a #rrggbb color toward white by `ratio` (0 = unchanged, 1 = white). Used for the selected-token border. */
function lightenColor(hex: string, ratio: number): string {
	const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
	if (!match || !match[1] || !match[2] || !match[3]) return hex;
	const mix = (channel: string) => Math.round(parseInt(channel, 16) + (255 - parseInt(channel, 16)) * ratio);
	return `rgb(${mix(match[1])}, ${mix(match[2])}, ${mix(match[3])})`;
}

/** Stable per-token phase offset (radians) so several tokens' fog tremble doesn't move in lockstep. */
function tremblePhase(tokenId: string): number {
	let hash = 0;
	for (let i = 0; i < tokenId.length; i++) hash = (hash * 31 + tokenId.charCodeAt(i)) | 0;
	return (hash % 1000) / 1000;
}

/**
 * Smooth 2D pseudo-noise sampled at a world position and time, each axis roughly in [-1, 1] —
 * used only in "advanced" fog animation mode, for the memory frontier's per-tile drift (`drawFog`).
 *
 * This is deliberately a sum of a couple of *mismatched* sine waves (different spatial wavelengths,
 * different speeds, unrelated phase offsets) rather than either a single shared offset ("simple"
 * mode's `sharedJitterX`/`sharedJitterY`) or fully independent per-tile random phase. A single
 * offset moves the whole frontier as one rigid block — not what "advanced" asks for. Fully
 * independent per-tile randomness was tried first and looked like flickering static: neighboring
 * tiles got uncorrelated offsets, so gaps of raw unexplored-opacity fog flashed open between them
 * every frame as their offsets drifted apart. Because this function is continuous in `worldX`/
 * `worldY`, two points closer together than `FOG_ORGANIC_WAVELENGTH` come out nearly identical (no
 * seam at a shared tile edge), while points farther apart drift independently and out of phase —
 * which is what actually reads as "separate zones of fog, each alive on its own" instead of either
 * a single rigid shift or noise.
 */
function organicJitter2D(worldX: number, worldY: number, time: number): { x: number; y: number } {
	const k = (2 * Math.PI) / FOG_ORGANIC_WAVELENGTH;
	const x = Math.sin(worldX * k + time * 0.5) * 0.55 + Math.sin(worldY * k * 1.7 - time * 0.33 + 1.3) * 0.45;
	const y = Math.sin(worldY * k * 1.3 + time * 0.41 + 2.1) * 0.55 + Math.sin(worldX * k * 0.8 - time * 0.27 + 0.7) * 0.45;
	return { x, y };
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

/** View mode only: a multi-selected group of tokens being dragged together — see `MapCanvas.startGroupDrag`/`commitGroupDrag`. */
interface DraggingTokenGroup {
	anchorTokenId: string;
	entries: { token: Token; originWorld: { x: number; y: number } }[];
	pointerDownWorld: { x: number; y: number };
	currentWorld: { x: number; y: number };
}

/**
 * One token's full itinerary for the "Animation" token-movement gesture: a straight lead-in from its
 * own position at the moment the path was drawn, onto the drawn path, then along it as far as this
 * token's own rank allows (see `MapCanvas.startPathAnimation`) — `points[0]` is always that starting
 * position, `points[points.length - 1]` is where it comes to rest. `cumulative`/`totalLength` are
 * `polylineCumulativeLengths(points)`/its last entry, kept alongside rather than recomputed every
 * animation frame. `finalRotation` is the direction `points` is heading at its very last point —
 * baked in once here since a zero-length final segment (this token never actually moves) would
 * otherwise have no direction of its own to fall back on.
 *
 * Exported so `mirrorRegistry`/`MapView`/`MapEmbed` can relay a whole tween (pure position/timing
 * data, no canvas-specific state) to a player-mirror window's own `MapCanvas` — see
 * `MapCanvasOptions.onPathAnimation`/`playPathAnimationEcho`.
 */
export interface PathAnimationRoute {
	tokenId: string;
	points: Point[];
	cumulative: number[];
	totalLength: number;
	finalRotation: number;
}

/** An in-flight "Animation" token-movement tween — see `MapCanvas.startPathAnimation`/`runPathAnimationLoop`/`finishPathAnimation`. */
interface PathAnimationState {
	routes: PathAnimationRoute[];
	startedAt: number;
	/** World units per ms — every route tweens at the same constant speed (see `PATH_ANIMATION_CELLS_PER_SEC`), so a route's own remaining distance alone determines how much longer it keeps moving. */
	speedWorldPerMs: number;
	/**
	 * Whether this instance's own copy of the tween is the one that commits final position/facing to
	 * `MapController` once every route finishes (`finishPathAnimation`) — true for the canvas that
	 * actually started the gesture, false for a player-mirror window's purely visual echo of it (see
	 * `playPathAnimationEcho`), which just lets its local state lapse instead.
	 */
	commitOnFinish: boolean;
}

/** Live preview for the Ctrl-drag "distribute the selection into this area" gesture — see `MapCanvas.recomputeDistributePreview`. */
interface DistributePreview {
	valid: boolean;
	/** Celled grids: the actual candidate cells (drawn as real cell shapes, not a free-floating rectangle — see `drawDistributePreview`). `null` on grid type "none", which has no cells to highlight. */
	cellKeys: string[] | null;
	/** Grid type "none" only: each token's proposed free-form landing point (drawn as a dot, since there's no cell to highlight). */
	points: { x: number; y: number }[];
	assignment: { tokenId: string; cellKey?: string; point?: { x: number; y: number } }[] | null;
}

interface BackgroundEntry {
	path: string;
	img: HTMLImageElement | null;
}

/** A player token's traced vision for the current frame: 0..360° rays fanning out from its center (see `../grid/fog.ts`). */
interface PlayerVisionRays extends VisionRays {
	/** Stable per-token phase for the *cosmetic* fan-edge tremble (see `appendVisionFan`) — never affects `rays` itself. */
	phase: number;
}

export interface MapCanvasOptions {
	/**
	 * Marks this instance as a passive mirror of another (interactive) MapCanvas showing the same
	 * MapController — see `MapPlayerMirrorView`/`mirrorRegistry`. A mirror never attaches its own
	 * pointer/wheel input; instead of managing pan/zoom locally, `render()` re-derives its own pan
	 * from the last camera pushed via `setMirrorCamera` (the source's zoom and the world point at the
	 * center of *its* viewport — see `getViewCenter()` for why raw panX/panY can't be copied as-is
	 * across differently sized canvases). That camera is deliberately *not* re-read from the source on
	 * every render: the source's `getViewCenter()` depends on its own current viewport size, which
	 * also shifts for reasons that have nothing to do with the GM actually panning/zooming — e.g. its
	 * InfoPanel opening and narrowing the canvas. Re-reading it on every mirror render (which happens
	 * on any shared-controller change, like a selection) would drag the mirror's view along with that.
	 */
	isMirror?: boolean;
	/** Marks fog as independent of `data.fogEnabled`/mode on this instance — a player mirror shows/hides fog per its own `MapController.playerMirrorFogEnabled` toggle (see the player-window dropdown in `Toolbar`) even while the source window has `data.fogEnabled` set differently. */
	forceFog?: boolean;
	/** Called whenever pan/zoom changes from user input (wheel, drag-pan, recenter). Panning/zooming never touches `MapController` (no `notify()`), so a mirror wouldn't otherwise learn about it. */
	onViewportChange?: () => void;
	/** Called with the world position of a plain click (see `triggerPing`) so a mirror can show the same ping ring — a click isn't a `MapController` mutation either. */
	onPing?: (x: number, y: number) => void;
	/** Called whenever an "Animation" token-movement tween starts (see `startPathAnimation`) so a mirror can replay the same tween visually via `playPathAnimationEcho` — panning/dragging the tween itself never touches `MapController` until it finishes, so a mirror wouldn't otherwise see it move until the drop. */
	onPathAnimation?: (routes: PathAnimationRoute[], speedWorldPerMs: number) => void;
}

export class MapCanvas {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private resizeObserver: ResizeObserver;
	private transform: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
	private viewportW = 0;
	private viewportH = 0;
	/** Mirror-only: the source's last-pushed world-space camera — see `setMirrorCamera` and the note on `MapCanvasOptions.isMirror`. */
	private mirrorCamera: { zoom: number; x: number; y: number } | null = null;

	private bgImages: Map<string, BackgroundEntry> = new Map();
	/** Keyed by token id (not path), since several tokens could share the same image. */
	private tokenImages: Map<string, BackgroundEntry> = new Map();
	/** True once the initial "center on the image, zoomed out to fit it" framing has run. */
	private hasAutoFramed = false;

	/** Every player token's traced vision rays, recomputed once per `render()` and reused by both `drawFog` and `drawTokens`. */
	private frameVisionCache: PlayerVisionRays[] = [];
	/**
	 * Every token's (any category) traced `lightRadius` reach, recomputed once per `render()` —
	 * mirrors `frameVisionCache` but for `Token.lightRadius` instead of a player's own vision cone.
	 * Reused by `drawFog` (to hide fog without writing to `exploredCells` — see `drawFog`'s doc
	 * comment) and `isEntityRevealedByFog` (so a lit entity is noticed regardless of any player's own
	 * vision). Wall-aware (`castLightRays`), unlike the plain distance check `visionRadius`'s own
	 * "rayon exploré" fallback still uses.
	 */
	private frameLightCache: PlayerVisionRays[] = [];

	/**
	 * Memoizes the actual (expensive) ray/wall tracing behind `castRaysForToken`/`castEntityConeVision`,
	 * keyed against `MapController.dataVersion` — `render()` runs on every pan/zoom/hover/fog-tremble
	 * animation frame, none of which touch `data`, so re-tracing rays whose token/wall inputs haven't
	 * changed since the last `render()` was pure waste (the dominant cost of "several tokens with
	 * vision on" lagging view mode). Only the cheap, per-frame cosmetic tremble in `appendVisionFan`
	 * still runs unconditionally. Keyed by token id for players (one cone), and `tokenId|direction|
	 * fullAngleDeg` for entities (multiple cones/tiers per token — see `drawEntityEyeCones`).
	 */
	private playerVisionRaysCache: Map<string, { version: number; result: VisionRays }> = new Map();
	private entityConeRaysCache: Map<string, { version: number; result: VisionRays }> = new Map();
	/** Same memoization as `playerVisionRaysCache`, for `castLightRaysForToken` — keyed by token id, any category. */
	private lightRaysCache: Map<string, { version: number; result: VisionRays }> = new Map();

	/** Offscreen buffer fog is composited on before being drawn onto the main canvas as one image — see the constructor comment. */
	private fogCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogCtx: CanvasRenderingContext2D;
	/** Second pass: `fogCanvas`'s crisp content, blurred under a plain (unscaled) transform — see `renderFogLayer`. */
	private fogBlurCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogBlurCtx: CanvasRenderingContext2D;
	/** Non-null while the fog-tremble animation loop (settings.fogAnimationMode) is actively re-rendering every frame. */
	private animationFrameId: number | null = null;

	/** The "look here" ring shown after a plain click (`triggerPing`) — world position and when it started, or `null` once it's finished expanding/fading. */
	private activePing: { x: number; y: number; startedAt: number } | null = null;
	/** Non-null while `activePing`'s expand/fade animation is actively re-rendering every frame. */
	private pingAnimationFrameId: number | null = null;

	private dragging = false;
	private dragMoved = false;
	private draggingToken: DraggingToken | null = null;
	private draggingMarker: DraggingMarker | null = null;
	private draggingWallPoint: DraggingWallPoint | null = null;
	/** Set in onPointerDown when a plain click lands on a wall segment's line (away from either endpoint) — segments have no drag of their own, so this just waits to see whether onPointerUp should select it (a click) or leave it to pan as normal (a drag past the threshold). See `onPointerUp`. */
	private pendingWallSegmentId: string | null = null;
	/** True while the brush tool is actively painting cells under a held-down drag. */
	private painting = false;
	private lastPaintedKey: string | null = null;
	/** Cells already painted during the current brush stroke, to avoid re-applying (and re-history-grouping) the same cell twice. */
	private paintedInStroke: Set<string> = new Set();
	/** True once a click has been fully handled by a tool (e.g. fill) in onPointerDown, so onPointerUp shouldn't also run the normal click/pan logic. */
	private toolConsumedClick = false;
	private pointerDownAt = { x: 0, y: 0 };
	private lastPointer = { x: 0, y: 0 };

	/** "select" tool only: whatever object (if any) sat directly under the pointer on down — resolved into a toggle on a plain click, or ignored in favor of `marqueeWorld` once the drag exceeds `DRAG_THRESHOLD`. See `handleSelectPointerDown`. */
	private selectPointerHit: { kind: MassSelectionKind; id: string } | null = null;
	/**
	 * The live marquee rectangle (world space) while dragging — `null` outside a marquee drag. Shared
	 * by the edit-mode "select" tool (see `handleSelectPointerDown`) and view mode's Shift-drag
	 * multi-token select (see `onPointerDown`'s `e.shiftKey` branch). See `onPointerMove`/
	 * `drawMassSelectionOverlay`.
	 */
	private marqueeWorld: { start: { x: number; y: number }; current: { x: number; y: number } } | null = null;

	/** View mode only: a token's whole selected group being dragged together, preserving relative offsets — see `startGroupDrag`/`commitGroupDrag`. */
	private draggingTokenGroup: DraggingTokenGroup | null = null;
	/** View mode only: whatever token (if any) sat under the pointer at a Ctrl+mousedown — resolved into a toggle on a plain Ctrl+click, or ignored in favor of the distribute-paint drag once past `DRAG_THRESHOLD`. See `handleViewCtrlPointerDown`. */
	private viewCtrlTokenHit: string | null = null;
	/**
	 * View mode only: "distribute the selection into this area" — works like the brush tool, painting
	 * whatever cell the pointer is over into the area as the Ctrl-drag moves (any resulting shape, not
	 * just a rectangle), rather than dragging out a bounding box. `cellKeys` accumulates every distinct
	 * cell painted so far (celled grids); `points` accumulates the raw pointer path (grid type "none",
	 * which has no cells to paint — see `recomputeDistributePreview`'s proportional-remap branch).
	 * `null` outside that gesture. See `handleViewCtrlPointerDown`/`recomputeDistributePreview`.
	 */
	private distributePaint: { cellKeys: Set<string>; points: { x: number; y: number }[]; lastCellKey: string | null } | null = null;
	/** Live preview for the distribute-paint gesture, recomputed on every cell/point painted — see `recomputeDistributePreview`. */
	private distributePreview: DistributePreview | null = null;

	/** Live (possibly snapped) target for the wall tool's in-progress chain — see `drawWallPreview`. Recomputed on every pointer move regardless of `dragging` (a click, not a drag, places each wall point). */
	private wallPreview: { x: number; y: number } | null = null;

	/** True while "Seau à murs" is flood-filling from a click (see `runColorRegionWalls`) — guards against a second click starting an overlapping run before the first one's async image load/analysis finishes. */
	private colorRegionWallsRunning = false;

	/** View mode "Animation" mode only: the path being traced by a held-down drag on empty canvas (with a token selection already in place) — see `beginPathDraw`/`commitPathDraw`. `null` outside that gesture. */
	private drawingPath: { points: Point[] } | null = null;
	/** Non-null while the "Animation" mode's tween is actively running — see `startPathAnimation`/`runPathAnimationLoop`. */
	private pathAnimation: PathAnimationState | null = null;
	/** Non-null while `pathAnimation`'s own render loop is actively re-rendering every frame — same pattern as `pingAnimationFrameId`. */
	private pathAnimationFrameId: number | null = null;

	private unsubscribe: () => void;

	private onContextMenu = (e: MouseEvent) => {
		if (this.controller.activeTool === "wall") {
			e.preventDefault();
			if (this.controller.pendingWallShape) {
				this.controller.cancelWallShapeStep();
			} else if (this.controller.pendingWallBucket) {
				this.controller.cancelWallBucketPlacement();
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
		// Markers are freeform (grid type "none" only, see `Marker`), map-structure objects — edit mode only.
		if (this.controller.mode === "edit" && this.controller.getData().gridType === "none") {
			menu.addItem((item) => item.setTitle("Placer un tampon ici").setIcon("map-pin").onClick(() => this.addMarkerAt(px, py)));
			hasItem = true;
		}
		// Tokens can be dropped in both modes — a GM adding a monster/NPC mid-session (view mode)
		// needs this as much as one building the map out (edit mode).
		menu.addItem((item) => item.setTitle("Placer un pion ici").setIcon("user").onClick(() => this.addTokenAt(px, py)));
		hasItem = true;
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

		// Only the primary (left) button hits tokens/markers/wall points/segments or drives
		// brush/fill/wall tool actions below — any other button (middle-click to pan while a tool
		// like "wall" is active, in particular) falls straight through to the plain drag-to-pan
		// handled in onPointerMove's final `else` branch, same as a left-click on empty space.
		if (e.button !== 0) return;

		// The "select" tool gets its own entirely separate branch — it never falls through to the
		// token/marker/wall-point/brush/fill/wall handling below, which assumes a different tool is
		// active. See `handleSelectPointerDown`.
		if (this.controller.mode === "edit" && this.controller.activeTool === "select") {
			this.handleSelectPointerDown(px, py);
			return;
		}

		// View mode's own multi-token select gestures take priority over the plain token-drag/pan
		// handling below — Ctrl (toggle-on-click / paint-the-distribute-area-on-drag) and Shift
		// (marquee select) each get their own branch, mutually exclusive with everything else a click
		// could do.
		if (this.controller.mode === "view" && e.ctrlKey) {
			this.handleViewCtrlPointerDown(px, py);
			return;
		}
		if (this.controller.mode === "view" && e.shiftKey) {
			const world = screenToWorld(px, py, this.transform);
			this.marqueeWorld = { start: world, current: world };
			return;
		}

		// Tokens are selectable in both modes, but only draggable/movable in view mode — edit mode
		// is for the map's structure (grid, zones, layers, markers, brush/fill), so a hit there just
		// selects the token instead of letting the click fall through to panning/tools.
		const tokenHit = this.findTokenAtScreenPoint(px, py);

		// "Animation" token movement (view mode only, the default and only way tokens tween — see
		// CLAUDE.md/this class's own doc): a drag starting on empty canvas — not on a token itself,
		// which keeps its own plain instant drag either way (see `tokenHit` below) — while there's
		// already a token selection in place takes over the gesture to trace a path instead of
		// panning. No selection yet just falls through to the ordinary tokenHit/pan handling below,
		// unchanged. Ctrl/Shift-held drags never reach here at all (both already returned above), so
		// this never fights the Ctrl-drag "distribute"/Shift-drag "marquee select" gestures.
		if (this.controller.mode === "view" && !tokenHit && this.hasAnimatableTokenSelection()) {
			this.beginPathDraw(px, py);
			return;
		}

		if (tokenHit) {
			if (this.controller.mode === "view") {
				// A token already part of a real (2+) multi-selection drags the whole group together;
				// otherwise this click starts fresh — any previous multi-selection is dropped so a plain
				// drag only ever moves the one token actually under the pointer.
				if (this.controller.massSelectionKind === "token" && this.controller.massSelectedTokenIds.has(tokenHit.id) && this.controller.massSelectedTokenIds.size > 1) {
					this.startGroupDrag(tokenHit, px, py);
				} else {
					if (this.controller.massSelectedTokenIds.size > 0) this.controller.clearMassSelection();
					this.draggingToken = { token: tokenHit, currentWorld: screenToWorld(px, py, this.transform) };
				}
			} else {
				this.controller.selectToken(tokenHit.id);
				this.toolConsumedClick = true;
			}
			return;
		}
		if (this.controller.mode === "view") return;

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
		// closing a shape onto an existing point. Wall segments are click-selectable the same way
		// (there's no independent drag for a segment — it moves via its endpoint points).
		if (this.controller.activeTool !== "wall") {
			const hitPoint = this.findWallPointAtScreenPoint(px, py);
			if (hitPoint) {
				this.draggingWallPoint = { point: hitPoint, currentWorld: screenToWorld(px, py, this.transform) };
				return;
			}
			const hitSegment = this.findWallSegmentAtScreenPoint(px, py);
			if (hitSegment) {
				this.pendingWallSegmentId = hitSegment.id;
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
			if (this.controller.pendingWallBucket) {
				void this.runColorRegionWalls(screenToWorld(px, py, this.transform));
			} else {
				const placement = this.resolveWallPlacement(px, py);
				if (this.controller.pendingWallShape) {
					this.controller.placeWallShapeCorner(placement.x, placement.y);
				} else {
					this.controller.commitWallPoint(placement.x, placement.y, placement.existingPointId);
				}
			}
			this.toolConsumedClick = true;
		}
	};

	/**
	 * The "select" tool's own pointer-down handling: hit-tests token → wall segment → (marker on grid
	 * "none", else cell) in that priority, skipping a tier whose kind doesn't match an already-locked
	 * `massSelectionKind`. Doesn't mutate the controller yet — `onPointerUp` decides between a plain
	 * click (toggle) and a marquee drag once `dragMoved` is known, same pattern as token/marker drags.
	 */
	private handleSelectPointerDown(px: number, py: number): void {
		const world = screenToWorld(px, py, this.transform);
		this.marqueeWorld = { start: world, current: world };
		this.selectPointerHit = this.resolveSelectHit(px, py);
	}

	private resolveSelectHit(px: number, py: number): { kind: MassSelectionKind; id: string } | null {
		const lockedKind = this.controller.massSelectionKind;
		if (!lockedKind || lockedKind === "token") {
			const token = this.findTokenAtScreenPoint(px, py);
			if (token) return { kind: "token", id: token.id };
		}
		if (!lockedKind || lockedKind === "wallSegment") {
			const segment = this.findWallSegmentAtScreenPoint(px, py);
			if (segment) return { kind: "wallSegment", id: segment.id };
		}
		if (!lockedKind || lockedKind === "stamp") {
			const data = this.controller.getData();
			if (data.gridType === "none") {
				const marker = this.findMarkerAtScreenPoint(px, py);
				if (marker) return { kind: "stamp", id: marker.id };
			} else {
				const world = screenToWorld(px, py, this.transform);
				return { kind: "stamp", id: this.cellKeyAt(world.x, world.y) };
			}
		}
		return null;
	}

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

		// Like `painting` above, this runs regardless of `dragMoved` — the distribute area is painted
		// continuously as the pointer moves, cell by cell (any shape), not dragged out as a rectangle.
		if (this.distributePaint) {
			this.paintDistributeCellAt(px, py);
			this.recomputeDistributePreview();
			this.render();
			return;
		}

		// Same idea, for the "Animation" mode's path trace: sampled continuously (not just once
		// `dragMoved` is known), but only every `PATH_SAMPLE_SPACING_RATIO` of a cell so the point
		// count — and thus the per-frame arc-length work once the tween starts — stays bounded.
		if (this.drawingPath) {
			const world = screenToWorld(px, py, this.transform);
			const last = this.drawingPath.points[this.drawingPath.points.length - 1];
			if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= this.cellVisualWidth() * PATH_SAMPLE_SPACING_RATIO) {
				this.drawingPath.points.push(world);
			}
			this.render();
			return;
		}

		if (!this.dragMoved) return;

		// Shared by the edit-mode "select" tool's marquee and view mode's Shift-drag marquee — both
		// just fill in the same `marqueeWorld` at pointer-down (see `onPointerDown`).
		if (this.marqueeWorld) {
			this.marqueeWorld.current = screenToWorld(px, py, this.transform);
			this.render();
			return;
		}

		if (this.draggingTokenGroup) {
			this.draggingTokenGroup.currentWorld = screenToWorld(px, py, this.transform);
			this.render();
			return;
		}

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
			this.options.onViewportChange?.();
		}
	};

	private onPointerUp = (e: PointerEvent) => {
		if (!this.dragging) return;
		this.dragging = false;
		if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);

		// "Animation" mode's path trace: checked first (even before the ping logic just below, which
		// would otherwise also match a no-motion release of this same gesture) since `beginPathDraw`
		// already consumed the mousedown that started it — see `onPointerDown`.
		if (this.drawingPath) {
			this.commitPathDraw();
			return;
		}

		// A plain left-click on empty space (no edit tool armed, and not landing on a token/marker —
		// those already have their own selection/info-panel feedback, a ping would be redundant)
		// pings that spot for players — view mode only, since in edit mode a plain click is just
		// deselecting/panning. Checked before `toolConsumedClick`/`painting` below, since a
		// token click in edit mode also flips `toolConsumedClick` (it's not just for brush/fill/wall
		// placement). Re-does the same hit-tests as `onPointerDown` rather than reading
		// `draggingToken`/`draggingMarker`, since edit mode never sets those for a token click.
		// Right-click is excluded — that's `onContextMenu`'s job (placing a token there), not a ping.
		if (!this.dragMoved && e.button === 0 && !e.ctrlKey && !e.shiftKey && this.controller.mode === "view" && this.controller.activeTool === "none") {
			const rect = this.canvas.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const py = e.clientY - rect.top;
			const hitToken = this.findTokenAtScreenPoint(px, py);
			const hitMarker = this.controller.getData().gridType === "none" ? this.findMarkerAtScreenPoint(px, py) : null;
			if (!hitToken && !hitMarker) {
				// Genuinely empty space, no modifier: same "click clears" convention as the edit-mode
				// select tool's marquee (see `handleSelectPointerUp`), on top of the existing ping.
				if (this.controller.massSelectedTokenIds.size > 0) this.controller.clearMassSelection();
				const world = screenToWorld(px, py, this.transform);
				this.triggerPing(world.x, world.y);
				this.options.onPing?.(world.x, world.y);
			}
		}

		if (this.controller.mode === "view" && this.marqueeWorld) {
			this.handleViewMarqueePointerUp();
			return;
		}
		if (this.distributePaint) {
			this.handleDistributePointerUp();
			return;
		}
		if (this.draggingTokenGroup) {
			this.commitGroupDrag();
			return;
		}

		if (this.controller.mode === "edit" && this.controller.activeTool === "select") {
			this.handleSelectPointerUp();
			return;
		}

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

		if (this.pendingWallSegmentId) {
			const segmentId = this.pendingWallSegmentId;
			this.pendingWallSegmentId = null;
			// A drag past the threshold that merely started on top of a segment's line is just a pan
			// (already applied live in onPointerMove's default branch, since nothing above consumed
			// it) — only a plain click selects the segment.
			if (!this.dragMoved) this.controller.selectWallSegment(segmentId);
			return;
		}

		// Left-click only: right-click on empty cell space is left to `onContextMenu` (placing a
		// token/marker) rather than toggling the cell's info panel open/closed.
		if (!this.dragMoved && e.button === 0) this.handleClick(e);
	};

	private onPointerCancel = () => {
		this.dragging = false;
		this.draggingToken = null;
		this.draggingMarker = null;
		this.draggingWallPoint = null;
		this.pendingWallSegmentId = null;
		if (this.painting) this.controller.endHistoryGroup();
		this.painting = false;
		this.lastPaintedKey = null;
		this.paintedInStroke = new Set();
		this.toolConsumedClick = false;
		this.selectPointerHit = null;
		this.marqueeWorld = null;
		this.draggingTokenGroup = null;
		this.viewCtrlTokenHit = null;
		this.distributePaint = null;
		this.distributePreview = null;
		this.drawingPath = null;
	};

	/**
	 * A plain click (no drag) toggles whatever `handleSelectPointerDown` resolved under the pointer;
	 * a marquee drag instead adds every matching-kind object inside the drag rect. If no kind is
	 * locked yet, a marquee tries tokens → wall segments → stamps, locking on the first tier with any
	 * hits — see `inferMarqueeKind`.
	 */
	private handleSelectPointerUp(): void {
		const hit = this.selectPointerHit;
		const marquee = this.marqueeWorld;
		this.selectPointerHit = null;
		this.marqueeWorld = null;

		if (!this.dragMoved) {
			if (hit) {
				this.controller.toggleMassSelection(hit.kind, hit.id);
			} else if (this.controller.getData().gridType === "none") {
				// Genuinely empty background — only possible on grid "none" (a celled grid has no
				// "empty" click, every point belongs to some cell) — resets the whole selection.
				this.controller.clearMassSelection();
			}
			return;
		}

		if (!marquee) return;
		const rect = this.normalizedWorldRect(marquee.start, marquee.current);
		const kind = this.controller.massSelectionKind ?? this.inferMarqueeKind(rect);
		if (!kind) return;
		const ids = this.idsInRect(kind, rect);
		if (ids.length > 0) this.controller.addMassSelection(kind, ids);
	}

	/** View mode's Shift-drag marquee release: unlike the edit-mode select tool, this only ever targets tokens — a click with no drag is a no-op (Ctrl+click is the dedicated single-token toggle gesture). */
	private handleViewMarqueePointerUp(): void {
		const marquee = this.marqueeWorld;
		this.marqueeWorld = null;
		if (!marquee || !this.dragMoved) return;
		const rect = this.normalizedWorldRect(marquee.start, marquee.current);
		const ids = this.tokensInRect(rect);
		if (ids.length > 0) this.controller.addMassSelection("token", ids);
	}

	private normalizedWorldRect(a: { x: number; y: number }, b: { x: number; y: number }): { minX: number; maxX: number; minY: number; maxY: number } {
		return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
	}

	/** Tries each kind in priority order and locks onto the first with any hits inside `rect` — used when a marquee drag starts on an unlocked selection. */
	private inferMarqueeKind(rect: { minX: number; maxX: number; minY: number; maxY: number }): MassSelectionKind | null {
		if (this.tokensInRect(rect).length > 0) return "token";
		if (this.wallSegmentsInRect(rect).length > 0) return "wallSegment";
		const stampIds = this.controller.getData().gridType === "none" ? this.markersInRect(rect) : this.cellsInRect(rect);
		return stampIds.length > 0 ? "stamp" : null;
	}

	private idsInRect(kind: MassSelectionKind, rect: { minX: number; maxX: number; minY: number; maxY: number }): string[] {
		if (kind === "token") return this.tokensInRect(rect);
		if (kind === "wallSegment") return this.wallSegmentsInRect(rect);
		return this.controller.getData().gridType === "none" ? this.markersInRect(rect) : this.cellsInRect(rect);
	}

	/**
	 * Same fog-visibility rule as `findTokenAtScreenPoint` — irrelevant to the edit-mode select tool
	 * (fog is never active there), but view mode's Shift-drag marquee reuses this too, so a GM's
	 * marquee can't scoop up an entity currently hidden by fog that a plain click on it couldn't
	 * have selected either. Only actually gates anything on the player-mirror canvas — see
	 * `entitiesHiddenByFog`.
	 */
	private tokensInRect(rect: { minX: number; maxX: number; minY: number; maxY: number }): string[] {
		const out: string[] = [];
		const fogActive = this.entitiesHiddenByFog();
		for (const token of this.controller.getData().tokens) {
			if (this.isLightTokenHiddenFromMirror(token)) continue;
			const c = this.footprintCenter(token);
			if (c.x < rect.minX || c.x > rect.maxX || c.y < rect.minY || c.y > rect.maxY) continue;
			const isPlayer = (token.category ?? "entity") === "player";
			if (fogActive && !isPlayer && !this.isEntityRevealedByFog(c)) continue;
			out.push(token.id);
		}
		return out;
	}

	/** A segment matches if either endpoint's world position falls inside `rect` ("touches" semantics, like most marquee tools). */
	private wallSegmentsInRect(rect: { minX: number; maxX: number; minY: number; maxY: number }): string[] {
		const out: string[] = [];
		const inRect = (p: { x: number; y: number }) => p.x >= rect.minX && p.x <= rect.maxX && p.y >= rect.minY && p.y <= rect.maxY;
		for (const layer of this.controller.getData().layers) {
			if (!layer.visible) continue;
			const pointsById = new Map(layer.wallPoints.map((p) => [p.id, p]));
			for (const segment of layer.wallSegments) {
				const a = pointsById.get(segment.aId);
				const b = pointsById.get(segment.bId);
				if ((a && inRect(a)) || (b && inRect(b))) out.push(segment.id);
			}
		}
		return out;
	}

	private markersInRect(rect: { minX: number; maxX: number; minY: number; maxY: number }): string[] {
		const out: string[] = [];
		for (const layer of this.controller.getData().layers) {
			if (!layer.visible) continue;
			for (const marker of layer.markers) {
				if (marker.x >= rect.minX && marker.x <= rect.maxX && marker.y >= rect.minY && marker.y <= rect.maxY) out.push(marker.id);
			}
		}
		return out;
	}

	/**
	 * Reuses `getVisibleSquareCells`/`getVisibleHexCells` (normally used to enumerate the whole
	 * viewport) by synthesizing a `ViewTransform` that maps `rect` itself onto a same-sized "viewport"
	 * — then trims the result back to cells actually centered inside `rect`, since those helpers pad
	 * their result by a margin of about one cell.
	 */
	private cellsInRect(rect: { minX: number; maxX: number; minY: number; maxY: number }): string[] {
		if (rect.maxX <= rect.minX || rect.maxY <= rect.minY) return [];
		const data = this.controller.getData();
		const cellSize = this.effectiveCellSize();
		const transform: ViewTransform = { zoom: 1, panX: -rect.minX, panY: -rect.minY };
		const w = rect.maxX - rect.minX;
		const h = rect.maxY - rect.minY;
		const keys =
			data.gridType === "hex-pointy" || data.gridType === "hex-flat"
				? getVisibleHexCells(transform, cellSize, data.gridType === "hex-pointy" ? "pointy" : "flat", w, h).map((c) => hexKey(c.a, c.b))
				: getVisibleSquareCells(transform, cellSize, w, h).map((c) => squareKey(c.a, c.b));
		return keys.filter((key) => {
			const center = this.cellCenter(key);
			return center.x >= rect.minX && center.x <= rect.maxX && center.y >= rect.minY && center.y <= rect.maxY;
		});
	}

	// ---- View mode: multi-token select / group move / distribute-into-area ----

	/**
	 * Ctrl+mousedown in view mode: remembers whatever token (if any) is under the pointer, for a
	 * later toggle if this turns out to be a plain click, and always starts a distribute-paint stroke
	 * — immediately painting the cell right under the pointer, exactly like the brush tool's own
	 * `onPointerDown` paints its very first cell rather than waiting for the first `onPointerMove` —
	 * which gesture this actually is is only known once `onPointerUp` sees whether the pointer moved
	 * past `DRAG_THRESHOLD` (see `handleDistributePointerUp`).
	 */
	private handleViewCtrlPointerDown(px: number, py: number): void {
		this.viewCtrlTokenHit = this.findTokenAtScreenPoint(px, py)?.id ?? null;
		this.distributePaint = { cellKeys: new Set(), points: [], lastCellKey: null };
		this.paintDistributeCellAt(px, py);
		this.recomputeDistributePreview();
		this.render();
	}

	/** Paints whatever cell (or, on grid type "none", raw point) is at `(px, py)` into the in-progress `distributePaint` stroke — a no-op if it's the same cell already painted last. */
	private paintDistributeCellAt(px: number, py: number): void {
		const paint = this.distributePaint;
		if (!paint) return;
		const world = screenToWorld(px, py, this.transform);
		if (this.controller.getData().gridType === "none") {
			paint.points.push(world);
			return;
		}
		const key = this.cellKeyAt(world.x, world.y);
		if (key === paint.lastCellKey) return;
		paint.lastCellKey = key;
		paint.cellKeys.add(key);
	}

	/** Ctrl+mouseup: a plain click toggles whatever token was under the pointer at mousedown; a drag commits (or, if the preview turned red, rejects) the distribute-into-area gesture computed live by `recomputeDistributePreview`. */
	private handleDistributePointerUp(): void {
		const hitId = this.viewCtrlTokenHit;
		const preview = this.distributePreview;
		this.viewCtrlTokenHit = null;
		this.distributePaint = null;
		this.distributePreview = null;

		if (!this.dragMoved) {
			if (hitId) this.controller.toggleMassSelection("token", hitId);
			this.render();
			return;
		}
		if (preview?.valid) {
			this.commitDistribute(preview);
		} else if (this.controller.massSelectedTokenIds.size > 0) {
			new Notice("Pas assez de place dans la zone pour tous les pions.");
		}
		this.render();
	}

	/** Snapshots every mass-selected token's current footprint center so `onPointerMove` can drag them all together, preserving relative offsets — see `commitGroupDrag`. */
	private startGroupDrag(anchorToken: Token, px: number, py: number): void {
		const world = screenToWorld(px, py, this.transform);
		const ids = this.controller.massSelectedTokenIds;
		const entries = this.controller
			.getData()
			.tokens.filter((t) => ids.has(t.id))
			.map((t) => ({ token: t, originWorld: this.footprintCenter(t) }));
		this.draggingTokenGroup = { anchorTokenId: anchorToken.id, entries, pointerDownWorld: world, currentWorld: world };
	}

	/**
	 * Commits (or, on a plain click, collapses) a group drag started by `startGroupDrag`. On grid
	 * "none" every token's target is just its origin plus the drag delta (no collision concept, like
	 * single-token free drag). On a celled grid the anchor token (the one actually clicked) resolves
	 * its own target cell exactly like a single-token drop (`dropAnchorKey`, respecting its own
	 * footprint/size snapping), and that anchor's cell delta is applied rigidly to every other
	 * token's *original* cell — so the whole group moves as one block instead of each token
	 * independently re-snapping to its own nearest cell.
	 */
	private commitGroupDrag(): void {
		const group = this.draggingTokenGroup;
		this.draggingTokenGroup = null;
		if (!group) return;

		if (!this.dragMoved) {
			// Clicking (not dragging) a token that's part of a multi-selection collapses the selection
			// down to just that one — same convention as clicking empty space clearing it entirely.
			this.controller.clearMassSelection();
			this.controller.selectToken(group.anchorTokenId);
			return;
		}

		const dx = group.currentWorld.x - group.pointerDownWorld.x;
		const dy = group.currentWorld.y - group.pointerDownWorld.y;
		const data = this.controller.getData();

		if (data.gridType === "none") {
			const targets = new Map(group.entries.map((e) => [e.token.id, { x: e.originWorld.x + dx, y: e.originWorld.y + dy }]));
			this.controller.moveTokensToPoints(targets);
			this.render();
			return;
		}

		const anchorEntry = group.entries.find((e) => e.token.id === group.anchorTokenId);
		const anchorOriginKey = anchorEntry?.token.cellKey;
		if (!anchorEntry || !anchorOriginKey) {
			this.render();
			return;
		}
		const anchorTargetKey = this.dropAnchorKey(anchorEntry.token, anchorEntry.originWorld.x + dx, anchorEntry.originWorld.y + dy);
		const { a: oa, b: ob } = parseCellKey(anchorOriginKey);
		const { a: ta, b: tb } = parseCellKey(anchorTargetKey);
		const deltaA = ta - oa;
		const deltaB = tb - ob;

		const targets = new Map<string, string>();
		for (const entry of group.entries) {
			if (!entry.token.cellKey) continue;
			const { a, b } = parseCellKey(entry.token.cellKey);
			targets.set(entry.token.id, squareKey(a + deltaA, b + deltaB));
		}
		const moved = this.controller.moveTokensToCells(targets);
		if (!moved) new Notice("Case déjà occupée par un pion.");
		this.render();
	}

	/**
	 * Recomputes the live preview for the Ctrl-drag distribute-into-area gesture: where each
	 * mass-selected token would land if the stroke ended right now, and whether the whole batch
	 * actually fits into whatever's been painted so far (see `distributePaint`/`paintDistributeCellAt`
	 * — any shape, not just a rectangle). Tokens are ordered left-to-right then top-to-bottom (reading
	 * order) by their *current* footprint center, and paired 1:1 with destinations sorted the same
	 * way — so "leftmost token before → leftmost destination" holds regardless of where in the
	 * selection each token sits.
	 */
	private recomputeDistributePreview(): void {
		const paint = this.distributePaint;
		if (!paint) {
			this.distributePreview = null;
			return;
		}
		const ids = this.controller.massSelectedTokenIds;
		const data = this.controller.getData();
		const tokens = data.tokens.filter((t) => ids.has(t.id));
		if (tokens.length === 0) {
			this.distributePreview = null;
			return;
		}
		const readingOrder = (p: { x: number; y: number }, q: { x: number; y: number }) => p.x - q.x || p.y - q.y;
		const ordered = [...tokens].sort((a, b) => readingOrder(this.footprintCenter(a), this.footprintCenter(b)));

		if (data.gridType === "none") {
			// No cells, no capacity limit: proportionally remap each token's position within the
			// selection's own bounding box into the painted stroke's own bounding box.
			if (paint.points.length === 0) {
				this.distributePreview = null;
				return;
			}
			const destMinX = Math.min(...paint.points.map((p) => p.x));
			const destMaxX = Math.max(...paint.points.map((p) => p.x));
			const destMinY = Math.min(...paint.points.map((p) => p.y));
			const destMaxY = Math.max(...paint.points.map((p) => p.y));
			const centers = tokens.map((t) => this.footprintCenter(t));
			const minX = Math.min(...centers.map((c) => c.x));
			const maxX = Math.max(...centers.map((c) => c.x));
			const minY = Math.min(...centers.map((c) => c.y));
			const maxY = Math.max(...centers.map((c) => c.y));
			const spanX = Math.max(maxX - minX, 1e-6);
			const spanY = Math.max(maxY - minY, 1e-6);
			const points = ordered.map((t) => {
				const c = this.footprintCenter(t);
				const nx = (c.x - minX) / spanX;
				const ny = (c.y - minY) / spanY;
				return { x: destMinX + nx * (destMaxX - destMinX), y: destMinY + ny * (destMaxY - destMinY) };
			});
			this.distributePreview = { valid: true, cellKeys: null, points, assignment: ordered.map((t, i) => ({ tokenId: t.id, point: points[i] })) };
			return;
		}

		const occupied = occupiedFootprintCells(data, ids);
		const painted = [...paint.cellKeys].sort((k1, k2) => readingOrder(this.cellCenter(k1), this.cellCenter(k2)));
		const free = painted.filter((k) => !occupied.has(k));
		const n = ordered.length;
		const valid = free.length >= n;
		this.distributePreview = {
			valid,
			// Always highlight everything actually painted, regardless of shape or validity — WYSIWYG,
			// like a brush stroke. Only the first `n` *free* cells (in reading order) are ever really
			// assigned; painting more than needed just means the extras don't get used.
			cellKeys: painted,
			points: painted.map((k) => this.cellCenter(k)),
			assignment: valid ? ordered.map((t, i) => ({ tokenId: t.id, cellKey: free[i] })) : null,
		};
	}

	/** Applies a valid `distributePreview`'s assignment — see `recomputeDistributePreview`. */
	private commitDistribute(preview: DistributePreview): void {
		if (!preview.valid || !preview.assignment) return;
		const data = this.controller.getData();
		if (data.gridType === "none") {
			const targets = new Map<string, { x: number; y: number }>();
			for (const a of preview.assignment) if (a.point) targets.set(a.tokenId, a.point);
			this.controller.moveTokensToPoints(targets);
			return;
		}
		const targets = new Map<string, string>();
		for (const a of preview.assignment) if (a.cellKey) targets.set(a.tokenId, a.cellKey);
		if (!this.controller.moveTokensToCells(targets)) new Notice("Case déjà occupée par un pion.");
	}

	// ---- View mode: "Animation" token movement (draw a path, tokens tween along it) ----

	/** Whether the path-draw gesture has anything to animate right now — see `onPointerDown`'s "Animation" mode branch and `animatedSelectionTokenIds`. */
	private hasAnimatableTokenSelection(): boolean {
		if (this.controller.massSelectionKind === "token" && this.controller.massSelectedTokenIds.size > 0) return true;
		return !!this.controller.selectedTokenId;
	}

	/** The tokens a path-draw gesture would animate: the current mass token selection if there is one, else the single selected token, else none. Same priority `hasAnimatableTokenSelection` checks. */
	private animatedSelectionTokenIds(): string[] {
		if (this.controller.massSelectionKind === "token" && this.controller.massSelectedTokenIds.size > 0) return [...this.controller.massSelectedTokenIds];
		return this.controller.selectedTokenId ? [this.controller.selectedTokenId] : [];
	}

	private beginPathDraw(px: number, py: number): void {
		this.drawingPath = { points: [screenToWorld(px, py, this.transform)] };
	}

	/** Pointer-up while a path was being traced: fewer than 2 sampled points means the pointer never actually moved (a plain click that happened to land where the gesture was armed) — a no-op, same as a click with nothing to drag. */
	private commitPathDraw(): void {
		const drawn = this.drawingPath;
		this.drawingPath = null;
		if (!drawn || drawn.points.length < 2) return;
		this.startPathAnimation(drawn.points);
	}

	/**
	 * Builds one `PathAnimationRoute` per animatable token and starts the tween loop. Each token's
	 * own route is a straight lead-in from wherever it actually is onto the drawn path's first point,
	 * then as much of the path itself as its rank allows — see the interface doc on
	 * `PathAnimationRoute`/`PATH_FOLLOW_GAP_CELLS` for why rank (closest-to-the-path's-start-first)
	 * shortens how far along the path each successive token gets to go, so they end up queued
	 * single-file rather than stacked on the same final cell.
	 */
	private startPathAnimation(pathPoints: Point[]): void {
		const pathStart = pathPoints[0];
		if (!pathStart) return;
		const ids = this.animatedSelectionTokenIds();
		const tokens = this.controller.getData().tokens.filter((t) => ids.includes(t.id));
		if (tokens.length === 0) return;

		const ranked = tokens
			.map((token) => {
				const origin = this.footprintCenter(token);
				return { token, origin, dist: Math.hypot(origin.x - pathStart.x, origin.y - pathStart.y) };
			})
			.sort((a, b) => a.dist - b.dist);

		const pathCumulative = polylineCumulativeLengths(pathPoints);
		const pathTotalLength = pathCumulative[pathCumulative.length - 1] ?? 0;
		const gap = this.cellVisualWidth() * PATH_FOLLOW_GAP_CELLS;

		const routes: PathAnimationRoute[] = ranked.map(({ token, origin }, rank) => {
			const stopArc = Math.max(0, pathTotalLength - rank * gap);
			const points = [origin, ...truncatePolyline(pathPoints, pathCumulative, stopArc)];
			const cumulative = polylineCumulativeLengths(points);
			const totalLength = cumulative[cumulative.length - 1] ?? 0;
			const finalRotation = directionAtArcLength(points, cumulative, totalLength) ?? token.rotation ?? 0;
			return { tokenId: token.id, points, cumulative, totalLength, finalRotation };
		});

		const speedWorldPerMs = (this.cellVisualWidth() * PATH_ANIMATION_CELLS_PER_SEC) / 1000;
		this.playPathAnimation(routes, speedWorldPerMs, true);
		// A mirror never touches `MapController` until this canvas's own `finishPathAnimation` commits
		// (they share the same controller — see `mirrorRegistry`), so left alone it would only see the
		// tokens jump once the tween is over. `routes`/`speedWorldPerMs` are pure position/timing data
		// (no canvas-specific state), so relaying them lets a mirror replay the exact same tween on its
		// own local clock — see `MapCanvasOptions.onPathAnimation`/`playPathAnimationEcho`.
		this.options.onPathAnimation?.(routes, speedWorldPerMs);
	}

	/** Starts (or, for a mirror, replays) an "Animation" tween — shared by `startPathAnimation` and `playPathAnimationEcho`. */
	private playPathAnimation(routes: PathAnimationRoute[], speedWorldPerMs: number, commitOnFinish: boolean): void {
		this.pathAnimation = { routes, startedAt: performance.now(), speedWorldPerMs, commitOnFinish };
		this.runPathAnimationLoop();
	}

	/**
	 * Mirror-only: replays an "Animation" token-movement tween initiated on the source canvas — see
	 * `MapCanvasOptions.onPathAnimation`/`MirrorSource.onPathAnimationStart` (wired up the same way
	 * `triggerPing` already is for pings). Runs on this canvas's own `performance.now()` clock (a
	 * popout window's clock has a different origin than the main window's — sharing a raw timestamp
	 * across them would desync immediately), and never commits anything to `MapController`: the source
	 * canvas's own `finishPathAnimation` already will, and both canvases share that same controller.
	 */
	playPathAnimationEcho(routes: PathAnimationRoute[], speedWorldPerMs: number): void {
		this.playPathAnimation(routes, speedWorldPerMs, false);
	}

	/** Same self-contained start/stop `requestAnimationFrame` pattern as `triggerPing` — re-renders every frame until every route has covered its own `totalLength` at the shared speed, then hands off to `finishPathAnimation` (owner) or just lets the local echo lapse (mirror — see `PathAnimationState.commitOnFinish`). */
	private runPathAnimationLoop(): void {
		if (this.pathAnimationFrameId !== null) return;
		const tick = () => {
			const anim = this.pathAnimation;
			if (!anim) {
				this.pathAnimationFrameId = null;
				return;
			}
			const elapsed = performance.now() - anim.startedAt;
			const finished = anim.routes.every((route) => elapsed * anim.speedWorldPerMs >= route.totalLength);
			if (finished) {
				this.pathAnimationFrameId = null;
				if (anim.commitOnFinish) {
					this.finishPathAnimation();
				} else {
					this.pathAnimation = null;
					this.render();
				}
				return;
			}
			this.render();
			this.pathAnimationFrameId = requestAnimationFrame(tick);
		};
		this.pathAnimationFrameId = requestAnimationFrame(tick);
	}

	/**
	 * Nearest cell to `fromKey` (BFS, 4-/6-connected same as the fill tool's flood — `neighborKeys`;
	 * a hop blocked by a wall segment — `edgeBlocked` — is never taken, so the result is always
	 * actually walkable to) whose whole footprint (`size`) is absent from `claimed`. `fromKey` itself
	 * is tried first and returned as-is if it already fits. Bounded by `COLLISION_SEARCH_LIMIT`
	 * visited cells; past that (a fully packed map with nowhere left to go) `fromKey` is returned
	 * unchanged rather than searching forever — same "leave it where it collided" fallback
	 * `moveTokensToCells`'s own rejection used to mean for the whole batch, now scoped to just the one
	 * token that couldn't be placed. Used by `finishPathAnimation` to resolve two animated tokens (or
	 * an animated token and a stationary one) ending their move on the same cell.
	 */
	private nearestFreeCell(fromKey: string, size: number, claimed: ReadonlySet<string>, wallSegments: ResolvedWallSegment[]): string {
		const data = this.controller.getData();
		const fits = (key: string) => footprintCellKeys(data, key, size).every((k) => !claimed.has(k));
		if (fits(fromKey)) return fromKey;
		const visited = new Set<string>([fromKey]);
		const queue: string[] = [fromKey];
		let visitedCount = 0;
		while (queue.length > 0 && visitedCount < COLLISION_SEARCH_LIMIT) {
			const key = queue.shift();
			if (!key) break;
			for (const n of this.neighborKeys(key)) {
				if (visited.has(n) || this.edgeBlocked(key, n, wallSegments)) continue;
				visited.add(n);
				visitedCount++;
				if (fits(n)) return n;
				queue.push(n);
				if (visitedCount >= COLLISION_SEARCH_LIMIT) break;
			}
		}
		return fromKey;
	}

	/**
	 * Commits every route's final position/facing in one batch, as one undo step
	 * (`beginHistoryGroup`/`endHistoryGroup`). Position, on a celled grid, is resolved through
	 * `nearestFreeCell` first (see its own doc) rather than handed straight to
	 * `moveTokensToCells`: routes are already in priority order (closest-to-the-path's-start-first —
	 * see `startPathAnimation`), so claiming each route's cell in that same order and nudging only a
	 * later, colliding one out of the way — instead of `moveTokensToCells`'s own atomic all-or-nothing
	 * collision check, which would otherwise reject the *entire* batch (leaving every token exactly
	 * where it started) the instant any two of them land on the same cell — means the group still
	 * ends up queued single-file even when `PATH_FOLLOW_GAP_CELLS` alone wasn't enough to keep them
	 * apart (a short path, or one that curls back on itself). Grid type "none" has no collision
	 * concept at all (`moveTokensToPoints`), so this only ever applies to celled grids. Then
	 * `setTokenRotations` for facing.
	 */
	private finishPathAnimation(): void {
		const anim = this.pathAnimation;
		this.pathAnimation = null;
		if (!anim || anim.routes.length === 0) return;
		const data = this.controller.getData();

		this.controller.beginHistoryGroup();
		let moved = true;
		if (data.gridType === "none") {
			const targets = new Map<string, { x: number; y: number }>();
			for (const route of anim.routes) {
				const end = route.points[route.points.length - 1];
				if (end) targets.set(route.tokenId, end);
			}
			this.controller.moveTokensToPoints(targets);
		} else {
			const wallSegments = this.resolveWallSegments();
			const movingIds = new Set(anim.routes.map((r) => r.tokenId));
			const claimed = occupiedFootprintCells(data, movingIds);
			const targets = new Map<string, string>();
			for (const route of anim.routes) {
				const token = this.controller.findToken(route.tokenId);
				const end = route.points[route.points.length - 1];
				if (!token || !end) continue;
				const size = token.size ?? 1;
				const desiredKey = this.dropAnchorKey(token, end.x, end.y);
				const finalKey = this.nearestFreeCell(desiredKey, size, claimed, wallSegments);
				for (const key of footprintCellKeys(data, finalKey, size)) claimed.add(key);
				targets.set(route.tokenId, finalKey);
			}
			moved = this.controller.moveTokensToCells(targets);
			if (!moved) new Notice("Case déjà occupée par un pion.");
		}
		if (moved) {
			const rotations = new Map(anim.routes.map((r) => [r.tokenId, r.finalRotation]));
			this.controller.setTokenRotations(rotations);
		}
		this.controller.endHistoryGroup();

		this.render();
	}

	/**
	 * Double-clicking a wall segment's line (away from an existing point) inserts a new point right
	 * there, splitting the segment in two — lets a straight wall line be reshaped without redrawing
	 * it. Gated the same way as dragging/selecting an existing point (`onPointerDown` above): only
	 * in edit mode, and not while the wall tool itself is armed, since there each click already means
	 * something else (placing/continuing a chain).
	 */
	private onDoubleClick = (e: MouseEvent) => {
		if (this.controller.mode !== "edit" || this.controller.activeTool === "wall") return;
		const rect = this.canvas.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		if (this.findWallPointAtScreenPoint(px, py)) return;
		const segment = this.findWallSegmentAtScreenPoint(px, py);
		if (!segment) return;
		e.preventDefault();
		const world = this.snapWorldToGrid(screenToWorld(px, py, this.transform));
		const newPointId = this.controller.insertWallPointOnSegment(segment.id, world.x, world.y);
		if (newPointId) this.controller.selectWallPoint(newPointId);
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
		this.options.onViewportChange?.();
	};

	private get isMirror(): boolean {
		return !!this.options.isMirror;
	}

	/**
	 * A mirror always renders as if in "view" mode, regardless of the GM's own shared
	 * `controller.mode` — otherwise the player window's fog/cover-zoom/cell-visibility/edit-tool
	 * overlays would depend on whatever mode the GM's own tab happens to be in (and the GM would have
	 * to switch their own tab to "Vue" just to make the player window look right). All rendering
	 * decisions below should read this instead of `this.controller.mode` directly; input-handling
	 * code (which a mirror never runs — see the constructor) is unaffected and still reads the real
	 * shared mode.
	 */
	private effectiveMode(): MapMode {
		return this.isMirror ? "view" : this.controller.mode;
	}

	constructor(private container: HTMLElement, private controller: MapController, private app: App, private settings: MapManagerSettings, private options: MapCanvasOptions = {}) {
		this.canvas = container.createEl("canvas", { cls: "map-manager-canvas" });
		if (this.isMirror) this.canvas.addClass("is-mirror-canvas");
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

		if (!this.isMirror) {
			this.canvas.addEventListener("pointerdown", this.onPointerDown);
			this.canvas.addEventListener("pointermove", this.onPointerMove);
			this.canvas.addEventListener("pointerup", this.onPointerUp);
			this.canvas.addEventListener("pointercancel", this.onPointerCancel);
			this.canvas.addEventListener("dblclick", this.onDoubleClick);
			this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
			this.canvas.addEventListener("contextmenu", this.onContextMenu);
		}

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
			// View mode covers the viewport (larger ratio) so no empty space beyond the image is ever
			// visible; edit mode fits the whole image on screen (smaller ratio) so nothing is cropped.
			const zoom =
				this.effectiveMode() === "view"
					? clamp(Math.max(this.viewportW / bounds.w, this.viewportH / bounds.h), ABS_MIN_ZOOM, data.maxZoom)
					: clamp(Math.min(this.viewportW / bounds.w, this.viewportH / bounds.h), data.minZoom, data.maxZoom);
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
		this.options.onViewportChange?.();
	}

	/**
	 * The world point currently at the center of *this* canvas's own viewport, plus its zoom — the
	 * aspect-ratio-independent camera description a mirror canvas re-derives its own pan from (see
	 * `setMirrorCamera`). Raw `panX`/`panY` can't be copied as-is: they anchor world (0,0) to *this*
	 * canvas's own top-left corner, so the same values on a differently-sized canvas shift the content
	 * away from that canvas's own center instead of keeping it centered.
	 */
	getViewCenter(): { zoom: number; x: number; y: number } {
		const center = screenToWorld(this.viewportW / 2, this.viewportH / 2, this.transform);
		return { zoom: this.transform.zoom, x: center.x, y: center.y };
	}

	/**
	 * Mirror-only: sets the camera to display, pushed by the caller (`MapPlayerMirrorView`) only when
	 * the source's camera actually changed (its `onViewportChange`) plus once at mount — never read on
	 * a schedule, for exactly the reason explained on `MapCanvasOptions.isMirror`.
	 */
	setMirrorCamera(view: { zoom: number; x: number; y: number }): void {
		this.mirrorCamera = view;
		this.render();
	}

	/**
	 * Shows an expanding, fading ring at a world position for `PING_DURATION_MS` — "look here",
	 * triggered by a plain click (see `onPointerUp`) and echoed to a player mirror via
	 * `MapCanvasOptions.onPing`/`MirrorSource.onPing` (also called directly on a mirror's own canvas
	 * once it receives that echo — see `MapPlayerMirrorView`).
	 */
	triggerPing(x: number, y: number): void {
		this.activePing = { x, y, startedAt: performance.now() };
		if (this.pingAnimationFrameId !== null) return;
		const tick = () => {
			if (!this.activePing || performance.now() - this.activePing.startedAt >= PING_DURATION_MS) {
				this.activePing = null;
				this.pingAnimationFrameId = null;
				this.render();
				return;
			}
			this.render();
			this.pingAnimationFrameId = requestAnimationFrame(tick);
		};
		this.pingAnimationFrameId = requestAnimationFrame(tick);
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
		// Edit mode: zooming out is unrestricted.
		if (this.effectiveMode() !== "view") return ABS_MIN_ZOOM;
		const data = this.controller.getData();
		if (this.viewportW === 0 || this.viewportH === 0) return ABS_MIN_ZOOM;
		const bounds = this.computeVisibleImageBounds();
		if (!bounds || bounds.w <= 0 || bounds.h <= 0) return ABS_MIN_ZOOM;
		// View mode: never zoom out past the point where the image still covers the whole viewport
		// (the larger of the two ratios) — using the smaller ratio would let one axis "fit" while
		// leaving empty space beyond the image on the other. The per-map `minZoom` setting must not
		// clamp this *upward* past that either, or the map stops short of the image's edges.
		const coverZoom = Math.max(this.viewportW / bounds.w, this.viewportH / bounds.h);
		return clamp(coverZoom, ABS_MIN_ZOOM, data.maxZoom);
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
		if (this.pingAnimationFrameId !== null) cancelAnimationFrame(this.pingAnimationFrameId);
		if (this.pathAnimationFrameId !== null) cancelAnimationFrame(this.pathAnimationFrameId);
		this.resizeObserver.disconnect();
		if (!this.isMirror) {
			this.canvas.removeEventListener("pointerdown", this.onPointerDown);
			this.canvas.removeEventListener("pointermove", this.onPointerMove);
			this.canvas.removeEventListener("pointerup", this.onPointerUp);
			this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
			this.canvas.removeEventListener("dblclick", this.onDoubleClick);
			this.canvas.removeEventListener("wheel", this.onWheel);
			this.canvas.removeEventListener("contextmenu", this.onContextMenu);
		}
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
		return fogEffectiveCellSize(this.controller.getData());
	}

	/**
	 * A cell's actual on-screen width, for both grid types: a square's edge (already scaled by
	 * `effectiveCellSize`) and a hex's flat-to-flat width both equal `cellSize * SQUARE_CELL_SCALE`
	 * — hex functions just take the raw circumradius (`cellSize`) as their size parameter, so this
	 * needs its own scale-up rather than reusing `effectiveCellSize`. Used for anything sized
	 * "relative to the cell" regardless of grid type (tokens, vision range).
	 */
	private cellVisualWidth(): number {
		return fogCellVisualWidth(this.controller.getData());
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
		return fogCellCenter(this.controller.getData(), key);
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
		const fogActive = this.entitiesHiddenByFog();
		const tokens = data.tokens;
		for (let i = tokens.length - 1; i >= 0; i--) {
			const token = tokens[i];
			if (!token) continue;
			if (this.isLightTokenHiddenFromMirror(token)) continue;
			const center = this.footprintCenter(token);
			if (Math.hypot(world.x - center.x, world.y - center.y) > this.tokenRadius(token)) continue;
			const isPlayer = (token.category ?? "entity") === "player";
			if (fogActive && !isPlayer && !this.isEntityRevealedByFog(center)) continue;
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

	/** Closest committed `WallSegment` whose line passes within `WALL_SEGMENT_HIT_SCREEN_PX` of the screen point, or `null` — used both to select a segment (for its own type editor) and to insert a mid-point on it (see the `dblclick` handler). */
	private findWallSegmentAtScreenPoint(px: number, py: number): WallSegment | null {
		const world = screenToWorld(px, py, this.transform);
		const data = this.controller.getData();
		const tolerance = WALL_SEGMENT_HIT_SCREEN_PX / this.transform.zoom;
		for (let li = data.layers.length - 1; li >= 0; li--) {
			const layer = data.layers[li];
			if (!layer?.visible) continue;
			const pointsById = new Map(layer.wallPoints.map((p) => [p.id, p]));
			for (let i = layer.wallSegments.length - 1; i >= 0; i--) {
				const segment = layer.wallSegments[i];
				if (!segment) continue;
				const a = pointsById.get(segment.aId);
				const b = pointsById.get(segment.bId);
				if (!a || !b) continue;
				const proj = projectOntoSegment(world.x, world.y, a, b);
				if (Math.hypot(world.x - proj.x, world.y - proj.y) <= tolerance) return segment;
			}
		}
		return null;
	}

	/**
	 * Nearest point on any existing wall segment's line within `WALL_SEGMENT_HIT_SCREEN_PX`, or
	 * `null` — lets a wall-tool click land squarely on another wall (a T-junction the point-crossing
	 * reconciliation in `MapController.addWallSegment` then treats as "joined a wall") instead of a
	 * fraction of a pixel off it. Used by `resolveWallPlacement`, both for the live preview and the
	 * actual commit — the join itself only happens once `commitWallPoint` runs; this is just where
	 * the point gets snapped to.
	 */
	private snapToWallSegmentLine(px: number, py: number): { x: number; y: number } | null {
		const world = screenToWorld(px, py, this.transform);
		const data = this.controller.getData();
		const tolerance = WALL_SEGMENT_HIT_SCREEN_PX / this.transform.zoom;
		let best: { x: number; y: number } | null = null;
		let bestDist = tolerance;
		for (const layer of data.layers) {
			if (!layer.visible) continue;
			const pointsById = new Map(layer.wallPoints.map((p) => [p.id, p]));
			for (const segment of layer.wallSegments) {
				const a = pointsById.get(segment.aId);
				const b = pointsById.get(segment.bId);
				if (!a || !b) continue;
				const proj = projectOntoSegment(world.x, world.y, a, b);
				const dist = Math.hypot(world.x - proj.x, world.y - proj.y);
				if (dist <= bestDist) {
					best = proj;
					bestDist = dist;
				}
			}
		}
		return best;
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
	 * an existing point first (closes a shape / continues from a shared node), else onto an existing
	 * wall's line (a T-junction — see `snapToWallSegmentLine`), else onto the grid via
	 * `snapWorldToGrid`, else the raw clicked position.
	 */
	private resolveWallPlacement(px: number, py: number): { x: number; y: number; existingPointId?: string } {
		const hit = this.findWallPointAtScreenPoint(px, py);
		if (hit) return { x: hit.x, y: hit.y, existingPointId: hit.id };
		const onSegment = this.snapToWallSegmentLine(px, py);
		if (onSegment) return onSegment;
		return this.snapWorldToGrid(screenToWorld(px, py, this.transform));
	}

	/** Every `WallSegment` (across visible layers) resolved to world-space endpoints, for ray casting and the fill tool's flood boundary. */
	private resolveWallSegments(): ResolvedWallSegment[] {
		return fogResolveWallSegments(this.controller.getData());
	}

	/**
	 * "Seau à murs": runs `detectColorRegionWalls` from the clicked world point and, if it found a
	 * candidate wall network, opens `ColorRegionWallsModal` for the user to confirm before anything is
	 * actually written to the map (`MapController.applyMagicWalls` — the same merge step "Murs
	 * magiques" uses, since both produce the same `WallPoint[]`/`WallSegment[]` shape). The bucket
	 * tool stays armed afterward, like the shape picker does, so filling several rooms in a row
	 * doesn't need re-arming it from the toolbar each time. Guard conditions (no background image,
	 * grid type "none", region too large) are all just thrown `Error`s from `detectColorRegionWalls`
	 * with an already user-facing French message — shown as-is.
	 */
	private async runColorRegionWalls(world: { x: number; y: number }): Promise<void> {
		if (this.colorRegionWallsRunning) return;
		this.colorRegionWallsRunning = true;
		try {
			const activeLayer = this.controller.getActiveLayer();
			const result = await detectColorRegionWalls(this.app, this.controller.getData(), activeLayer, this.controller.wallDrawBlockerType, world);
			if (!result) {
				new Notice("Impossible de délimiter une zone à cet endroit (couleur hors image, ou zone transparente).");
				return;
			}
			new ColorRegionWallsModal(this.app, result, () => {
				this.controller.applyMagicWalls(result.wallPoints, result.wallSegments);
				const count = result.wallSegments.length;
				new Notice(`${count} mur${count > 1 ? "s" : ""} ajouté${count > 1 ? "s" : ""} autour de la zone.`);
			}).open();
		} catch (e) {
			console.error("Map Manager: échec du seau à murs", e);
			new Notice(e instanceof Error ? e.message : "Échec de la détection de la zone.");
		} finally {
			this.colorRegionWallsRunning = false;
		}
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

	/** Places a token at a specific screen point (edit-mode right-click menu) rather than the viewport center. */
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
		return fitsOnScreen && (this.effectiveMode() === "edit" || this.controller.showCells);
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
		if (this.options.forceFog) return this.controller.playerMirrorFogEnabled;
		const data = this.controller.getData();
		return data.fogEnabled && this.controller.mode === "view";
	}

	/**
	 * Whether fog should currently hide *entity* tokens from view (`findTokenAtScreenPoint`/
	 * `tokensInRect`/`drawTokens`) — unlike the fog overlay itself (`fogCurrentlyVisible`, which the
	 * GM's own canvas also draws, so they can track explored/unexplored ground and player vision),
	 * entity-hiding only ever applies on the actual player-facing mirror canvas (`isMirror`, see
	 * `MapPlayerMirrorView`): the GM always sees every entity token on their own canvas regardless of
	 * fog, player vision, or `lightRadius`.
	 */
	private entitiesHiddenByFog(): boolean {
		return this.isMirror && this.fogCurrentlyVisible();
	}

	/**
	 * A "light" category token is a pure light fixture, never a piece on the board — invisible on the
	 * player-facing mirror canvas unconditionally (fog on or off, lit or not, unlike an entity's own
	 * fog-gated visibility), while still fully visible/selectable on the GM's own canvas so it can be
	 * placed and moved. Its `lightRadius` effect itself is unaffected either way — this only gates the
	 * token's own on-canvas marker (`drawTokens`/`findTokenAtScreenPoint`/`tokensInRect`).
	 */
	private isLightTokenHiddenFromMirror(token: Token): boolean {
		return this.isMirror && (token.category ?? "entity") === "light";
	}

	/**
	 * The active fog tremble mode right now: the setting has to be something other than "none", and
	 * zoom can't be out past `FOG_ANIMATION_MIN_ZOOM` — the animation loop forcing a render every
	 * frame while zoomed out that far is the one combination that's shown fog visibly breaking near
	 * the edges, so it's disabled there as a hard safety net regardless of the exact cause.
	 */
	private activeFogAnimationMode(): FogAnimationMode {
		if (this.settings.fogAnimationMode === "none" || this.transform.zoom < FOG_ANIMATION_MIN_ZOOM) return "none";
		return this.settings.fogAnimationMode;
	}

	/**
	 * Keeps a `requestAnimationFrame` loop running for as long as (and only while) fog is visible
	 * and animations are actually active (see `activeFogAnimationMode`), so the vision edge's subtle
	 * tremble (see `appendVisionFan`) keeps redrawing; otherwise fog is static and this never fires,
	 * costing nothing when the setting is "none" (its default) or zoomed out too far.
	 */
	private syncFogAnimationLoop(): void {
		const shouldAnimate = this.activeFogAnimationMode() !== "none" && this.fogCurrentlyVisible();
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
		const tool = this.effectiveMode() === "edit" ? this.controller.activeTool : "none";
		this.canvas.toggleClass("is-brush-tool", tool === "brush");
		this.canvas.toggleClass("is-fill-tool", tool === "fill");
		this.canvas.toggleClass("is-wall-tool", tool === "wall");
		this.canvas.toggleClass("is-select-tool", tool === "select");
	}

	render(): void {
		if (this.viewportW === 0 || this.viewportH === 0) return;
		this.updateCursor();
		this.ensureBackgroundsLoaded();
		this.ensureTokenImagesLoaded();

		if (!this.isMirror && !this.hasAutoFramed) {
			const loadedBounds = this.computeVisibleImageBounds();
			if (loadedBounds && loadedBounds.w > 0 && loadedBounds.h > 0) {
				this.applyFraming();
				this.hasAutoFramed = true;
			}
		}

		const imageBounds = this.effectiveMode() === "view" ? this.computeVisibleImageBounds() : null;
		const minZoom = this.getEffectiveMinZoom();
		if (this.isMirror && this.mirrorCamera) {
			// A mirror re-derives its own pan/zoom from the source's last-pushed world-space camera
			// (center + zoom, see `setMirrorCamera`) rather than copying raw panX/panY — those are
			// meaningless across differently sized canvases (screenX = worldX*zoom + panX is anchored
			// to *this* canvas's own top-left, not a shared center). Its zoom is never allowed below
			// its OWN cover zoom (computed from its own viewport/aspect ratio) even if the source is
			// zoomed out further — otherwise a mirror with a different aspect ratio than the source
			// could show empty space beyond the image edges once the source hits its own minimum zoom.
			const source = this.mirrorCamera;
			const zoom = clamp(Math.max(source.zoom, minZoom), minZoom, this.controller.getData().maxZoom);
			this.transform = {
				zoom,
				panX: this.viewportW / 2 - source.x * zoom,
				panY: this.viewportH / 2 - source.y * zoom,
			};
		} else if (!this.isMirror) {
			this.transform.zoom = clamp(this.transform.zoom, minZoom, this.controller.getData().maxZoom);
		}
		if (imageBounds) this.clampPanToBounds(imageBounds);

		const dpr = window.devicePixelRatio || 1;
		const ctx = this.ctx;
		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, this.viewportW, this.viewportH);

		ctx.translate(this.transform.panX, this.transform.panY);
		ctx.scale(this.transform.zoom, this.transform.zoom);

		// Computed up front (rather than alongside the fog overlay itself, further down) so
		// `drawWallShadowBlackout` below — and thus `drawBackgrounds`/`drawGridAndCells` — can already
		// use this frame's live vision reach, not just last frame's.
		if (this.fogCurrentlyVisible()) {
			const wallSegments = this.resolveWallSegments();
			// A player token currently mid "Animation" tween (`currentAnimatedPose`) casts from its live
			// interpolated position/facing instead of its still-uncommitted `cellKey`/`x,y`/`rotation` —
			// otherwise fog would only ever unlock once the whole move commits, well after the tween
			// that's supposed to be revealing it as it goes has already finished playing.
			this.frameVisionCache = this.controller
				.getData()
				.tokens.filter((t) => (t.category ?? "entity") === "player")
				.map((t) => this.castRaysForToken(t, wallSegments, this.currentAnimatedPose(t.id) ?? undefined));
			// Any token, any category, with an effective light radius > 0 — see `frameLightCache`'s own doc comment.
			this.frameLightCache = this.controller
				.getData()
				.tokens.filter((t) => resolveLightRadius(t) > 0)
				.map((t) => this.castLightRaysForToken(t, wallSegments, this.currentAnimatedPose(t.id) ?? undefined));
		} else {
			this.frameVisionCache = [];
			this.frameLightCache = [];
		}

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

		// Patches solid black back over content drawn right above, but only within a margin of an
		// actual wall and only where fog wouldn't otherwise reveal it — see the method doc. Away from
		// any wall, `drawBackgrounds`/`drawGridAndCells` above are left completely untouched, so open
		// territory keeps exactly its original smooth vision-cone look with no masking artifacts.
		if (this.fogCurrentlyVisible()) this.drawWallShadowBlackout(ctx, dpr, imageBounds);

		const noGrid = this.controller.getData().gridType === "none";
		if (noGrid) this.drawMarkers(ctx);
		this.drawWalls(ctx);

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

		// GM's own window always shows this tactical hint; a player-mirror window only shows it while
		// the GM has explicitly toggled it on (see `MapController.showEntityVisionToPlayers` and the
		// player-window dropdown in `Toolbar`) — hidden there by default.
		if (!this.isMirror || this.controller.showEntityVisionToPlayers) this.drawTokenVisionZones(ctx);

		this.drawTokens(ctx);
		if (cellsVisible || noGrid || this.controller.selectedWallPointId) this.drawSelection(ctx);
		// The edit-mode select tool always wants the overlay (marquee mid-drag, or nothing selected
		// yet); view mode needs it either once there's an actual token mass selection to outline, or
		// while a fresh Shift-drag marquee is being drawn (that live rectangle must show up even
		// before anything's been added to the selection — see `drawMassSelectionOverlay`'s own
		// `marqueeWorld` handling at the bottom).
		if (this.controller.activeTool === "select" || this.controller.massSelectedTokenIds.size > 0 || this.marqueeWorld) this.drawMassSelectionOverlay(ctx);
		this.drawDistributePreview(ctx);
		this.drawWallPreview(ctx);
		this.drawPathPreview(ctx);
		if (this.activePing) this.drawPing(ctx);

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
					if (cell?.zoneTypeId) this.fillZone(ctx, this.settings.defaultZoneTypes, cell.zoneTypeId, () => ctx.rect(x, y, cellSize, cellSize));
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
					if (cell?.zoneTypeId) this.fillZone(ctx, this.settings.defaultZoneTypes, cell.zoneTypeId, drawPath);
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
	 * Traces every ray outward from a player token's center against `wallSegments` — see
	 * `castVisionRays` in `../grid/fog.ts` for the actual (canvas-agnostic) ray tracing.
	 *
	 * These reaches are the *true* vision extent: they gate what counts as lit for gameplay
	 * (`isLitByCache`) and what gets permanently written to fog memory (`markExplored`). The
	 * tremble animation must never perturb them — an earlier version wobbled `reach` here, which
	 * meant every outward wobble peak got permanently baked into explored memory (since a bucket
	 * once marked explored stays marked), slowly and permanently growing the explored area for as
	 * long as the animation ran, worse the more zoomed out (a larger wobble/reach ratio) — a lasting
	 * corruption, not a rendering glitch, hence surviving after the zoom/animation stopped. The
	 * tremble is now applied only in `appendVisionFan`, purely to the drawn shape.
	 *
	 * `pose`, when given (see `currentAnimatedPose`), casts from that live interpolated
	 * position/facing instead of the token's own committed data — and always recomputes rather than
	 * reading/writing `playerVisionRaysCache`, since that cache is keyed on `MapController.dataVersion`
	 * alone, which doesn't change while a tween is merely in flight (nothing's committed yet) and so
	 * would otherwise just keep returning the pre-tween rays for every frame of the animation.
	 */
	private castRaysForToken(token: Token, wallSegments: ResolvedWallSegment[], pose?: { center: Point; direction: number }): PlayerVisionRays {
		if (pose) return { ...castVisionRays(this.controller.getData(), token, wallSegments, pose), phase: tremblePhase(token.id) };
		const version = this.controller.dataVersion;
		const cached = this.playerVisionRaysCache.get(token.id);
		const { center, rays } =
			cached && cached.version === version ? cached.result : castVisionRays(this.controller.getData(), token, wallSegments);
		if (!cached || cached.version !== version) this.playerVisionRaysCache.set(token.id, { version, result: { center, rays } });
		return { center, rays, phase: tremblePhase(token.id) };
	}

	/** Same idea as `castRaysForToken`, for a token's `lightRadius` reach (`castLightRays`, any category) — see `drawTokenLightZones`/`drawFog`'s `frameLightCache` use. */
	private castLightRaysForToken(token: Token, wallSegments: ResolvedWallSegment[], pose?: { center: Point; direction: number }): PlayerVisionRays {
		if (pose) return { ...castLightRays(this.controller.getData(), token, wallSegments, pose), phase: tremblePhase(token.id) };
		const version = this.controller.dataVersion;
		const cached = this.lightRaysCache.get(token.id);
		const { center, rays } = cached && cached.version === version ? cached.result : castLightRays(this.controller.getData(), token, wallSegments);
		if (!cached || cached.version !== version) this.lightRaysCache.set(token.id, { version, result: { center, rays } });
		return { center, rays, phase: tremblePhase(token.id) };
	}

	/** Same idea as `castRaysForToken`, for one of an entity's `resolveEyeCones` cones — see `drawEntityEyeCones`. */
	private castEntityConeVision(token: Token, direction: number, fullAngleDeg: number, wallSegments: ResolvedWallSegment[]): PlayerVisionRays {
		const version = this.controller.dataVersion;
		const key = `${token.id}|${direction}|${fullAngleDeg}`;
		const cached = this.entityConeRaysCache.get(key);
		const { center, rays } =
			cached && cached.version === version ? cached.result : castEntityConeRays(this.controller.getData(), token, direction, fullAngleDeg, wallSegments);
		if (!cached || cached.version !== version) this.entityConeRaysCache.set(key, { version, result: { center, rays } });
		return { center, rays, phase: tremblePhase(token.id) };
	}

	/**
	 * Appends one token's vision fan (a closed polygon through its ray endpoints) to `path`. The
	 * tremble (`mode`) is applied only to this drawn shape, never to `rays` themselves — see the
	 * comment on `castRaysForToken` for why baking it into the actual reach caused lasting corruption.
	 *
	 * `inset` (world units, default 0) pulls every ray's endpoint inward by that much before anything
	 * else — used only by `drawFog`'s own crisp shapes (see the comment there) to keep the blur applied
	 * afterward from ever visibly bleeding past a ray's *true* reach; every other caller (GM tactical
	 * previews, `buildRevealedPath`) leaves it at 0, the real, unshrunk reach.
	 */
	private appendVisionFan(path: Path2D, vision: PlayerVisionRays, useDim: boolean, mode: FogAnimationMode, time: number, inset = 0): void {
		const { center, rays, phase } = vision;
		let started = false;
		for (let i = 0; i < rays.length; i++) {
			const ray = rays[i];
			if (!ray) continue;
			const angle = (360 / rays.length) * i;
			const rad = (angle * Math.PI) / 180;
			let dist = Math.max(0, (useDim ? ray.dimEnd : ray.clearEnd) - inset);
			if (mode !== "none" && dist > 0) {
				// Fixed screen-pixel amplitude (divided by zoom) so it stays equally visible at any
				// zoom, capped to a fraction of `dist` so it can't push the drawn point past the
				// center (dividing a fixed px amount by a shrinking zoom is unbounded on its own).
				const wobblePx = Math.min(FOG_TREMBLE_SCREEN_PX / this.transform.zoom, dist * 0.3);
				if (mode === "advanced") {
					// Sum of a few mismatched angular harmonics (integer multiples of `rad` — integer
					// so the closed fan shape still lines up seamlessly at the 0/360 wrap, no seam)
					// at different speeds and phases, instead of "simple"'s single traveling wave (one
					// direction, one speed for the whole edge — see the `else` branch, unchanged).
					// Summing mismatched harmonics makes different lobes of the fan edge bulge and
					// recede on their own schedule rather than one ripple sweeping uniformly around it.
					dist +=
						wobblePx *
						(Math.sin(time * 1.3 + rad * 3 + phase) * 0.5 +
							Math.sin(time * 0.8 + rad * 7 + phase * 1.7) * 0.3 +
							Math.sin(time * 1.9 + rad * 13 + phase * 2.3) * 0.2);
				} else {
					dist += wobblePx * Math.sin(time * FOG_TREMBLE_SPEED + angle * 0.11 + phase);
				}
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
		return isPointLit(cache, worldX, worldY, useDim);
	}

	/**
	 * Whether an entity token at `center` should be shown despite fog: the ordinary raycast reach
	 * (`isLitByCache` against `frameVisionCache`, walls included), or simply standing within any
	 * player token's own "rayon exploré" (`visionRadius`) — a straight-line distance check, walls or
	 * not, so something right next to a player is always noticed even through a partial wall the
	 * raycast rule itself would otherwise still dim/block at a distance — or standing within any
	 * token's (any category) traced `lightRadius` reach (`isLitByCache` against `frameLightCache`),
	 * which unlike the other two *does* stop at a wall (see `castLightRays`). Callers still gate this
	 * on `fogActive` and `!isPlayer` themselves — see `drawTokens`/`findTokenAtScreenPoint`/`tokensInRect`.
	 */
	private isEntityRevealedByFog(center: { x: number; y: number }): boolean {
		if (this.isLitByCache(this.frameVisionCache, center.x, center.y, false)) return true;
		if (this.isLitByCache(this.frameLightCache, center.x, center.y, false)) return true;
		const cellSize = this.cellVisualWidth();
		for (const player of this.controller.getData().tokens) {
			if ((player.category ?? "entity") !== "player") continue;
			const playerCenter = this.currentAnimatedPose(player.id)?.center ?? this.footprintCenter(player);
			const radius = (player.visionRadius ?? DEFAULT_VISION_RADIUS) * cellSize;
			if (Math.hypot(center.x - playerCenter.x, center.y - playerCenter.y) <= radius) return true;
		}
		return false;
	}

	/** Translucent fill color for a player token's own vision-cone preview — see `drawTokenVisionZones`. */
	private static readonly PLAYER_VISION_ZONE_COLOR = "rgba(37, 99, 235, 0.28)";

	/**
	 * An entity eye cone's 3 tiers (see `resolveEyeCones`), listed widest-to-narrowest — the order
	 * `drawEntityEyeCones` draws them in, so the narrower/sharper tiers layer visibly on top of the
	 * wider/dimmer ones instead of underneath. Same red hue throughout, rising alpha per tier reads
	 * as a gradient of "how well the entity actually makes you out" rather than one flat wash.
	 */
	private static readonly ENTITY_EYE_TIERS: { key: "monocularAngle" | "binocularAngle" | "detectionAngle"; alpha: number }[] = [
		{ key: "monocularAngle", alpha: 0.1 },
		{ key: "binocularAngle", alpha: 0.16 },
		{ key: "detectionAngle", alpha: 0.28 },
	];

	/**
	 * Normally a GM-only tactical hint: a token's own vision cone(s), drawn as translucent colored
	 * zone(s) so the GM can preview exactly what a token would notice without touching the real fog
	 * system at all: this never feeds `isLitByCache` (so it doesn't affect which entities the fog
	 * itself renders) and never calls `markExplored` (so it can't leak into a player's explored
	 * memory). The call site in `render` excludes the player-mirror window by default
	 * (`isMirror`/`forceFog`), the one canvas real players actually see, except when the GM has
	 * explicitly opted in via the player-window dropdown (`MapController.showEntityVisionToPlayers`)
	 * — a mirror is always in "view" mode (see `effectiveMode`), so it only ever reaches the "every
	 * entity" branch below, never a selected token's own zone (see the "Public viewer" section of
	 * CLAUDE.md on why in-Obsidian "view" mode is otherwise still GM-only).
	 *
	 * In edit mode specifically, only the *selected* token's own zone is drawn, regardless of
	 * category — with every token's zone shown at once, a map with more than a couple of tokens
	 * placed turns into a wash of overlapping color; a player's cone is also otherwise invisible in
	 * edit mode (the real fog only ever renders in "view" mode, see `fogCurrentlyVisible`), so this
	 * is the only way to preview it there at all. In "view" mode (live play, not actively
	 * placing/editing tokens) every entity's zone shows continuously instead, since there's no
	 * selection concept driving that same clutter there — a player's cone doesn't need the same
	 * treatment in "view" mode since the real fog overlay already shows it for free there.
	 *
	 * The two categories draw entirely differently below: a player token keeps the single blue cone
	 * this always drew (`castVisionRays`, `dimEnd` — reaches past a "dim"/partial wall, matching what
	 * its real fog memory would eventually show once explored); an entity token instead draws both of
	 * `resolveEyeCones`'s cones via `drawEntityEyeCones`, each using `clearEnd` — an entity has no
	 * fog-memory concept, so a "partial" wall stops its sight exactly like an opaque one. Either
	 * category also gets `drawTokenLightZones`'s amber wall-aware fan underneath when it has a
	 * `lightRadius` set — see `Token.lightRadius`/`isEntityRevealedByFog`/`drawFog`'s `frameLightCache`
	 * use for the actual reveal rule this previews.
	 */
	private drawTokenVisionZones(ctx: CanvasRenderingContext2D): void {
		const wallSegments = this.resolveWallSegments();

		if (this.effectiveMode() === "edit") {
			const selected = this.controller.getData().tokens.find((t) => t.id === this.controller.selectedTokenId);
			if (!selected) return;
			this.drawTokenLightZones([selected], wallSegments, ctx);
			const category = selected.category ?? "entity";
			// "light" tokens have no vision/eye-cone shape of their own — only `drawTokenLightZones`
			// above applies to them (see `Token.category`'s doc comment).
			if (category === "entity") {
				this.drawEntityEyeCones([selected], wallSegments, ctx);
			} else if (category === "player") {
				const path = new Path2D();
				this.appendVisionFan(path, this.castRaysForToken(selected, wallSegments), true, "none", 0);
				ctx.fillStyle = MapCanvas.PLAYER_VISION_ZONE_COLOR;
				ctx.fill(path);
			}
			return;
		}

		const allTokens = this.controller.getData().tokens;
		this.drawTokenLightZones(allTokens, wallSegments, ctx);
		this.drawEntityEyeCones(
			allTokens.filter((t) => (t.category ?? "entity") === "entity"),
			wallSegments,
			ctx
		);
	}

	/** Translucent fill color for a token's own `lightRadius` preview — warm/amber, distinct from the vision-cone red/blue so it reads as "light" rather than "sight". */
	private static readonly TOKEN_LIGHT_ZONE_COLOR = "rgba(250, 204, 21, 0.2)";

	/**
	 * Wall-aware (`castLightRaysForToken`/`castLightRays`, blocked by opaque and "dim" walls alike)
	 * fan preview of every `tokens` token's `lightRadius`, any category — batched into a single
	 * `Path2D`/fill regardless of how many tokens are on screen, same as `drawEntityEyeCones`. Tokens
	 * with no light radius set contribute nothing. This is the exact shape `drawFog` also punches
	 * through the real fog overlay for (see `frameLightCache`), just drawn as a GM preview instead —
	 * live-tracking a token's `currentAnimatedPose` during an in-flight move the same way.
	 */
	private drawTokenLightZones(tokens: Token[], wallSegments: ResolvedWallSegment[], ctx: CanvasRenderingContext2D): void {
		const path = new Path2D();
		let any = false;
		for (const token of tokens) {
			if (resolveLightRadius(token) <= 0) continue;
			any = true;
			const vision = this.castLightRaysForToken(token, wallSegments, this.currentAnimatedPose(token.id) ?? undefined);
			this.appendVisionFan(path, vision, false, "none", 0);
		}
		if (!any) return;
		ctx.fillStyle = MapCanvas.TOKEN_LIGHT_ZONE_COLOR;
		ctx.fill(path);
	}

	/**
	 * Draws every one of `tokens`'s eye cones (see `resolveEyeCones` — 2 cones per token, mirrored
	 * around its facing by `sideEyeAngle` and collapsing onto a single visible cone when that's 0,
	 * each carrying its own 3-tier angle set sharing the token's own `visionRange`/`visionRadius`) as
	 * layered translucent wedges — see `ENTITY_EYE_TIERS`. One Path2D per tier, batched across every
	 * cone of every token, so each tier costs a single `ctx.fill` regardless of how many entities are
	 * on screen, same batching the old single-path per-category fill used.
	 */
	private drawEntityEyeCones(tokens: Token[], wallSegments: ResolvedWallSegment[], ctx: CanvasRenderingContext2D): void {
		if (tokens.length === 0) return;
		for (const { key, alpha } of MapCanvas.ENTITY_EYE_TIERS) {
			const path = new Path2D();
			for (const token of tokens) {
				for (const cone of resolveEyeCones(token)) {
					this.appendVisionFan(path, this.castEntityConeVision(token, cone.direction, cone[key], wallSegments), false, "none", 0);
				}
			}
			ctx.fillStyle = `rgba(220, 38, 38, ${alpha})`;
			ctx.fill(path);
		}
	}

	/** World-space rectangle currently on screen, used to bound the fog-memory bucket scan. */
	private visibleWorldRect(): { minX: number; minY: number; maxX: number; maxY: number } {
		const tl = screenToWorld(0, 0, this.transform);
		const br = screenToWorld(this.viewportW, this.viewportH, this.transform);
		return { minX: Math.min(tl.x, br.x), minY: Math.min(tl.y, br.y), maxX: Math.max(tl.x, br.x), maxY: Math.max(tl.y, br.y) };
	}

	private fogBucketSize(): number {
		return fogFogBucketSize(this.controller.getData());
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
	 * Everything this frame considers explored-or-lit at all, as two different shapes unioned
	 * together, each matching what it represents — used only to subtract from `drawWallShadowBlackout`
	 * below, never drawn on its own:
	 *
	 * - Persisted "ever explored" memory has no shape of its own worth preserving (it's just "has a
	 *   token been here"), so it's built one whole grid cell at a time (a cell's center decides the
	 *   *entire* cell, revealed cells getting their own real square/hex shape) instead of off the
	 *   fog's own independent bucket grid — the memory boundary then always lands exactly on a grid
	 *   line instead of cutting across cells wherever a fog bucket happens to fall. Grid type "none"
	 *   has no visible cells to align to, so it falls back to that same bucket grid fog memory is
	 *   actually stored on (see `fogBucketSize`) — the hidden square substrate fog still runs on
	 *   there (see `MapController.updateCell`) has no on-screen lines to visibly misalign with.
	 * - Current live vision keeps its natural round/fan shape: the same precise, ungridded polygon
	 *   `drawFog` itself traces (`appendVisionFan`, unanimated) — snapping *this* part to cells too
	 *   would stair-step the field of view's own outline along the grid instead of leaving it smooth.
	 * - Current `lightRadius` reach (`frameLightCache`) is unioned in the same way as vision, for the
	 *   same reason: a wall standing at the edge of a lit-but-not-actually-seen area still needs its
	 *   shadow patch skipped there, or the blackout would visibly punch a hole back into the light.
	 *
	 * Deliberately independent of `drawFog`'s own drawing (no jitter/tremble, no `markExplored` side
	 * effect — that stays `drawFog`'s alone).
	 */
	private buildRevealedPath(): Path2D {
		const data = this.controller.getData();
		const exploredSet = this.controller.getExploredSet();
		const isExplored = (worldX: number, worldY: number) => fogIsWorldPointExplored(exploredSet, data, worldX, worldY);

		const path = new Path2D();

		if (data.gridType === "none") {
			const rect = this.visibleWorldRect();
			const tile = this.fogIterationBucketSize(rect);
			const margin = tile * 2;
			const bx0 = Math.floor((rect.minX - margin) / tile);
			const bx1 = Math.ceil((rect.maxX + margin) / tile);
			const by0 = Math.floor((rect.minY - margin) / tile);
			const by1 = Math.ceil((rect.maxY + margin) / tile);
			for (let by = by0; by <= by1; by++) {
				for (let bx = bx0; bx <= bx1; bx++) {
					const worldX = bx * tile + tile / 2;
					const worldY = by * tile + tile / 2;
					if (isExplored(worldX, worldY)) path.rect(bx * tile, by * tile, tile, tile);
				}
			}
		} else {
			const cellSize = this.effectiveCellSize();
			if (data.gridType === "square") {
				for (const c of getVisibleSquareCells(this.transform, cellSize, this.viewportW, this.viewportH)) {
					const x = c.a * cellSize;
					const y = c.b * cellSize;
					if (isExplored(x + cellSize / 2, y + cellSize / 2)) path.rect(x, y, cellSize, cellSize);
				}
			} else {
				const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
				for (const c of getVisibleHexCells(this.transform, cellSize, orientation, this.viewportW, this.viewportH)) {
					const center = hexCellToWorldCenter(c.a, c.b, cellSize, orientation);
					if (!isExplored(center.x, center.y)) continue;
					const corners = hexCorners(center.x, center.y, cellSize, orientation);
					corners.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
					path.closePath();
				}
			}
		}

		for (const vision of this.frameVisionCache) this.appendVisionFan(path, vision, true, "none", 0);
		// A wall standing inside a light's own (already wall-blocked) reach must not get its shadow
		// patch redrawn over that same light — see `frameLightCache`.
		for (const vision of this.frameLightCache) this.appendVisionFan(path, vision, true, "none", 0);
		return path;
	}

	/**
	 * Patches solid black back over `drawBackgrounds`/`drawGridAndCells`'s own output, one cell wide
	 * (`cellVisualWidth`, so it visually reads as "the one grid square straddling the wall" rather
	 * than an unrelated-looking band) and centered on each actual wall segment, wherever
	 * `buildRevealedPath` doesn't already reveal it. Everywhere else — any open territory not near a
	 * wall at all — this touches nothing, leaving the original content exactly as drawn. Deliberately a
	 * fixed world-space (i.e. grid-relative) size — it never grows or shrinks on its own as the view is
	 * zoomed, same as the grid itself.
	 *
	 * A `stroke()` hugging every wall segment, then punched through wherever already revealed, patches
	 * that band back to opaque black — unblurred, so blurring *this* patch's own edges afterward can't
	 * reopen a leak. Keeping the blurred fog tint itself from ever bleeding *past* a wall in the first
	 * place (rather than growing this patch to chase it) is `drawFog`'s job — see the inset there.
	 *
	 * Drawn into `fogCanvas`/`fogCtx` (idle at this point in `render()` — `renderFogLayer` further
	 * down starts by clearing and resizing it fresh for its own, unrelated use) and blitted back with
	 * the same world-rect-to-buffer-rect technique the fog overlay's own final blit uses, just without
	 * that blit's blur or overdraw margin — nothing here is filtered, so there's no blur radius that
	 * needs real pixels past the viewport's own edge to sample from.
	 */
	private drawWallShadowBlackout(ctx: CanvasRenderingContext2D, dpr: number, imageBounds: { x: number; y: number; w: number; h: number } | null): void {
		const wallSegments = this.resolveWallSegments();
		if (wallSegments.length === 0) return;

		const rect = this.visibleWorldRect();
		const w = Math.max(1, Math.round(this.viewportW * dpr));
		const h = Math.max(1, Math.round(this.viewportH * dpr));
		if (this.fogCanvas.width !== w || this.fogCanvas.height !== h) {
			this.fogCanvas.width = w;
			this.fogCanvas.height = h;
		}

		const fctx = this.fogCtx;
		fctx.save();
		fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		fctx.clearRect(0, 0, this.viewportW, this.viewportH);
		fctx.translate(this.transform.panX, this.transform.panY);
		fctx.scale(this.transform.zoom, this.transform.zoom);

		fctx.lineCap = "round";
		fctx.lineJoin = "round";
		fctx.strokeStyle = "rgba(8, 8, 12, 1)";
		fctx.lineWidth = this.cellVisualWidth();
		fctx.beginPath();
		for (const seg of wallSegments) {
			fctx.moveTo(seg.a.x, seg.a.y);
			fctx.lineTo(seg.b.x, seg.b.y);
		}
		fctx.stroke();

		fctx.globalCompositeOperation = "destination-out";
		fctx.fillStyle = "rgba(0, 0, 0, 1)";
		fctx.fill(this.buildRevealedPath());
		fctx.restore();

		ctx.save();
		if (imageBounds) {
			ctx.beginPath();
			ctx.rect(imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h);
			ctx.clip();
		}
		ctx.drawImage(this.fogCanvas, rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
		ctx.restore();
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
	 * Scales a pair of insets eroding a tile's two *opposite* edges (e.g. west/east) down together,
	 * only when they'd otherwise overlap and flip the tile's width negative — a narrow corridor or an
	 * isolated tile facing unexplored space on both opposite sides at once, the one case where the
	 * fixed anti-bleed margin (`erosionInset` in `drawFog`, deliberately *not* capped on its own — see
	 * the comment there) is large enough relative to the tile to fully erase it. Left untouched
	 * (`[a, b]` unchanged) whenever there's room, which is the ordinary case — most eroded tiles border
	 * unexplored space on only one side, where the full margin was never at risk of collapsing
	 * anything and shrinking it would only needlessly weaken the anti-bleed protection near a real
	 * boundary (a wall, most importantly). A small floor (`span * 0.1`) is always left standing rather
	 * than letting the scale reach exactly 0, so a corridor thins down to a sliver instead of
	 * disappearing outright.
	 */
	private fitOpposingInsets(a: number, b: number, span: number): [number, number] {
		const avail = Math.max(0, span * 0.9);
		const sum = a + b;
		if (sum <= avail) return [a, b];
		const scale = avail / sum;
		return [a * scale, b * scale];
	}

	/**
	 * Renders fog as: a coarse "ever explored" memory layer (square buckets, independent of grid
	 * type/shape — see `FOG_BUCKET_SCALE`), with each player's traced vision fan punched out on top
	 * (fully lit within `clearEnd`, dimmed-but-visible out to `dimEnd`), then every token's
	 * `lightRadius` fan (`frameLightCache`) punched fully transparent on top of *that* — a light
	 * hides the fog exactly like being seen would, but deliberately never joins `newlyExplored` below,
	 * so it never gets written to `exploredCells`: unlike real vision, its reveal is temporary and
	 * disappears the moment the light source moves on or its `lightRadius` drops back to 0 (see
	 * `Token.lightRadius`'s own doc comment). No per-grid-cell shape work. Draws onto the offscreen
	 * fog buffer (see `renderFogLayer`), never the main canvas directly.
	 */
	private drawFog(ctx: CanvasRenderingContext2D, rect: { minX: number; minY: number; maxX: number; maxY: number }): void {
		const exploredSet = this.controller.getExploredSet();
		const cache = this.frameVisionCache;
		const lightCache = this.frameLightCache;
		const baseBucket = this.fogBucketSize();
		const tile = this.fogIterationBucketSize(rect);
		const mode = this.activeFogAnimationMode();
		const animate = mode !== "none";
		const time = animate ? performance.now() / 1000 : 0;
		// A fixed screen-pixel amplitude, converted to world units by the current zoom, so the
		// tremble stays equally visible at any zoom instead of shrinking away when zoomed out (a
		// world-space amplitude like "a fraction of the tile size" shrinks on screen right along
		// with everything else once zoom drops, which read as "the animation stops"). Capped to a
		// fraction of `tile` so it can never exceed a sane range at extreme zoom.
		//
		// In "simple" mode this is a *single* offset applied uniformly to every tile's drawn
		// position (not each tile's own size — see `jitterX`/`jitterY` below); in "advanced" mode
		// each tile instead samples smooth spatial noise (see `organicJitter2D`) so different
		// patches of the frontier drift independently instead of the whole boundary moving in
		// lockstep. Neither mode touches which world point is sampled for the persisted-memory
		// lookup a few lines down. Perturbing each tile's own rect *size* (an earlier version of
		// this) could shrink a tile to zero or negative at extreme/changing zoom, which is what
		// actually broke near the edges; a position-only shift can't do that, and keeping the memory
		// lookup itself un-jittered means resetting fog has no bearing on the animation — it's
		// purely cosmetic.
		const jitterAmplitude = animate ? Math.min(FOG_MEMORY_TREMBLE_SCREEN_PX / this.transform.zoom, tile * 0.4) : 0;
		const sharedJitterX = jitterAmplitude * Math.sin(time * FOG_TREMBLE_SPEED * 0.7);
		const sharedJitterY = jitterAmplitude * Math.cos(time * FOG_TREMBLE_SPEED * 0.9);
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

		// One extra ring of tiles all around, purely so every tile actually drawn below can look up
		// whether each of its 4 neighbors is revealed too (see `erosionInset` below) — including the
		// ones right at bx0/bx1/by0/by1's own edge, whose outward neighbor sits just outside that
		// range. `margin` (2 whole tiles) already comfortably covers the one extra ring this costs.
		const gbx0 = bx0 - 1;
		const gbx1 = bx1 + 1;
		const gby0 = by0 - 1;
		const gby1 = by1 + 1;
		const gridCols = gbx1 - gbx0 + 1;
		const revealedGrid = new Uint8Array(gridCols * (gby1 - gby0 + 1));
		const gridIndex = (bx: number, by: number) => (by - gby0) * gridCols + (bx - gbx0);

		const exploredPath = new Path2D();
		let hasExplored = false;
		const newlyExplored: string[] = [];

		for (let by = gby0; by <= gby1; by++) {
			for (let bx = gbx0; bx <= gbx1; bx++) {
				const worldX = bx * tile + tile / 2;
				const worldY = by * tile + tile / 2;
				// Persisted memory always keys off the fine `baseBucket` grid regardless of how
				// coarse `tile` got — a single sample at the tile's center is close enough once
				// tiles are this much bigger than a base bucket anyway.
				const key = `${Math.floor(worldX / baseBucket)},${Math.floor(worldY / baseBucket)}`;
				const already = exploredSet.has(key);
				const litNow = !already && this.isLitByCache(cache, worldX, worldY, true);
				// Only the tiles actually drawn below (not this loop's extra lookup-only ring) ever
				// get persisted — see the comment on `gbx0`/`gbx1`/`gby0`/`gby1` above.
				if (litNow && bx >= bx0 && bx <= bx1 && by >= by0 && by <= by1) newlyExplored.push(key);
				if (already || litNow) revealedGrid[gridIndex(bx, by)] = 1;
			}
		}
		const isRevealedTile = (bx: number, by: number) => revealedGrid[gridIndex(bx, by)] === 1;

		// A revealed tile's edge is eroded inward by roughly the blur radius (world units, so it
		// shrinks back down as the view zooms in) wherever it faces a tile that *isn't* revealed —
		// same reasoning as `dimInset` below: the blur applied to this whole buffer afterward then has
		// nowhere near that boundary left to visibly bleed light past. An edge shared with another
		// revealed tile is left untouched, so two neighboring revealed tiles always keep touching
		// seamlessly (no artificial grid lines cutting across an already fully-explored room).
		//
		// Deliberately *not* capped relative to `tile`: this is the same fixed screen-pixel margin
		// wherever it's applied, on purpose — a wall (or any other genuine unexplored boundary) needs
		// that full margin to keep the blur from visibly bleeding past it regardless of how coarse the
		// memory tile grid happens to be at the current zoom. Weakening it broadly (e.g. capping it to
		// a fraction of `tile`) was tried and made *that* leak worse — it doesn't just affect the rare
		// tile eroded on two opposite sides, it also shrinks the margin on the far more common tile
		// eroded on only one side, where there was never any risk of collapsing to begin with. Only the
		// two-opposite-sides case (a corridor/isolated tile narrower than twice this margin) needs
		// scaling down, and `fitOpposingInsets` below does that alone, per axis, only when it's
		// actually needed to keep the tile from vanishing — see its own doc comment.
		const erosionInset = FOG_LEAK_INSET_PX / this.transform.zoom;

		for (let by = by0; by <= by1; by++) {
			for (let bx = bx0; bx <= bx1; bx++) {
				if (!isRevealedTile(bx, by)) continue;
				hasExplored = true;
				const worldX = bx * tile + tile / 2;
				const worldY = by * tile + tile / 2;
				// "simple": every tile of the explored/unexplored frontier shifts together a
				// little (rather than only the vision fan near a token), so the whole fog
				// boundary feels alive. "advanced": each tile instead samples smooth spatial
				// noise (see `organicJitter2D`) at its own world position, so different zones of
				// fog drift independently instead of the whole frontier moving as one block.
				let jitterX = sharedJitterX;
				let jitterY = sharedJitterY;
				// In "advanced" mode, neighboring tiles can end up with slightly different
				// offsets (that's the point — see above), which would otherwise crack open a
				// sliver of raw unexplored-opacity fog between them right at their shared edge.
				// `organicJitter2D` is built to keep that difference far smaller than
				// `jitterAmplitude` between adjacent tiles, but inflating every tile by that same
				// amplitude on all sides guarantees neighbors always overlap regardless, so nothing
				// in this loop depends on exactly how smooth the noise turns out to be. "simple"
				// needs none of this: one shared offset moves every tile identically, so adjacent
				// tiles never separate in the first place.
				let overlap = 0;
				if (mode === "advanced") {
					const n = organicJitter2D(worldX, worldY, time);
					jitterX = jitterAmplitude * n.x;
					jitterY = jitterAmplitude * n.y;
					overlap = jitterAmplitude;
				}
				const left = bx * tile + jitterX - overlap;
				const right = (bx + 1) * tile + jitterX + overlap;
				const top = by * tile + jitterY - overlap;
				const bottom = (by + 1) * tile + jitterY + overlap;
				const westInset = isRevealedTile(bx - 1, by) ? 0 : erosionInset;
				const eastInset = isRevealedTile(bx + 1, by) ? 0 : erosionInset;
				const northInset = isRevealedTile(bx, by - 1) ? 0 : erosionInset;
				const southInset = isRevealedTile(bx, by + 1) ? 0 : erosionInset;
				const [insetW, insetE] = this.fitOpposingInsets(westInset, eastInset, right - left);
				const [insetN, insetS] = this.fitOpposingInsets(northInset, southInset, bottom - top);
				const x0 = left + insetW;
				const x1 = right - insetE;
				const y0 = top + insetN;
				const y1 = bottom - insetS;
				exploredPath.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
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
			// `dimFan`'s outer edge is the one that meets the opaque unexplored base right below —
			// pulling it inward by a bit more than the blur's own radius means the blur (applied to
			// this whole buffer afterward, in `renderFogLayer`) has nowhere near a wall/max-range edge
			// left to visibly bleed light *past* — its outward half of the softening now lands back on
			// roughly the true boundary instead of beyond it, at the cost of that same softening now
			// eating into the fan's own edge instead (a harmless vignette, since that's still legitimate,
			// already-revealed territory). `clearFan` gets the identical inset so it stays strictly
			// inside `dimFan` (dim reach is never shorter than clear reach — see `fog.ts` — so the same
			// subtraction preserves that ordering); insetting only one of the two would let the other
			// stick out past it and carve its own separate leak through the base layer.
			const dimInset = FOG_LEAK_INSET_PX / this.transform.zoom;
			for (const vision of cache) {
				this.appendVisionFan(dimFan, vision, true, mode, time, dimInset);
				this.appendVisionFan(clearFan, vision, false, mode, time, dimInset);
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

		if (lightCache.length > 0) {
			// A single tier, always fully see-through — unlike a player's own vision, a light source
			// has no "explored/dim" memory tint to fall back to once it moves on: it's either
			// currently reaching a point or it isn't. Same anti-bleed `dimInset` idea as the vision fan
			// above, so a wall-blocked light's own blurred edge can't visibly bleed past the wall it
			// already stopped at (`castLightRays`).
			const lightFan = new Path2D();
			const lightInset = FOG_LEAK_INSET_PX / this.transform.zoom;
			for (const vision of lightCache) this.appendVisionFan(lightFan, vision, false, mode, time, lightInset);
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = "rgba(0, 0, 0, 1)";
			ctx.fill(lightFan);
		}
		ctx.restore();

		// `newlyExplored`/`markExplored` are driven only by `cache` (real player vision) above — never
		// by `lightCache` — so a light source hides the fog for as long as it's around without ever
		// writing to `exploredCells` (see `Token.lightRadius`'s own doc comment).
		if (newlyExplored.length > 0) this.controller.markExplored(newlyExplored);
	}

	private drawTokens(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		const fogActive = this.entitiesHiddenByFog();
		const group = this.draggingTokenGroup;
		const groupIds = group ? new Set(group.entries.map((e) => e.token.id)) : null;
		const animatingIds = this.pathAnimation ? new Set(this.pathAnimation.routes.map((r) => r.tokenId)) : null;
		for (const token of data.tokens) {
			if (this.draggingToken?.token.id === token.id) continue;
			if (groupIds?.has(token.id)) continue;
			if (animatingIds?.has(token.id)) continue;
			if (this.isLightTokenHiddenFromMirror(token)) continue;
			const isPlayer = (token.category ?? "entity") === "player";
			const center = this.footprintCenter(token);
			if (fogActive && !isPlayer && !this.isEntityRevealedByFog(center)) continue;
			this.drawToken(ctx, center.x, center.y, token, token.id === this.controller.selectedTokenId);
		}
		if (this.draggingToken) {
			const { token, currentWorld } = this.draggingToken;
			this.drawToken(ctx, currentWorld.x, currentWorld.y, token, true);
		}
		if (group) {
			const dx = group.currentWorld.x - group.pointerDownWorld.x;
			const dy = group.currentWorld.y - group.pointerDownWorld.y;
			for (const entry of group.entries) {
				this.drawToken(ctx, entry.originWorld.x + dx, entry.originWorld.y + dy, entry.token, true);
			}
		}
		// "Animation" token movement mode: drawn at each route's current interpolated position/facing
		// (see `startPathAnimation`) rather than the token's own still-uncommitted `cellKey`/`x,y` —
		// same "override the render, leave the data alone until it's dropped" precedent as
		// `draggingToken`/`draggingTokenGroup` above, including ignoring fog (a GM sees their own
		// in-flight move regardless — see those two for the same choice).
		if (this.pathAnimation) {
			for (const route of this.pathAnimation.routes) {
				const token = data.tokens.find((t) => t.id === route.tokenId);
				const pose = this.currentAnimatedPose(route.tokenId);
				if (!token || !pose) continue;
				this.drawToken(ctx, pose.center.x, pose.center.y, { ...token, rotation: pose.direction }, true);
			}
		}
	}

	/**
	 * Center of a token's footprint. On square grids, a token with size > 1 occupies a
	 * size×size block growing down and right from its anchor cell, so it never overlaps
	 * any cell outside that block. Hex grids have no such block concept, so the token is
	 * simply centered (and enlarged) on its single anchor cell.
	 */
	private footprintCenter(token: Token): { x: number; y: number } {
		return fogFootprintCenter(this.controller.getData(), token);
	}

	/**
	 * `token`'s live interpolated position/facing if it's currently mid an "Animation" token-movement
	 * tween (`pathAnimation`), else `null` — a single source of truth for "where does this token
	 * actually read as being *right now*, tween or not", shared by the token's own draw call, the fog
	 * vision cache (`frameVisionCache`, so it unlocks fog as the tween runs rather than only once it
	 * commits), and `isEntityRevealedByFog`'s proximity check (so a moving player also reveals nearby
	 * entities live, not just once it stops).
	 */
	private currentAnimatedPose(tokenId: string): { center: Point; direction: number } | null {
		const route = this.pathAnimation?.routes.find((r) => r.tokenId === tokenId);
		if (!route) return null;
		const elapsed = performance.now() - (this.pathAnimation?.startedAt ?? 0);
		const arc = clamp(elapsed * (this.pathAnimation?.speedWorldPerMs ?? 0), 0, route.totalLength);
		const center = pointAtArcLength(route.points, route.cumulative, arc);
		const token = this.controller.findToken(tokenId);
		const direction = directionAtArcLength(route.points, route.cumulative, arc) ?? token?.rotation ?? 0;
		return { center, direction };
	}

	private tokenRadius(token: Token): number {
		return this.cellVisualWidth() * (token.size ?? 1) * TOKEN_SIZE_RATIO;
	}

	/** Fixed glyph/color for every "light" category token's own marker — see `drawLightToken`. */
	private static readonly LIGHT_TOKEN_ICON = "💡";
	private static readonly LIGHT_TOKEN_FILL = "rgba(250, 204, 21, 0.92)";
	private static readonly LIGHT_TOKEN_BORDER = "#a16207";

	/**
	 * A "light" category token's own on-canvas marker — GM canvas only, see
	 * `isLightTokenHiddenFromMirror`/`drawTokens` for why it never reaches here on the player-facing
	 * mirror. Deliberately ignores every per-token customization `drawToken` would otherwise draw
	 * (`icon`/`image`/`label`/`color`/`rotation`): a light token has none of those to configure to
	 * begin with (see `Token.category`'s own doc comment on why it's the one category with nothing to
	 * set beyond `lightRadius`), so its marker is always this same fixed glyph.
	 */
	private drawLightToken(ctx: CanvasRenderingContext2D, cx: number, cy: number, token: Token, selected: boolean): void {
		const r = this.tokenRadius(token);
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fillStyle = MapCanvas.LIGHT_TOKEN_FILL;
		ctx.fill();
		ctx.lineWidth = selected ? Math.max(2.5, 4 / this.transform.zoom) : Math.max(1.5, 2.5 / this.transform.zoom);
		ctx.strokeStyle = selected ? lightenColor(MapCanvas.LIGHT_TOKEN_BORDER, 0.55) : MapCanvas.LIGHT_TOKEN_BORDER;
		ctx.stroke();
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillStyle = "#000000";
		ctx.font = `${Math.max(10, r * 2 * 0.42)}px sans-serif`;
		ctx.fillText(MapCanvas.LIGHT_TOKEN_ICON, cx, cy);
	}

	private drawToken(ctx: CanvasRenderingContext2D, cx: number, cy: number, token: Token, selected: boolean): void {
		if ((token.category ?? "entity") === "light") {
			this.drawLightToken(ctx, cx, cy, token, selected);
			return;
		}
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

		drawTokenFacingArrow(ctx, cx, cy, r, token.rotation ?? 0, selected ? lightenColor(baseColor, 0.55) : baseColor);

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
		const showHandles =
			this.effectiveMode() === "edit" &&
			(this.controller.activeTool === "wall" || this.controller.selectedWallPointId !== null || this.controller.selectedWallSegmentId !== null);
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
		if (this.effectiveMode() !== "edit" || this.controller.activeTool !== "wall" || !this.wallPreview) return;

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

	/** The "Animation" mode's in-progress path trace (`drawingPath`) — a dashed line, own color so it doesn't read as a wall (see `drawWallPreview`, same dash/line-width scaling conventions). */
	private drawPathPreview(ctx: CanvasRenderingContext2D): void {
		const points = this.drawingPath?.points;
		if (!points || points.length < 2) return;
		ctx.save();
		ctx.strokeStyle = "rgba(37, 99, 235, 0.9)";
		ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
		ctx.setLineDash([Math.max(3, 6 / this.transform.zoom), Math.max(3, 6 / this.transform.zoom)]);
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		ctx.beginPath();
		points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
		ctx.stroke();
		ctx.restore();
	}

	/** An expanding, fading ring at `activePing`'s position — see `triggerPing`. */
	private drawPing(ctx: CanvasRenderingContext2D): void {
		if (!this.activePing) return;
		const t = clamp((performance.now() - this.activePing.startedAt) / PING_DURATION_MS, 0, 1);
		const maxRadius = this.cellVisualWidth() * 2.2;
		const alpha = 1 - t;
		ctx.save();
		ctx.lineWidth = Math.max(2, 4 / this.transform.zoom);
		ctx.strokeStyle = `rgba(255, 205, 45, ${alpha})`;
		ctx.beginPath();
		ctx.arc(this.activePing.x, this.activePing.y, maxRadius * t, 0, Math.PI * 2);
		ctx.stroke();
		// A second, smaller ring lagging behind the first for a "ripple" feel.
		const innerT = Math.max(0, t - 0.3);
		if (innerT > 0) {
			ctx.strokeStyle = `rgba(255, 205, 45, ${alpha * 0.7})`;
			ctx.beginPath();
			ctx.arc(this.activePing.x, this.activePing.y, maxRadius * innerT, 0, Math.PI * 2);
			ctx.stroke();
		}
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
		const selectedWallSegment = this.controller.getSelectedWallSegment();
		if (selectedWallSegment) {
			const layer = data.layers.find((l) => l.wallSegments.some((s) => s.id === selectedWallSegment.id));
			const a = layer?.wallPoints.find((p) => p.id === selectedWallSegment.aId);
			const b = layer?.wallPoints.find((p) => p.id === selectedWallSegment.bId);
			if (a && b) {
				const aPos = this.wallPointPosition(a);
				const bPos = this.wallPointPosition(b);
				ctx.lineWidth = Math.max(3, 5 / this.transform.zoom);
				ctx.strokeStyle = "#e0a020";
				ctx.beginPath();
				ctx.moveTo(aPos.x, aPos.y);
				ctx.lineTo(bPos.x, bPos.y);
				ctx.stroke();
			}
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

	/**
	 * Outlines every mass-selected object (see `MassSelectionKind`) using the same amber highlight
	 * `drawSelection` uses for a single selection, plus the live marquee drag rectangle itself.
	 */
	private drawMassSelectionOverlay(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		ctx.save();
		ctx.strokeStyle = "#e0a020";
		ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);

		for (const tokenId of this.controller.massSelectedTokenIds) {
			const token = data.tokens.find((t) => t.id === tokenId);
			if (!token) continue;
			const center = this.footprintCenter(token);
			ctx.beginPath();
			ctx.arc(center.x, center.y, this.tokenRadius(token) + 3 / this.transform.zoom, 0, Math.PI * 2);
			ctx.stroke();
		}

		if (this.controller.massSelectedWallSegmentIds.size > 0) {
			ctx.lineWidth = Math.max(3, 5 / this.transform.zoom);
			for (const layer of data.layers) {
				const pointsById = new Map(layer.wallPoints.map((p) => [p.id, p]));
				for (const segment of layer.wallSegments) {
					if (!this.controller.massSelectedWallSegmentIds.has(segment.id)) continue;
					const a = pointsById.get(segment.aId);
					const b = pointsById.get(segment.bId);
					if (!a || !b) continue;
					ctx.beginPath();
					ctx.moveTo(a.x, a.y);
					ctx.lineTo(b.x, b.y);
					ctx.stroke();
				}
			}
			ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
		}

		if (this.controller.massSelectedCellKeys.size > 0 && data.gridType !== "none") {
			const cellSize = this.effectiveCellSize();
			for (const key of this.controller.massSelectedCellKeys) {
				const { a, b } = parseCellKey(key);
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

		if (this.controller.massSelectedMarkerIds.size > 0) {
			const radius = this.markerHitRadius();
			for (const layer of data.layers) {
				for (const marker of layer.markers) {
					if (!this.controller.massSelectedMarkerIds.has(marker.id)) continue;
					ctx.beginPath();
					ctx.arc(marker.x, marker.y, radius, 0, Math.PI * 2);
					ctx.stroke();
				}
			}
		}

		ctx.restore();

		if (this.marqueeWorld && this.dragMoved) {
			const rect = this.normalizedWorldRect(this.marqueeWorld.start, this.marqueeWorld.current);
			ctx.save();
			ctx.fillStyle = "rgba(224, 160, 32, 0.12)";
			ctx.strokeStyle = "#e0a020";
			ctx.lineWidth = Math.max(1, 1.5 / this.transform.zoom);
			ctx.setLineDash([Math.max(3, 6 / this.transform.zoom), Math.max(3, 6 / this.transform.zoom)]);
			ctx.beginPath();
			ctx.rect(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
			ctx.fill();
			ctx.stroke();
			ctx.restore();
		}
	}

	/**
	 * The Ctrl-drag "distribute the selection into this area" gesture's live feedback. Deliberately
	 * doesn't draw a bounding rectangle (that would read as a free-floating destination box,
	 * independent of the grid) — instead it directly highlights every cell actually painted so far
	 * (see `distributePaint`), exactly like `massSelectedCellKeys`' own cell outlines, all white
	 * ("fits") or all red ("won't fit" — see `recomputeDistributePreview`). Shown from the very first
	 * painted cell, even before `dragMoved` — a plain Ctrl+click that never turns into a drag clears
	 * both fields before the next render, so nothing lingers. Grid type "none" has no cells to
	 * highlight, so it falls back to one dot per token's proposed landing point instead.
	 */
	private drawDistributePreview(ctx: CanvasRenderingContext2D): void {
		if (!this.distributePaint || !this.distributePreview) return;
		const preview = this.distributePreview;
		const fillStyle = preview.valid ? "rgba(224, 160, 32, 0.28)" : "rgba(192, 57, 43, 0.28)";
		const strokeStyle = preview.valid ? "#e0a020" : "#c0392b";

		ctx.save();
		ctx.fillStyle = fillStyle;
		ctx.strokeStyle = strokeStyle;
		ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);

		if (preview.cellKeys) {
			const data = this.controller.getData();
			const cellSize = this.effectiveCellSize();
			for (const key of preview.cellKeys) {
				const { a, b } = parseCellKey(key);
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
				ctx.fill();
				ctx.stroke();
			}
		} else {
			const dotRadius = Math.max(4, this.cellVisualWidth() * 0.12);
			for (const p of preview.points) {
				ctx.beginPath();
				ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2);
				ctx.fill();
				ctx.stroke();
			}
		}
		ctx.restore();
	}
}

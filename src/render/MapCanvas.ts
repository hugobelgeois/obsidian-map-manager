import { App, Menu, Notice } from "obsidian";
import { MapController, MapMode, MassSelectionKind } from "../controller/MapController";
import { getTokenClipboard, hasTokenClipboard, parseClipboardTokens, serializeClipboardTokens, setTokenClipboard } from "../controller/tokenClipboard";
import { MapManagerSettings } from "../settings/types";
import { DEFAULT_TOKEN_COLOR, Token, configuredLightRadius, hexKey, isCellEmpty, parseCellKey, squareKey, wallPassableWithInteract } from "../data/mapData";
import { drawTokenFacingArrow } from "./drawing";
import { detectColorRegionWalls } from "../platform/detectColorRegionWalls";
import { ColorRegionWallsModal } from "../ui/ColorRegionWallsModal";
import { FogRenderer } from "./FogRenderer";
import { HitTester } from "./HitTester";
import { MapDrawer } from "./MapDrawer";
import { DraggingMarker, DraggingWallPoint, ImageBounds } from "./canvasTypes";
import {
	ABS_MIN_ZOOM,
	Point,
	ViewTransform,
	clamp,
	directionAtArcLength,
	hexCellToWorldCenter,
	hexCorners,
	pointAtArcLength,
	polylineCumulativeLengths,
	screenToWorld,
	segmentIntersection,
	truncatePolyline,
	wallShapeCorners,
	worldToScreen,
} from "../grid/gridMath";
import { ResolvedWallSegment, cellVisualWidth, footprintCellKeys, occupiedFootprintCells, resolveWallSegments as fogResolveWallSegments } from "../grid/fog";
import { GamepadInputPoller } from "../controller/gamepadInput";

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
/** Below this on-screen cell size (in px), the grid/cell overlay auto-hides until zoomed back in. */
const MIN_CELL_PIXELS = 12;
/** Gamepad-driven token movement (see `GamepadInputPoller`/`handleGamepadMove`): how long a single-cell "jump" hop (`cellHops`) takes, ms — quick enough to keep up with a direction held down and auto-repeating. */
const CELL_HOP_DURATION_MS = 180;
/** How high (as a fraction of a cell's width) a "jump" hop arcs upward at its midpoint — see `currentHopPose`. */
const CELL_HOP_HEIGHT_RATIO = 0.35;
/** "Centrer" player-mirror camera mode (see `computeFitCamera`/`MapPlayerMirrorView`): the tightest player-token bounding box is padded by this factor so tokens don't sit flush against the viewport edges. */
const CENTER_CAMERA_PADDING_RATIO = 1.4;
/** "Centrer" player-mirror camera mode: minimum framed extent, in cells, so a single token (or a tight cluster) doesn't zoom in absurdly close. */
const CENTER_CAMERA_MIN_CELLS = 6;

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

/** Mixes a #rrggbb color toward white by `ratio` (0 = unchanged, 1 = white). Used for the selected-token border. */
function lightenColor(hex: string, ratio: number): string {
	const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
	if (!match || !match[1] || !match[2] || !match[3]) return hex;
	const mix = (channel: string) => Math.round(parseInt(channel, 16) + (255 - parseInt(channel, 16)) * ratio);
	return `rgb(${mix(match[1])}, ${mix(match[2])}, ${mix(match[3])})`;
}

interface DraggingToken {
	token: Token;
	currentWorld: { x: number; y: number };
}

/** A multi-selected group of tokens being dragged together, either mode — see `MapCanvas.startGroupDrag`/`commitGroupDrag`. */
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

/**
 * One token's in-flight gamepad-driven "jump" hop, purely cosmetic — by the time this starts,
 * `MapController.moveToken` has already committed the token's new `cellKey` (see `handleGamepadMove`),
 * same "draw the tween, not yet the commit" idea as `pathAnimation`/`draggingToken`, just for a single
 * step instead of a whole gesture. `from`/`to` are the two cells' centers in world space.
 */
interface CellHopState {
	from: Point;
	to: Point;
	startedAt: number;
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
	/** Called whenever a gamepad-driven "jump" hop starts (`startCellHop`, from `handleGamepadMove`) so a mirror can replay it visually via `playCellHopEcho` — the hop is purely cosmetic (the actual move already committed to `MapController` by the time this fires), so a mirror wouldn't otherwise see anything but the token instantly snapping to its new cell. */
	onCellHop?: (tokenId: string, from: Point, to: Point) => void;
	/** Called on every poll tick the gamepad's right stick reports a "look" angle (or `null` once it returns to center — see `GamepadCallbacks.onAim`) so a mirror can replay the same live facing override via `playAimEcho` — `aimOverrides` is purely local render state, never itself a `MapController` mutation, so a mirror wouldn't otherwise see it at all until the eventual commit-on-release. */
	onAim?: (tokenId: string, angleDeg: number | null) => void;
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

	/** Ray casting, fog compositing, and the GM-only vision/light zone preview — see `FogRenderer`. */
	private fog: FogRenderer;
	/** Screen-space hit-testing and cell/token coordinate conversions — see `HitTester`. */
	private hit: HitTester;
	/** Static grid/wall/marker drawing — no dependency on this canvas's own drag/gesture state — see `MapDrawer`. */
	private drawer: MapDrawer;

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

	/** Ctrl+mousedown only, both modes: whatever object (if any) sat directly under the pointer — resolved into a toggle on a plain ctrl+click, or just dropped in favor of the distribute-paint drag (tokens only) once the drag exceeds `DRAG_THRESHOLD`. See `handleMassSelectCtrlPointerDown`. */
	private massSelectCtrlHit: { kind: MassSelectionKind; id: string } | null = null;
	/**
	 * The live marquee rectangle (world space) while dragging — `null` outside a marquee drag. Shift
	 * held down, either mode — see `onPointerDown`'s `e.shiftKey` branch. See `onPointerMove`/
	 * `drawMassSelectionOverlay`.
	 */
	private marqueeWorld: { start: { x: number; y: number }; current: { x: number; y: number } } | null = null;

	/** A token's whole selected group being dragged together, preserving relative offsets, either mode — see `startGroupDrag`/`commitGroupDrag`. */
	private draggingTokenGroup: DraggingTokenGroup | null = null;
	/**
	 * "Distribute the selection into this area" (ctrl+drag, either mode) — works like the brush tool,
	 * painting whatever cell the pointer is over into the area as the drag moves (any resulting shape,
	 * not just a rectangle), rather than dragging out a bounding box. `cellKeys` accumulates every
	 * distinct cell painted so far (celled grids); `points` accumulates the raw pointer path (grid
	 * type "none", which has no cells to paint — see `recomputeDistributePreview`'s proportional-remap
	 * branch). `null` outside that gesture. See `handleMassSelectCtrlPointerDown`/`recomputeDistributePreview`.
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

	/** Continuously polls connected gamepads and turns a held direction into "move one step" calls (`handleGamepadMove`) — view mode only in effect (see the check inside), but always running so a direction held while switching into view mode doesn't fire immediately. `null` for a mirror canvas (see the constructor) — a mirror never drives token movement, only reflects it. */
	private gamepadPoller: GamepadInputPoller | null = null;
	/** In-flight gamepad-triggered "jump" hops, keyed by token id — see `CellHopState`/`startCellHop`/`drawTokens`. */
	private cellHops: Map<string, CellHopState> = new Map();
	/** Non-null while any `cellHops` entry is actively re-rendering every frame — same pattern as `pingAnimationFrameId`. */
	private cellHopFrameId: number | null = null;
	/**
	 * Live right-stick "look" override, keyed by token id — see `handleGamepadAim`/`drawTokens`. Purely
	 * local render state, never touching `MapController` while the stick is actively held (unlike
	 * `cellHops`, this isn't a tween with a natural end — committing it to real data on every poll tick
	 * would flood the undo stack and rebuild the InfoPanel's DOM up to 60×/s); only committed via a
	 * single ordinary `MapController.updateToken` call once the stick returns to center.
	 */
	private aimOverrides: Map<string, number> = new Map();

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

		// "Placer un pion ici" is always on offer, so this always overrides the browser's own context
		// menu — unlike `showContextMenu`'s "Coller ici", which depends on an async clipboard read.
		e.preventDefault();
		void this.showContextMenu(e, px, py);
	};

	/**
	 * Builds and shows the right-click menu — split out from `onContextMenu` (which must call
	 * `e.preventDefault()` synchronously to suppress the browser's own menu) because deciding whether
	 * to offer "Coller ici" needs an async read of the real OS clipboard first, so it isn't shown for
	 * clipboard content that wouldn't actually paste anything (see `parseClipboardTokens`).
	 */
	private async showContextMenu(e: MouseEvent, px: number, py: number): Promise<void> {
		await this.refreshClipboardFromSystem();

		const menu = new Menu();
		// Placing a tampon is map-structure — edit mode only — regardless of grid type; see `addStampAt`
		// for the grid-type-"none" (freeform `Marker`) vs. celled-grid (a cell's own `stamp` field) split.
		if (this.controller.mode === "edit") {
			menu.addItem((item) => item.setTitle("Placer un tampon ici").setIcon("map-pin").onClick(() => this.addStampAt(px, py)));
		}
		// Tokens can be dropped in both modes — a GM adding a monster/NPC mid-session (view mode)
		// needs this as much as one building the map out (edit mode).
		menu.addItem((item) => item.setTitle("Placer un pion ici").setIcon("user").onClick(() => this.addTokenAt(px, py)));
		// Only offered once the clipboard refresh above found something valid to paste — see this
		// method's own doc.
		if (hasTokenClipboard()) {
			menu.addItem((item) => item.setTitle("Coller ici").setIcon("clipboard-paste").onClick(() => void this.pasteTokensAtScreenPoint(px, py)));
		}
		menu.showAtMouseEvent(e);
	}

	/**
	 * Refreshes the in-memory token clipboard (see `tokenClipboard.ts`) from the real OS clipboard, so
	 * a paste picks up tokens copied in a *previous* Obsidian session, or copied via Ctrl+C on a
	 * *different* open map, not just this same session's in-memory copy. Shared by `showContextMenu`
	 * (deciding whether to offer "Coller ici") and `pasteTokensAtWorldPoint` (the actual paste) — a
	 * soft failure (denied/unavailable clipboard: sandboxed webview, missing permission, mobile...)
	 * just leaves the in-memory clipboard as whatever it already was.
	 */
	private async refreshClipboardFromSystem(): Promise<void> {
		try {
			const text = await navigator.clipboard.readText();
			const tokens = parseClipboardTokens(text);
			if (tokens) setTokenClipboard(tokens);
		} catch (err) {
			console.warn("Map Manager: lecture du presse-papier système impossible, utilisation du presse-papier interne", err);
		}
	}

	private onPointerDown = (e: PointerEvent) => {
		// Grabs keyboard focus so Ctrl+C/Ctrl+V (see `onKeyDown`) work right after interacting with the
		// map, without an extra dedicated click just to focus it first. `preventScroll` avoids the
		// page jumping to bring the canvas into view — it's already what was just clicked.
		this.canvas.focus({ preventScroll: true });

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

		// Mass-select gestures (ctrl+click toggle / shift-drag marquee) take priority over the plain
		// token-drag/pan handling below, in both modes — but only while no drawing tool (brush/fill/
		// wall) is armed, same as brush/fill/wall themselves only ever apply in edit mode. Ctrl also
		// arms the "distribute the selection into this area" drag (see `handleMassSelectCtrlPointerDown`),
		// mutually exclusive with everything else a click could do.
		if (this.controller.activeTool === "none" && e.shiftKey) {
			const world = screenToWorld(px, py, this.transform);
			this.marqueeWorld = { start: world, current: world };
			return;
		}
		if (this.controller.activeTool === "none" && e.ctrlKey) {
			this.handleMassSelectCtrlPointerDown(px, py);
			return;
		}

		// Tokens are selectable and draggable/movable in both modes — unlike the grid/zones/walls,
		// pion placement isn't "map structure" reserved to edit mode.
		const tokenHit = this.hit.findTokenAtScreenPoint(px, py);

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
			// A token already part of a real (2+) multi-selection drags the whole group together;
			// otherwise this click starts fresh — any previous multi-selection is dropped so a plain
			// drag only ever moves the one token actually under the pointer. `onPointerUp` decides
			// between a plain click (select) and an actual drag (move) once `dragMoved` is known.
			if (this.controller.massSelectionKind === "token" && this.controller.massSelectedTokenIds.has(tokenHit.id) && this.controller.massSelectedTokenIds.size > 1) {
				this.startGroupDrag(tokenHit, px, py);
			} else {
				if (this.controller.massSelectedTokenIds.size > 0) this.controller.clearMassSelection();
				this.draggingToken = { token: tokenHit, currentWorld: screenToWorld(px, py, this.transform) };
			}
			return;
		}
		if (this.controller.mode === "view") return;

		const data = this.controller.getData();
		if (data.gridType === "none") {
			const hit = this.hit.findMarkerAtScreenPoint(px, py);
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
			const hitPoint = this.hit.findWallPointAtScreenPoint(px, py);
			if (hitPoint) {
				this.draggingWallPoint = { point: hitPoint, currentWorld: screenToWorld(px, py, this.transform) };
				return;
			}
			const hitSegment = this.hit.findWallSegmentAtScreenPoint(px, py);
			if (hitSegment) {
				this.pendingWallSegmentId = hitSegment.id;
				return;
			}
		}

		if (this.controller.activeTool === "brush") {
			this.painting = true;
			this.paintedInStroke = new Set();
			const world = screenToWorld(px, py, this.transform);
			const key = this.hit.cellKeyAt(world.x, world.y);
			this.lastPaintedKey = key;
			this.controller.beginHistoryGroup();
			this.paintBrushAt(key);
		} else if (this.controller.activeTool === "fill") {
			const world = screenToWorld(px, py, this.transform);
			const key = this.hit.cellKeyAt(world.x, world.y);
			this.fillFrom(key);
			this.toolConsumedClick = true;
		} else if (this.controller.activeTool === "wall") {
			if (this.controller.pendingWallBucket) {
				void this.runColorRegionWalls(screenToWorld(px, py, this.transform));
			} else {
				const placement = this.hit.resolveWallPlacement(px, py);
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
	 * Hit-tests token → wall segment → (marker on grid "none", else cell) in that priority, skipping a
	 * tier whose kind doesn't match an already-locked `massSelectionKind`. The "wallSegment" tier only
	 * applies in edit mode — walls aren't a selectable concept in Vue.
	 */
	private resolveSelectHit(px: number, py: number): { kind: MassSelectionKind; id: string } | null {
		const lockedKind = this.controller.massSelectionKind;
		if (!lockedKind || lockedKind === "token") {
			const token = this.hit.findTokenAtScreenPoint(px, py);
			if (token) return { kind: "token", id: token.id };
		}
		if (this.controller.mode === "edit" && (!lockedKind || lockedKind === "wallSegment")) {
			const segment = this.hit.findWallSegmentAtScreenPoint(px, py);
			if (segment) return { kind: "wallSegment", id: segment.id };
		}
		if (!lockedKind || lockedKind === "stamp") {
			const data = this.controller.getData();
			if (data.gridType === "none") {
				const marker = this.hit.findMarkerAtScreenPoint(px, py);
				if (marker) return { kind: "stamp", id: marker.id };
			} else {
				const world = screenToWorld(px, py, this.transform);
				return { kind: "stamp", id: this.hit.cellKeyAt(world.x, world.y) };
			}
		}
		return null;
	}

	/**
	 * Ctrl+mousedown, either mode: remembers whatever token/wall-segment/tampon (if any) is under the
	 * pointer, for a later toggle if this turns out to be a plain click (`handleDistributePointerUp`),
	 * and always starts a distribute-paint stroke too — immediately painting the cell right under the
	 * pointer, exactly like the brush tool's own `onPointerDown` paints its very first cell rather than
	 * waiting for the first `onPointerMove`. Harmless when the hit isn't a token or nothing's
	 * mass-selected yet: `recomputeDistributePreview`/`commitDistribute` only ever move
	 * `massSelectedTokenIds`, regardless of what tier was actually hit here.
	 */
	private handleMassSelectCtrlPointerDown(px: number, py: number): void {
		this.massSelectCtrlHit = this.resolveSelectHit(px, py);
		this.distributePaint = { cellKeys: new Set(), points: [], lastCellKey: null };
		this.paintDistributeCellAt(px, py);
		this.recomputeDistributePreview();
		this.render();
	}

	private onPointerMove = (e: PointerEvent) => {
		// Unlike brush/drag gestures, wall points/shape corners are placed one click at a time — the
		// live preview of the next one must track the pointer even while no button is held
		// (`!this.dragging`).
		if (this.controller.activeTool === "wall" && (this.controller.getWallChainTailId() || this.controller.getWallShapeFirstCorner())) {
			const rect = this.canvas.getBoundingClientRect();
			this.wallPreview = this.hit.resolveWallPlacement(e.clientX - rect.left, e.clientY - rect.top);
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
			const key = this.hit.cellKeyAt(world.x, world.y);
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
			if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= this.hit.cellVisualWidth() * PATH_SAMPLE_SPACING_RATIO) {
				this.drawingPath.points.push(world);
			}
			this.render();
			return;
		}

		if (!this.dragMoved) return;

		// The shift-drag marquee, either mode — just fills in `marqueeWorld` at pointer-down (see
		// `onPointerDown`).
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
			this.draggingWallPoint.currentWorld = this.hit.snapWorldToGrid(screenToWorld(px, py, this.transform));
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
		// deselecting/panning. Checked before `toolConsumedClick`/`painting` below. Re-does the same
		// hit-tests as `onPointerDown` rather than reading `draggingToken`/`draggingMarker` directly,
		// so this stays correct regardless of exactly which of those two ends up set for a given hit.
		// Right-click is excluded — that's `onContextMenu`'s job (placing a token there), not a ping.
		if (!this.dragMoved && e.button === 0 && !e.ctrlKey && !e.shiftKey && this.controller.mode === "view" && this.controller.activeTool === "none") {
			const rect = this.canvas.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const py = e.clientY - rect.top;
			const hitToken = this.hit.findTokenAtScreenPoint(px, py);
			const hitMarker = this.controller.getData().gridType === "none" ? this.hit.findMarkerAtScreenPoint(px, py) : null;
			if (!hitToken && !hitMarker) {
				// Genuinely empty space, no modifier: same "click clears" convention as the mass-select
				// marquee/toggle gestures (see `handleMarqueePointerUp`/`handleDistributePointerUp`), on
				// top of the existing ping.
				if (this.controller.massSelectedTokenIds.size > 0) this.controller.clearMassSelection();
				const world = screenToWorld(px, py, this.transform);
				this.triggerPing(world.x, world.y);
				this.options.onPing?.(world.x, world.y);
			}
		}

		if (this.marqueeWorld) {
			this.handleMarqueePointerUp();
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
					const targetKey = this.hit.dropAnchorKey(drag.token, drag.currentWorld.x, drag.currentWorld.y);
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
		this.cancelActiveGesture();
	};

	/** Drops whatever pointer gesture is currently in progress without committing anything — shared by `onPointerCancel` (losing pointer capture mid-gesture) and `handleEscape` (the same thing, keyboard-triggered). */
	private cancelActiveGesture(): void {
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
		this.massSelectCtrlHit = null;
		this.marqueeWorld = null;
		this.draggingTokenGroup = null;
		this.distributePaint = null;
		this.distributePreview = null;
		this.drawingPath = null;
	}

	/** Whether some pointer gesture is currently in progress — see `cancelActiveGesture`. Kept in sync with the fields `cancelActiveGesture` resets. */
	private hasActiveGesture(): boolean {
		return (
			this.dragging ||
			!!this.draggingToken ||
			!!this.draggingMarker ||
			!!this.draggingWallPoint ||
			!!this.pendingWallSegmentId ||
			this.painting ||
			!!this.massSelectCtrlHit ||
			!!this.marqueeWorld ||
			!!this.draggingTokenGroup ||
			!!this.distributePaint ||
			!!this.drawingPath
		);
	}

	/**
	 * Shift-drag marquee release, either mode: adds every matching-kind object inside the drag rect.
	 * If no kind is locked yet, tries tokens → wall segments (edit mode only), locking on the first
	 * tier with any hits — see `inferMarqueeKind`. Stamps can never be marquee-selected, even when a
	 * mass selection is already `"stamp"`-locked from earlier ctrl+clicks (one at a time is the only way
	 * to add to it — see `resolveSelectHit`/`handleMassSelectCtrlPointerDown`), since a marquee over
	 * painted zone cells would otherwise scoop up huge swaths of the grid at once. A plain shift-click
	 * with no drag is a no-op (ctrl+click is the dedicated single-object toggle gesture).
	 */
	private handleMarqueePointerUp(): void {
		const marquee = this.marqueeWorld;
		this.marqueeWorld = null;
		if (!marquee || !this.dragMoved) return;
		const rect = this.hit.normalizedWorldRect(marquee.start, marquee.current);
		const kind = this.controller.massSelectionKind ?? this.hit.inferMarqueeKind(rect);
		if (!kind || kind === "stamp") return;
		const ids = this.hit.idsInRect(kind, rect);
		if (ids.length > 0) this.controller.addMassSelection(kind, ids);
	}

	// ---- Mass-select (ctrl+click/shift-drag) / group move / distribute-into-area, either mode ----

	/** Paints whatever cell (or, on grid type "none", raw point) is at `(px, py)` into the in-progress `distributePaint` stroke — a no-op if it's the same cell already painted last. */
	private paintDistributeCellAt(px: number, py: number): void {
		const paint = this.distributePaint;
		if (!paint) return;
		const world = screenToWorld(px, py, this.transform);
		if (this.controller.getData().gridType === "none") {
			paint.points.push(world);
			return;
		}
		const key = this.hit.cellKeyAt(world.x, world.y);
		if (key === paint.lastCellKey) return;
		paint.lastCellKey = key;
		paint.cellKeys.add(key);
	}

	/**
	 * Ctrl+mouseup, either mode: a plain click toggles whatever `handleMassSelectCtrlPointerDown`
	 * resolved under the pointer (any kind — token/wall segment/tampon), or clears the whole selection
	 * if nothing was hit on grid type "none" (a celled grid has no "empty" click — every point belongs
	 * to some cell). A drag instead commits (or, if the preview turned red, rejects) the
	 * distribute-into-area gesture computed live by `recomputeDistributePreview` — always token-only,
	 * regardless of what tier was hit at mousedown.
	 */
	private handleDistributePointerUp(): void {
		const hit = this.massSelectCtrlHit;
		const preview = this.distributePreview;
		this.massSelectCtrlHit = null;
		this.distributePaint = null;
		this.distributePreview = null;

		if (!this.dragMoved) {
			if (hit) {
				this.controller.toggleMassSelection(hit.kind, hit.id);
			} else if (this.controller.getData().gridType === "none") {
				this.controller.clearMassSelection();
			}
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
			.map((t) => ({ token: t, originWorld: this.hit.footprintCenter(t) }));
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
		const anchorTargetKey = this.hit.dropAnchorKey(anchorEntry.token, anchorEntry.originWorld.x + dx, anchorEntry.originWorld.y + dy);
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
		const ordered = [...tokens].sort((a, b) => readingOrder(this.hit.footprintCenter(a), this.hit.footprintCenter(b)));

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
			const centers = tokens.map((t) => this.hit.footprintCenter(t));
			const minX = Math.min(...centers.map((c) => c.x));
			const maxX = Math.max(...centers.map((c) => c.x));
			const minY = Math.min(...centers.map((c) => c.y));
			const maxY = Math.max(...centers.map((c) => c.y));
			const spanX = Math.max(maxX - minX, 1e-6);
			const spanY = Math.max(maxY - minY, 1e-6);
			const points = ordered.map((t) => {
				const c = this.hit.footprintCenter(t);
				const nx = (c.x - minX) / spanX;
				const ny = (c.y - minY) / spanY;
				return { x: destMinX + nx * (destMaxX - destMinX), y: destMinY + ny * (destMaxY - destMinY) };
			});
			this.distributePreview = { valid: true, cellKeys: null, points, assignment: ordered.map((t, i) => ({ tokenId: t.id, point: points[i] })) };
			return;
		}

		const occupied = occupiedFootprintCells(data, ids);
		const painted = [...paint.cellKeys].sort((k1, k2) => readingOrder(this.hit.cellCenter(k1), this.hit.cellCenter(k2)));
		const free = painted.filter((k) => !occupied.has(k));
		const n = ordered.length;
		const valid = free.length >= n;
		this.distributePreview = {
			valid,
			// Always highlight everything actually painted, regardless of shape or validity — WYSIWYG,
			// like a brush stroke. Only the first `n` *free* cells (in reading order) are ever really
			// assigned; painting more than needed just means the extras don't get used.
			cellKeys: painted,
			points: painted.map((k) => this.hit.cellCenter(k)),
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
				const origin = this.hit.footprintCenter(token);
				return { token, origin, dist: Math.hypot(origin.x - pathStart.x, origin.y - pathStart.y) };
			})
			.sort((a, b) => a.dist - b.dist);

		const pathCumulative = polylineCumulativeLengths(pathPoints);
		const pathTotalLength = pathCumulative[pathCumulative.length - 1] ?? 0;
		const gap = this.hit.cellVisualWidth() * PATH_FOLLOW_GAP_CELLS;

		const routes: PathAnimationRoute[] = ranked.map(({ token, origin }, rank) => {
			const stopArc = Math.max(0, pathTotalLength - rank * gap);
			const points = [origin, ...truncatePolyline(pathPoints, pathCumulative, stopArc)];
			const cumulative = polylineCumulativeLengths(points);
			const totalLength = cumulative[cumulative.length - 1] ?? 0;
			const finalRotation = directionAtArcLength(points, cumulative, totalLength) ?? token.rotation ?? 0;
			return { tokenId: token.id, points, cumulative, totalLength, finalRotation };
		});

		const speedWorldPerMs = (this.hit.cellVisualWidth() * PATH_ANIMATION_CELLS_PER_SEC) / 1000;
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
				const desiredKey = this.hit.dropAnchorKey(token, end.x, end.y);
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
		if (this.hit.findWallPointAtScreenPoint(px, py)) return;
		const segment = this.hit.findWallSegmentAtScreenPoint(px, py);
		if (!segment) return;
		e.preventDefault();
		const world = this.hit.snapWorldToGrid(screenToWorld(px, py, this.transform));
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

		// Fog is composited on its own offscreen buffer (see `FogRenderer.renderFogLayer`) rather than
		// painted directly onto the main canvas: `destination-out` erases whatever is already on the
		// surface it's drawn to, and the main canvas already has the background/grid/zones on it by
		// the time fog is drawn — punching a hole there would erase the map itself, not just a fog
		// overlay.
		this.fog = new FogRenderer(
			this.controller,
			this.settings,
			() => this.transform,
			this.isMirror,
			!!this.options.forceFog,
			() => ({ w: this.viewportW, h: this.viewportH }),
			(tokenId) => this.currentAnimatedPose(tokenId),
			() => this.render()
		);
		this.hit = new HitTester(this.controller, () => this.transform, this.fog);
		this.drawer = new MapDrawer(this.controller, this.settings, () => this.transform, () => ({ w: this.viewportW, h: this.viewportH }), this.hit);

		if (!this.isMirror) {
			this.canvas.addEventListener("pointerdown", this.onPointerDown);
			this.canvas.addEventListener("pointermove", this.onPointerMove);
			this.canvas.addEventListener("pointerup", this.onPointerUp);
			this.canvas.addEventListener("pointercancel", this.onPointerCancel);
			this.canvas.addEventListener("dblclick", this.onDoubleClick);
			this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
			this.canvas.addEventListener("contextmenu", this.onContextMenu);
			// Focusable so its own `keydown` (Ctrl+C/Ctrl+V — see `onKeyDown`) fires at all; a plain
			// `<canvas>` isn't in the tab order by default. Never focused for a mirror canvas — it has
			// no interaction handlers to begin with (see the branch this sits in).
			this.canvas.tabIndex = 0;
			this.canvas.addEventListener("keydown", this.onKeyDown);

			this.gamepadPoller = new GamepadInputPoller({
				onMove: (gamepadIndex, angleDeg, interactHeld) => this.handleGamepadMove(gamepadIndex, angleDeg, interactHeld),
				onInteract: (gamepadIndex) => this.handleGamepadInteract(gamepadIndex),
				onLightStep: (gamepadIndex, delta) => this.handleGamepadLightStep(gamepadIndex, delta),
				onAim: (gamepadIndex, angleDeg) => this.handleGamepadAim(gamepadIndex, angleDeg),
			});
			this.gamepadPoller.start();
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
	 * "Centrer" player-mirror camera mode: a camera (world-space center + zoom, same shape as
	 * `setMirrorCamera` expects) that fits every point in `points` inside this canvas's own current
	 * viewport, padded by `CENTER_CAMERA_PADDING_RATIO` and never framing tighter than
	 * `CENTER_CAMERA_MIN_CELLS`. Returns `null` if this canvas hasn't measured a real viewport size yet
	 * (see `resize`) or `points` is empty (no player tokens on the map) — the caller should just leave
	 * the camera as it was in either case. See `MapPlayerMirrorView.applyCameraForMode`.
	 */
	computeFitCamera(points: Point[]): { zoom: number; x: number; y: number } | null {
		if (this.viewportW === 0 || this.viewportH === 0 || points.length === 0) return null;
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const p of points) {
			minX = Math.min(minX, p.x);
			maxX = Math.max(maxX, p.x);
			minY = Math.min(minY, p.y);
			maxY = Math.max(maxY, p.y);
		}
		const data = this.controller.getData();
		const minExtent = data.cellSize * CENTER_CAMERA_MIN_CELLS;
		const w = Math.max(maxX - minX, minExtent) * CENTER_CAMERA_PADDING_RATIO;
		const h = Math.max(maxY - minY, minExtent) * CENTER_CAMERA_PADDING_RATIO;
		const zoom = clamp(Math.min(this.viewportW / w, this.viewportH / h), data.minZoom, data.maxZoom);
		return { zoom, x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
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
	private computeVisibleImageBounds(): ImageBounds | null {
		const data = this.controller.getData();
		const cellSize = this.hit.effectiveCellSize();
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
	private clampPanToBounds(bounds: ImageBounds): void {
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
		this.fog.destroy();
		if (this.pingAnimationFrameId !== null) cancelAnimationFrame(this.pingAnimationFrameId);
		if (this.pathAnimationFrameId !== null) cancelAnimationFrame(this.pathAnimationFrameId);
		if (this.cellHopFrameId !== null) cancelAnimationFrame(this.cellHopFrameId);
		this.gamepadPoller?.stop();
		this.resizeObserver.disconnect();
		if (!this.isMirror) {
			this.canvas.removeEventListener("pointerdown", this.onPointerDown);
			this.canvas.removeEventListener("pointermove", this.onPointerMove);
			this.canvas.removeEventListener("pointerup", this.onPointerUp);
			this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
			this.canvas.removeEventListener("dblclick", this.onDoubleClick);
			this.canvas.removeEventListener("wheel", this.onWheel);
			this.canvas.removeEventListener("contextmenu", this.onContextMenu);
			this.canvas.removeEventListener("keydown", this.onKeyDown);
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

	/** Adjacent cell keys (4-connected for square, 6-connected for hex) — used by the fill tool's flood fill and by gamepad-driven token movement (`nearestNeighborKey`). Falls back to square adjacency for grid type "none" (same convention as `zoneAt`), though in practice `handleGamepadMove` never calls this for a "none"-grid token, which has no `cellKey` to begin with. */
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

	/**
	 * Classifies whether/how a step from `fromKey` to `toKey` is stopped by a wall crossing the
	 * straight line between the two cells' centers — every wall type blocks a plain step (see
	 * `VisionBlockerType`'s own doc comment), so any crossing at all rules out `"clear"`:
	 *  - `"clear"` — no wall crosses this line at all.
	 *  - `"interact"` — blocked for a plain step, but every wall crossing this line is
	 *    interact-crossable (`wallPassableWithInteract` — `"pass-through"`/`"pass-see-through"`),
	 *    forcible via the gamepad's interact-to-pass action — see `handleGamepadMove`.
	 *  - `"blocked"` — at least one crossing wall has no override at all (`"opaque"`/`"see-through"`),
	 *    so even holding interact can't get a token through.
	 * Used by the fill tool's flood fill (`edgeBlocked`, which treats anything but `"clear"` as
	 * blocked — it has no interact concept) and by gamepad movement (`handleGamepadMove`, the only
	 * caller that cares about the `"interact"` distinction).
	 */
	private wallCrossing(fromKey: string, toKey: string, wallSegments: ResolvedWallSegment[]): "clear" | "interact" | "blocked" {
		const a = this.hit.cellCenter(fromKey);
		const b = this.hit.cellCenter(toKey);
		let interactOnly = true;
		let sawAny = false;
		for (const seg of wallSegments) {
			if (segmentIntersection(a, b, seg.a, seg.b) === null) continue;
			sawAny = true;
			if (!wallPassableWithInteract(seg.type)) interactOnly = false;
		}
		if (!sawAny) return "clear";
		return interactOnly ? "interact" : "blocked";
	}

	/** Boolean flattening of `wallCrossing` for `fillFrom`, which has no interact concept of its own — anything but `"clear"` stops the flood. */
	private edgeBlocked(fromKey: string, toKey: string, wallSegments: ResolvedWallSegment[]): boolean {
		return this.wallCrossing(fromKey, toKey, wallSegments) !== "clear";
	}

	/** Smallest angular distance between two degree angles (0..180), direction-agnostic — used by `nearestNeighborKey` to find whichever grid direction a gamepad's held angle points closest to. */
	private static angularDistanceDeg(a: number, b: number): number {
		const diff = Math.abs(a - b) % 360;
		return diff > 180 ? 360 - diff : diff;
	}

	/**
	 * Whichever of `key`'s grid neighbors (`neighborKeys`) best matches `inputAngleDeg` (same atan2/
	 * y-down world-space convention as `GamepadInputPoller`'s own angle), plus that neighbor's own
	 * exact direction — turns a stick/d-pad direction into one concrete cell to step onto (and the
	 * facing to rotate the token to, see `handleGamepadMove`), on both the square grid's 4 neighbors and
	 * either hex grid's 6 alike. `null` if `key` has no neighbors (shouldn't happen for a celled grid,
	 * but `neighborKeys` is total).
	 */
	private nearestNeighborKey(key: string, inputAngleDeg: number): { key: string; angleDeg: number } | null {
		const origin = this.hit.cellCenter(key);
		let best: { key: string; angleDeg: number } | null = null;
		let bestDiff = Infinity;
		for (const candidate of this.neighborKeys(key)) {
			const center = this.hit.cellCenter(candidate);
			const rawAngle = (Math.atan2(center.y - origin.y, center.x - origin.x) * 180) / Math.PI;
			const angleDeg = rawAngle < 0 ? rawAngle + 360 : rawAngle;
			const diff = MapCanvas.angularDistanceDeg(inputAngleDeg, angleDeg);
			if (diff < bestDiff) {
				bestDiff = diff;
				best = { key: candidate, angleDeg };
			}
		}
		return best;
	}

	/**
	 * `GamepadInputPoller`'s `onMove` callback (see the constructor): one gamepad just reported a held
	 * direction (edge-triggered, possibly auto-repeating — see the poller itself) — if `gamepadIndex` is
	 * assigned to a player token (`MapController.gamepadAssignments`), steps that token one cell in
	 * whichever of its grid neighbors is closest to `inputAngleDeg`, rotating it to face that direction
	 * (`token.rotation`, same commit as the move — see `MapController.moveToken`'s `rotation` param),
	 * unless that neighbor is already occupied by something other than a "light" token (`moveToken`'s own
	 * check) or a wall stands between the two (`wallCrossing`) — `"blocked"` always stops it, `"interact"`
	 * only stops it while `interactHeld` is false, letting the gamepad's interact button force a step
	 * through a `"pass-through"` wall. On success, plays the "jump" hop animation (`startCellHop`,
	 * echoed to any player-mirror window via `MapCanvasOptions.onCellHop`) — started *before*
	 * `MapController.moveToken` itself, see the comment at that call below for why the order matters.
	 *
	 * A no-op outside view mode, on a mirror canvas (`gamepadPoller` is never even created for one — see
	 * the constructor), for an unassigned gamepad, for a token with no `cellKey` (grid type "none" —
	 * there's no notion of "cell to cell" movement to step through there), or while that same token is
	 * still mid an earlier hop (`cellHops`) — a new step only starts once the last one's animation has
	 * actually finished, so held-direction auto-repeat can't outrun what's on screen.
	 */
	private handleGamepadMove(gamepadIndex: number, inputAngleDeg: number, interactHeld: boolean): void {
		if (this.controller.mode !== "view") return;
		const tokenId = this.controller.gamepadAssignments.get(gamepadIndex);
		if (!tokenId) return;
		if (this.cellHops.has(tokenId)) return;
		const token = this.controller.findToken(tokenId);
		if (!token?.cellKey) return;
		const target = this.nearestNeighborKey(token.cellKey, inputAngleDeg);
		if (!target) return;
		const crossing = this.wallCrossing(token.cellKey, target.key, this.resolveWallSegments());
		if (crossing === "blocked") return;
		if (crossing === "interact" && !interactHeld) return;
		const from = this.hit.cellCenter(token.cellKey);
		const to = this.hit.cellCenter(target.key);
		// Start the hop's render override on this canvas *and* broadcast it to any player-mirror window
		// *before* `moveToken` — `MapController.update` calls its listeners synchronously, and that
		// includes both this canvas's own `render()` *and* the mirror's (they share one `MapController`).
		// If `moveToken` ran first, either canvas's next render would draw the token already at its
		// newly-committed cell (nothing in `cellHops` yet on that canvas), then visibly snap back to
		// `from` once its hop actually starts — a teleport-then-rewind flash. Starting (and echoing) the
		// hop first means both canvases' `cellHops` are already populated by the time that synchronous
		// render runs, so it draws the hop's very first frame (t≈0, i.e. still at `from`) instead.
		this.startCellHop(tokenId, from, to);
		this.options.onCellHop?.(tokenId, from, to);
		if (!this.controller.moveToken(tokenId, target.key, target.angleDeg)) {
			this.cellHops.delete(tokenId);
			return;
		}
	}

	/**
	 * `GamepadInputPoller`'s `onInteract` callback (see the constructor): one gamepad's interact button
	 * was just pressed (edge-triggered) — if `gamepadIndex` is assigned to a player token, toggles a
	 * light: whichever "light" category token shares the player's own cell, if any (a co-located light —
	 * see `MapController.moveToken`'s light-passthrough exception), else the player token's own light.
	 * The "!" indicator itself isn't triggered from here at all — see `tokenCanInteract`/`drawTokens`,
	 * which show it live off the token's actual position, independent of whether this button has ever
	 * been pressed. A no-op outside view mode, on a mirror canvas, or for an unassigned gamepad — same
	 * gating as `handleGamepadMove`.
	 */
	private handleGamepadInteract(gamepadIndex: number): void {
		if (this.controller.mode !== "view") return;
		const tokenId = this.controller.gamepadAssignments.get(gamepadIndex);
		if (!tokenId) return;
		const token = this.controller.findToken(tokenId);
		if (!token) return;
		const data = this.controller.getData();
		const lightHere = token.cellKey ? data.tokens.find((t) => t.id !== token.id && t.cellKey === token.cellKey && (t.category ?? "entity") === "light") : undefined;
		const targetId = lightHere?.id ?? token.id;
		this.controller.updateToken(targetId, (t) => (t.lightEnabled = !(t.lightEnabled ?? true)));
	}

	/**
	 * `GamepadInputPoller`'s `onLightStep` callback (see the constructor): L1/R1 was just pressed
	 * (edge-triggered) — if `gamepadIndex` is assigned to a player token, steps `token.lightRadiusReduction`
	 * by `-delta` (L1's `delta` of `-1` *increases* the reduction, i.e. dims; R1's `1` decreases it, i.e.
	 * brightens), clamped so the effective radius (`resolveLightRadius`) stays within
	 * `[0, configuredLightRadius(token)]` — the InfoPanel menu's own authored value is the ceiling this
	 * can brighten back up to, never exceeded, and never itself touched by the gamepad. A no-op outside
	 * view mode, on a mirror canvas, or for an unassigned gamepad — same gating as `handleGamepadMove`.
	 */
	private handleGamepadLightStep(gamepadIndex: number, delta: -1 | 1): void {
		if (this.controller.mode !== "view") return;
		const tokenId = this.controller.gamepadAssignments.get(gamepadIndex);
		if (!tokenId) return;
		const token = this.controller.findToken(tokenId);
		if (!token) return;
		const max = configuredLightRadius(token);
		const currentReduction = Math.max(0, token.lightRadiusReduction ?? 0);
		const nextReduction = clamp(currentReduction - delta, 0, max);
		this.controller.updateToken(tokenId, (t) => (t.lightRadiusReduction = nextReduction));
	}

	/**
	 * `GamepadInputPoller`'s `onAim` callback (see the constructor): the right stick's current "look"
	 * angle for `gamepadIndex`, reported every poll tick (continuous, not edge-triggered — see
	 * `GamepadCallbacks.onAim`'s own doc comment) — if assigned to a player token, either updates that
	 * token's live `aimOverrides` entry and re-renders (`angleDeg` non-`null`, the stick is actively
	 * held somewhere), or — the tick it first reports `null` (the stick just returned to center) — drops
	 * the override and commits its last angle to the real `token.rotation` via one ordinary
	 * `MapController.updateToken` call, the same one-undo-step/one-save write any other facing change
	 * gets. Broadcasts every tick to `MapCanvasOptions.onAim` so a player-mirror window's own
	 * `aimOverrides` stays in lockstep — see `playAimEcho`. A no-op outside view mode, on a mirror
	 * canvas, or for an unassigned gamepad — same gating as `handleGamepadMove`.
	 */
	private handleGamepadAim(gamepadIndex: number, angleDeg: number | null): void {
		if (this.controller.mode !== "view") return;
		const tokenId = this.controller.gamepadAssignments.get(gamepadIndex);
		if (!tokenId) return;
		if (angleDeg === null) {
			const committed = this.aimOverrides.get(tokenId);
			if (committed === undefined) return;
			this.aimOverrides.delete(tokenId);
			this.options.onAim?.(tokenId, null);
			this.controller.updateToken(tokenId, (t) => (t.rotation = committed));
			return;
		}
		this.aimOverrides.set(tokenId, angleDeg);
		this.options.onAim?.(tokenId, angleDeg);
		this.render();
	}

	/**
	 * Replays a live right-stick "look" tick on a player-mirror window — see `MapCanvasOptions.onAim`/
	 * `handleGamepadAim`. `angleDeg` of `null` drops the mirror's own override (the stick returned to
	 * center on the source canvas — the eventual `rotation` commit itself reaches the mirror normally,
	 * through the shared `MapController`, no echo needed for that part).
	 */
	playAimEcho(tokenId: string, angleDeg: number | null): void {
		if (angleDeg === null) {
			this.aimOverrides.delete(tokenId);
		} else {
			this.aimOverrides.set(tokenId, angleDeg);
		}
		this.render();
	}

	/**
	 * Whether `token` currently has something to interact with via the gamepad's interact button — a
	 * "light" category token sharing its cell, or a `"pass-through"` wall standing between it and one of
	 * its grid neighbors (`wallCrossing` returning `"interact"` — see `handleGamepadMove`). Drives the
	 * live "!" indicator (`drawTokens`/`drawInteractIndicator`): recomputed fresh from the token's actual
	 * current position on every render rather than triggered for a fixed duration by the button itself,
	 * so it appears/disappears immediately as the token moves, in perfect sync on a player-mirror window
	 * too (no separate echo needed — both canvases already share the same `MapController` data this
	 * reads). `false` for a token with no `cellKey` (grid type "none").
	 */
	private tokenCanInteract(token: Token, wallSegments: ResolvedWallSegment[]): boolean {
		const cellKey = token.cellKey;
		if (!cellKey) return false;
		const data = this.controller.getData();
		if (data.tokens.some((t) => t.id !== token.id && t.cellKey === cellKey && (t.category ?? "entity") === "light")) return true;
		return this.neighborKeys(cellKey).some((neighborKey) => this.wallCrossing(cellKey, neighborKey, wallSegments) === "interact");
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
		const key = this.hit.cellKeyAt(world.x, world.y);

		if (!this.cellsCurrentlyVisible()) {
			this.controller.selectCell(null);
			return;
		}

		// A plain left-click only (re)opens the info panel for a cell that already carries something (a
		// placed tampon/zone/label/link) — the same rule in both modes now (used to be view-mode only).
		// An empty cell is left untouched by a plain click: paint it with the brush/fill tool first
		// (edit mode) to make it selectable, then click it to add a tampon/label/links.
		const data = this.controller.getData();
		if (data.gridType === "none") return;
		const cell = this.controller.getActiveLayer().cellsByGridType[data.gridType][key];
		if (isCellEmpty(cell)) {
			this.controller.selectCell(null);
			return;
		}

		this.controller.selectCell(this.controller.selectedCellKey === key ? null : key);
	}

	/** Places a marker at a specific screen point (edit-mode right-click menu) rather than the viewport center. */
	private addMarkerAt(px: number, py: number): void {
		const world = screenToWorld(px, py, this.transform);
		const marker = this.controller.addMarker(world.x, world.y);
		this.controller.selectMarker(marker.id);
	}

	/**
	 * Right-click menu's "Placer un tampon ici" (edit mode, any grid type): a freeform `Marker` on grid
	 * type "none" (`addMarkerAt`), or, on a celled grid, the clicked cell's own `stamp` field — matching
	 * `InfoPanel`'s "Logo" quick-pick (see `QUICK_STAMPS`). An already-stamped cell is left alone and
	 * just (re)selected, rather than clobbered with the default, mirroring how right-clicking empty
	 * space never creates a second marker on top of an existing one on grid type "none" either.
	 */
	private addStampAt(px: number, py: number): void {
		const data = this.controller.getData();
		if (data.gridType === "none") {
			this.addMarkerAt(px, py);
			return;
		}
		const world = screenToWorld(px, py, this.transform);
		const key = this.hit.cellKeyAt(world.x, world.y);
		const cell = this.controller.getActiveLayer().cellsByGridType[data.gridType][key];
		if (!cell?.stamp) {
			// "📍" mirrors the menu item's own "map-pin" icon — just a sensible default, freely
			// changeable afterward from the info panel's "Logo" row like any other quick-pick.
			this.controller.updateCell(key, (c) => (c.stamp = "📍"));
		}
		this.controller.selectCell(key);
	}

	/** Places a token at a specific screen point (edit-mode right-click menu) rather than the viewport center. */
	private addTokenAt(px: number, py: number): void {
		const world = screenToWorld(px, py, this.transform);
		if (this.controller.getData().gridType === "none") {
			const token = this.controller.addFreeToken(world.x, world.y);
			this.controller.selectToken(token.id);
			return;
		}
		const key = this.hit.cellKeyAt(world.x, world.y);
		const token = this.controller.addToken(key);
		if (!token) {
			new Notice("Impossible de placer un pion ici : la case est déjà occupée sur ce calque. Déplacez la vue et réessayez.");
			return;
		}
		this.controller.selectToken(token.id);
	}

	/** Right-click menu's "Coller ici" — screen-point wrapper around `pasteTokensAtWorldPoint`, mirroring `addTokenAt`. */
	private pasteTokensAtScreenPoint(px: number, py: number): Promise<void> {
		const world = screenToWorld(px, py, this.transform);
		return this.pasteTokensAtWorldPoint(world.x, world.y);
	}

	/**
	 * Pastes at a specific world point — shared by the right-click "Coller ici" and the Ctrl+V
	 * shortcut (see `onKeyDown`). First tries to refresh the in-memory clipboard (see
	 * `tokenClipboard.ts`) from the real OS clipboard, so a paste picks up tokens copied in a
	 * *previous* Obsidian session, or copied via Ctrl+C on a *different* open map, not just this same
	 * session's in-memory copy — falling back to whatever's already in-memory (e.g. copied moments ago
	 * via the InfoPanel's "Copier" button) if the OS clipboard is empty/unreadable/holds something
	 * that isn't tokens copied from this plugin (see `parseClipboardTokens`). Surfaces a `Notice` only
	 * when there was something to paste but it didn't fit (occupied cells) or there was truly nothing
	 * to paste at all — silent on success, like every other placement gesture here.
	 */
	private async pasteTokensAtWorldPoint(worldX: number, worldY: number): Promise<void> {
		await this.refreshClipboardFromSystem();
		const hadClipboard = hasTokenClipboard();
		if (!hadClipboard) {
			new Notice("Presse-papier vide : copiez d'abord un ou plusieurs pions (Ctrl+C, ou le bouton « Copier »).");
			return;
		}
		const placed = this.controller.pasteTokens(worldX, worldY);
		if (placed === 0) {
			new Notice("Impossible de coller ici : la ou les cases visées sont déjà occupées sur ce calque.");
		}
	}

	/**
	 * Whatever's currently selected resolves the Ctrl+V drop point: the selected cell's center on a
	 * celled grid, the selected marker/token's own free position on grid type "none", falling back to
	 * the viewport's own center when nothing's selected at all — see `onKeyDown`. A right-click's
	 * "Coller ici" doesn't need this (the clicked point already *is* the drop point).
	 */
	private pasteAnchorWorldPoint(): { x: number; y: number } {
		const data = this.controller.getData();
		if (data.gridType !== "none" && this.controller.selectedCellKey) {
			return this.hit.cellCenter(this.controller.selectedCellKey);
		}
		const marker = this.controller.getSelectedMarker();
		if (marker) return { x: marker.x, y: marker.y };
		const token = this.controller.getSelectedToken();
		if (token) return this.hit.footprintCenter(token);
		return screenToWorld(this.viewportW / 2, this.viewportH / 2, this.transform);
	}

	/**
	 * Ctrl+C / Ctrl+V / Échap while the canvas has focus (see the `tabIndex`/`focus()` calls around
	 * `onPointerDown`) — the canvas is a plain, non-editable `<canvas>`, so there's never a competing
	 * native text copy/paste (or a text field to blur) to preserve here; the only reason this is
	 * scoped to the canvas element's own `keydown` (rather than `document`) is to leave every *other*
	 * keyboard shortcut in Obsidian (including the note editor's own Ctrl+C/V, elsewhere on the page)
	 * completely alone.
	 */
	private onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			this.handleEscape();
			return;
		}
		if (!(e.ctrlKey || e.metaKey)) return;
		const key = e.key.toLowerCase();
		if (key === "c") {
			if (this.controller.getSelectedTokens().length === 0) return;
			e.preventDefault();
			void this.copySelectionToSystemClipboard();
		} else if (key === "v") {
			e.preventDefault();
			const anchor = this.pasteAnchorWorldPoint();
			void this.pasteTokensAtWorldPoint(anchor.x, anchor.y);
		}
	};

	/**
	 * Échap: cancels whatever's in progress first — an armed wall chain/shape/bucket placement (full
	 * cancel, not `onContextMenu`'s one-step-back undo), or any other in-progress pointer gesture (see
	 * `cancelActiveGesture`) — without committing anything. Only once nothing is in progress does it
	 * fall back to clearing every current selection: the mass selection, and whichever single object
	 * (token/marker/case/wall point/wall segment) is selected.
	 */
	private handleEscape(): void {
		if (this.controller.getWallChainTailId() || this.controller.getWallShapeFirstCorner() || this.controller.pendingWallShape || this.controller.pendingWallBucket) {
			this.controller.cancelWallShapePlacement();
			this.controller.cancelWallBucketPlacement();
			this.controller.resetWallChain();
			this.render();
			return;
		}
		if (this.hasActiveGesture()) {
			this.cancelActiveGesture();
			this.render();
			return;
		}
		this.controller.clearMassSelection();
		this.controller.selectToken(null);
		this.controller.selectMarker(null);
		this.controller.selectCell(null);
		this.controller.selectWallPoint(null);
		this.controller.selectWallSegment(null);
	}

	/** Ctrl+C: copies the current token selection (see `MapController.copySelectedTokens`) into both the in-memory clipboard and the real OS clipboard, as JSON (see `tokenClipboard.ts`) — so it survives closing Obsidian and can be pasted onto a map open in a different window/session, not just this one. */
	private async copySelectionToSystemClipboard(): Promise<void> {
		const count = this.controller.copySelectedTokens();
		if (count === 0) return;
		try {
			await navigator.clipboard.writeText(serializeClipboardTokens(getTokenClipboard()));
		} catch (err) {
			// Same soft-failure spirit as the paste side: the in-memory clipboard set by
			// copySelectedTokens() above already covers same-session copy/paste across open maps.
			console.warn("Map Manager: écriture dans le presse-papier système impossible", err);
		}
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
		const cellSize = this.hit.effectiveCellSize();
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
		const fitsOnScreen = this.hit.cellVisualWidth() * this.transform.zoom >= MIN_CELL_PIXELS;
		return fitsOnScreen && (this.effectiveMode() === "edit" || this.controller.showCells);
	}

	private updateCursor(): void {
		const tool = this.effectiveMode() === "edit" ? this.controller.activeTool : "none";
		this.canvas.toggleClass("is-brush-tool", tool === "brush");
		this.canvas.toggleClass("is-fill-tool", tool === "fill");
		this.canvas.toggleClass("is-wall-tool", tool === "wall");
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

		// `resolveWallSegments` walks every visible layer's wall points/segments into a fresh
		// array (and a throwaway lookup Map per layer) — up to three call sites below
		// (vision/light-ray casting, `drawWallShadowBlackout`, `drawVisionZones`) used to each
		// redo that work independently on every single render() call, including every frame of the
		// fog-tremble/path-animation loops. Resolved at most once per render() call instead, lazily
		// (a render that needs none of the three skips it entirely, e.g. a mirror with fog and
		// entity-vision-to-players both off).
		let wallSegmentsCache: ResolvedWallSegment[] | null = null;
		const getWallSegments = () => (wallSegmentsCache ??= this.resolveWallSegments());

		// Computed up front (rather than alongside the fog overlay itself, further down) so
		// `drawWallShadowBlackout` below — and thus `drawBackgrounds`/`drawGridAndCells` — can already
		// use this frame's live vision reach, not just last frame's.
		if (this.fog.isCurrentlyVisible()) {
			this.fog.recomputeFrame(getWallSegments());
		} else {
			this.fog.clearFrame();
		}

		this.drawBackgrounds(ctx);

		const cellsVisible = this.cellsCurrentlyVisible();
		// The "Afficher/masquer les zones" toggle (edit mode's "Zones" toolbar group) only ever hides
		// the zone-color tint, and only in edit mode — Vue always shows zones (there's no equivalent
		// button there) — see `MapDrawer.drawGridAndCells`'s own doc comment.
		const zonesVisible = this.effectiveMode() !== "edit" || this.controller.showZones;
		if (cellsVisible) {
			if (imageBounds) {
				ctx.save();
				ctx.beginPath();
				ctx.rect(imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h);
				ctx.clip();
				this.drawer.drawGridAndCells(ctx, zonesVisible);
				ctx.restore();
			} else {
				this.drawer.drawGridAndCells(ctx, zonesVisible);
			}
		}

		// Patches solid black back over content drawn right above, but only within a margin of an
		// actual wall and only where fog wouldn't otherwise reveal it — see the method doc. Away from
		// any wall, `drawBackgrounds`/`drawGridAndCells` above are left completely untouched, so open
		// territory keeps exactly its original smooth vision-cone look with no masking artifacts.
		if (this.fog.isCurrentlyVisible()) this.fog.drawWallShadowBlackout(ctx, dpr, imageBounds, getWallSegments());

		const noGrid = this.controller.getData().gridType === "none";
		if (noGrid) this.drawer.drawMarkers(ctx, this.draggingMarker);
		this.drawer.drawWalls(ctx, cellsVisible, this.effectiveMode(), this.isMirror, this.draggingWallPoint);

		if (this.fog.isCurrentlyVisible()) this.fog.renderAndComposite(ctx, dpr, imageBounds);

		// GM's own window always shows this tactical hint; a player-mirror window only shows it while
		// the GM has explicitly toggled it on (see `MapController.showEntityVisionToPlayers` and the
		// player-window dropdown in `Toolbar`) — hidden there by default.
		if (!this.isMirror || this.controller.showEntityVisionToPlayers) this.fog.drawVisionZones(ctx, getWallSegments());

		this.drawTokens(ctx);
		if (cellsVisible || noGrid || this.controller.selectedWallPointId) this.drawSelection(ctx);
		// Whenever there's an actual mass selection (any kind) to outline, or while a fresh shift-drag
		// marquee is being drawn — that live rectangle must show up even before anything's been added
		// to the selection yet (see `drawMassSelectionOverlay`'s own `marqueeWorld` handling at the
		// bottom).
		if (this.controller.massSelectionKind || this.marqueeWorld) this.drawMassSelectionOverlay(ctx);
		this.drawDistributePreview(ctx);
		this.drawWallPreview(ctx);
		this.drawPathPreview(ctx);
		if (this.activePing) this.drawPing(ctx);

		ctx.restore();
		this.fog.syncAnimationLoop();
	}

	private drawTokens(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		const fogActive = this.fog.areEntitiesHidden();
		const group = this.draggingTokenGroup;
		const groupIds = group ? new Set(group.entries.map((e) => e.token.id)) : null;
		const animatingIds = this.pathAnimation ? new Set(this.pathAnimation.routes.map((r) => r.tokenId)) : null;
		for (const token of data.tokens) {
			if (this.draggingToken?.token.id === token.id) continue;
			if (groupIds?.has(token.id)) continue;
			if (animatingIds?.has(token.id)) continue;
			if (this.cellHops.has(token.id)) continue;
			if (this.fog.isLightTokenHidden(token)) continue;
			const isPlayer = (token.category ?? "entity") === "player";
			const center = this.hit.footprintCenter(token);
			if (fogActive && !isPlayer && !this.fog.isEntityRevealed(center)) continue;
			// Live right-stick "look" override (`handleGamepadAim`) — a token being actively aimed with
			// the gamepad draws facing that live angle instead of its own still-uncommitted `rotation`.
			const aimAngle = this.aimOverrides.get(token.id);
			const drawnToken = aimAngle !== undefined ? { ...token, rotation: aimAngle } : token;
			this.drawToken(ctx, center.x, center.y, drawnToken, token.id === this.controller.selectedTokenId);
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
		// Gamepad-driven "jump" hop: same "override the render, data's already committed" precedent as
		// `pathAnimation` above, including ignoring fog — see its own comment.
		if (this.cellHops.size > 0) {
			for (const tokenId of this.cellHops.keys()) {
				const token = data.tokens.find((t) => t.id === tokenId);
				const pose = this.currentHopPose(tokenId);
				if (!token || !pose) continue;
				this.drawToken(ctx, pose.x, pose.y, token, token.id === this.controller.selectedTokenId);
			}
		}
		// Gamepad interact button's "!" indicator — live (`tokenCanInteract`), not tied to the button
		// ever having been pressed: shown above any gamepad-assigned token for as long as it actually
		// has something to interact with right now, view mode only (the only mode the button does
		// anything in — see `handleGamepadMove`/`handleGamepadInteract`), drawn above whatever position
		// the token is actually at (mid-hop or not, see `currentHopPose`'s footprint-center fallback).
		if (this.effectiveMode() === "view" && this.controller.gamepadAssignments.size > 0) {
			const wallSegments = this.resolveWallSegments();
			for (const tokenId of this.controller.gamepadAssignments.values()) {
				const token = data.tokens.find((t) => t.id === tokenId);
				if (!token || !this.tokenCanInteract(token, wallSegments)) continue;
				const pose = this.currentHopPose(tokenId) ?? this.hit.footprintCenter(token);
				this.drawInteractIndicator(ctx, pose.x, pose.y, token);
			}
		}
	}

	/**
	 * `token`'s live interpolated position/facing if it's currently mid an "Animation" token-movement
	 * tween (`pathAnimation`), else `null` — a single source of truth for "where does this token
	 * actually read as being *right now*, tween or not", shared by the token's own draw call, the fog
	 * vision cache (`FogRenderer.frameVisionCache`, so it unlocks fog as the tween runs rather than only
	 * once it commits), and `FogRenderer.isEntityRevealed`'s proximity check (so a moving player also
	 * reveals nearby entities live, not just once it stops).
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

	/** Starts (or restarts, if a fast gamepad repeat lands mid-hop) `tokenId`'s "jump" bounce from `from` to `to` (both world points, its old and new cell centers) — see `CellHopState`/`drawTokens`/`currentHopPose`. Called by `handleGamepadMove` right before `MapController.moveToken` commits the actual cell change. */
	private startCellHop(tokenId: string, from: Point, to: Point): void {
		this.cellHops.set(tokenId, { from, to, startedAt: performance.now() });
		this.runCellHopLoop();
	}

	/** Same self-contained start/stop `requestAnimationFrame` pattern as `triggerPing`/`runPathAnimationLoop`: re-renders every frame while any hop is in flight, dropping each one once its own `CELL_HOP_DURATION_MS` has elapsed. */
	private runCellHopLoop(): void {
		if (this.cellHopFrameId !== null) return;
		const tick = () => {
			const now = performance.now();
			for (const [id, hop] of this.cellHops) {
				if (now - hop.startedAt >= CELL_HOP_DURATION_MS) this.cellHops.delete(id);
			}
			this.render();
			if (this.cellHops.size === 0) {
				this.cellHopFrameId = null;
				return;
			}
			this.cellHopFrameId = requestAnimationFrame(tick);
		};
		this.cellHopFrameId = requestAnimationFrame(tick);
	}

	/**
	 * `tokenId`'s current interpolated position if it's mid a gamepad-triggered "jump" hop (`cellHops`),
	 * else `null` — a straight lerp from `from` to `to` with a sine-eased upward arc
	 * (`CELL_HOP_HEIGHT_RATIO` of a cell's width at the midpoint) so it reads as a little hop rather
	 * than a slide.
	 */
	private currentHopPose(tokenId: string): Point | null {
		const hop = this.cellHops.get(tokenId);
		if (!hop) return null;
		const t = clamp((performance.now() - hop.startedAt) / CELL_HOP_DURATION_MS, 0, 1);
		const height = cellVisualWidth(this.controller.getData()) * CELL_HOP_HEIGHT_RATIO;
		return {
			x: hop.from.x + (hop.to.x - hop.from.x) * t,
			y: hop.from.y + (hop.to.y - hop.from.y) * t - Math.sin(t * Math.PI) * height,
		};
	}

	/**
	 * Replays a gamepad-driven "jump" hop on a player-mirror window — see `MapCanvasOptions.onCellHop`/
	 * `handleGamepadMove`. No owner-vs-mirror distinction to make here (unlike `playPathAnimationEcho`):
	 * a hop never itself commits anything to `MapController` (that already happened, before this even
	 * fires — see `handleGamepadMove`), it's purely a visual tween, so both the owner canvas and any
	 * mirror just run the exact same `startCellHop`.
	 */
	playCellHopEcho(tokenId: string, from: Point, to: Point): void {
		this.startCellHop(tokenId, from, to);
	}

	/**
	 * The "!" indicator drawn above a gamepad-assigned token for as long as `tokenCanInteract` says it
	 * has something to interact with right now — always drawn regardless of fog, same "a GM/player sees
	 * their own token's status" reasoning as `draggingToken`/`pathAnimation`. Needs no player-mirror echo
	 * of its own (unlike `playCellHopEcho`): it's derived live from the same `MapController` data both
	 * canvases already share, so a mirror's own `drawTokens` call just recomputes the same answer.
	 */
	private drawInteractIndicator(ctx: CanvasRenderingContext2D, cx: number, cy: number, token: Token): void {
		const r = this.hit.tokenRadius(token);
		ctx.save();
		ctx.textAlign = "center";
		ctx.textBaseline = "bottom";
		ctx.font = `bold ${Math.max(14, r * 1.1)}px sans-serif`;
		ctx.lineWidth = Math.max(1.5, 3 / this.transform.zoom);
		ctx.strokeStyle = "#000000";
		ctx.fillStyle = "#f1c40f";
		const y = cy - r * 1.3;
		ctx.strokeText("!", cx, y);
		ctx.fillText("!", cx, y);
		ctx.restore();
	}

	/** Fixed glyph/color for every "light" category token's own marker — see `drawLightToken`. */
	private static readonly LIGHT_TOKEN_ICON = "💡";
	private static readonly LIGHT_TOKEN_FILL = "rgba(250, 204, 21, 0.92)";
	private static readonly LIGHT_TOKEN_BORDER = "#a16207";

	/**
	 * A "light" category token's own on-canvas marker — GM canvas only, see
	 * `FogRenderer.isLightTokenHidden`/`drawTokens` for why it never reaches here on the player-facing
	 * mirror. Deliberately ignores every per-token customization `drawToken` would otherwise draw
	 * (`icon`/`image`/`label`/`color`/`rotation`): a light token has none of those to configure to
	 * begin with (see `Token.category`'s own doc comment on why it's the one category with nothing to
	 * set beyond `lightRadius`), so its marker is always this same fixed glyph.
	 */
	private drawLightToken(ctx: CanvasRenderingContext2D, cx: number, cy: number, token: Token, selected: boolean): void {
		const r = this.hit.tokenRadius(token);
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
		const r = this.hit.tokenRadius(token);
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

	/** Truncates `text` with a trailing "…" if it wouldn't fit `maxWidth`, else returns it unchanged. Duplicated in `MapDrawer` (its own `drawStampAndLabel` needs the same tiny pure helper) rather than shared across the two classes for one 6-line function. */
	private fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
		if (ctx.measureText(text).width <= maxWidth) return text;
		let truncated = text;
		while (truncated.length > 1 && ctx.measureText(`${truncated}…`).width > maxWidth) {
			truncated = truncated.slice(0, -1);
		}
		return `${truncated}…`;
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
		const maxRadius = this.hit.cellVisualWidth() * 2.2;
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

	private drawSelection(ctx: CanvasRenderingContext2D): void {
		const data = this.controller.getData();
		const selectedWallPoint = this.controller.getSelectedWallPoint();
		if (selectedWallPoint) {
			const pos = this.drawer.wallPointPosition(selectedWallPoint, this.draggingWallPoint);
			ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
			ctx.strokeStyle = "#e0a020";
			ctx.beginPath();
			ctx.arc(pos.x, pos.y, this.hit.wallPointHitRadius(), 0, Math.PI * 2);
			ctx.stroke();
			return;
		}
		const selectedWallSegment = this.controller.getSelectedWallSegment();
		if (selectedWallSegment) {
			const layer = data.layers.find((l) => l.wallSegments.some((s) => s.id === selectedWallSegment.id));
			const a = layer?.wallPoints.find((p) => p.id === selectedWallSegment.aId);
			const b = layer?.wallPoints.find((p) => p.id === selectedWallSegment.bId);
			if (a && b) {
				const aPos = this.drawer.wallPointPosition(a, this.draggingWallPoint);
				const bPos = this.drawer.wallPointPosition(b, this.draggingWallPoint);
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
			ctx.arc(marker.x, marker.y, this.hit.markerHitRadius(), 0, Math.PI * 2);
			ctx.stroke();
			return;
		}
		const key = this.controller.selectedCellKey;
		if (!key) return;
		const { a, b } = parseCellKey(key);
		const cellSize = this.hit.effectiveCellSize();
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
			const center = this.hit.footprintCenter(token);
			ctx.beginPath();
			ctx.arc(center.x, center.y, this.hit.tokenRadius(token) + 3 / this.transform.zoom, 0, Math.PI * 2);
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
			const cellSize = this.hit.effectiveCellSize();
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
			const radius = this.hit.markerHitRadius();
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
			const rect = this.hit.normalizedWorldRect(this.marqueeWorld.start, this.marqueeWorld.current);
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
			const cellSize = this.hit.effectiveCellSize();
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
			const dotRadius = Math.max(4, this.hit.cellVisualWidth() * 0.12);
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

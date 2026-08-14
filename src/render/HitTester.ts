import { MapController, MassSelectionKind } from "../controller/MapController";
import { Marker, Token, WallPoint, WallSegment, hexKey, squareKey } from "../data/mapData";
import {
	SnapCandidate,
	ViewTransform,
	getVisibleHexCells,
	getVisibleSquareCells,
	hexGridSnapCandidates,
	projectOntoSegment,
	screenToWorld,
	squareFootprintAnchor,
	squareGridSnapCandidates,
} from "../grid/gridMath";
import {
	cellCenter as fogCellCenter,
	cellVisualWidth as fogCellVisualWidth,
	effectiveCellSize as fogEffectiveCellSize,
	footprintCenter as fogFootprintCenter,
	worldPointToCellKey as fogWorldPointToCellKey,
} from "../grid/fog";
import { FogRenderer } from "./FogRenderer";
import { WorldRect } from "./canvasTypes";

/** World-unit radius (as a fraction of `cellVisualWidth`) for clicking an existing wall point. */
const WALL_POINT_HIT_RATIO = 0.2;
/** Fixed screen-pixel radius within which a placed wall point snaps to a grid corner/midpoint/edge. */
const WALL_SNAP_SCREEN_PX = 14;
/** Fixed screen-pixel tolerance for clicking on/near an existing wall segment's line — selecting it, or double-clicking to insert a mid-point (see `findWallSegmentAtScreenPoint`). */
const WALL_SEGMENT_HIT_SCREEN_PX = 8;
/**
 * Radius as a fraction of (cellVisualWidth * token.size): 0.475 → a diameter equal to 95% of the
 * cell's width. Duplicated from `MapCanvas.ts`, which still needs its own copy for its token-drawing
 * math — not worth a reverse import back into this file for one shared number.
 */
const TOKEN_SIZE_RATIO = 0.475;

/**
 * Answers "what map object is at this screen point/rect?" and "where in world space does this
 * cell/token/wall-point live?" — every hit-test and coordinate conversion `MapCanvas` needs, with no
 * dependency on its interaction state (dragging, tool, animation...), only `controller`'s data, the
 * live `transform`, and `FogRenderer`'s public gating methods (for token hits). Constructed once by
 * `MapCanvas` alongside its `FogRenderer`.
 */
export class HitTester {
	constructor(
		private controller: MapController,
		// Same live-getter pattern as `FogRenderer` — `MapCanvas.transform` is sometimes reassigned
		// wholesale (mirror-camera framing, `applyFraming`) rather than mutated in place, so a
		// reference captured once at construction would go stale the first time that happens.
		private getTransform: () => ViewTransform,
		private fog: FogRenderer
	) {}

	private get transform(): ViewTransform {
		return this.getTransform();
	}

	// ---- Cell/token coordinate conversions ----

	/**
	 * Pixel size used for a cell's own geometry (grid lines, hit-testing, background offsets,
	 * token sizing...). Square grids are scaled up by `SQUARE_CELL_SCALE` so that, for the same
	 * stored `cellSize`, a square cell's edge matches a hex cell's flat-to-flat width — keeping
	 * everything (tokens included) visually consistent across a grid-type switch. Grid type "none"
	 * has no visible cells but still uses square math for its hidden fog substrate (see `updateCell`).
	 */
	effectiveCellSize(): number {
		return fogEffectiveCellSize(this.controller.getData());
	}

	/**
	 * A cell's actual on-screen width, for both grid types: a square's edge (already scaled by
	 * `effectiveCellSize`) and a hex's flat-to-flat width both equal `cellSize * SQUARE_CELL_SCALE`
	 * — hex functions just take the raw circumradius (`cellSize`) as their size parameter, so this
	 * needs its own scale-up rather than reusing `effectiveCellSize`. Used for anything sized
	 * "relative to the cell" regardless of grid type (tokens, vision range).
	 */
	cellVisualWidth(): number {
		return fogCellVisualWidth(this.controller.getData());
	}

	/** Grid type "none" is treated as "square" here — it has no visible cells, but fog still uses this square substrate. */
	cellKeyAt(worldX: number, worldY: number): string {
		return fogWorldPointToCellKey(this.controller.getData(), worldX, worldY);
	}

	/** Anchor cell for a dropped token: accounts for its footprint so its visual center lands under the pointer. */
	dropAnchorKey(token: Token, worldX: number, worldY: number): string {
		const data = this.controller.getData();
		const size = token.size ?? 1;
		if (data.gridType === "square" && size > 1) {
			const { a, b } = squareFootprintAnchor(worldX, worldY, this.effectiveCellSize(), size);
			return squareKey(a, b);
		}
		return this.cellKeyAt(worldX, worldY);
	}

	cellCenter(key: string): { x: number; y: number } {
		return fogCellCenter(this.controller.getData(), key);
	}

	/**
	 * Center of a token's footprint. On square grids, a token with size > 1 occupies a
	 * size×size block growing down and right from its anchor cell, so it never overlaps
	 * any cell outside that block. Hex grids have no such block concept, so the token is
	 * simply centered (and enlarged) on its single anchor cell.
	 */
	footprintCenter(token: Token): { x: number; y: number } {
		return fogFootprintCenter(this.controller.getData(), token);
	}

	tokenRadius(token: Token): number {
		return this.cellVisualWidth() * (token.size ?? 1) * TOKEN_SIZE_RATIO;
	}

	// ---- Point hit-tests ----

	findTokenAtScreenPoint(px: number, py: number): Token | null {
		const world = screenToWorld(px, py, this.transform);
		const data = this.controller.getData();
		const fogActive = this.fog.areEntitiesHidden();
		const tokens = data.tokens;
		for (let i = tokens.length - 1; i >= 0; i--) {
			const token = tokens[i];
			if (!token) continue;
			if (this.fog.isLightTokenHidden(token)) continue;
			const center = this.footprintCenter(token);
			if (Math.hypot(world.x - center.x, world.y - center.y) > this.tokenRadius(token)) continue;
			const isPlayer = (token.category ?? "entity") === "player";
			if (fogActive && !isPlayer && !this.fog.isEntityRevealed(center)) continue;
			return token;
		}
		return null;
	}

	markerHitRadius(): number {
		return this.cellVisualWidth() * TOKEN_SIZE_RATIO;
	}

	findMarkerAtScreenPoint(px: number, py: number): Marker | null {
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

	wallPointHitRadius(): number {
		return this.cellVisualWidth() * WALL_POINT_HIT_RATIO;
	}

	findWallPointAtScreenPoint(px: number, py: number): WallPoint | null {
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

	/** Closest committed `WallSegment` whose line passes within `WALL_SEGMENT_HIT_SCREEN_PX` of the screen point, or `null` — used both to select a segment (for its own type editor) and to insert a mid-point on it (see `MapCanvas`'s `dblclick` handler). */
	findWallSegmentAtScreenPoint(px: number, py: number): WallSegment | null {
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
	snapToWallSegmentLine(px: number, py: number): { x: number; y: number } | null {
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
	snapWorldToGrid(world: { x: number; y: number }): { x: number; y: number } {
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
	resolveWallPlacement(px: number, py: number): { x: number; y: number; existingPointId?: string } {
		const hit = this.findWallPointAtScreenPoint(px, py);
		if (hit) return { x: hit.x, y: hit.y, existingPointId: hit.id };
		const onSegment = this.snapToWallSegmentLine(px, py);
		if (onSegment) return onSegment;
		return this.snapWorldToGrid(screenToWorld(px, py, this.transform));
	}

	// ---- Rect queries (marquee/mass-selection) ----

	normalizedWorldRect(a: { x: number; y: number }, b: { x: number; y: number }): WorldRect {
		return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
	}

	/**
	 * Tries each kind in priority order and locks onto the first with any hits inside `rect` — used when
	 * a marquee drag starts on an unlocked selection. Stamps are deliberately never inferred here — a
	 * marquee over painted zone cells would otherwise scoop up huge swaths of the grid at once; see
	 * `MapCanvas.handleMarqueePointerUp`, which also blocks a marquee from adding to an
	 * already-`"stamp"`-locked selection.
	 */
	inferMarqueeKind(rect: WorldRect): MassSelectionKind | null {
		if (this.tokensInRect(rect).length > 0) return "token";
		if (this.wallSegmentsInRect(rect).length > 0) return "wallSegment";
		return null;
	}

	idsInRect(kind: MassSelectionKind, rect: WorldRect): string[] {
		if (kind === "token") return this.tokensInRect(rect);
		if (kind === "wallSegment") return this.wallSegmentsInRect(rect);
		return this.controller.getData().gridType === "none" ? this.markersInRect(rect) : this.cellsInRect(rect);
	}

	/**
	 * Same fog-visibility rule as `findTokenAtScreenPoint` — irrelevant to the edit-mode select tool
	 * (fog is never active there), but view mode's Shift-drag marquee reuses this too, so a GM's
	 * marquee can't scoop up an entity currently hidden by fog that a plain click on it couldn't
	 * have selected either. Only actually gates anything on the player-mirror canvas — see
	 * `FogRenderer.areEntitiesHidden`.
	 */
	tokensInRect(rect: WorldRect): string[] {
		const out: string[] = [];
		const fogActive = this.fog.areEntitiesHidden();
		for (const token of this.controller.getData().tokens) {
			if (this.fog.isLightTokenHidden(token)) continue;
			const c = this.footprintCenter(token);
			if (c.x < rect.minX || c.x > rect.maxX || c.y < rect.minY || c.y > rect.maxY) continue;
			const isPlayer = (token.category ?? "entity") === "player";
			if (fogActive && !isPlayer && !this.fog.isEntityRevealed(c)) continue;
			out.push(token.id);
		}
		return out;
	}

	/** A segment matches if either endpoint's world position falls inside `rect` ("touches" semantics, like most marquee tools). */
	wallSegmentsInRect(rect: WorldRect): string[] {
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

	markersInRect(rect: WorldRect): string[] {
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
	cellsInRect(rect: WorldRect): string[] {
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
}

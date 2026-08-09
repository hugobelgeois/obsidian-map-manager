import {
	DEFAULT_TOKEN_ROTATION,
	DEFAULT_VISION_ANGLE,
	DEFAULT_VISION_RADIUS,
	DEFAULT_VISION_RANGE,
	MapFileData,
	Token,
	VisionBlockerType,
	parseCellKey,
	squareKey,
} from "../data/mapData";
import { Point, SQUARE_CELL_SCALE, hexCellToWorldCenter, pointSegmentDistance, raySegmentDistance } from "./gridMath";

/**
 * Rays cast per player token when tracing vision (ray/path tracing, not grid tracing) — fixed
 * angular resolution independent of zoom, grid type, or cell size. 180 gives a 2° step, smooth
 * enough for cone edges without the cost scaling with how many cells are on screen.
 */
export const FOG_RAY_COUNT = 180;
/**
 * Size, in cell-widths, of the square buckets used only to persist "ever explored" ground.
 * Still coarser than the actual grid (and independent of grid type/shape) — exploration memory
 * doesn't need cell-level precision — but small enough to hug walls/blockers reasonably closely.
 */
export const FOG_BUCKET_SCALE = 1.25;
/**
 * How close (in cell-widths) a vision source has to be to a "dim"/partial wall segment for its
 * *directional cone* (`visionRange`/`visionAngle` — "être contre ce mur") to see through it at all.
 * Farther than this, a partial wall blocks the cone exactly like an opaque one instead of letting a
 * dim glimpse through from any distance — see the proximity check in `traceRays`. The omnidirectional
 * `visionRadius` fallback (rays outside the cone) is unaffected by this and keeps stopping at any
 * wall type regardless of distance, same as before this rule existed.
 */
export const WALL_ADJACENCY_CELLS = 1;

/** A `WallSegment` with its two endpoints resolved to world coordinates, for ray casting/flood-fill. */
export interface ResolvedWallSegment {
	a: Point;
	b: Point;
	type: VisionBlockerType;
}

/** One ray's traced reach, in world units from the token center, at a fixed angle (see `FOG_RAY_COUNT`). */
export interface RaySample {
	/** Distance to the first blocker of any kind (or the vision's natural edge if none). */
	clearEnd: number;
	/** Distance to the first *opaque* blocker (or the natural edge) — reaches past a "dim" blocker. */
	dimEnd: number;
}

/** A player token's traced vision: 0..360° rays fanning out from its center. Purely geometric — no cosmetic tremble. */
export interface VisionRays {
	center: { x: number; y: number };
	rays: RaySample[];
}

/**
 * World-unit size used for a cell's own geometry (grid lines, hit-testing, background offsets,
 * token sizing...). Square grids are scaled up by `SQUARE_CELL_SCALE` so that, for the same
 * stored `cellSize`, a square cell's edge matches a hex cell's flat-to-flat width. Grid type
 * "none" has no visible cells but still uses square math for its hidden fog substrate.
 */
export function effectiveCellSize(data: MapFileData): number {
	return data.gridType === "square" || data.gridType === "none" ? data.cellSize * SQUARE_CELL_SCALE : data.cellSize;
}

/**
 * A cell's actual world-space width, for both grid types: a square's edge (already scaled by
 * `effectiveCellSize`) and a hex's flat-to-flat width both equal `cellSize * SQUARE_CELL_SCALE`.
 * Used for anything sized "relative to the cell" regardless of grid type (tokens, vision range).
 */
export function cellVisualWidth(data: MapFileData): number {
	return data.cellSize * SQUARE_CELL_SCALE;
}

export function cellCenter(data: MapFileData, key: string): { x: number; y: number } {
	const { a, b } = parseCellKey(key);
	const cellSize = effectiveCellSize(data);
	if (data.gridType === "square") {
		return { x: a * cellSize + cellSize / 2, y: b * cellSize + cellSize / 2 };
	}
	const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
	return hexCellToWorldCenter(a, b, cellSize, orientation);
}

/**
 * Center of a token's footprint. On square grids, a token with size > 1 occupies a
 * size×size block growing down and right from its anchor cell, so it never overlaps
 * any cell outside that block. Hex grids have no such block concept, so the token is
 * simply centered (and enlarged) on its single anchor cell.
 */
export function footprintCenter(data: MapFileData, token: Token): { x: number; y: number } {
	if (data.gridType === "none") return { x: token.x ?? 0, y: token.y ?? 0 };
	const size = token.size ?? 1;
	const cellKey = token.cellKey ?? squareKey(0, 0);
	if (data.gridType !== "square" || size <= 1) return cellCenter(data, cellKey);
	const { a, b } = parseCellKey(cellKey);
	const cellSize = effectiveCellSize(data);
	return {
		x: a * cellSize + (size * cellSize) / 2,
		y: b * cellSize + (size * cellSize) / 2,
	};
}

/**
 * Every cell key a token's full footprint covers: on a square grid with `size` > 1, the whole
 * size×size block growing down/right from `cellKey` (its anchor — see `footprintCenter`); anything
 * else (hex, size 1) is just `[cellKey]`, since hex tokens are only ever centered/enlarged on their
 * single anchor cell.
 */
export function footprintCellKeys(data: MapFileData, cellKey: string, size: number): string[] {
	if (data.gridType !== "square" || size <= 1) return [cellKey];
	const { a, b } = parseCellKey(cellKey);
	const keys: string[] = [];
	for (let da = 0; da < size; da++) {
		for (let db = 0; db < size; db++) keys.push(squareKey(a + da, b + db));
	}
	return keys;
}

/**
 * Every cell key occupied by any token *not* in `excludeIds` (each expanded to its full footprint
 * via `footprintCellKeys`) — a batch-move collision check, used both by
 * `MapController.moveTokensToCells` and `MapCanvas`'s group-move/distribute-into-area preview so
 * the footprint math isn't duplicated between them. Tokens with no `cellKey` (grid type "none") are
 * skipped, same as any single-token collision check on this map.
 */
export function occupiedFootprintCells(data: MapFileData, excludeIds: ReadonlySet<string>): Set<string> {
	const occupied = new Set<string>();
	for (const token of data.tokens) {
		if (excludeIds.has(token.id) || !token.cellKey) continue;
		for (const key of footprintCellKeys(data, token.cellKey, token.size ?? 1)) occupied.add(key);
	}
	return occupied;
}

/** Every `WallSegment` (across visible layers) resolved to world-space endpoints, for ray casting and the fill tool's flood boundary. */
export function resolveWallSegments(data: MapFileData): ResolvedWallSegment[] {
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

/** Signed difference between two angles in degrees, normalized to [-180, 180]. */
function angleDiffDeg(a: number, b: number): number {
	let diff = (a - b) % 360;
	if (diff > 180) diff -= 360;
	if (diff < -180) diff += 360;
	return diff;
}

/**
 * Traces `FOG_RAY_COUNT` rays outward from `center` (the omnidirectional `radius` plus a
 * directional cone reaching `range` within `halfAngle` of `direction`, whichever reaches further at
 * a given angle) against `wallSegments`. Shared core for `castVisionRays` (a player's own facing
 * cone) and `castEntityConeRays` (one of an entity's `resolveEyeCones` cones) — everything about
 * *whose* angle/direction/reach this is lives in the caller, this function only knows geometry.
 *
 * A "dim" wall segment blocks a ray completely (both `clearEnd` and `dimEnd` stop there, same as an
 * opaque wall) *unless* that ray is inside the directional cone AND `center` sits within
 * `wallAdjacency` (world units, see `WALL_ADJACENCY_CELLS`) of the segment itself — only then does it
 * not block the ray at all (skipped entirely, as if it weren't there). The plain omnidirectional
 * `radius` fallback (rays outside the cone) never gets that exception, regardless of distance to the
 * wall — only the directional cone is ever meant to "peer through" a partial wall up close.
 */
function traceRays(
	center: Point,
	radius: number,
	range: number,
	halfAngle: number,
	direction: number,
	wallSegments: ResolvedWallSegment[],
	wallAdjacency: number
): RaySample[] {
	const rays: RaySample[] = [];
	for (let i = 0; i < FOG_RAY_COUNT; i++) {
		const angle = (360 / FOG_RAY_COUNT) * i;
		const inCone = range > 0 && (halfAngle >= 180 || Math.abs(angleDiffDeg(angle, direction)) <= halfAngle);
		const reach = inCone ? Math.max(radius, range) : radius;
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
			if (dist === null) continue;
			if (seg.type === "dim") {
				if (inCone && pointSegmentDistance(center, seg.a, seg.b) <= wallAdjacency) continue; // against it, cone only: fully passable
				hits.push({ dist, type: "opaque" }); // radius fallback, or cone but too far: blocks fully, like an opaque wall
				continue;
			}
			hits.push({ dist, type: seg.type });
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
	return rays;
}

/**
 * A player token's vision: the cone points wherever the token's own facing arrow does
 * (`token.rotation` — see `drawTokenFacingArrow`), full angle `token.visionAngle` — a player's
 * vision is tied to their token's facing, not a separate value, so turning the token turns what it
 * can see. Purely geometric (world units) — no cosmetic tremble, see `VisionRays`.
 *
 * `pose`, when given, overrides where the cone is cast from/toward instead of the token's own
 * committed `cellKey`/`x,y`/`rotation` — used by `MapCanvas` to keep fog reveal following a token's
 * live interpolated position during the "Animation" token-movement tween instead of jumping only
 * once the move commits (see `MapCanvas.currentAnimatedPose`).
 */
export function castVisionRays(data: MapFileData, token: Token, wallSegments: ResolvedWallSegment[], pose?: { center: Point; direction: number }): VisionRays {
	const center = pose?.center ?? footprintCenter(data, token);
	const radius = (token.visionRadius ?? DEFAULT_VISION_RADIUS) * cellVisualWidth(data);
	const range = (token.visionRange ?? DEFAULT_VISION_RANGE) * cellVisualWidth(data);
	const halfAngle = (token.visionAngle ?? DEFAULT_VISION_ANGLE) / 2;
	const direction = pose?.direction ?? token.rotation ?? DEFAULT_TOKEN_ROTATION;
	const wallAdjacency = WALL_ADJACENCY_CELLS * cellVisualWidth(data);
	return { center, rays: traceRays(center, radius, range, halfAngle, direction, wallSegments, wallAdjacency) };
}

/**
 * One of an entity's eye cones (see `resolveEyeCones` in `mapData.ts`): same geometry as
 * `castVisionRays`, but with an explicit `direction`/`fullAngleDeg` instead of the token's own
 * `rotation`/`visionAngle` — an entity's `visionRange`/`visionRadius` still supply the shared
 * magnitude (see `resolveEyeCones`'s doc comment on why every tier/cone reaches the same distance).
 */
export function castEntityConeRays(data: MapFileData, token: Token, direction: number, fullAngleDeg: number, wallSegments: ResolvedWallSegment[]): VisionRays {
	const center = footprintCenter(data, token);
	const radius = (token.visionRadius ?? DEFAULT_VISION_RADIUS) * cellVisualWidth(data);
	const range = (token.visionRange ?? DEFAULT_VISION_RANGE) * cellVisualWidth(data);
	const wallAdjacency = WALL_ADJACENCY_CELLS * cellVisualWidth(data);
	return { center, rays: traceRays(center, radius, range, fullAngleDeg / 2, direction, wallSegments, wallAdjacency) };
}

/** Every player token's traced vision, for `data` as a whole (all visible layers' walls). */
export function buildVisionCache(data: MapFileData): VisionRays[] {
	const wallSegments = resolveWallSegments(data);
	return data.tokens.filter((t) => (t.category ?? "entity") === "player").map((t) => castVisionRays(data, t, wallSegments));
}

/** Whether `worldX,worldY` falls within any cached token's traced reach (dim reach if `useDim`, else clear-only). */
export function isPointLit(cache: VisionRays[], worldX: number, worldY: number, useDim: boolean): boolean {
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

export function fogBucketSize(data: MapFileData): number {
	return cellVisualWidth(data) * FOG_BUCKET_SCALE;
}

/** Fog memory ("ever explored") is persisted on a coarse square bucket grid, independent of grid type/shape. */
export function fogBucketKeyAt(data: MapFileData, worldX: number, worldY: number): string {
	const base = fogBucketSize(data);
	return `${Math.floor(worldX / base)},${Math.floor(worldY / base)}`;
}

export function isWorldPointExplored(exploredSet: ReadonlySet<string>, data: MapFileData, worldX: number, worldY: number): boolean {
	return exploredSet.has(fogBucketKeyAt(data, worldX, worldY));
}

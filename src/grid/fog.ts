import {
	DEFAULT_VISION_RANGE,
	MapFileData,
	Token,
	VisionBlockerType,
	hexKey,
	parseCellKey,
	resolveLightRadius,
	squareKey,
	wallBlocksVision,
} from "../data/mapData";
import { Point, SQUARE_CELL_SCALE, hexCellToWorldCenter, hexWorldToCell, raySegmentDistance, squareWorldToCell } from "./gridMath";

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
/** A `WallSegment` with its two endpoints resolved to world coordinates, for ray casting/flood-fill. */
export interface ResolvedWallSegment {
	a: Point;
	b: Point;
	type: VisionBlockerType;
}

/**
 * One ray's traced reach, in world units from the token center, at a fixed angle (see `FOG_RAY_COUNT`).
 * `clearEnd` and `dimEnd` are always equal now — every `VisionBlockerType` either blocks a ray outright
 * (`wallBlocksVision`) or doesn't affect it at all, no in-between "hazy, slightly further" reach the
 * way the old (pre-v15) `"dim"` wall type produced. Kept as two fields anyway, rather than collapsing
 * to one, since `FogRenderer`'s fog-memory rendering (`appendVisionFan`'s paired dim/clear fan draw)
 * still reads them as two separate values — touching that is out of scope here.
 */
export interface RaySample {
	clearEnd: number;
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
 * The inverse of `cellCenter`: which cell key a world point falls in, for any grid type. Grid type
 * "none" is treated as "square" here — it has no visible cells, but fog still runs on this hidden
 * square substrate (see `MapController.updateCell`). Used both by `HitTester.cellKeyAt` (click
 * hit-testing) and `MapController.pasteTokens` (resolving a pasted token's world position onto
 * whatever grid the target map happens to use).
 */
export function worldPointToCellKey(data: MapFileData, x: number, y: number): string {
	const cellSize = effectiveCellSize(data);
	if (data.gridType === "square" || data.gridType === "none") {
		const c = squareWorldToCell(x, y, cellSize);
		return squareKey(c.a, c.b);
	}
	const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
	const c = hexWorldToCell(x, y, cellSize, orientation);
	return hexKey(c.a, c.b);
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
 * skipped, same as any single-token collision check on this map — as are "light" category tokens
 * (see `Token.category`'s doc comment): a pure light fixture, non-physical, never blocks another
 * token from moving onto its cell (see `MapController.moveToken`'s own matching exception).
 */
export function occupiedFootprintCells(data: MapFileData, excludeIds: ReadonlySet<string>): Set<string> {
	const occupied = new Set<string>();
	for (const token of data.tokens) {
		if (excludeIds.has(token.id) || !token.cellKey || (token.category ?? "entity") === "light") continue;
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
 * a given angle) against `wallSegments`. Shared core for `castLightRays` (a plain omnidirectional
 * `radius`, `range` pinned to `0`) and `castEntityConeRays` (one of an entity's `resolveEyeCones`
 * cones, `radius` pinned to `0`) — everything about *whose* angle/direction/reach this is lives in
 * the caller, this function only knows geometry.
 *
 * Only wall segments with `wallBlocksVision(seg.type)` ever stop a ray at all — anything else
 * (`"see-through"`/`"pass-see-through"`) is skipped entirely, as if it weren't there. Unlike the
 * pre-v15 `"dim"` wall type this replaced, there's no partial/proximity-dependent peek-through left:
 * a vision-blocking wall always fully blocks, a non-blocking one never blocks at all (see
 * `RaySample`'s own doc comment on why `clearEnd`/`dimEnd` end up equal here).
 */
function traceRays(center: Point, radius: number, range: number, halfAngle: number, direction: number, wallSegments: ResolvedWallSegment[]): RaySample[] {
	const blockers = wallSegments.filter((seg) => wallBlocksVision(seg.type));
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

		let end = reach;
		for (const seg of blockers) {
			const dist = raySegmentDistance(center, dx, dy, end, seg.a, seg.b);
			if (dist !== null && dist < end) end = dist;
		}
		rays.push({ clearEnd: end, dimEnd: end });
	}
	return rays;
}

/**
 * One of an entity's eye cones (see `resolveEyeCones` in `mapData.ts`): a directional cone reaching
 * `token.visionRange` within `fullAngleDeg` of `direction`, no omnidirectional fallback outside it
 * (`radius` pinned to `0` — an entity's `lightRadius`/`castLightRays` covers whatever it can see
 * outside its own eye cones now, same as any other category).
 */
export function castEntityConeRays(data: MapFileData, token: Token, direction: number, fullAngleDeg: number, wallSegments: ResolvedWallSegment[]): VisionRays {
	const center = footprintCenter(data, token);
	const range = (token.visionRange ?? DEFAULT_VISION_RANGE) * cellVisualWidth(data);
	return { center, rays: traceRays(center, 0, range, fullAngleDeg / 2, direction, wallSegments) };
}

/**
 * Every player token's traced fog-reveal reach, for `data` as a whole (all visible layers' walls) —
 * a player's fog reveal is their `lightRadius`, omnidirectional and wall-aware (see `castLightRays`),
 * not a directional cone. Used by `mapRedaction.ts` to redact the public snapshot the same way the
 * live game determines what's been explored.
 */
export function buildVisionCache(data: MapFileData): VisionRays[] {
	const wallSegments = resolveWallSegments(data);
	return data.tokens.filter((t) => (t.category ?? "entity") === "player").map((t) => castLightRays(data, t, wallSegments));
}

/**
 * A token's "light" reach (`resolveLightRadius`, any category — see the field's doc comment in
 * `mapData.ts`): a plain omnidirectional radius, fully blocked by any vision-blocking wall it meets
 * (`wallBlocksVision`). Reuses `traceRays` with `range` pinned at 0, so every angle falls outside its
 * (otherwise inactive) directional cone and gets the plain `radius` reach.
 *
 * `pose` mirrors `castEntityConeRays`'s own parameter (indirectly, via the direction it ignores) —
 * lets a light source keep tracking a token's live interpolated position during an in-flight
 * "Animation" move tween.
 */
export function castLightRays(data: MapFileData, token: Token, wallSegments: ResolvedWallSegment[], pose?: { center: Point; direction: number }): VisionRays {
	const center = pose?.center ?? footprintCenter(data, token);
	const radius = resolveLightRadius(token) * cellVisualWidth(data);
	return { center, rays: traceRays(center, radius, 0, 0, 0, wallSegments) };
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

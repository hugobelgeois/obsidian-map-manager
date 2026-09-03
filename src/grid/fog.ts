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
import { Point, SQUARE_CELL_SCALE, collinearOverlap, hexCellToWorldCenter, hexCorners, hexWorldToCell, raySegmentDistance, squareWorldToCell } from "./gridMath";

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
	/** The originating `WallSegment.id` — lets a caller (e.g. `MapCanvas.interactCrossedSegmentIds`) look the segment itself back up (its `clockTrigger`, in particular) once geometry alone has picked it out. */
	id: string;
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
	/**
	 * The light's *configured* reach in world units (before any wall clipping) — i.e. the radius of
	 * the true circle it would light in the open. `FogRenderer.renderCellFog` punches this exact
	 * circle (`ctx.arc`) so the lit area reads as a real circle with no ray-fan facets, then subtracts
	 * wall shadows separately. `0` for a directional-only entity cone.
	 */
	radius: number;
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
			result.push({ id: segment.id, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, type: segment.blockerType });
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
	return { center, rays: traceRays(center, 0, range, fullAngleDeg / 2, direction, wallSegments), radius: 0 };
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
	return { center, rays: traceRays(center, radius, 0, 0, 0, wallSegments), radius };
}

/**
 * Whether a straight line from `from` to `to` crosses any vision-blocking wall segment. Used to gate
 * a light's visible reach on whether a player token can actually see each part of it (see
 * `clipLightToPlayerLineOfSight`), and — exported for this — to gate a lit *entity*'s own visibility
 * on an exact check to its precise position (see `FogRenderer.isEntityRevealed`) rather than the
 * coarser, sampled-ray approximation `clipLightToPlayerLineOfSight` uses for the fog overlay's own
 * smooth area reveal.
 */
export function hasLineOfSight(from: Point, to: Point, wallSegments: ResolvedWallSegment[]): boolean {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dist = Math.hypot(dx, dy);
	if (dist <= 0) return true;
	const ux = dx / dist;
	const uy = dy / dist;
	for (const seg of wallSegments) {
		if (!wallBlocksVision(seg.type)) continue;
		const hit = raySegmentDistance(from, ux, uy, dist, seg.a, seg.b);
		// A hair short of `dist` so a wall sitting essentially right at the target (a light placed
		// flush against its own wall, most commonly) doesn't self-block on float rounding.
		if (hit !== null && hit < dist - 0.01) return false;
	}
	return true;
}

/**
 * Number of stepped samples checked along each light ray, from its far end inward, when clipping to
 * player line-of-sight (see `clipLightToPlayerLineOfSight`). A single point (either the light's own
 * source, or just the ray's far endpoint) isn't enough: a doorway standing between a player and a
 * lit room beyond it genuinely blocks LOS to *most* of that room from an off-center player position,
 * while still leaving the near portion of that very same ray visible — a whole-light on/off gate
 * wrongly reveals the entire far room the moment the player can see the light itself (e.g. through
 * that same doorway), and a single far-endpoint check wrongly zeroes an entire ray the moment its
 * exact tip happens to graze a wall's shadow, even when most of that ray's length is plainly open.
 * Stepping inward and keeping the farthest sample that's actually visible approximates the true
 * (continuous) visible sub-segment without needing a real polygon intersection.
 */
const LIGHT_LOS_SAMPLE_STEPS = 10;

/**
 * Clips a light source's own traced reach (`vision`, from `castLightRays` — already blocked by any
 * wall standing between the light and *itself*) down to only the parts a player could actually see:
 * each ray is walked inward from its traced endpoint in `LIGHT_LOS_SAMPLE_STEPS` steps (see its own
 * doc comment for why a single sample isn't enough), kept out to the farthest sample where at least
 * one of `playerCenters` has an unobstructed `hasLineOfSight` to it, and collapsed to 0 if none of
 * them do. This is a second, independent check from the light's own reach — walls between the
 * *viewer* and a given point, rather than walls between the light and empty space — so a light can
 * be fully "on" (reaching some open area from its own position) while a player standing on the other
 * side of a wall from it still can't see any (or only part) of that area.
 *
 * With no player tokens on the map at all, nothing can see any light, so every ray collapses to 0.
 */
export function clipLightToPlayerLineOfSight(vision: VisionRays, playerCenters: Point[], wallSegments: ResolvedWallSegment[]): VisionRays {
	if (playerCenters.length === 0) return { center: vision.center, radius: vision.radius, rays: vision.rays.map(() => ({ clearEnd: 0, dimEnd: 0 })) };
	const rayCount = vision.rays.length;
	const rays = vision.rays.map((ray, i) => {
		if (ray.clearEnd <= 0) return ray;
		const angle = (360 / rayCount) * i;
		const rad = (angle * Math.PI) / 180;
		const dx = Math.cos(rad);
		const dy = Math.sin(rad);
		let visibleEnd = 0;
		for (let s = LIGHT_LOS_SAMPLE_STEPS; s >= 1; s--) {
			const d = (ray.clearEnd * s) / LIGHT_LOS_SAMPLE_STEPS;
			const point = { x: vision.center.x + dx * d, y: vision.center.y + dy * d };
			if (playerCenters.some((center) => hasLineOfSight(center, point, wallSegments))) {
				visibleEnd = d;
				break;
			}
		}
		return { clearEnd: visibleEnd, dimEnd: visibleEnd };
	});
	return { center: vision.center, radius: vision.radius, rays };
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

// ---------------- "Avec grillage" per-cell fog (celled grid types) ----------------

export interface FogWorldRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Explored-memory cell keys whose center falls within `rect` grown by `margin` — bounds all per-cell
 * fog work by what's actually on screen rather than by the grid's extent, so it stays cheap however
 * far the view is zoomed out (`FogRenderer.renderCellFog` / `drawCellFogMask`).
 */
export function exploredCellsInRect(data: MapFileData, exploredSet: ReadonlySet<string>, rect: FogWorldRect, margin: number): string[] {
	const out: string[] = [];
	for (const key of exploredSet) {
		const c = cellCenter(data, key);
		if (c.x >= rect.minX - margin && c.x <= rect.maxX + margin && c.y >= rect.minY - margin && c.y <= rect.maxY + margin) out.push(key);
	}
	return out;
}

/** Corners of the grid cell `key`, world coordinates — 4 for a square grid, 6 for a hex grid (order: `[NW, NE, SE, SW]` for square). */
export function cellPolygon(data: MapFileData, key: string): Point[] {
	const { a, b } = parseCellKey(key);
	const size = effectiveCellSize(data);
	if (data.gridType === "square" || data.gridType === "none") {
		const x0 = a * size;
		const y0 = b * size;
		return [
			{ x: x0, y: y0 },
			{ x: x0 + size, y: y0 },
			{ x: x0 + size, y: y0 + size },
			{ x: x0, y: y0 + size },
		];
	}
	const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
	const center = hexCellToWorldCenter(a, b, size, orientation);
	return hexCorners(center.x, center.y, size, orientation);
}

/** Sample points used to decide whether a cell is *entirely* lit: its corners, centroid, and edge midpoints. */
function cellSamplePoints(poly: Point[]): Point[] {
	const pts: Point[] = [...poly];
	let sx = 0;
	let sy = 0;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i];
		const q = poly[(i + 1) % poly.length];
		if (!p || !q) continue;
		sx += p.x;
		sy += p.y;
		pts.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
	}
	pts.push({ x: sx / poly.length, y: sy / poly.length });
	return pts;
}

/**
 * Whether every part of cell `key` is currently visible to a player: each sample point (corners,
 * edge midpoints, centroid) has to be (a) inside some `lightSources` circle *and* in that light's own
 * direct line of sight — the player's own light, or an external light source such as a torch — and
 * (b) in some `viewerCenters` (player token) line of sight. Exact wall tests (`hasLineOfSight`), not
 * the angularly-quantized ray cache, so a point near a circle edge doesn't fail on rounding. Drives
 * the live "a fully-revealed cell becomes permanently explored" rule (`FogRenderer.renderCellFog` →
 * `MapController.markExplored`) — so a room lit by an outside torch that a player can see gets
 * unlocked even though it's outside the player's own light radius. A cell a wall cuts through stays
 * unexplored on its far side (those samples fail one of the line-of-sight checks).
 */
export function isCellFullyLit(
	data: MapFileData,
	key: string,
	lightSources: VisionRays[],
	viewerCenters: Point[],
	wallSegments: ResolvedWallSegment[]
): boolean {
	if (lightSources.length === 0 || viewerCenters.length === 0) return false;
	for (const p of cellSamplePoints(cellPolygon(data, key))) {
		const lit = lightSources.some((l) => {
			if (l.radius <= 0) return false;
			// A hair of slack so a sample sitting exactly on the radius still counts.
			return Math.hypot(p.x - l.center.x, p.y - l.center.y) <= l.radius + 0.01 && hasLineOfSight(l.center, p, wallSegments);
		});
		if (!lit) return false;
		if (!viewerCenters.some((c) => hasLineOfSight(c, p, wallSegments))) return false;
	}
	return true;
}

/**
 * `traceVisibilityPolygon` splits the full circle into this many seed arcs before adaptive
 * subdivision takes over. Each seed arc is < 180° (so the "one continuous straight wall spans the
 * whole arc" short-circuit stays valid) and small enough that the mid-arc guard rays land where they
 * should. Offset by `VIS_SEED_OFFSET` so a seed boundary never falls exactly on a wall corner.
 */
const VIS_SEED_ARCS = 6;
const VIS_SEED_OFFSET = 0.123;
/** Largest angular step `traceVisibilityPolygon` leaves un-subdivided in an *open* direction (no wall corner to aim at) — keeps the far-field polygon edge from bowing inside the light circle when zoomed out. ~12°. */
const VIS_MAX_STEP = (12 * Math.PI) / 180;
/** Hard recursion / vertex ceilings for `traceVisibilityPolygon` — a runaway on pathological wall geometry degrades to a coarser polygon instead of hanging. */
const VIS_MAX_DEPTH = 40;
const VIS_MAX_VERTS = 6000;

/** Whether wall `b` is collinear with wall `a` *and* their spans touch or overlap along that line with no gap — i.e. the two segments form one continuous straight occluder (a straight run split into pieces, or a shared corner that doesn't actually turn). A doorway-sized gap between two collinear walls returns `false`. */
function straightContinuousRun(a: ResolvedWallSegment, b: ResolvedWallSegment): boolean {
	const dx = a.b.x - a.a.x;
	const dy = a.b.y - a.a.y;
	const len = Math.hypot(dx, dy);
	if (len === 0) return false;
	const ux = dx / len;
	const uy = dy / len;
	const tol = Math.max(0.5, len * 1e-3);
	const perp = (p: Point) => Math.abs((p.x - a.a.x) * uy - (p.y - a.a.y) * ux);
	if (perp(b.a) > tol || perp(b.b) > tol) return false;
	const proj = (p: Point) => (p.x - a.a.x) * ux + (p.y - a.a.y) * uy;
	let bLo = proj(b.a);
	let bHi = proj(b.b);
	if (bLo > bHi) [bLo, bHi] = [bHi, bLo];
	// Gap between [0, len] (segment a) and [bLo, bHi] (segment b) along the shared line.
	return Math.max(0, bLo) - Math.min(len, bHi) <= tol;
}

/**
 * The player's line of sight as a polygon, in angular order — the classic 2D visibility polygon,
 * traced `far` world units outward ("jusqu'au prochain mur / à l'infini" — the caller passes a
 * distance well past anything on screen). `FogRenderer.renderCellFog` clips its fog punch to this
 * polygon and then punches the actual *light* inside it (the token's own radius circle as a true
 * `ctx.arc`; every other light source's own reach) — so what the player sees is exactly
 * "line of sight ∩ light": a smooth circle edge where the light just runs out, a straight edge where
 * a wall cuts it, other lit rooms revealed only where this same line of sight reaches them.
 *
 * **Adaptive subdivision**, rather than a fixed fan: the circle is cut into `VIS_SEED_ARCS` seed
 * arcs, and each arc is refined only where the geometry actually changes —
 *
 * - if the arc's two bounding rays land on one continuous straight occluder (same wall segment, or
 *   collinear touching segments — `straightContinuousRun`) with nothing poking in front, the
 *   boundary between them is a single straight edge and no ray is cast between them ("si 2 points
 *   sont reliés par un mur droit continu, on ne raycast pas entre eux");
 * - otherwise the nearest vision-blocking wall corner whose angle falls strictly inside the arc and
 *   that sits in front of the arc's bounds is picked, a ray is cast just each side of it (± a hair,
 *   so a shadow edge is one straight line past the corner, not a staircase), and the two sub-arcs
 *   recurse ("on détecte les coins les plus proches entre ces 2 points et on recommence");
 * - a wall-less arc wider than `VIS_MAX_STEP` is just bisected so its far-field edge stays put.
 *
 * Corners fully hidden behind a nearer continuous wall are never aimed at (the arc covering them
 * short-circuits first), and there is no always-on safety ring — so closed interiors and
 * heavily-occluded views cost a fraction of the old fixed fan.
 */
export function traceVisibilityPolygon(center: Point, far: number, wallSegments: ResolvedWallSegment[]): Point[] {
	const blockers = wallSegments.filter((seg) => wallBlocksVision(seg.type));
	const TWO_PI = 2 * Math.PI;
	const eps = 1e-4;

	if (blockers.length === 0) {
		// Nothing to occlude — a plain far-field ring at the open-arc resolution.
		const ring: Point[] = [];
		const steps = Math.ceil(TWO_PI / VIS_MAX_STEP);
		for (let i = 0; i < steps; i++) {
			const a = VIS_SEED_OFFSET + (TWO_PI * i) / steps;
			ring.push({ x: center.x + Math.cos(a) * far, y: center.y + Math.sin(a) * far });
		}
		return ring;
	}

	const blockerById = new Map(blockers.map((seg) => [seg.id, seg]));
	const corners: { angle: number; dist: number }[] = [];
	for (const seg of blockers) {
		for (const p of [seg.a, seg.b]) {
			corners.push({
				angle: Math.atan2(p.y - center.y, p.x - center.x),
				dist: Math.hypot(p.x - center.x, p.y - center.y),
			});
		}
	}

	interface Hit {
		point: Point;
		dist: number;
		segId: string | null;
	}
	const hitCache = new Map<number, Hit>();
	const castHit = (angle: number): Hit => {
		const key = Math.round(angle / eps);
		const cached = hitCache.get(key);
		if (cached) return cached;
		const dx = Math.cos(angle);
		const dy = Math.sin(angle);
		let end = far;
		let segId: string | null = null;
		for (const seg of blockers) {
			const t = raySegmentDistance(center, dx, dy, end, seg.a, seg.b);
			if (t !== null && t < end) {
				end = t;
				segId = seg.id;
			}
		}
		const hit: Hit = { point: { x: center.x + dx * end, y: center.y + dy * end }, dist: end, segId };
		hitCache.set(key, hit);
		return hit;
	};

	// Whether the visibility boundary across the whole arc [lo, hi] is a single straight edge: both
	// bounding rays hit real wall on one continuous straight occluder, and a mid-arc guard ray isn't
	// stopped short by something closer poking in front.
	const isStraightSpan = (lo: number, hi: number, hLo: Hit, hHi: Hit): boolean => {
		if (hLo.segId === null || hHi.segId === null) return false;
		if (hLo.segId !== hHi.segId) {
			const segA = blockerById.get(hLo.segId);
			const segB = blockerById.get(hHi.segId);
			if (!segA || !segB || !straightContinuousRun(segA, segB)) return false;
		}
		const mid = (lo + hi) / 2;
		const dx = Math.cos(mid);
		const dy = Math.sin(mid);
		const expected = raySegmentDistance(center, dx, dy, far, hLo.point, hHi.point);
		if (expected === null) return false;
		const actual = castHit(mid).dist;
		return actual >= expected - Math.max(0.5, expected * 0.02);
	};

	const out: Point[] = [];
	const push = (angle: number) => {
		if (out.length < VIS_MAX_VERTS) out.push(castHit(angle).point);
	};

	// Emits the polygon vertices for the half-open arc (lo, hi] — the caller has already pushed lo's
	// vertex. lo/hi are unwrapped (may exceed 2π); each seed arc spans < 180°.
	const emitArc = (lo: number, hi: number, depth: number): void => {
		if (hi - lo <= eps) return;
		const hLo = castHit(lo);
		const hHi = castHit(hi);

		if (depth < VIS_MAX_DEPTH && out.length < VIS_MAX_VERTS) {
			// Nearest wall corner strictly inside the arc that sits in front of the arc's far bound —
			// the next silhouette to resolve. Corners behind what we already see are left alone.
			const farBound = Math.max(hLo.dist, hHi.dist);
			const slack = Math.max(0.5, farBound * 1e-3);
			let best: number | null = null;
			let bestDist = Infinity;
			for (const c of corners) {
				for (const cand of [c.angle, c.angle + TWO_PI, c.angle - TWO_PI]) {
					if (cand > lo + 2 * eps && cand < hi - 2 * eps && c.dist < farBound - slack && c.dist < bestDist) {
						best = cand;
						bestDist = c.dist;
					}
				}
			}
			if (best !== null) {
				const aMinus = best - eps;
				const aPlus = best + eps;
				// emitArc(lo, aMinus) ends by pushing the aMinus vertex itself; we only add the
				// far side of the corner before recursing on.
				emitArc(lo, aMinus, depth + 1);
				push(aPlus);
				emitArc(aPlus, hi, depth + 1);
				return;
			}
		}

		if (!isStraightSpan(lo, hi, hLo, hHi) && hi - lo > VIS_MAX_STEP && depth < VIS_MAX_DEPTH && out.length < VIS_MAX_VERTS) {
			const mid = (lo + hi) / 2;
			// emitArc(lo, mid) pushes the mid vertex; emitArc(mid, hi) pushes hi.
			emitArc(lo, mid, depth + 1);
			emitArc(mid, hi, depth + 1);
			return;
		}

		push(hi);
	};

	const seed0 = VIS_SEED_OFFSET;
	push(seed0);
	for (let k = 0; k < VIS_SEED_ARCS; k++) {
		const lo = seed0 + (TWO_PI * k) / VIS_SEED_ARCS;
		const hi = seed0 + (TWO_PI * (k + 1)) / VIS_SEED_ARCS;
		emitArc(lo, hi, 0);
	}
	// The last seed arc closed back onto seed0's vertex — drop the duplicate.
	out.pop();
	return out;
}

/** The world-space segment shared by the touching edge of two orthogonally-adjacent cells, or `null` if they don't share a full edge. Square grids only. */
function sharedSquareEdge(data: MapFileData, keyA: string, keyB: string): [Point, Point] | null {
	const size = effectiveCellSize(data);
	const A = parseCellKey(keyA);
	const B = parseCellKey(keyB);
	const da = B.a - A.a;
	const db = B.b - A.b;
	if (Math.abs(da) + Math.abs(db) !== 1) return null;
	const x0 = A.a * size;
	const y0 = A.b * size;
	if (da === 1) return [{ x: x0 + size, y: y0 }, { x: x0 + size, y: y0 + size }];
	if (da === -1) return [{ x: x0, y: y0 }, { x: x0, y: y0 + size }];
	if (db === 1) return [{ x: x0, y: y0 + size }, { x: x0 + size, y: y0 + size }];
	return [{ x: x0, y: y0 }, { x: x0 + size, y: y0 }];
}

/** Whether a wall segment runs along the edge shared by cells `keyA`/`keyB` (any blocker type — a see-through window still physically separates them). Square grids only. */
export function cellsWallSeparated(data: MapFileData, keyA: string, keyB: string, wallSegments: ResolvedWallSegment[]): boolean {
	const edge = sharedSquareEdge(data, keyA, keyB);
	if (!edge) return false;
	return wallSegments.some((seg) => collinearOverlap(edge[0], edge[1], seg.a, seg.b) !== null);
}

/**
 * Black half-cell triangles for the diagonal split at concave corners of an explored square cell:
 * for each of the 4 corners, if both orthogonally-adjacent cells there are "fog" per `isFogNeighbour`
 * (which must already exclude neighbours separated by a wall — "sans prendre en compte les angles à
 * travers les murs"), the cell is cut along the diagonal between the two *other* corners and the
 * half containing the concave corner is returned, to be filled at full fog opacity while the rest
 * stays at explored opacity. Square grids only (hex has no natural diagonal) — returns `[]` otherwise.
 */
export function concaveCornerBlackTriangles(data: MapFileData, key: string, isFogNeighbour: (neighbourKey: string) => boolean): Point[][] {
	if (data.gridType !== "square") return [];
	const { a, b } = parseCellKey(key);
	const [nw, ne, se, sw] = cellPolygon(data, key);
	if (!nw || !ne || !se || !sw) return [];
	const N = squareKey(a, b - 1);
	const S = squareKey(a, b + 1);
	const E = squareKey(a + 1, b);
	const W = squareKey(a - 1, b);
	const fogN = isFogNeighbour(N);
	const fogS = isFogNeighbour(S);
	const fogE = isFogNeighbour(E);
	const fogW = isFogNeighbour(W);
	const tris: Point[][] = [];
	if (fogN && fogW) tris.push([nw, ne, sw]); // concave at NW → diagonal NE–SW
	if (fogN && fogE) tris.push([ne, nw, se]); // concave at NE → diagonal NW–SE
	if (fogS && fogE) tris.push([se, ne, sw]); // concave at SE → diagonal NE–SW
	if (fogS && fogW) tris.push([sw, nw, se]); // concave at SW → diagonal NW–SE
	return tris;
}

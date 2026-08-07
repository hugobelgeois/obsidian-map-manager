export interface ViewTransform {
	zoom: number;
	panX: number;
	panY: number;
}

export interface AxialCoord {
	a: number;
	b: number;
}

export type HexOrientation = "pointy" | "flat";

const SQRT3 = Math.sqrt(3);

export function worldToScreen(x: number, y: number, t: ViewTransform): { x: number; y: number } {
	return { x: x * t.zoom + t.panX, y: y * t.zoom + t.panY };
}

export function screenToWorld(x: number, y: number, t: ViewTransform): { x: number; y: number } {
	return { x: (x - t.panX) / t.zoom, y: (y - t.panY) / t.zoom };
}

// ---------------- Square grid ----------------

/** Rounds to the nearest integer, with exact .5 ties going down (toward -Infinity) rather than up. */
function roundHalfDown(v: number): number {
	return Math.ceil(v - 0.5);
}

/**
 * Same as a plain floor-based cell lookup, except a point landing exactly on a cell edge
 * resolves to the cell above/left of it rather than below/right — i.e. ties go to the
 * top-left cell, matching "closest cell to the point, top-left wins on a tie".
 */
function nearestCellIndex(v: number, cellSize: number): number {
	return roundHalfDown(v / cellSize - 0.5);
}

export function squareWorldToCell(x: number, y: number, cellSize: number): AxialCoord {
	return { a: nearestCellIndex(x, cellSize), b: nearestCellIndex(y, cellSize) };
}

/** Nearest grid intersection (corner shared by 4 cells), ties going to the top-left vertex. */
export function nearestSquareVertex(x: number, y: number, cellSize: number): AxialCoord {
	return { a: roundHalfDown(x / cellSize), b: roundHalfDown(y / cellSize) };
}

/**
 * Top-left anchor cell for a size×size square token footprint, given the point where its
 * visual center is dropped:
 * - Odd sizes (1×1, 3×3, ...) have a true center cell: the footprint is centered on
 *   whichever cell is nearest to the point.
 * - Even sizes (2×2, ...) have no center cell (their center sits on a grid intersection):
 *   the footprint is centered on whichever grid intersection is nearest to the point.
 */
export function squareFootprintAnchor(x: number, y: number, cellSize: number, size: number): AxialCoord {
	if (size % 2 === 1) {
		const half = (size - 1) / 2;
		const center = squareWorldToCell(x, y, cellSize);
		return { a: center.a - half, b: center.b - half };
	}
	const half = size / 2;
	const vertex = nearestSquareVertex(x, y, cellSize);
	return { a: vertex.a - half, b: vertex.b - half };
}

export function getVisibleSquareCells(t: ViewTransform, cellSize: number, viewportW: number, viewportH: number): AxialCoord[] {
	const topLeft = screenToWorld(0, 0, t);
	const bottomRight = screenToWorld(viewportW, viewportH, t);
	const c0 = Math.floor(topLeft.x / cellSize) - 1;
	const c1 = Math.ceil(bottomRight.x / cellSize) + 1;
	const r0 = Math.floor(topLeft.y / cellSize) - 1;
	const r1 = Math.ceil(bottomRight.y / cellSize) + 1;
	const cells: AxialCoord[] = [];
	for (let row = r0; row <= r1; row++) {
		for (let col = c0; col <= c1; col++) {
			cells.push({ a: col, b: row });
		}
	}
	return cells;
}

/**
 * Square cell indices whose cells intersect a world-space rectangle, with a 1-cell margin — the
 * same bounding-box logic as `getVisibleSquareCells`, but driven by an arbitrary world rect instead
 * of a live viewport/`ViewTransform`. Used to enumerate every cell under a background image (see
 * `detectMagicWalls`) without a canvas to project through.
 */
export function squareCellsInWorldRect(minX: number, minY: number, maxX: number, maxY: number, cellSize: number): AxialCoord[] {
	const c0 = Math.floor(minX / cellSize) - 1;
	const c1 = Math.ceil(maxX / cellSize) + 1;
	const r0 = Math.floor(minY / cellSize) - 1;
	const r1 = Math.ceil(maxY / cellSize) + 1;
	const cells: AxialCoord[] = [];
	for (let row = r0; row <= r1; row++) {
		for (let col = c0; col <= c1; col++) {
			cells.push({ a: col, b: row });
		}
	}
	return cells;
}

/** The 4 edges of square cell `(col, row)`, each as a `[a, b]` endpoint pair, in world coordinates. */
export function squareCellEdges(col: number, row: number, cellSize: number): [Point, Point][] {
	const x0 = col * cellSize;
	const y0 = row * cellSize;
	const x1 = x0 + cellSize;
	const y1 = y0 + cellSize;
	const corners: Point[] = [
		{ x: x0, y: y0 },
		{ x: x1, y: y0 },
		{ x: x1, y: y1 },
		{ x: x0, y: y1 },
	];
	return [
		[corners[0] as Point, corners[1] as Point],
		[corners[1] as Point, corners[2] as Point],
		[corners[2] as Point, corners[3] as Point],
		[corners[3] as Point, corners[0] as Point],
	];
}

// ---------------- Hex grid (axial q,r) ----------------

export function hexCellToWorldCenter(q: number, r: number, size: number, orientation: HexOrientation): { x: number; y: number } {
	if (orientation === "pointy") {
		return { x: size * (SQRT3 * q + (SQRT3 / 2) * r), y: size * (1.5 * r) };
	}
	return { x: size * (1.5 * q), y: size * ((SQRT3 / 2) * q + SQRT3 * r) };
}

function hexRound(q: number, r: number): AxialCoord {
	const x = q;
	const z = r;
	const y = -x - z;
	let rx = Math.round(x);
	let ry = Math.round(y);
	let rz = Math.round(z);
	const xDiff = Math.abs(rx - x);
	const yDiff = Math.abs(ry - y);
	const zDiff = Math.abs(rz - z);
	if (xDiff > yDiff && xDiff > zDiff) {
		rx = -ry - rz;
	} else if (yDiff > zDiff) {
		ry = -rx - rz;
	} else {
		rz = -rx - ry;
	}
	return { a: rx, b: rz };
}

export function hexWorldToCell(x: number, y: number, size: number, orientation: HexOrientation): AxialCoord {
	let q: number;
	let r: number;
	if (orientation === "pointy") {
		q = ((SQRT3 / 3) * x - (1 / 3) * y) / size;
		r = ((2 / 3) * y) / size;
	} else {
		q = ((2 / 3) * x) / size;
		r = ((-1 / 3) * x + (SQRT3 / 3) * y) / size;
	}
	return hexRound(q, r);
}

export function hexCorners(cx: number, cy: number, size: number, orientation: HexOrientation): { x: number; y: number }[] {
	const corners: { x: number; y: number }[] = [];
	for (let i = 0; i < 6; i++) {
		const angleDeg = 60 * i + (orientation === "pointy" ? 30 : 0);
		const angleRad = (Math.PI / 180) * angleDeg;
		corners.push({ x: cx + size * Math.cos(angleRad), y: cy + size * Math.sin(angleRad) });
	}
	return corners;
}

export function getVisibleHexCells(t: ViewTransform, size: number, orientation: HexOrientation, viewportW: number, viewportH: number): AxialCoord[] {
	const corners = [
		screenToWorld(0, 0, t),
		screenToWorld(viewportW, 0, t),
		screenToWorld(0, viewportH, t),
		screenToWorld(viewportW, viewportH, t),
	];
	let qMin = Infinity;
	let qMax = -Infinity;
	let rMin = Infinity;
	let rMax = -Infinity;
	for (const c of corners) {
		const hc = hexWorldToCell(c.x, c.y, size, orientation);
		qMin = Math.min(qMin, hc.a);
		qMax = Math.max(qMax, hc.a);
		rMin = Math.min(rMin, hc.b);
		rMax = Math.max(rMax, hc.b);
	}
	const margin = 2;
	const cells: AxialCoord[] = [];
	for (let r = rMin - margin; r <= rMax + margin; r++) {
		for (let q = qMin - margin; q <= qMax + margin; q++) {
			cells.push({ a: q, b: r });
		}
	}
	return cells;
}

/**
 * Axial hex cell coordinates whose cells intersect a world-space rectangle, with a margin — the
 * same bounding-box logic as `getVisibleHexCells`, but driven by an arbitrary world rect instead of
 * a live viewport/`ViewTransform`. Used to enumerate every cell under a background image (see
 * `detectMagicWalls`) without a canvas to project through.
 */
export function hexCellsInWorldRect(minX: number, minY: number, maxX: number, maxY: number, size: number, orientation: HexOrientation): AxialCoord[] {
	const corners: Point[] = [
		{ x: minX, y: minY },
		{ x: maxX, y: minY },
		{ x: minX, y: maxY },
		{ x: maxX, y: maxY },
	];
	let qMin = Infinity;
	let qMax = -Infinity;
	let rMin = Infinity;
	let rMax = -Infinity;
	for (const c of corners) {
		const hc = hexWorldToCell(c.x, c.y, size, orientation);
		qMin = Math.min(qMin, hc.a);
		qMax = Math.max(qMax, hc.a);
		rMin = Math.min(rMin, hc.b);
		rMax = Math.max(rMax, hc.b);
	}
	const margin = 1;
	const cells: AxialCoord[] = [];
	for (let r = rMin - margin; r <= rMax + margin; r++) {
		for (let q = qMin - margin; q <= qMax + margin; q++) {
			cells.push({ a: q, b: r });
		}
	}
	return cells;
}

/** The 6 edges of hex cell `(q, r)`, each as a `[a, b]` endpoint pair, in world coordinates. */
export function hexCellEdges(q: number, r: number, size: number, orientation: HexOrientation): [Point, Point][] {
	const center = hexCellToWorldCenter(q, r, size, orientation);
	const corners = hexCorners(center.x, center.y, size, orientation);
	const edges: [Point, Point][] = [];
	for (let i = 0; i < corners.length; i++) {
		const a = corners[i];
		const b = corners[(i + 1) % corners.length];
		if (a && b) edges.push([a, b]);
	}
	return edges;
}

/** Hard safety rails: no per-map zoom setting can go beyond these. */
export const ABS_MIN_ZOOM = 0.02;
export const ABS_MAX_ZOOM = 10;

/** Sensible starting point for a new map's configurable zoom range. */
export const DEFAULT_MIN_ZOOM = 0.05;
export const DEFAULT_MAX_ZOOM = 3;

/**
 * Applied to `cellSize` when rendering a square grid so that, for the same stored `cellSize`,
 * a square cell's edge matches a hex cell's flat-to-flat width (`cellSize * sqrt(3)`, since hex
 * cells use `cellSize` as their circumradius). This keeps token sizes visually consistent when
 * switching between square and hex grids.
 */
export const SQUARE_CELL_SCALE = Math.sqrt(3);

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// ---------------- Wall-point grid snapping ----------------

export interface Point {
	x: number;
	y: number;
}

/** 0 = a grid corner, 1 = an edge's midpoint, 2 = anywhere along an edge (projected, clamped to the segment). */
export interface SnapCandidate extends Point {
	priority: 0 | 1 | 2;
}

/** Nearest point on segment `a`-`b` to `(x, y)`, clamped to the segment (not the infinite line). */
export function projectOntoSegment(x: number, y: number, a: Point, b: Point): Point {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const lenSq = abx * abx + aby * aby;
	if (lenSq === 0) return { x: a.x, y: a.y };
	const t = clamp(((x - a.x) * abx + (y - a.y) * aby) / lenSq, 0, 1);
	return { x: a.x + t * abx, y: a.y + t * aby };
}

/** Corner (priority 0), midpoint (priority 1) and nearest-projected-point (priority 2) candidates for each edge of a closed polygon (`corners`, in order). */
function polygonSnapCandidates(corners: Point[], x: number, y: number): SnapCandidate[] {
	const candidates: SnapCandidate[] = corners.map((c) => ({ x: c.x, y: c.y, priority: 0 }));
	const n = corners.length;
	for (let i = 0; i < n; i++) {
		const a = corners[i];
		const b = corners[(i + 1) % n];
		if (!a || !b) continue;
		candidates.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, priority: 1 });
		const proj = projectOntoSegment(x, y, a, b);
		candidates.push({ ...proj, priority: 2 });
	}
	return candidates;
}

/** Corners/edges/midpoints of the square grid cell containing `(x, y)`, for wall-point snapping. */
export function squareGridSnapCandidates(x: number, y: number, cellSize: number): SnapCandidate[] {
	const col = Math.floor(x / cellSize);
	const row = Math.floor(y / cellSize);
	const corners: Point[] = [
		{ x: col * cellSize, y: row * cellSize },
		{ x: (col + 1) * cellSize, y: row * cellSize },
		{ x: (col + 1) * cellSize, y: (row + 1) * cellSize },
		{ x: col * cellSize, y: (row + 1) * cellSize },
	];
	return polygonSnapCandidates(corners, x, y);
}

/** Corners/edges/midpoints of the hex grid cell containing `(x, y)`, for wall-point snapping. */
export function hexGridSnapCandidates(x: number, y: number, cellSize: number, orientation: HexOrientation): SnapCandidate[] {
	const cell = hexWorldToCell(x, y, cellSize, orientation);
	const center = hexCellToWorldCenter(cell.a, cell.b, cellSize, orientation);
	const corners = hexCorners(center.x, center.y, cellSize, orientation);
	return polygonSnapCandidates(corners, x, y);
}

// ---------------- Segment / ray-segment intersection ----------------

/** Where two finite segments `p1`-`p2` and `p3`-`p4` cross, or `null` if they don't (parallel or out of range). */
export function segmentIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
	const d1x = p2.x - p1.x;
	const d1y = p2.y - p1.y;
	const d2x = p4.x - p3.x;
	const d2y = p4.y - p3.y;
	const denom = d1x * d2y - d1y * d2x;
	if (denom === 0) return null;
	const dx = p3.x - p1.x;
	const dy = p3.y - p1.y;
	const t = (dx * d2y - dy * d2x) / denom;
	const u = (dx * d1y - dy * d1x) / denom;
	if (t < 0 || t > 1 || u < 0 || u > 1) return null;
	return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/**
 * Parameter `t` such that `a + t*(b-a)` is the closest point on the infinite line through `a`-`b`
 * to `p` — unlike `projectOntoSegment`, NOT clamped to `[0, 1]`, so a caller can tell whether `p`
 * sits before, after, or within the segment's own extent (used to reconcile a wall segment against
 * one it's collinear with — see `collinearOverlap`/`MapController.addWallSegment`).
 */
export function projectParam(p: Point, a: Point, b: Point): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const lenSq = abx * abx + aby * aby;
	if (lenSq === 0) return 0;
	return ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
}

/**
 * Where segments `p1`-`p2` and `p3`-`p4` overlap along their shared line, as a `t` range along
 * `p1`-`p2` (`0` = `p1`, `1` = `p2`, clamped to that segment's own extent) — or `null` if they
 * aren't collinear, or are collinear but don't actually overlap. `segmentIntersection` returns
 * `null` for this exact case (parallel lines have no single crossing point) — this fills that gap
 * so two walls drawn along the same line don't end up stacked as two redundant, coincident
 * segments (see `MapController.addWallSegment`).
 */
export function collinearOverlap(p1: Point, p2: Point, p3: Point, p4: Point): { t0: number; t1: number } | null {
	const dx = p2.x - p1.x;
	const dy = p2.y - p1.y;
	const len = Math.hypot(dx, dy);
	if (len === 0) return null;
	// Perpendicular distance of p3/p4 from the infinite line through p1-p2 — both must sit right on
	// it (within a tiny fraction of the segment's own length) for this to be the same line, not just
	// a parallel one running alongside it.
	const dist3 = Math.abs(dx * (p3.y - p1.y) - dy * (p3.x - p1.x)) / len;
	const dist4 = Math.abs(dx * (p4.y - p1.y) - dy * (p4.x - p1.x)) / len;
	const tolerance = len * 1e-4;
	if (dist3 > tolerance || dist4 > tolerance) return null;
	const t3 = projectParam(p3, p1, p2);
	const t4 = projectParam(p4, p1, p2);
	const t0 = Math.max(0, Math.min(t3, t4));
	const t1 = Math.min(1, Math.max(t3, t4));
	if (t1 - t0 <= 1e-4) return null;
	return { t0, t1 };
}

/**
 * Whether `mid` sits exactly on the straight line running from `a` through to `b` — i.e. the
 * polyline `a`→`mid`→`b` doesn't turn at `mid` at all, as opposed to merely being collinear (which
 * would also be true of a spike where the path folds straight back on itself). Used to decide
 * whether a wall point in between two segments of the same blocker type is just a redundant
 * midpoint that can be dropped in favor of one direct `a`-`b` segment — see
 * `MapController.optimizeWalls`.
 */
export function isStraightThrough(a: Point, mid: Point, b: Point): boolean {
	const v1x = mid.x - a.x;
	const v1y = mid.y - a.y;
	const v2x = b.x - mid.x;
	const v2y = b.y - mid.y;
	const len1 = Math.hypot(v1x, v1y);
	const len2 = Math.hypot(v2x, v2y);
	if (len1 === 0 || len2 === 0) return false;
	const cross = v1x * v2y - v1y * v2x;
	const dot = v1x * v2x + v1y * v2y;
	// Same relative-tolerance style as `collinearOverlap`: `cross` scales with len1*len2*sin(angle),
	// so bounding it by a small fraction of len1*len2 is equivalent to bounding the angle itself.
	const tolerance = len1 * len2 * 1e-4;
	return Math.abs(cross) <= tolerance && dot > 0;
}

/**
 * Distance along the ray from `origin` in unit direction `(dx, dy)` to where it crosses segment
 * `a`-`b`, or `null` if it doesn't cross within `[0, maxDist]`. `(dx, dy)` must already be a unit
 * vector — the returned distance is the direct `t` parameter, not rescaled.
 */
export function raySegmentDistance(origin: Point, dx: number, dy: number, maxDist: number, a: Point, b: Point): number | null {
	const sx = b.x - a.x;
	const sy = b.y - a.y;
	const denom = dx * sy - dy * sx;
	if (denom === 0) return null;
	const diffX = a.x - origin.x;
	const diffY = a.y - origin.y;
	const t = (diffX * sy - diffY * sx) / denom;
	const u = (diffX * dy - diffY * dx) / denom;
	if (t < 0 || t > maxDist || u < 0 || u > 1) return null;
	return t;
}

// ---------------- Wall shape presets (two-corner interactive placement) ----------------

export type WallShapeKind = "square" | "triangle" | "losange";

/**
 * Closed-polygon corners for a wall shape preset spanning the bounding box between two opposite
 * corners (the "click one corner, click the opposite corner" gesture):
 * - "square": the bounding box itself — a rectangle in general, a square only if the two clicked
 *   corners happen to be equally spaced on both axes.
 * - "triangle": sits on its base (the box's bottom edge), apex centered on the top edge — fills the
 *   box as much as a triangle can while standing flat.
 * - "losange": a diamond touching the midpoint of each of the box's four edges — the same bounding
 *   box as "square", just standing on a vertex (top-center) instead of a flat side.
 */
export function wallShapeCorners(shape: WallShapeKind, corner1: Point, corner2: Point): Point[] {
	const minX = Math.min(corner1.x, corner2.x);
	const maxX = Math.max(corner1.x, corner2.x);
	const minY = Math.min(corner1.y, corner2.y);
	const maxY = Math.max(corner1.y, corner2.y);
	const midX = (minX + maxX) / 2;
	const midY = (minY + maxY) / 2;

	if (shape === "triangle") {
		return [
			{ x: midX, y: minY },
			{ x: maxX, y: maxY },
			{ x: minX, y: maxY },
		];
	}
	if (shape === "losange") {
		return [
			{ x: midX, y: minY },
			{ x: maxX, y: midY },
			{ x: midX, y: maxY },
			{ x: minX, y: midY },
		];
	}
	return [
		{ x: minX, y: minY },
		{ x: maxX, y: minY },
		{ x: maxX, y: maxY },
		{ x: minX, y: maxY },
	];
}

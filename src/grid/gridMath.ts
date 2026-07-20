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
function projectOntoSegment(x: number, y: number, a: Point, b: Point): Point {
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

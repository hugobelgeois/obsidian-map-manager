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

import { App } from "obsidian";
import { GridType, Layer, MapFileData, VisionBlockerType, WallPoint, WallSegment } from "../data/mapData";
import { effectiveCellSize } from "../grid/fog";
import { AxialCoord, HexOrientation, Point, hexCellEdges, hexCellToWorldCenter, hexWorldToCell, squareCellEdges, squareWorldToCell } from "../grid/gridMath";
import { Rgb, buildNetworkFromEdges, colorDistance, getPixels, loadImage, pixelAt, rgbToHex } from "./detectMagicWalls";

/**
 * "Seau à murs" (paint-bucket wall tool, in the wall-shapes dropdown next to "Murs magiques"): flood-
 * fills grid cells outward from a single clicked spot on the active layer's background image, as long
 * as each newly-reached cell's own average color stays within `COLOR_REGION_TOLERANCE` of the
 * *clicked* cell's color, then walls off every edge where the fill stopped — i.e. it encircles "the
 * color you clicked" the instant that color changes too much, cell by cell. A different,
 * complementary way to get walls out of a background image than `detectMagicWalls`: that one traces
 * an already hand-drawn wall *line* (thickness/contrast/orientation heuristics — see there), so it
 * needs the map to actually have wall linework painted on it; this one has no idea what a wall looks
 * like and doesn't need one — it just reads the fill of a painted floor/room and walls off wherever
 * that fill ends, which also works on maps with no drawn borders at all. Shares this file's image-
 * loading/sampling primitives and its edges→network finishing pass (`buildNetworkFromEdges`) with
 * `detectMagicWalls` rather than duplicating them.
 */

// ---- Tunable heuristics ----

/** Max Euclidean RGB distance (0-441) a cell's average color may drift from the clicked cell's before the edge into it counts as a boundary instead of more of the same region. Comparison is always against the original clicked cell, not the immediately preceding one — a single fixed anchor keeps a slow gradient (soft-shaded floor, say) from silently drifting the fill into an unrelated color over enough cells, and keeps the result independent of the flood order. */
const COLOR_REGION_TOLERANCE = 46;
/** Hard safety rail: a region this large (or a grid this fine relative to the image) turns the flood fill into an impractically slow scan — bail out with a clear message instead of hanging, same spirit as `detectMagicWalls`' `MAX_CANDIDATE_EDGES`. */
const MAX_REGION_CELLS = 20000;
/** Per-cell color sample patch reaches this far from the cell's center, as a fraction of the cell's own size — kept comfortably short of the true cell edge (0.5) so a wall stroke or grid line drawn along the boundary never enters it. */
const CELL_SAMPLE_RADIUS_FRACTION = 0.42;
/**
 * Sample points within this fraction of the cell's size from either of the cell's *own* centerlines
 * (the horizontal and vertical lines through its center) are skipped entirely, leaving only the four
 * quadrants beyond that gap. Many hand-drawn/generated dungeon map styles decorate every cell with a
 * dashed "+" running edge-midpoint to edge-midpoint (a cobbled-floor/worked-tile marker — decorative,
 * not a wall), which sits *exactly* along those centerlines. A sampling patch simply centered on the
 * cell (the obvious choice) would scan right along that decoration on every cell, letting its ink
 * compete with — and, once split across a few near-identical floor-color buckets, sometimes outvote —
 * the actual floor color it's drawn over (see `sampleCellColor`). Skipping the cross-shaped band
 * around the centerlines sidesteps the decoration without needing to specifically recognize it.
 */
const CELL_SAMPLE_CENTERLINE_GAP_FRACTION = 0.18;
/** Sample spacing within the patch, as a divisor of its radius — finer than a plain center-patch grid would need, since the centerline gap above already throws a chunk of the grid away and each surviving quadrant still needs enough samples of its own for `sampleCellColor`'s bucket vote to mean anything. */
const CELL_SAMPLE_STEP_DIVISOR = 6;
/** Color-quantization bucket width (per RGB channel) for grouping a cell's sampled pixels into "the same floor color" — see `sampleCellColor`. Wider than `detectMagicWalls`' own `COLOR_QUANT` (tuned for crisp, flat wall ink): a painted/textured floor has more natural pixel-to-pixel variance, and too narrow a bucket here just splits the true floor color's vote across several near-identical buckets instead of grouping it into one. */
const COLOR_REGION_QUANT = 34;

export interface ColorRegionWallsResult {
	/** The clicked spot's own sampled color, as a CSS hex string — shown to the user for confirmation, not otherwise used. */
	color: string;
	/** How many grid cells ended up inside the flood-filled region — shown alongside the segment count so the user can sanity-check "does this look like the room I clicked" before confirming. */
	cellCount: number;
	wallPoints: WallPoint[];
	wallSegments: WallSegment[];
}

function regionQuantizeKey(c: Rgb): string {
	const q = (v: number) => Math.round(v / COLOR_REGION_QUANT);
	return `${q(c[0])},${q(c[1])},${q(c[2])}`;
}

/**
 * A cell's *dominant* color, sampled from the four quadrants around `centerImg` (image pixel
 * coordinates) — the average of whichever quantized color bucket (see `regionQuantizeKey`) wins the
 * most samples, not a flat mean of every sample — `null` if every sampled point was out of bounds or
 * (mostly) transparent, meaning "no usable color here" (outside the image, or a hole in it). Points
 * within `gapImg` of either of the cell's own centerlines are skipped (see
 * `CELL_SAMPLE_CENTERLINE_GAP_FRACTION`).
 *
 * A flat mean would let a decorative dashed line crossing the patch drag the whole cell's reading
 * toward that line's ink color even though most of the cell is still plainly the same floor as its
 * neighbor, wrongly reading as "the color changed too much" right where the dashes are. Voting for the
 * majority bucket instead means a minority of dashed-line pixels can't outweigh the actual floor color
 * surrounding them — matching "as long as the color still carries over into the next cell, it isn't a
 * wall", as a second line of defense alongside the gap for whatever ink still lands in the patch.
 */
function sampleCellColor(pixels: Uint8ClampedArray, width: number, height: number, centerImg: Point, radiusImg: number, gapImg: number, step: number): Rgb | null {
	interface Bucket {
		count: number;
		sumR: number;
		sumG: number;
		sumB: number;
	}
	const buckets = new Map<string, Bucket>();
	for (let oy = -radiusImg; oy <= radiusImg; oy += step) {
		for (let ox = -radiusImg; ox <= radiusImg; ox += step) {
			if (Math.abs(ox) < gapImg || Math.abs(oy) < gapImg) continue;
			const c = pixelAt(pixels, width, height, centerImg.x + ox, centerImg.y + oy);
			if (!c) continue;
			const key = regionQuantizeKey(c);
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
				buckets.set(key, bucket);
			}
			bucket.count++;
			bucket.sumR += c[0];
			bucket.sumG += c[1];
			bucket.sumB += c[2];
		}
	}
	let dominant: Bucket | null = null;
	for (const bucket of buckets.values()) {
		if (!dominant || bucket.count > dominant.count) dominant = bucket;
	}
	if (!dominant) return null;
	return [dominant.sumR / dominant.count, dominant.sumG / dominant.count, dominant.sumB / dominant.count];
}

/** Square cell `(col, row)`'s 4 edges, each paired with the neighbor cell it's shared with. */
function squareCellNeighborEdges(cell: AxialCoord, cellSize: number): { edge: [Point, Point]; neighbor: AxialCoord }[] {
	const edges = squareCellEdges(cell.a, cell.b, cellSize);
	const top = edges[0];
	const right = edges[1];
	const bottom = edges[2];
	const left = edges[3];
	const pairs: { edge: [Point, Point]; neighbor: AxialCoord }[] = [];
	if (top) pairs.push({ edge: top, neighbor: { a: cell.a, b: cell.b - 1 } });
	if (right) pairs.push({ edge: right, neighbor: { a: cell.a + 1, b: cell.b } });
	if (bottom) pairs.push({ edge: bottom, neighbor: { a: cell.a, b: cell.b + 1 } });
	if (left) pairs.push({ edge: left, neighbor: { a: cell.a - 1, b: cell.b } });
	return pairs;
}

/** The 6 axial neighbor directions of a hex grid — a property of axial coordinates themselves, so it holds regardless of the "pointy"/"flat" rendering orientation. */
const HEX_AXIAL_DIRECTIONS: AxialCoord[] = [
	{ a: 1, b: 0 },
	{ a: 1, b: -1 },
	{ a: 0, b: -1 },
	{ a: -1, b: 0 },
	{ a: -1, b: 1 },
	{ a: 0, b: 1 },
];

/**
 * Hex cell `(q, r)`'s 6 edges, each paired with the neighbor cell it's shared with — found by
 * matching each edge's own outward direction (from the cell center) to whichever neighbor's center
 * lies in the closest-aligned direction, rather than assuming a fixed edges-array order:
 * `hexCellEdges`'s corner-index-0 starting angle already depends on orientation (pointy vs flat), so
 * a hardcoded edge→neighbor table would just have to special-case that anyway — comparing directions
 * sidesteps it entirely.
 */
function hexCellNeighborEdges(cell: AxialCoord, cellSize: number, orientation: HexOrientation): { edge: [Point, Point]; neighbor: AxialCoord }[] {
	const center = hexCellToWorldCenter(cell.a, cell.b, cellSize, orientation);
	const edges = hexCellEdges(cell.a, cell.b, cellSize, orientation);
	const neighbors = HEX_AXIAL_DIRECTIONS.map((d) => ({ a: cell.a + d.a, b: cell.b + d.b }));
	const neighborDirs = neighbors.map((n) => {
		const nc = hexCellToWorldCenter(n.a, n.b, cellSize, orientation);
		return { x: nc.x - center.x, y: nc.y - center.y };
	});
	return edges.map((edge) => {
		const midx = (edge[0].x + edge[1].x) / 2 - center.x;
		const midy = (edge[0].y + edge[1].y) / 2 - center.y;
		const edgeMag = Math.hypot(midx, midy);
		let bestIndex = 0;
		let bestDot = -Infinity;
		for (let i = 0; i < neighborDirs.length; i++) {
			const dir = neighborDirs[i];
			if (!dir) continue;
			const dirMag = Math.hypot(dir.x, dir.y);
			if (edgeMag < 1e-6 || dirMag < 1e-6) continue;
			const dot = (midx * dir.x + midy * dir.y) / (edgeMag * dirMag);
			if (dot > bestDot) {
				bestDot = dot;
				bestIndex = i;
			}
		}
		return { edge, neighbor: neighbors[bestIndex] ?? cell };
	});
}

/**
 * @param seedWorld The clicked spot, in world coordinates — the cell under it seeds the flood fill,
 * and its own sampled color is what every other cell's color is compared against.
 */
export async function detectColorRegionWalls(app: App, data: MapFileData, layer: Layer, blockerType: VisionBlockerType, seedWorld: Point): Promise<ColorRegionWallsResult | null> {
	if (!layer.background) throw new Error("Le calque actif n'a pas d'image de fond.");
	const gridTypesWithoutGrid: GridType[] = ["none"];
	if (gridTypesWithoutGrid.includes(data.gridType)) throw new Error("Le seau à murs nécessite une grille (carrée ou hexagonale) — pas « aucune grille ».");

	const bg = layer.background;
	const img = await loadImage(app, bg.path);
	const { pixels, width, height } = getPixels(img);

	const cellSize = effectiveCellSize(data);
	const w = width * bg.scale;
	const h = height * bg.scale;
	// Same world-space origin convention as `detectMagicWalls`/`MapCanvas.drawBackgrounds`.
	const originX = bg.offsetX * cellSize - w / 2;
	const originY = bg.offsetY * cellSize - h / 2;
	const worldToImage = (p: Point): Point => ({ x: (p.x - originX) / bg.scale, y: (p.y - originY) / bg.scale });

	const isHex = data.gridType === "hex-pointy" || data.gridType === "hex-flat";
	const orientation: HexOrientation = data.gridType === "hex-flat" ? "flat" : "pointy";
	const cellCenter = (cell: AxialCoord): Point =>
		isHex ? hexCellToWorldCenter(cell.a, cell.b, cellSize, orientation) : { x: (cell.a + 0.5) * cellSize, y: (cell.b + 0.5) * cellSize };
	const cellNeighborEdges = (cell: AxialCoord): { edge: [Point, Point]; neighbor: AxialCoord }[] =>
		isHex ? hexCellNeighborEdges(cell, cellSize, orientation) : squareCellNeighborEdges(cell, cellSize);

	const radiusImg = (cellSize * CELL_SAMPLE_RADIUS_FRACTION) / bg.scale;
	const gapImg = (cellSize * CELL_SAMPLE_CENTERLINE_GAP_FRACTION) / bg.scale;
	const step = Math.max(1, Math.round(radiusImg / CELL_SAMPLE_STEP_DIVISOR));
	const colorCache = new Map<string, Rgb | null>();
	const cellKey = (cell: AxialCoord) => `${cell.a},${cell.b}`;
	const getColor = (cell: AxialCoord): Rgb | null => {
		const key = cellKey(cell);
		const cached = colorCache.get(key);
		if (cached !== undefined) return cached;
		const color = sampleCellColor(pixels, width, height, worldToImage(cellCenter(cell)), radiusImg, gapImg, step);
		colorCache.set(key, color);
		return color;
	};

	const seedCell = isHex ? hexWorldToCell(seedWorld.x, seedWorld.y, cellSize, orientation) : squareWorldToCell(seedWorld.x, seedWorld.y, cellSize);
	const seedColor = getColor(seedCell);
	if (!seedColor) return null;

	const region = new Set<string>([cellKey(seedCell)]);
	const queue: AxialCoord[] = [seedCell];
	const boundaryEdges: [Point, Point][] = [];
	while (queue.length > 0) {
		if (region.size > MAX_REGION_CELLS) {
			throw new Error("La zone à délimiter est trop grande pour cette analyse — augmentez la taille de cellule et réessayez, ou cliquez sur une zone plus petite.");
		}
		const cell = queue.shift();
		if (!cell) break;
		for (const { edge, neighbor } of cellNeighborEdges(cell)) {
			const neighborKey = cellKey(neighbor);
			if (region.has(neighborKey)) continue;
			const neighborColor = getColor(neighbor);
			if (neighborColor && colorDistance(neighborColor, seedColor) <= COLOR_REGION_TOLERANCE) {
				region.add(neighborKey);
				queue.push(neighbor);
			} else {
				boundaryEdges.push(edge);
			}
		}
	}
	if (boundaryEdges.length === 0) return null;

	const network = buildNetworkFromEdges(boundaryEdges, blockerType, cellSize);
	return { color: rgbToHex(seedColor), cellCount: region.size, wallPoints: network.wallPoints, wallSegments: network.wallSegments };
}

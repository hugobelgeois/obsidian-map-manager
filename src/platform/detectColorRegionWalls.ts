import { App } from "obsidian";
import { GridType, Layer, MapFileData, VisionBlockerType, WallPoint, WallSegment } from "../data/mapData";
import { effectiveCellSize } from "../grid/fog";
import { AxialCoord, HexOrientation, Point, hexCellEdges, hexCellToWorldCenter, hexWorldToCell, squareCellEdges, squareWorldToCell } from "../grid/gridMath";
import { Rgb, buildNetworkFromEdges, colorDistance, getPixels, loadImage, pixelAt, rgbToHex } from "./detectMagicWalls";

/**
 * "Seau à murs" (paint-bucket wall tool, in the wall-shapes dropdown next to "Murs magiques"): flood-
 * fills grid cells outward from a single clicked spot on the active layer's background image. The
 * clicked pixel's own color is the only reference color used throughout (`targetColor` below) — from
 * the clicked cell, every one of its borders is walked point by point along its length, and each of
 * those points is judged by its own *perpendicular* line of pixels crossing the border there
 * (`options.pixelReach` to either side of the theoretical grid line — a hand-drawn/generated wall
 * rarely sits pixel-perfect on it): a point counts as *wall evidence* the moment any pixel on its own
 * perpendicular line is NOT within tolerance of `targetColor` (`options.colorTolerancePercent`) — the
 * question at each point is "can a wall line plausibly be traced through here", not "is every pixel
 * here wall-colored". Once at least `options.wallFailFraction` of a border's points carry wall
 * evidence, a wall goes there and the fill doesn't cross it (`borderIsOpen`); otherwise — too few
 * points show any trace of a line, meaning this reads as open floor rather than a wall with the odd
 * gap in it — the fill crosses into the neighbor cell and repeats from there. A border only needs a
 * large majority of its points to carry a trace, not every single one: an occasional gap (antialiasing,
 * a worn spot in hand-drawn linework) between two clearly-traceable wall segments still counts as a
 * wall overall, exactly like a real wall with a small imperfection in it would. All three tolerances default to
 * `DEFAULT_COLOR_REGION_WALLS_OPTIONS` but are meant to be tuned per-run from the "Murs" dropdown's
 * fields under the bucket button (see `MapController.wallBucketColorTolerancePercent` and friends) —
 * how forgiving a given background image's line art needs varies a lot map to map.
 *
 * A different, complementary way to get walls out of a background image than `detectMagicWalls`: that one traces an already hand-drawn
 * wall *line* (thickness/contrast/orientation heuristics — see there), so it needs the map to actually
 * have wall linework painted on it; this one has no idea what a wall looks like and doesn't need one —
 * it just walks the fill of a painted floor/room outward until the color it started on stops holding,
 * which also works on maps with no drawn borders at all. Shares this file's image-loading/sampling
 * primitives and its edges→network finishing pass (`buildNetworkFromEdges`) with `detectMagicWalls`
 * rather than duplicating them.
 */

export interface ColorRegionWallsOptions {
	/** How far a border pixel's color may differ from the clicked pixel's, as a fraction (0-1) of the maximum possible RGB distance (pure black to pure white), to still count as a match — see `borderIsOpen`. */
	colorTolerancePercent: number;
	/**
	 * A border becomes a wall once at least this fraction (0-1) of the points along its length carry
	 * *wall evidence* — a non-matching pixel somewhere on that point's own perpendicular line (see
	 * `borderIsOpen`) — i.e. how much of a traceable wall line, gaps included, is enough to count as an
	 * actual wall rather than open floor with the odd noisy pixel. Deliberately not "any point missing
	 * evidence → open" nor "any point with evidence → wall": a hand-drawn/generated map's line art is
	 * rarely unbroken for its entire length even where it's obviously a real, continuous wall
	 * (antialiasing, a worn/faded spot, a doorway gap), and open floor can just as easily throw a stray
	 * matching pixel somewhere. This threshold only needs a large majority of the length to carry a
	 * trace, not literally every point.
	 */
	wallFailFraction: number;
	/**
	 * How many image pixels to either side of a border's exact theoretical line still get sampled at
	 * each point along it — 5 (the default) checks the line itself plus 5 pixels of slack on each side;
	 * e.g. 10 checks every pixel from 10 before the line to 10 past it. Real, hand-drawn (or
	 * hand-placed) linework is rarely pixel-perfect on the theoretical grid line, so sampling only the
	 * exact line under-counts real walls/openings that sit a few pixels off it. Shown in the toolbar as
	 * "Tolérance d'éloignement de mur".
	 */
	pixelReach: number;
}

export const DEFAULT_COLOR_REGION_WALLS_OPTIONS: ColorRegionWallsOptions = {
	colorTolerancePercent: 0.1,
	wallFailFraction: 0.95,
	pixelReach: 5,
};

const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 * 255);
/** Spacing between sampled points along a border's length, in image pixels — 1 checks every pixel along the line, matching the tool's spec literally ("tous les pixels du bord"). Raise this first if a very large/fine-grid map turns out too slow in practice. */
const BORDER_SAMPLE_STEP_PX = 1;
/** Hard safety rail: a region this large (or a grid this fine relative to the image) turns the flood fill into an impractically slow scan — bail out with a clear message instead of hanging, same spirit as `detectMagicWalls`' `MAX_CANDIDATE_EDGES`. */
const MAX_REGION_CELLS = 20000;

export interface ColorRegionWallsResult {
	/** The clicked pixel's own color, as a CSS hex string — shown to the user for confirmation, not otherwise used. */
	color: string;
	/** How many grid cells ended up inside the flood-filled region — shown alongside the segment count so the user can sanity-check "does this look like the room I clicked" before confirming. */
	cellCount: number;
	wallPoints: WallPoint[];
	wallSegments: WallSegment[];
}

/**
 * Walks the straight line from `aImg` to `bImg` (image pixel coordinates) one `BORDER_SAMPLE_STEP_PX`
 * at a time, asking at each point: "is there a wall-colored pixel anywhere near here?" rather than
 * "is every pixel near here wall-colored?" — each point is judged by its own *perpendicular* line of
 * pixels (`options.pixelReach` to either side of the theoretical border, across it), and counts as
 * carrying *wall evidence* the moment even one pixel on that line is NOT within tolerance of
 * `targetColor` (an out-of-bounds/transparent pixel, see `pixelAt`, always counts as evidence too —
 * there's no floor there either). This is what makes a wall line "traceable" through `pixelReach`'s
 * width of lateral wobble: consecutive points don't need the *same* offset to both carry evidence, so
 * a real wall stroke that wanders a little from the theoretical grid line still reads as one
 * continuous line rather than a series of near-misses.
 *
 * Returns whether at least `options.wallFailFraction` of all the points carried evidence — allowing
 * some points to have none at all (a genuine gap: no wall-colored pixel anywhere within reach) without
 * that alone breaking the line, the same way a real hand-drawn wall can have a faded/worn spot without
 * stopping being a wall. Deliberately not a flat ratio over every pixel sampled (points × line width):
 * pooling both dimensions into one count would let a wide `pixelReach` band's worth of ordinary floor
 * pixels on either side of a thin wall stroke outvote the very points that actually carry the wall,
 * since a stroke only a couple of pixels thick is a small fraction of a wide band's *raw pixel* count
 * even though every point along it does carry evidence. Judging each point by its own line first —
 * evidence or not, one vote each — is what keeps a wide reach from erasing a thin wall instead of just
 * tolerating its wobble.
 */
function borderIsOpen(pixels: Uint8ClampedArray, width: number, height: number, aImg: Point, bImg: Point, targetColor: Rgb, options: ColorRegionWallsOptions): boolean {
	const colorTolerance = MAX_RGB_DISTANCE * options.colorTolerancePercent;
	const dx = bImg.x - aImg.x;
	const dy = bImg.y - aImg.y;
	const length = Math.hypot(dx, dy);
	const steps = Math.max(1, Math.round(length / BORDER_SAMPLE_STEP_PX));
	// Unit vector along the border, and its perpendicular — for probing `pixelReach` pixels to either
	// side of each along-the-line sample point.
	const ux = length > 0 ? dx / length : 0;
	const uy = length > 0 ? dy / length : 0;
	const nx = -uy;
	const ny = ux;
	const reach = Math.max(0, Math.round(options.pixelReach));
	let totalPoints = 0;
	let wallEvidencePoints = 0;
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const px = aImg.x + dx * t;
		const py = aImg.y + dy * t;
		let hasWallEvidence = false;
		for (let o = -reach; o <= reach && !hasWallEvidence; o++) {
			const c = pixelAt(pixels, width, height, px + nx * o, py + ny * o);
			if (!c || colorDistance(c, targetColor) > colorTolerance) hasWallEvidence = true;
		}
		totalPoints++;
		if (hasWallEvidence) wallEvidencePoints++;
	}
	return totalPoints > 0 && wallEvidencePoints / totalPoints < options.wallFailFraction;
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
 * and the color of the exact pixel clicked (`targetColor`) is what every border's pixels are checked
 * against for the rest of the fill.
 * @param options Defaults to `DEFAULT_COLOR_REGION_WALLS_OPTIONS` — callers normally pass the user's
 * own tuned values instead (`MapController.wallBucketColorTolerancePercent` and friends).
 */
export async function detectColorRegionWalls(
	app: App,
	data: MapFileData,
	layer: Layer,
	blockerType: VisionBlockerType,
	seedWorld: Point,
	options: ColorRegionWallsOptions = DEFAULT_COLOR_REGION_WALLS_OPTIONS
): Promise<ColorRegionWallsResult | null> {
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
	const cellNeighborEdges = (cell: AxialCoord): { edge: [Point, Point]; neighbor: AxialCoord }[] =>
		isHex ? hexCellNeighborEdges(cell, cellSize, orientation) : squareCellNeighborEdges(cell, cellSize);

	const seedCell = isHex ? hexWorldToCell(seedWorld.x, seedWorld.y, cellSize, orientation) : squareWorldToCell(seedWorld.x, seedWorld.y, cellSize);
	const seedImg = worldToImage(seedWorld);
	const targetColor = pixelAt(pixels, width, height, seedImg.x, seedImg.y);
	if (!targetColor) return null;

	const cellKey = (cell: AxialCoord) => `${cell.a},${cell.b}`;
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
			const aImg = worldToImage(edge[0]);
			const bImg = worldToImage(edge[1]);
			if (borderIsOpen(pixels, width, height, aImg, bImg, targetColor, options)) {
				region.add(neighborKey);
				queue.push(neighbor);
			} else {
				boundaryEdges.push(edge);
			}
		}
	}
	if (boundaryEdges.length === 0) return null;

	const network = buildNetworkFromEdges(boundaryEdges, blockerType, cellSize);
	return { color: rgbToHex(targetColor), cellCount: region.size, wallPoints: network.wallPoints, wallSegments: network.wallSegments };
}

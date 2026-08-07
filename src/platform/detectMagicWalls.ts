import { App } from "obsidian";
import { GridType, Layer, MapFileData, VisionBlockerType, WallPoint, WallSegment, generateLocalId } from "../data/mapData";
import { effectiveCellSize } from "../grid/fog";
import { HexOrientation, Point, hexCellEdges, hexCellsInWorldRect, squareCellEdges, squareCellsInWorldRect } from "../grid/gridMath";
import { WallNetwork, optimizeWallNetwork } from "../grid/wallOptimize";

/**
 * "Murs magiques": detects the single-color stroke drawn thickest and with the most contrast
 * against its surroundings across the active layer's background image (typically a hand-drawn or
 * generated dungeon map's wall linework), then places wall segments along every grid edge that
 * carries that same stroke — snapped to the grid, straight lines only (no free-hand diagonal
 * tracing; see `enumerateCandidateEdges`). Returns a standalone candidate network for the caller to
 * preview and confirm (`MagicWallsModal`) before `MapController.applyMagicWalls` merges it into the
 * layer — nothing here touches `MapFileData` itself.
 */

/** RGB triple, 0-255 per channel. Alpha is only used to skip transparent pixels (see `pixelAt`), never carried further. Exported for `detectColorRegionWalls` ("seau à murs"), which shares this file's image-sampling primitives instead of re-implementing them. */
export type Rgb = [number, number, number];

export interface MagicWallsResult {
	/** The wall-drawing color, as a CSS hex string — shown to the user for confirmation, not otherwise used. */
	color: string;
	/** Whether `color` came from the user's own eyedropper pick (Toolbar) rather than automatic detection — purely cosmetic, changes only `MagicWallsModal`'s wording. */
	manual: boolean;
	wallPoints: WallPoint[];
	wallSegments: WallSegment[];
}

// ---- Tunable heuristics ----

/** Color-quantization bucket width (per RGB channel) used to group sampled pixels into "the same drawn color". */
const COLOR_QUANT = 20;
/** Spacing between centerline samples along a candidate edge, in image pixels. */
const SAMPLE_STEP_PX = 2;
/** How far the perpendicular thickness/contrast scan reaches on each side of the centerline, in image pixels — a stroke wider than this reads as "no edge found" on that side (see `scanRun`). */
const MAX_PROFILE_PX = 10;
/** Max Euclidean RGB distance for a perpendicular-scan pixel to still count as "part of the same stroke" as the centerline sample. */
const PIXEL_TOLERANCE = 24;
/**
 * Minimum fraction of an edge's centerline samples, as one *contiguous* run (small gaps bridged, see
 * `RUN_GAP_TOLERANCE`), that must carry the wall color for that edge to qualify. Deliberately about
 * contiguity rather than a plain overall fraction: a real wall paints (almost) the entire edge in one
 * unbroken stroke, while a diagonal texture hatch (rubble, cross-hatched fill — the same ink color as
 * the walls, just not a wall) only clips across a grid edge in short, scattered bursts. A plain
 * "X% of samples matched, anywhere along the edge" fraction can't tell those apart — `ALIGN_SEARCH_PX`
 * widening what counts as "found" makes this worse, not better, so contiguity is what actually keeps
 * texture from being read as walls.
 */
const MIN_RUN_COVERAGE = 0.75;
/**
 * How many consecutive non-matching centerline samples a contiguous run may bridge over (wobbly
 * hand-drawn linework, antialiasing) without breaking. Safe to be a little generous now that
 * `ORIENTATION_MIN_RATIO` — not this — is what actually keeps texture out: a diagonal hatch stroke
 * essentially never produces an *aligned* hit in the first place (see `sampleEdgeStats`), so bridging
 * a couple of misses in a row still can't stitch scattered texture into a fake run the way it could
 * back when color match alone decided a "hit".
 */
const RUN_GAP_TOLERANCE = 2;
/** Minimum average stroke thickness (image px) for an edge to qualify. */
const MIN_THICKNESS_PX = 1.2;
/** Minimum average contrast (Euclidean RGB distance, 0-441) against the colors just outside the stroke for an edge to qualify. */
const MIN_CONTRAST = 28;
/** A color needs to be the qualifying choice on at least this many edges before it's trusted as "the" wall color, rather than one noisy outlier. */
const MIN_QUALIFYING_EDGES = 3;
/**
 * How far off the theoretical grid line (image px, perpendicular) a known wall color may be found
 * and still count as "on" this edge — hand-drawn (or hand-placed) linework is rarely pixel-perfect
 * on the grid, so sampling only the exact theoretical line under-counts real walls (gaps/"trous" in
 * the result). Only used once the wall color is already known (a user pick, or automatic detection's
 * own second pass) — see `findAlignedPixel`. `ORIENTATION_MIN_RATIO` is the actual defense against
 * texture, not this — but too wide a reach still occasionally lets a search anchored on one grid edge
 * find ink that really belongs to a *different* nearby edge (the true wall running along the next
 * cell over, say), which can then locally still look "aligned" — hence not pushed any wider than this.
 */
const ALIGN_SEARCH_PX = 5;
/** Hard safety rail: grid too fine relative to the image (or image too large) turns this into an impractically slow scan — bail out with a clear message instead of hanging. */
const MAX_CANDIDATE_EDGES = 20000;
/** A lone wall segment touching nothing at either end, no longer than this many grid cells, is more likely a stray mark (texture, a symbol) than a real wall — see `pruneIsolatedStubs`. Longer freestanding walls are left alone; disconnected-but-long is plausible, disconnected-and-tiny usually isn't. */
const MAX_ISOLATED_STUB_CELLS = 2;
/** How far the *parallel* (along-the-edge) scan reaches, in image px, when checking a sample's stroke orientation — see `ORIENTATION_MIN_RATIO`. Bigger than `MAX_PROFILE_PX` on purpose: a real wall runs the length of the edge, so this just needs to comfortably outrun any short diagonal mark. */
const PARALLEL_PROFILE_PX = 16;
/**
 * A sample only counts as "on a horizontal/vertical stroke" if the ink there reaches at least this
 * many times further running *along* the edge (`PARALLEL_PROFILE_PX`) than it does *across* it
 * (perpendicular thickness, clamped to `MAX_ORIENTATION_THICKNESS_PX` — see below) — a wall drawn
 * along the grid is long and thin in exactly that way; a diagonal texture hatch crossing the edge is
 * roughly as short in both directions, since a thin diagonal line cut by an axis-aligned ray never
 * runs far before exiting it. This is what "seulement les lignes horizontales/verticales, pas
 * diagonales" actually checks per pixel, rather than inferring it indirectly from coverage/contrast.
 * Set well above the "just barely elongated" line: a real wall's ratio is typically 5-10+ (many
 * cell-widths of ink vs. a handful of px of thickness), while two crossing hatch strokes can
 * occasionally chain into something *technically* longer-than-thick without being an actual straight
 * stroke — 2 let some of those through, hence the increase.
 */
const ORIENTATION_MIN_RATIO = 3;
/**
 * Ceiling used only for the orientation check's thickness side, not for the reported `avgThickness`
 * stat. A wall right at the edge of a hatched room can have its perpendicular scan bleed a few extra
 * pixels into a texture stroke that happens to touch it — inflating the *measured* thickness there
 * without the wall actually being that thick. Left uncapped, that inflated value would demand a
 * parallel extent past what `PARALLEL_PROFILE_PX` can even report, wrongly failing real wall samples
 * exactly where they touch the texture (a wall bordering two different textured rooms, say).
 */
const MAX_ORIENTATION_THICKNESS_PX = 8;

/** Exported alongside `getPixels`/`pixelAt`/`colorDistance`/`rgbToHex` for `detectColorRegionWalls` ("seau à murs") to reuse this file's image-loading/sampling primitives rather than duplicating them. */
export function loadImage(app: App, path: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`Impossible de charger l'image de fond ("${path}").`));
		img.src = app.vault.adapter.getResourcePath(path);
	});
}

export function getPixels(img: HTMLImageElement): { pixels: Uint8ClampedArray; width: number; height: number } {
	const canvas = document.createElement("canvas");
	canvas.width = img.naturalWidth;
	canvas.height = img.naturalHeight;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("Impossible d'analyser l'image (contexte de rendu indisponible).");
	ctx.drawImage(img, 0, 0);
	try {
		const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
		return { pixels: data.data, width: canvas.width, height: canvas.height };
	} catch {
		throw new Error("Impossible d'analyser l'image (accès aux pixels refusé).");
	}
}

/** `null` for out-of-bounds or (mostly) transparent pixels — both mean "no usable color data here". */
export function pixelAt(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number): Rgb | null {
	const px = Math.round(x);
	const py = Math.round(y);
	if (px < 0 || py < 0 || px >= width || py >= height) return null;
	const i = (py * width + px) * 4;
	const a = pixels[i + 3] ?? 0;
	if (a < 16) return null;
	return [pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0];
}

export function colorDistance(a: Rgb, b: Rgb): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function quantizeKey(c: Rgb): string {
	const q = (v: number) => Math.round(v / COLOR_QUANT);
	return `${q(c[0])},${q(c[1])},${q(c[2])}`;
}

export function rgbToHex(c: Rgb): string {
	const toHex = (v: number) =>
		Math.round(Math.min(255, Math.max(0, v)))
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(c[0])}${toHex(c[1])}${toHex(c[2])}`;
}

/** Parses a `"#rgb"` or `"#rrggbb"` CSS hex color (case-insensitive, as returned by the `EyeDropper` API or an `<input type="color">`) — throws rather than silently misreading it as black on a typo. */
function hexToRgb(hex: string): Rgb {
	const clean = hex.trim().replace(/^#/, "");
	const full = clean.length === 3
		? clean.split("").map((c) => c + c).join("")
		: clean;
	if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`Couleur de mur invalide : "${hex}".`);
	const num = parseInt(full, 16);
	return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/** Every grid edge (one cell's worth of straight line each) whose cell falls within the image's world-space bounding box, deduplicated so a boundary shared by two cells is only sampled once. */
function enumerateCandidateEdges(data: MapFileData, minX: number, minY: number, maxX: number, maxY: number): [Point, Point][] {
	const cellSize = effectiveCellSize(data);
	const edgesByKey = new Map<string, [Point, Point]>();
	const roundKey = (p: Point) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
	const addEdge = (a: Point, b: Point) => {
		const ka = roundKey(a);
		const kb = roundKey(b);
		const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
		if (!edgesByKey.has(key)) edgesByKey.set(key, [a, b]);
	};

	if (data.gridType === "hex-pointy" || data.gridType === "hex-flat") {
		const orientation: HexOrientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
		for (const cell of hexCellsInWorldRect(minX, minY, maxX, maxY, cellSize, orientation)) {
			for (const [a, b] of hexCellEdges(cell.a, cell.b, cellSize, orientation)) addEdge(a, b);
		}
	} else {
		for (const cell of squareCellsInWorldRect(minX, minY, maxX, maxY, cellSize)) {
			for (const [a, b] of squareCellEdges(cell.a, cell.b, cellSize)) addEdge(a, b);
		}
	}
	return Array.from(edgesByKey.values());
}

interface EdgeStat {
	colorKey: string;
	color: Rgb;
	/** Fraction of this edge's own longest contiguous run of matching samples (small gaps bridged — see `RUN_GAP_TOLERANCE`) out of every sample taken. The primary "is this really a wall, not just nearby texture" signal — see `MIN_RUN_COVERAGE`. */
	runCoverage: number;
	avgThickness: number;
	avgContrast: number;
}

/** Contiguous run length (image px) from `(px, py)` stepping by `(stepX, stepY)` per pixel, while the sampled color stays within `PIXEL_TOLERANCE` of `center` — plus the first color found just past the run (or `null` if the run went the full `maxDist` without breaking, meaning "no edge found within the scan window"). `maxDist` defaults to `MAX_PROFILE_PX` (the perpendicular thickness scan); the parallel orientation scan passes `PARALLEL_PROFILE_PX` instead. */
function scanRun(pixels: Uint8ClampedArray, width: number, height: number, px: number, py: number, stepX: number, stepY: number, center: Rgb, maxDist = MAX_PROFILE_PX): { run: number; neighbor: Rgb | null } {
	let run = 0;
	for (let o = 1; o <= maxDist; o++) {
		const c = pixelAt(pixels, width, height, px + stepX * o, py + stepY * o);
		if (!c || colorDistance(c, center) > PIXEL_TOLERANCE) return { run, neighbor: c };
		run = o;
	}
	return { run, neighbor: null };
}

/**
 * Looks for a pixel matching `targetColorKey`, starting at `(px, py)` and stepping outward along
 * `±(nx, ny)` up to `ALIGN_SEARCH_PX`, closest match first — so a hand-drawn line that wanders a few
 * pixels off the theoretical grid edge is still found and used, instead of registering as a gap
 * because the exact theoretical point happened to land just off the ink.
 */
function findAlignedPixel(pixels: Uint8ClampedArray, width: number, height: number, px: number, py: number, nx: number, ny: number, targetColorKey: string): { x: number; y: number; color: Rgb } | null {
	for (let o = 0; o <= ALIGN_SEARCH_PX; o++) {
		const signs = o === 0 ? [1] : [1, -1];
		for (const sign of signs) {
			const x = px + nx * o * sign;
			const y = py + ny * o * sign;
			const c = pixelAt(pixels, width, height, x, y);
			if (c && quantizeKey(c) === targetColorKey) return { x, y, color: c };
		}
	}
	return null;
}

/**
 * Samples one candidate edge's centerline (in image pixel coordinates) and aggregates a color
 * bucket's coverage/thickness/contrast — `null` if the edge carries no usable pixels (e.g. entirely
 * outside the image, or too short to say anything about).
 *
 * Without `targetColorKey`, reports whichever quantized color bucket is most common along this edge,
 * sampled exactly on the theoretical line (automatic detection's first pass — the caller then votes
 * across every edge's own dominant bucket to find "the" wall color; see `detectMagicWalls`). With
 * `targetColorKey` (a user eyedropper pick, or automatic detection's own refinement pass once it
 * knows the winning color), each centerline point instead searches perpendicular to the line for the
 * nearest pixel actually carrying that color (`findAlignedPixel`) before sampling from there — real,
 * hand-drawn linework is rarely pixel-perfect on the grid, so this recentering is what keeps a
 * slightly-off-grid wall from reading as a gap.
 */
function sampleEdgeStats(pixels: Uint8ClampedArray, width: number, height: number, aImg: Point, bImg: Point, targetColorKey?: string): EdgeStat | null {
	const dx = bImg.x - aImg.x;
	const dy = bImg.y - aImg.y;
	const length = Math.hypot(dx, dy);
	if (length < 1) return null;
	const ux = dx / length;
	const uy = dy / length;
	// Unit perpendicular, for the thickness/contrast scan (and, with a known target color, the
	// alignment search) at each centerline sample.
	const nx = -uy;
	const ny = ux;

	const steps = Math.max(2, Math.round(length / SAMPLE_STEP_PX));
	interface Sample {
		color: Rgb;
		thickness: number;
		contrast: number;
		/** Whether the ink at this sample runs mostly *along* the edge rather than just happening to cross it — see `ORIENTATION_MIN_RATIO`. Only an `aligned` sample can ever count as a match (bucket membership, run coverage): a diagonal texture hatch may share the wall's exact color, but it isn't a horizontal/vertical stroke, so it's excluded right here rather than downstream. */
		aligned: boolean;
	}
	const samples: Sample[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const px = aImg.x + dx * t;
		const py = aImg.y + dy * t;

		let cx = px;
		let cy = py;
		let center = pixelAt(pixels, width, height, px, py);
		if (targetColorKey) {
			const aligned = findAlignedPixel(pixels, width, height, px, py, nx, ny, targetColorKey);
			if (aligned) {
				cx = aligned.x;
				cy = aligned.y;
				center = aligned.color;
			}
			// No match within the search window: leave `center` as the exact theoretical point (almost
			// certainly not the target color), so this sample correctly counts against coverage below.
		}
		if (!center) continue;

		const pos = scanRun(pixels, width, height, cx, cy, nx, ny, center);
		const neg = scanRun(pixels, width, height, cx, cy, -nx, -ny, center);
		const thickness = pos.run + neg.run + 1;
		const contrasts: number[] = [];
		if (pos.neighbor) contrasts.push(colorDistance(center, pos.neighbor));
		if (neg.neighbor) contrasts.push(colorDistance(center, neg.neighbor));
		const contrast = contrasts.length > 0 ? contrasts.reduce((sum, v) => sum + v, 0) / contrasts.length : 0;

		// Orientation check ("horizontal/vertical, not diagonal"): the same ink, scanned *along* the
		// edge instead of across it, must reach much further — that's what a straight wall running
		// with the grid looks like. A diagonal hatch stroke crossing this point is short in both
		// directions, since an axis-aligned ray only clips a thin diagonal line briefly either way.
		// Thickness is clamped for this comparison only — see `MAX_ORIENTATION_THICKNESS_PX`.
		const along = scanRun(pixels, width, height, cx, cy, ux, uy, center, PARALLEL_PROFILE_PX);
		const back = scanRun(pixels, width, height, cx, cy, -ux, -uy, center, PARALLEL_PROFILE_PX);
		const parallelExtent = along.run + back.run + 1;
		const strokeAligned = parallelExtent >= ORIENTATION_MIN_RATIO * Math.min(thickness, MAX_ORIENTATION_THICKNESS_PX);

		samples.push({ color: center, thickness, contrast, aligned: strokeAligned });
	}
	if (samples.length === 0) return null;

	// Group samples by quantized color and keep whichever bucket is most common along this edge —
	// only among `aligned` samples, so a diagonal texture stroke's color never even enters the running
	// (automatic detection's color vote) or gets treated as "found" (a known target color).
	interface Bucket {
		count: number;
		sumR: number;
		sumG: number;
		sumB: number;
		sumThickness: number;
		sumContrast: number;
	}
	const buckets = new Map<string, Bucket>();
	let dominantKey: string | null = null;
	let dominant: Bucket | null = null;
	for (const s of samples) {
		if (!s.aligned) continue;
		const key = quantizeKey(s.color);
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { count: 0, sumR: 0, sumG: 0, sumB: 0, sumThickness: 0, sumContrast: 0 };
			buckets.set(key, bucket);
		}
		bucket.count++;
		bucket.sumR += s.color[0];
		bucket.sumG += s.color[1];
		bucket.sumB += s.color[2];
		bucket.sumThickness += s.thickness;
		bucket.sumContrast += s.contrast;
		if (!targetColorKey && (!dominant || bucket.count > dominant.count)) {
			dominant = bucket;
			dominantKey = key;
		}
	}

	const resultKey = targetColorKey ?? dominantKey;
	const result = targetColorKey ? buckets.get(targetColorKey) : dominant;
	if (!result || !resultKey) return null;

	// Longest contiguous run of samples matching `resultKey`, bridging small gaps — a real wall paints
	// (almost) the whole edge in one run; a texture stroke (rubble hatch, etc. — same ink color, just
	// not a wall) only clips across this particular edge in short, scattered bursts, so its longest run
	// stays well short of the full edge length. See `MIN_RUN_COVERAGE`.
	let bestRun = 0;
	let currentRun = 0;
	let gapStreak = 0;
	for (const s of samples) {
		if (s.aligned && quantizeKey(s.color) === resultKey) {
			currentRun++;
			gapStreak = 0;
		} else if (gapStreak < RUN_GAP_TOLERANCE) {
			currentRun++;
			gapStreak++;
		} else {
			bestRun = Math.max(bestRun, currentRun);
			currentRun = 0;
			gapStreak = 0;
		}
	}
	bestRun = Math.max(bestRun, currentRun);

	return {
		colorKey: resultKey,
		color: [result.sumR / result.count, result.sumG / result.count, result.sumB / result.count],
		runCoverage: bestRun / samples.length,
		avgThickness: result.sumThickness / result.count,
		avgContrast: result.sumContrast / result.count,
	};
}

function qualifies(stat: EdgeStat): boolean {
	return stat.runCoverage >= MIN_RUN_COVERAGE && stat.avgThickness >= MIN_THICKNESS_PX && stat.avgContrast >= MIN_CONTRAST;
}

/**
 * Drops any wall segment that, after `optimizeWallNetwork` has already collapsed straight runs,
 * still touches nothing at *either* end (a fully disconnected line — a real wall's network is almost
 * always chained or looped together) — but only if it's short, at most `maxLength`. A stray texture
 * mark or a small door/gate symbol that happens to line up with one grid edge produces exactly this
 * shape: an isolated, short segment. A long freestanding wall is much more plausibly intentional, so
 * it's left alone even when disconnected. Mutates `network` in place.
 */
function pruneIsolatedStubs(network: WallNetwork, maxLength: number): void {
	const degree = new Map<string, number>();
	for (const s of network.wallSegments) {
		degree.set(s.aId, (degree.get(s.aId) ?? 0) + 1);
		degree.set(s.bId, (degree.get(s.bId) ?? 0) + 1);
	}
	const pointsById = new Map(network.wallPoints.map((p) => [p.id, p]));
	network.wallSegments = network.wallSegments.filter((s) => {
		if (degree.get(s.aId) !== 1 || degree.get(s.bId) !== 1) return true;
		const a = pointsById.get(s.aId);
		const b = pointsById.get(s.bId);
		if (!a || !b) return true;
		return Math.hypot(b.x - a.x, b.y - a.y) > maxLength;
	});
	network.wallPoints = network.wallPoints.filter((p) => network.wallSegments.some((s) => s.aId === p.id || s.bId === p.id));
}

/** Turns a flat list of accepted edges into a `WallPoint`/`WallSegment` network — shared endpoints (within a hair of floating-point noise) reused as the same point — then runs it through the same straight-run collapsing `MapController.optimizeWalls` applies to hand-drawn walls (since the raw input is one tiny segment per grid edge), and prunes short disconnected noise (`pruneIsolatedStubs`). Exported for `detectColorRegionWalls` ("seau à murs"), which builds its own edge list (a flood-filled region's boundary rather than detected linework) but needs the exact same point-reconciliation/optimize/prune finishing pass. */
export function buildNetworkFromEdges(edges: [Point, Point][], blockerType: VisionBlockerType, cellSize: number): WallNetwork {
	const pointsByKey = new Map<string, WallPoint>();
	const network: WallNetwork = { wallPoints: [], wallSegments: [] };
	const resolvePoint = (p: Point): string => {
		const key = `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
		let point = pointsByKey.get(key);
		if (!point) {
			point = { id: generateLocalId("wallpoint"), x: p.x, y: p.y };
			pointsByKey.set(key, point);
			network.wallPoints.push(point);
		}
		return point.id;
	};
	for (const [a, b] of edges) {
		network.wallSegments.push({ id: generateLocalId("wallsegment"), aId: resolvePoint(a), bId: resolvePoint(b), blockerType });
	}
	optimizeWallNetwork(network);
	pruneIsolatedStubs(network, cellSize * MAX_ISOLATED_STUB_CELLS);
	return network;
}

/**
 * @param targetColor When given (the user picked a color with the toolbar's eyedropper, as a CSS
 * hex string), skips automatic color detection entirely and places walls along every grid edge that
 * carries *this* color instead — still subject to the same coverage/thickness/contrast thresholds
 * as automatic detection, so a color that's merely present (e.g. a shadow tinge) but not drawn as an
 * actual thick, high-contrast line still won't produce walls.
 */
export async function detectMagicWalls(app: App, data: MapFileData, layer: Layer, blockerType: VisionBlockerType, targetColor?: string): Promise<MagicWallsResult | null> {
	if (!layer.background) throw new Error("Le calque actif n'a pas d'image de fond.");
	const gridTypesWithoutGrid: GridType[] = ["none"];
	if (gridTypesWithoutGrid.includes(data.gridType)) throw new Error("Les murs magiques nécessitent une grille (carrée ou hexagonale) — pas « aucune grille ».");
	const targetRgb = targetColor ? hexToRgb(targetColor) : null;
	const targetColorKey = targetRgb ? quantizeKey(targetRgb) : undefined;

	const bg = layer.background;
	const img = await loadImage(app, bg.path);
	const { pixels, width, height } = getPixels(img);

	const cellSize = effectiveCellSize(data);
	const w = width * bg.scale;
	const h = height * bg.scale;
	// bg.offsetX/Y are the image's center, in grid cells; convert to a world-space top-left corner —
	// same convention as `MapCanvas.drawBackgrounds`.
	const originX = bg.offsetX * cellSize - w / 2;
	const originY = bg.offsetY * cellSize - h / 2;
	const worldToImage = (p: Point): Point => ({ x: (p.x - originX) / bg.scale, y: (p.y - originY) / bg.scale });

	const candidateEdges = enumerateCandidateEdges(data, originX, originY, originX + w, originY + h);
	if (candidateEdges.length > MAX_CANDIDATE_EDGES) {
		throw new Error("La grille est trop fine par rapport à l'image pour cette analyse — augmentez la taille de cellule et réessayez.");
	}

	if (targetColorKey && targetRgb) {
		// The user already told us the color — just gather every edge that carries it (with the
		// alignment search, since `targetColorKey` is set — see `sampleEdgeStats`), no voting needed.
		const acceptedEdges: [Point, Point][] = [];
		for (const edge of candidateEdges) {
			const aImg = worldToImage(edge[0]);
			const bImg = worldToImage(edge[1]);
			const stat = sampleEdgeStats(pixels, width, height, aImg, bImg, targetColorKey);
			if (stat && qualifies(stat)) acceptedEdges.push(edge);
		}
		if (acceptedEdges.length === 0) return null;
		const network = buildNetworkFromEdges(acceptedEdges, blockerType, cellSize);
		return { color: rgbToHex(targetRgb), manual: true, wallPoints: network.wallPoints, wallSegments: network.wallSegments };
	}

	// Pass 1: score every candidate edge sampled exactly on the theoretical grid line (no alignment
	// search yet — we don't know the wall color to search for until this pass is done), and bucket
	// the qualifying ones by color to find which single color is "the" wall style, used consistently
	// (not just a one-off outlier) across the image — weighted by thickness*contrast so a handful of
	// bold, high-contrast edges outweigh many faint, low-contrast ones in the same bucket. Voting only
	// needs a representative sample, not every misaligned edge caught — that's what pass 2 is for.
	interface GlobalBucket {
		edgeCount: number;
		score: number;
		weight: number;
		sumR: number;
		sumG: number;
		sumB: number;
	}
	const globalBuckets = new Map<string, GlobalBucket>();
	for (const edge of candidateEdges) {
		const stat = sampleEdgeStats(pixels, width, height, worldToImage(edge[0]), worldToImage(edge[1]));
		if (!stat || !qualifies(stat)) continue;
		let bucket = globalBuckets.get(stat.colorKey);
		if (!bucket) {
			bucket = { edgeCount: 0, score: 0, weight: 0, sumR: 0, sumG: 0, sumB: 0 };
			globalBuckets.set(stat.colorKey, bucket);
		}
		const weight = stat.avgThickness * stat.avgContrast;
		bucket.edgeCount++;
		bucket.score += weight;
		bucket.weight += weight;
		bucket.sumR += stat.color[0] * weight;
		bucket.sumG += stat.color[1] * weight;
		bucket.sumB += stat.color[2] * weight;
	}

	let winnerKey: string | null = null;
	let winner: GlobalBucket | null = null;
	for (const [key, bucket] of globalBuckets) {
		if (bucket.edgeCount < MIN_QUALIFYING_EDGES) continue;
		if (!winner || bucket.score > winner.score) {
			winner = bucket;
			winnerKey = key;
		}
	}
	if (!winner || !winnerKey || winner.weight === 0) return null;
	const wallColor: Rgb = [winner.sumR / winner.weight, winner.sumG / winner.weight, winner.sumB / winner.weight];

	// Pass 2: now that the wall color is known, re-sample every candidate edge against it with the
	// alignment search on (`findAlignedPixel`) — this is what actually decides the final wall set, so
	// edges pass 1 missed purely because the hand-drawn line sat a few pixels off the theoretical grid
	// line still get picked up here, rather than being silently dropped as a gap.
	const acceptedEdges: [Point, Point][] = [];
	for (const edge of candidateEdges) {
		const aImg = worldToImage(edge[0]);
		const bImg = worldToImage(edge[1]);
		const stat = sampleEdgeStats(pixels, width, height, aImg, bImg, winnerKey);
		if (stat && qualifies(stat)) acceptedEdges.push(edge);
	}
	if (acceptedEdges.length === 0) return null;

	const network = buildNetworkFromEdges(acceptedEdges, blockerType, cellSize);
	return { color: rgbToHex(wallColor), manual: false, wallPoints: network.wallPoints, wallSegments: network.wallSegments };
}

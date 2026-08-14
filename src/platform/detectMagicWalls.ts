import { App } from "obsidian";
import { VisionBlockerType, WallPoint, generateLocalId } from "../data/mapData";
import { Point } from "../grid/gridMath";
import { WallNetwork, optimizeWallNetwork } from "../grid/wallOptimize";

/**
 * Shared image-sampling/wall-network primitives, originally written for "Murs magiques" (automatic
 * wall detection from a background image — since removed) and kept here because
 * `detectColorRegionWalls` ("seau à murs") still relies on them: loading/sampling a background
 * image's pixels, and turning a flat list of accepted edges into a reconciled, optimized
 * `WallPoint`/`WallSegment` network.
 */

/** RGB triple, 0-255 per channel. Alpha is only used to skip transparent pixels (see `pixelAt`), never carried further. */
export type Rgb = [number, number, number];

/** A lone wall segment touching nothing at either end, no longer than this many grid cells, is more likely a stray mark (texture, a symbol) than a real wall — see `pruneIsolatedStubs`. Longer freestanding walls are left alone; disconnected-but-long is plausible, disconnected-and-tiny usually isn't. */
const MAX_ISOLATED_STUB_CELLS = 2;

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

export function rgbToHex(c: Rgb): string {
	const toHex = (v: number) =>
		Math.round(Math.min(255, Math.max(0, v)))
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(c[0])}${toHex(c[1])}${toHex(c[2])}`;
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

/** Turns a flat list of accepted edges into a `WallPoint`/`WallSegment` network — shared endpoints (within a hair of floating-point noise) reused as the same point — then runs it through the same straight-run collapsing `MapController.optimizeWalls` applies to hand-drawn walls (since the raw input is one tiny segment per grid edge), and prunes short disconnected noise (`pruneIsolatedStubs`). Used by `detectColorRegionWalls` ("seau à murs"), which builds its own edge list (a flood-filled region's boundary) and needs this point-reconciliation/optimize/prune finishing pass. */
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

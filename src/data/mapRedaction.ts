import { buildVisionCache, footprintCenter, isPointLit, isWorldPointExplored, worldPointToCellKey } from "../grid/fog";
import { CELLED_GRID_TYPES, CellsByGridType, Layer, MapFileData } from "./mapData";

/**
 * Strips everything hidden by fog of war out of `data`, for a read-only export that must never
 * leak what a player hasn't (or can't currently) see — see `PublicMapSnapshot`. Pure/synchronous:
 * no vault access, safe to run outside Obsidian too.
 *
 * Rules (confirmed with the map's owner):
 * - `fogEnabled === false` → nothing is redacted, the whole map is exported as-is — except "light"
 *   tokens (see below), which are never exported regardless of fog.
 * - cell content (zone/stamp/label/links) → kept only if the cell is explored. Celled grids test
 *   the cell key against `exploredCellsByGridType[gridType]` (the "avec grillage" per-cell fog);
 *   grid type "none" (legacy ray-traced fog) tests the cell's center against the coarse
 *   `exploredCells` bucket grid.
 * - markers (stamps) → kept if explored OR currently within a player's vision.
 * - "entity" tokens → kept only if currently within a player's vision (even if the ground under
 *   them was explored before — they can walk back out of sight).
 * - "player" tokens → always kept.
 * - "light" tokens → never kept, fog on or off: a pure light fixture, not something a player ever
 *   sees directly — same rule as the live player-mirror canvas (`MapCanvas.isLightTokenHiddenFromMirror`).
 * - wall points/segments → always stripped: the public viewer never re-traces vision (it just
 *   paints the exported explored memory as a static mask), and keeping wall geometry around would
 *   otherwise leak the shape of unexplored rooms.
 * - `exploredCellsByGridType` for grid types other than the active one → cleared (irrelevant to the
 *   export, and needless bulk).
 */
export function buildPublicSnapshot(data: MapFileData): MapFileData {
	const clone = structuredClone(data);
	clone.tokens = clone.tokens.filter((token) => (token.category ?? "entity") !== "light");
	if (!clone.fogEnabled) return clone;

	const gridType = clone.gridType;
	const visionCache = buildVisionCache(clone);
	const isLitWorld = (x: number, y: number) => isPointLit(visionCache, x, y, false);

	let isCellExplored: (key: string) => boolean;
	let isExploredWorld: (x: number, y: number) => boolean;
	if (gridType === "none") {
		const exploredSet = new Set(clone.exploredCells);
		isCellExplored = () => false;
		isExploredWorld = (x, y) => isWorldPointExplored(exploredSet, clone, x, y);
	} else {
		const exploredSet = new Set(clone.exploredCellsByGridType[gridType]);
		isCellExplored = (key) => exploredSet.has(key);
		isExploredWorld = (x, y) => exploredSet.has(worldPointToCellKey(clone, x, y));
	}

	clone.layers = clone.layers.map((layer) => redactLayer(layer, isCellExplored, isExploredWorld, isLitWorld));
	clone.tokens = clone.tokens.filter((token) => {
		if ((token.category ?? "entity") === "player") return true;
		const center = footprintCenter(clone, token);
		return isLitWorld(center.x, center.y);
	});

	for (const gt of CELLED_GRID_TYPES) {
		if (gt !== gridType) clone.exploredCellsByGridType[gt] = [];
	}

	return clone;
}

function redactLayer(
	layer: Layer,
	isCellExplored: (key: string) => boolean,
	isExploredWorld: (x: number, y: number) => boolean,
	isLitWorld: (x: number, y: number) => boolean
): Layer {
	const cellsByGridType = {} as CellsByGridType;
	for (const gridType of CELLED_GRID_TYPES) {
		const cells: CellsByGridType[typeof gridType] = {};
		for (const [key, cell] of Object.entries(layer.cellsByGridType[gridType])) {
			if (isCellExplored(key)) cells[key] = cell;
		}
		cellsByGridType[gridType] = cells;
	}

	const markers = layer.markers.filter((marker) => isExploredWorld(marker.x, marker.y) || isLitWorld(marker.x, marker.y));

	return { ...layer, cellsByGridType, markers, wallPoints: [], wallSegments: [] };
}

import { buildVisionCache, cellCenter, footprintCenter, isPointLit, isWorldPointExplored } from "../grid/fog";
import { CELLED_GRID_TYPES, CellsByGridType, Layer, MapFileData } from "./mapData";

/**
 * Strips everything hidden by fog of war out of `data`, for a read-only export that must never
 * leak what a player hasn't (or can't currently) see — see `PublicMapSnapshot`. Pure/synchronous:
 * no vault access, safe to run outside Obsidian too.
 *
 * Rules (confirmed with the map's owner):
 * - `fogEnabled === false` → nothing is redacted, the whole map is exported as-is.
 * - cell content (zone/stamp/label/links) → kept only if the cell's center was ever explored.
 * - markers (stamps) → kept if explored OR currently within a player's vision.
 * - "entity" tokens → kept only if currently within a player's vision (even if the ground under
 *   them was explored before — they can walk back out of sight).
 * - "player" tokens → always kept.
 * - wall points/segments → always stripped: the public viewer never re-traces vision (it just
 *   paints the exported `exploredCells` as a static mask), and keeping wall geometry around would
 *   otherwise leak the shape of unexplored rooms.
 */
export function buildPublicSnapshot(data: MapFileData): MapFileData {
	const clone = structuredClone(data);
	if (!clone.fogEnabled) return clone;

	const exploredSet = new Set(clone.exploredCells);
	const visionCache = buildVisionCache(clone);
	const isExploredWorld = (x: number, y: number) => isWorldPointExplored(exploredSet, clone, x, y);
	const isLitWorld = (x: number, y: number) => isPointLit(visionCache, x, y, false);

	clone.layers = clone.layers.map((layer) => redactLayer(clone, layer, isExploredWorld, isLitWorld));
	clone.tokens = clone.tokens.filter((token) => {
		if ((token.category ?? "entity") === "player") return true;
		const center = footprintCenter(clone, token);
		return isLitWorld(center.x, center.y);
	});

	return clone;
}

function redactLayer(
	data: MapFileData,
	layer: Layer,
	isExploredWorld: (x: number, y: number) => boolean,
	isLitWorld: (x: number, y: number) => boolean
): Layer {
	const cellsByGridType = {} as CellsByGridType;
	for (const gridType of CELLED_GRID_TYPES) {
		const cells: CellsByGridType[typeof gridType] = {};
		for (const [key, cell] of Object.entries(layer.cellsByGridType[gridType])) {
			const center = cellCenter(data, key);
			if (isExploredWorld(center.x, center.y)) cells[key] = cell;
		}
		cellsByGridType[gridType] = cells;
	}

	const markers = layer.markers.filter((marker) => isExploredWorld(marker.x, marker.y) || isLitWorld(marker.x, marker.y));

	return { ...layer, cellsByGridType, markers, wallPoints: [], wallSegments: [] };
}

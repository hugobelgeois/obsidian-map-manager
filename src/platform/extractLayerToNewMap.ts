import { App, normalizePath, TFile } from "obsidian";
import { generateLocalId, Layer, MapFileData, serializeMapData } from "../data/mapData";
import { sanitizeFileName } from "../utils";

/**
 * Extracts a single layer of `data` into a brand-new sibling `.map` file: the layer becomes that
 * file's sole layer (fresh id, so it doesn't collide with the source map's), and map-level settings
 * that a lone layer can't sensibly choose for itself (grid type, cell size, zoom range, fog on/off)
 * are cloned as-is from the source map.
 *
 * Tokens are map-level, not per-layer (see `MapFileData.tokens`), so there's no reliable way to tell
 * which ones "belong" to this layer — they're copied wholesale rather than silently dropped; the user
 * can delete the ones that don't apply on the new map. Fog memory is not carried over
 * (`exploredCells` starts empty) since it was traced against the full source map, not this one layer.
 *
 * Returns `null` if `layerId` doesn't match a layer on `data` (e.g. stale UI state).
 */
export async function extractLayerToNewMap(app: App, sourceFile: TFile, data: MapFileData, layerId: string): Promise<TFile | null> {
	const layer = data.layers.find((l) => l.id === layerId);
	if (!layer) return null;

	const clonedLayer: Layer = { ...structuredClone(layer), id: generateLocalId("layer") };
	const newData: MapFileData = {
		version: 15,
		gridType: data.gridType,
		cellSize: data.cellSize,
		layers: [clonedLayer],
		activeLayerId: clonedLayer.id,
		tokens: structuredClone(data.tokens),
		minZoom: data.minZoom,
		maxZoom: data.maxZoom,
		fogEnabled: data.fogEnabled,
		fogFrozen: data.fogFrozen,
		exploredCells: [],
	};

	const folder = sourceFile.parent?.path ?? "";
	const baseName = sanitizeFileName(`${sourceFile.basename} - ${layer.name}`);
	let path = normalizePath(folder ? `${folder}/${baseName}.map` : `${baseName}.map`);
	let index = 1;
	while (app.vault.getAbstractFileByPath(path)) {
		path = normalizePath(folder ? `${folder}/${baseName} ${index}.map` : `${baseName} ${index}.map`);
		index++;
	}

	return app.vault.create(path, serializeMapData(newData));
}

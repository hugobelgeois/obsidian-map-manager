import { CellData, Marker, createLayer, generateLocalId, getActiveLayer, Layer, MapFileData, Token } from "../data/mapData";

export type MapControllerListener = () => void;

export type MapMode = "edit" | "view";

export type EditTool = "none" | "brush" | "fill";

const MAX_HISTORY = 100;

/**
 * Owns the in-memory MapFileData for one open map (full view or embed) and
 * fans out change notifications to whichever UI pieces are mounted on top of it.
 */
export class MapController {
	selectedCellKey: string | null = null;
	selectedTokenId: string | null = null;
	selectedMarkerId: string | null = null;
	mode: MapMode;
	/** Whether the grid/cell overlay is shown in view mode (edit mode always shows it). Session-only, not persisted. */
	showCells = true;

	/**
	 * Brush/fill tools (edit mode): apply a zone type / vision blocker to cells, either one at a
	 * time while dragging (brush) or flood-filled from a click (fill). Session-only, not persisted.
	 * `brushZoneMode` is "keep" (untouched), "clear" (remove the zone), or a zoneTypeId to apply.
	 * In grid type "none" these paint the hidden square substrate used for fog only (see `updateCell`).
	 */
	activeTool: EditTool = "none";
	brushRadius = 0;
	brushZoneMode = "keep";
	brushBlockerMode: "keep" | "opaque" | "dim" | "off" = "keep";

	private data: MapFileData;
	private listeners: Set<MapControllerListener> = new Set();
	private exploredSetCache: { source: string[]; set: Set<string> } | null = null;

	/** Undo/redo history, in-memory only. A gesture (drag, brush stroke, fill) coalesces into one entry via begin/endHistoryGroup. */
	private undoStack: MapFileData[] = [];
	private redoStack: MapFileData[] = [];
	private historyGroupDepth = 0;

	constructor(data: MapFileData, private onSave: (data: MapFileData) => void, initialMode: MapMode = "edit") {
		this.data = data;
		this.mode = initialMode;
	}

	setMode(mode: MapMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.notify();
	}

	toggleShowCells(): void {
		this.showCells = !this.showCells;
		this.notify();
	}

	getData(): MapFileData {
		return this.data;
	}

	getActiveLayer(): Layer {
		return getActiveLayer(this.data);
	}

	update(mutator: (data: MapFileData) => void, options: { save?: boolean; history?: boolean } = {}): void {
		if (options.history !== false && this.historyGroupDepth === 0) this.pushHistory();
		mutator(this.data);
		this.notify();
		if (options.save !== false) this.onSave(this.data);
	}

	// ---- Undo/redo ----

	/** Snapshots the current state before a multi-step gesture (brush stroke, fill, slider drag) so it undoes as one step. */
	beginHistoryGroup(): void {
		if (this.historyGroupDepth === 0) this.pushHistory();
		this.historyGroupDepth++;
	}

	endHistoryGroup(): void {
		this.historyGroupDepth = Math.max(0, this.historyGroupDepth - 1);
	}

	private pushHistory(): void {
		this.undoStack.push(structuredClone(this.data));
		if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
		this.redoStack = [];
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	undo(): void {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.redoStack.push(this.data);
		this.data = prev;
		this.exploredSetCache = null;
		this.notify();
		this.onSave(this.data);
	}

	redo(): void {
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(this.data);
		this.data = next;
		this.exploredSetCache = null;
		this.notify();
		this.onSave(this.data);
	}

	// ---- Selection ----

	selectCell(key: string | null): void {
		if (this.selectedCellKey === key && this.selectedTokenId === null && this.selectedMarkerId === null) return;
		this.selectedCellKey = key;
		this.selectedTokenId = null;
		this.selectedMarkerId = null;
		this.notify();
	}

	selectToken(tokenId: string | null): void {
		if (this.selectedTokenId === tokenId && this.selectedCellKey === null && this.selectedMarkerId === null) return;
		this.selectedTokenId = tokenId;
		this.selectedCellKey = null;
		this.selectedMarkerId = null;
		this.notify();
	}

	selectMarker(markerId: string | null): void {
		if (this.selectedMarkerId === markerId && this.selectedCellKey === null && this.selectedTokenId === null) return;
		this.selectedMarkerId = markerId;
		this.selectedCellKey = null;
		this.selectedTokenId = null;
		this.notify();
	}

	getSelectedCell(): CellData | undefined {
		if (!this.selectedCellKey || this.data.gridType === "none") return undefined;
		return this.getActiveLayer().cellsByGridType[this.data.gridType][this.selectedCellKey];
	}

	getSelectedToken(): Token | undefined {
		if (!this.selectedTokenId) return undefined;
		return this.findToken(this.selectedTokenId);
	}

	getSelectedMarker(): Marker | undefined {
		if (!this.selectedMarkerId) return undefined;
		return this.findMarker(this.selectedMarkerId);
	}

	findToken(tokenId: string): Token | undefined {
		return this.data.tokens.find((t) => t.id === tokenId);
	}

	findMarker(markerId: string): Marker | undefined {
		for (const layer of this.data.layers) {
			const marker = layer.markers.find((m) => m.id === markerId);
			if (marker) return marker;
		}
		return undefined;
	}

	// ---- Cells (always on the active layer) ----

	/**
	 * In grid type "none" there's no visible/selectable cell grid, but fog still runs on a hidden
	 * square substrate (see MapCanvas) — so writes there target `cellsByGridType.square` too.
	 */
	updateCell(key: string, mutator: (cell: CellData) => void): void {
		this.update((data) => {
			const layer = getActiveLayer(data);
			const gridType = data.gridType === "none" ? "square" : data.gridType;
			const cells = layer.cellsByGridType[gridType];
			const cell = cells[key] ?? {};
			mutator(cell);
			cells[key] = cell;
		});
	}

	// ---- Brush/fill tools (edit mode) ----

	setActiveTool(tool: EditTool): void {
		this.activeTool = this.activeTool === tool ? "none" : tool;
		this.notify();
	}

	setBrushRadius(radius: number): void {
		this.brushRadius = Math.max(0, Math.round(radius));
		this.notify();
	}

	setBrushZoneMode(mode: string): void {
		this.brushZoneMode = mode;
		this.notify();
	}

	setBrushBlockerMode(mode: "keep" | "opaque" | "dim" | "off"): void {
		this.brushBlockerMode = mode;
		this.notify();
	}

	/** Applies the current brush settings to one cell (called continuously while painting/filling). */
	paintCell(key: string): void {
		if (this.brushZoneMode === "keep" && this.brushBlockerMode === "keep") return;
		const zoneMode = this.brushZoneMode;
		const blockerMode = this.brushBlockerMode;
		this.updateCell(key, (cell) => {
			if (zoneMode === "clear") cell.zoneTypeId = undefined;
			else if (zoneMode !== "keep") cell.zoneTypeId = zoneMode;
			if (blockerMode === "off") cell.visionBlocker = undefined;
			else if (blockerMode !== "keep") cell.visionBlocker = blockerMode;
		});
	}

	// ---- Tokens (map-level: not tied to any layer) ----

	getTokenAt(cellKey: string): Token | undefined {
		return this.data.tokens.find((t) => t.cellKey === cellKey);
	}

	addToken(cellKey: string, init: Partial<Omit<Token, "id" | "cellKey">> = {}): Token | null {
		if (this.getTokenAt(cellKey)) return null;
		const token: Token = {
			id: generateLocalId("token"),
			cellKey,
			icon: init.icon ?? "🧙",
			label: init.label,
			link: init.link,
			templateId: init.templateId,
			size: init.size,
			color: init.color,
		};
		this.update((data) => {
			data.tokens.push(token);
		});
		return token;
	}

	moveToken(tokenId: string, newCellKey: string): boolean {
		const found = this.findToken(tokenId);
		if (!found) return false;
		if (found.cellKey === newCellKey) return true;
		if (this.getTokenAt(newCellKey)) return false;
		this.update((data) => {
			const token = data.tokens.find((t) => t.id === tokenId);
			if (token) token.cellKey = newCellKey;
		});
		return true;
	}

	/** Adds a token positioned freely (grid type "none"), unrelated to any cell. */
	addFreeToken(x: number, y: number, init: Partial<Omit<Token, "id" | "cellKey" | "x" | "y">> = {}): Token {
		const token: Token = {
			id: generateLocalId("token"),
			x,
			y,
			icon: init.icon ?? "🧙",
			label: init.label,
			link: init.link,
			templateId: init.templateId,
			size: init.size,
			color: init.color,
		};
		this.update((data) => {
			data.tokens.push(token);
		});
		return token;
	}

	/** Moves a token to a free position (grid type "none"); no "one per cell" collision check applies. */
	moveTokenFree(tokenId: string, x: number, y: number): void {
		this.update((data) => {
			const token = data.tokens.find((t) => t.id === tokenId);
			if (token) {
				token.x = x;
				token.y = y;
			}
		});
	}

	updateToken(tokenId: string, mutator: (token: Token) => void): void {
		this.update((data) => {
			const token = data.tokens.find((t) => t.id === tokenId);
			if (token) mutator(token);
		});
	}

	removeToken(tokenId: string): void {
		this.update((data) => {
			data.tokens = data.tokens.filter((t) => t.id !== tokenId);
		});
		if (this.selectedTokenId === tokenId) this.selectToken(null);
	}

	// ---- Markers (free-floating stamps, grid type "none" only, scoped to the active layer) ----

	addMarker(x: number, y: number): Marker {
		const marker: Marker = { id: generateLocalId("marker"), x, y, stamp: "📍" };
		this.update((data) => {
			getActiveLayer(data).markers.push(marker);
		});
		return marker;
	}

	updateMarker(markerId: string, mutator: (marker: Marker) => void): void {
		this.update((data) => {
			for (const layer of data.layers) {
				const marker = layer.markers.find((m) => m.id === markerId);
				if (marker) {
					mutator(marker);
					return;
				}
			}
		});
	}

	moveMarker(markerId: string, x: number, y: number): void {
		this.updateMarker(markerId, (m) => {
			m.x = x;
			m.y = y;
		});
	}

	removeMarker(markerId: string): void {
		this.update((data) => {
			for (const layer of data.layers) layer.markers = layer.markers.filter((m) => m.id !== markerId);
		});
		if (this.selectedMarkerId === markerId) this.selectMarker(null);
	}

	// ---- Fog of war ----

	toggleFog(): void {
		this.update((data) => (data.fogEnabled = !data.fogEnabled));
	}

	resetFog(): void {
		this.update((data) => (data.exploredCells = []));
	}

	getExploredSet(): Set<string> {
		if (this.exploredSetCache?.source !== this.data.exploredCells) {
			this.exploredSetCache = { source: this.data.exploredCells, set: new Set(this.data.exploredCells) };
		}
		return this.exploredSetCache.set;
	}

	/** Adds newly-lit cells to the persisted "ever explored" set. No-op (and no save) if nothing is new. */
	markExplored(cellKeys: Iterable<string>): void {
		const existing = this.getExploredSet();
		const toAdd: string[] = [];
		for (const key of cellKeys) {
			if (!existing.has(key)) toAdd.push(key);
		}
		if (toAdd.length === 0) return;
		// Update the cache *before* update()/notify(), which re-enters render() synchronously:
		// if it ran after, the re-entrant render would see these cells as still unexplored and
		// recurse into markExplored again indefinitely (this was the "1 player token = huge lag" bug).
		for (const key of toAdd) existing.add(key);
		this.update(
			(data) => {
				data.exploredCells.push(...toAdd);
			},
			{ history: false }
		);
	}

	// ---- Layers ----

	setActiveLayer(layerId: string): void {
		this.update((data) => {
			if (data.layers.some((l) => l.id === layerId)) data.activeLayerId = layerId;
		});
	}

	toggleLayerVisibility(layerId: string): void {
		this.update((data) => {
			const layer = data.layers.find((l) => l.id === layerId);
			if (layer) layer.visible = !layer.visible;
		});
	}

	renameLayer(layerId: string, name: string): void {
		this.update((data) => {
			const layer = data.layers.find((l) => l.id === layerId);
			if (layer && name.trim()) layer.name = name.trim();
		});
	}

	addLayer(name: string): void {
		this.update((data) => {
			const layer = createLayer(name);
			data.layers.push(layer);
			data.activeLayerId = layer.id;
		});
	}

	removeLayer(layerId: string): void {
		this.update((data) => {
			if (data.layers.length <= 1) return;
			data.layers = data.layers.filter((l) => l.id !== layerId);
			if (data.activeLayerId === layerId) data.activeLayerId = data.layers[0]?.id ?? "";
		});
	}

	moveLayer(layerId: string, direction: -1 | 1): void {
		this.update((data) => {
			const index = data.layers.findIndex((l) => l.id === layerId);
			const target = index + direction;
			if (index === -1 || target < 0 || target >= data.layers.length) return;
			const [layer] = data.layers.splice(index, 1);
			if (layer) data.layers.splice(target, 0, layer);
		});
	}

	onChange(cb: MapControllerListener): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private notify(): void {
		for (const cb of this.listeners) cb();
	}
}

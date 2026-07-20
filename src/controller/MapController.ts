import { CellData, Marker, VisionBlockerType, WallPoint, createLayer, generateLocalId, getActiveLayer, Layer, MapFileData, Token } from "../data/mapData";
import { WallShapeKind, wallShapeCorners } from "../grid/gridMath";

export type MapControllerListener = () => void;

export type MapMode = "edit" | "view";

export type EditTool = "none" | "brush" | "fill" | "wall";

/** One step of the in-progress wall chain (see `commitWallPoint`/`undoLastWallPoint`). */
interface WallChainStep {
	pointId: string;
	/** Whether this step created a new point (vs. reusing/snapping onto an existing one) — determines whether undo deletes the point or just the segment. */
	createdPoint: boolean;
	/** The segment connecting this step to the previous one, or `null` for the chain's first point. */
	segmentId: string | null;
}

const MAX_HISTORY = 100;

/**
 * Owns the in-memory MapFileData for one open map (full view or embed) and
 * fans out change notifications to whichever UI pieces are mounted on top of it.
 */
export class MapController {
	selectedCellKey: string | null = null;
	selectedTokenId: string | null = null;
	selectedMarkerId: string | null = null;
	selectedWallPointId: string | null = null;
	mode: MapMode;
	/** Whether the grid/cell overlay is shown in view mode (edit mode always shows it). Session-only, not persisted. */
	showCells = true;

	/**
	 * Brush/fill tools (edit mode): apply a zone type to cells, either one at a time while dragging
	 * (brush) or flood-filled from a click (fill). Session-only, not persisted. `brushZoneMode` is
	 * "keep" (untouched), "clear" (remove the zone), or a zoneTypeId to apply.
	 */
	activeTool: EditTool = "none";
	brushRadius = 0;
	brushZoneMode = "keep";

	/** Default blocker type applied to newly-drawn wall segments (edit mode, "wall" tool). Session-only. */
	wallDrawBlockerType: VisionBlockerType = "opaque";
	/** The in-progress wall chain — each left-click while the "wall" tool is active pushes one step (see `commitWallPoint`). Session-only. */
	private wallChain: WallChainStep[] = [];

	/**
	 * Which shape preset (if any) is being interactively placed: the first click records a corner
	 * (`wallShapeFirstCorner`), the second commits a shape spanning both corners (see
	 * `placeWallShapeCorner`). Both session-only, mutually exclusive with `wallChain` (starting a
	 * shape placement resets the chain, and vice versa via `setActiveTool`).
	 */
	pendingWallShape: WallShapeKind | null = null;
	private wallShapeFirstCorner: { x: number; y: number } | null = null;

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
		if (this.selectedCellKey === key && this.selectedTokenId === null && this.selectedMarkerId === null && this.selectedWallPointId === null) return;
		this.selectedCellKey = key;
		this.selectedTokenId = null;
		this.selectedMarkerId = null;
		this.selectedWallPointId = null;
		this.notify();
	}

	selectToken(tokenId: string | null): void {
		if (this.selectedTokenId === tokenId && this.selectedCellKey === null && this.selectedMarkerId === null && this.selectedWallPointId === null) return;
		this.selectedTokenId = tokenId;
		this.selectedCellKey = null;
		this.selectedMarkerId = null;
		this.selectedWallPointId = null;
		this.notify();
	}

	selectMarker(markerId: string | null): void {
		if (this.selectedMarkerId === markerId && this.selectedCellKey === null && this.selectedTokenId === null && this.selectedWallPointId === null) return;
		this.selectedMarkerId = markerId;
		this.selectedCellKey = null;
		this.selectedTokenId = null;
		this.selectedWallPointId = null;
		this.notify();
	}

	selectWallPoint(pointId: string | null): void {
		if (this.selectedWallPointId === pointId && this.selectedCellKey === null && this.selectedTokenId === null && this.selectedMarkerId === null) return;
		this.selectedWallPointId = pointId;
		this.selectedCellKey = null;
		this.selectedTokenId = null;
		this.selectedMarkerId = null;
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

	getSelectedWallPoint(): WallPoint | undefined {
		if (!this.selectedWallPointId) return undefined;
		return this.findWallPoint(this.selectedWallPointId);
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

	findWallPoint(pointId: string): WallPoint | undefined {
		for (const layer of this.data.layers) {
			const point = layer.wallPoints.find((p) => p.id === pointId);
			if (point) return point;
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
		// A fresh activation of the wall tool always starts an unconnected chain and cancels any
		// pending shape placement, whether it's being turned on for the first time or re-toggled
		// after being switched off mid-chain/mid-placement.
		if (tool === "wall") {
			this.resetWallChain();
			this.cancelWallShapePlacement();
		}
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

	/** Applies the current brush zone type to one cell (called continuously while painting/filling). */
	paintCell(key: string): void {
		if (this.brushZoneMode === "keep") return;
		const zoneMode = this.brushZoneMode;
		this.updateCell(key, (cell) => {
			if (zoneMode === "clear") cell.zoneTypeId = undefined;
			else cell.zoneTypeId = zoneMode;
		});
	}

	// ---- Walls (freeform vision-blocking lines, scoped to the active layer) ----

	setWallDrawBlockerType(type: VisionBlockerType): void {
		this.wallDrawBlockerType = type;
		this.notify();
	}

	/** Clears the in-progress chain without deleting anything (tool toggled off/on). */
	resetWallChain(): void {
		this.wallChain = [];
	}

	/** The chain's current tail point (where the next click continues from), or `null` if no chain is in progress — used to draw the live preview line. */
	getWallChainTailId(): string | null {
		return this.wallChain[this.wallChain.length - 1]?.pointId ?? null;
	}

	/** The shape picker's first-clicked corner, or `null` if none has been placed yet — used to draw the live preview outline. */
	getWallShapeFirstCorner(): { x: number; y: number } | null {
		return this.wallShapeFirstCorner;
	}

	/**
	 * Arms the interactive shape picker: the next click records a corner, the one after commits a
	 * whole closed wall shape spanning both corners (see `placeWallShapeCorner`). Clicking the same
	 * shape again cancels it, matching the toggle behavior of `setActiveTool`.
	 */
	startWallShapePlacement(shape: WallShapeKind): void {
		if (this.pendingWallShape === shape) {
			this.cancelWallShapePlacement();
			return;
		}
		this.pendingWallShape = shape;
		this.wallShapeFirstCorner = null;
		this.resetWallChain();
		this.notify();
	}

	/** Fully cancels the shape picker (toolbar toggle-off / re-arming a different shape). */
	cancelWallShapePlacement(): void {
		if (!this.pendingWallShape) return;
		this.pendingWallShape = null;
		this.wallShapeFirstCorner = null;
		this.notify();
	}

	/** Right-click handler during shape placement: un-places the first corner if one was set, else cancels the picker entirely — mirrors `undoLastWallPoint`'s one-step-back undo. */
	cancelWallShapeStep(): void {
		if (!this.pendingWallShape) return;
		if (this.wallShapeFirstCorner) this.wallShapeFirstCorner = null;
		else this.pendingWallShape = null;
		this.notify();
	}

	/**
	 * The single entry point for every left-click while a shape is armed (`pendingWallShape` set):
	 * the first call records `(x, y)` as the first corner; the second commits a whole closed wall
	 * shape spanning both corners (see `wallShapeCorners`) using the current draw blocker type for
	 * every edge, then disarms the picker.
	 */
	placeWallShapeCorner(x: number, y: number): void {
		const shape = this.pendingWallShape;
		if (!shape) return;
		if (!this.wallShapeFirstCorner) {
			this.wallShapeFirstCorner = { x, y };
			this.notify();
			return;
		}
		const blockerType = this.wallDrawBlockerType;
		const corners = wallShapeCorners(shape, this.wallShapeFirstCorner, { x, y });
		this.pendingWallShape = null;
		this.wallShapeFirstCorner = null;
		this.update((data) => {
			const layer = getActiveLayer(data);
			const points: WallPoint[] = corners.map((c) => ({ id: generateLocalId("wallpoint"), x: c.x, y: c.y }));
			layer.wallPoints.push(...points);
			for (let i = 0; i < points.length; i++) {
				const a = points[i];
				const b = points[(i + 1) % points.length];
				if (!a || !b) continue;
				layer.wallSegments.push({ id: generateLocalId("wallsegment"), aId: a.id, bId: b.id, blockerType });
			}
		});
	}

	/**
	 * The single entry point for every left-click while the "wall" tool is active: resolves the
	 * clicked point (reusing `existingPointId` if the click snapped onto one, else creating a new
	 * point at `x,y`), connects it to the chain's previous point with a segment if there is one, and
	 * selects it. `existingPointId`, when given, must belong to a `WallPoint` already present on some
	 * layer (found via `resolveWallPlacement` in MapCanvas).
	 */
	commitWallPoint(x: number, y: number, existingPointId?: string): void {
		const blockerType = this.wallDrawBlockerType;
		const previous = this.wallChain[this.wallChain.length - 1];
		this.update((data) => {
			const layer = getActiveLayer(data);
			let pointId = existingPointId;
			if (!pointId) {
				const point: WallPoint = { id: generateLocalId("wallpoint"), x, y };
				layer.wallPoints.push(point);
				pointId = point.id;
			}
			let segmentId: string | null = null;
			if (previous && previous.pointId !== pointId) {
				segmentId = generateLocalId("wallsegment");
				layer.wallSegments.push({ id: segmentId, aId: previous.pointId, bId: pointId, blockerType });
			}
			this.wallChain.push({ pointId, createdPoint: !existingPointId, segmentId });
		});
		this.selectWallPoint(this.wallChain[this.wallChain.length - 1]?.pointId ?? null);
	}

	/** Right-click handler: undoes just the last placed point (and its connecting segment), like a vector pen tool. */
	undoLastWallPoint(): void {
		const last = this.wallChain.pop();
		if (!last) return;
		this.update((data) => {
			for (const layer of data.layers) {
				if (last.segmentId) layer.wallSegments = layer.wallSegments.filter((s) => s.id !== last.segmentId);
				if (last.createdPoint) layer.wallPoints = layer.wallPoints.filter((p) => p.id !== last.pointId);
			}
		});
		const newLast = this.wallChain[this.wallChain.length - 1];
		this.selectWallPoint(newLast?.pointId ?? null);
	}

	/**
	 * Every point/segment reachable from `pointId` by following wall segments (within the same
	 * layer, since a segment can't span layers — see `setActiveLayer`) — i.e. the whole connected
	 * "shape" this point belongs to, not just its immediately-touching segments. Deleting a point and
	 * changing a shape's blocker type both act on this whole set, since a wall's shape is one unit.
	 */
	private wallShapeOf(pointId: string): { layer: Layer; pointIds: Set<string>; segmentIds: Set<string> } | undefined {
		const layer = this.data.layers.find((l) => l.wallPoints.some((p) => p.id === pointId));
		if (!layer) return undefined;
		const pointIds = new Set<string>([pointId]);
		const segmentIds = new Set<string>();
		const queue: string[] = [pointId];
		while (queue.length > 0) {
			const current = queue.shift();
			if (current === undefined) break;
			for (const segment of layer.wallSegments) {
				if (segment.aId !== current && segment.bId !== current) continue;
				segmentIds.add(segment.id);
				const other = segment.aId === current ? segment.bId : segment.aId;
				if (!pointIds.has(other)) {
					pointIds.add(other);
					queue.push(other);
				}
			}
		}
		return { layer, pointIds, segmentIds };
	}

	/** Moves a wall point to a new position (drag), searching across all layers by id like `updateMarker`. */
	moveWallPoint(pointId: string, x: number, y: number): void {
		this.update((data) => {
			for (const layer of data.layers) {
				const point = layer.wallPoints.find((p) => p.id === pointId);
				if (point) {
					point.x = x;
					point.y = y;
					return;
				}
			}
		});
	}

	/** Deletes a wall point's entire connected shape — every point and segment reachable from it (info-panel delete button). */
	removeWallPoint(pointId: string): void {
		const shape = this.wallShapeOf(pointId);
		if (!shape) return;
		const { layer, pointIds, segmentIds } = shape;
		this.update((data) => {
			const target = data.layers.find((l) => l.id === layer.id);
			if (!target) return;
			target.wallPoints = target.wallPoints.filter((p) => !pointIds.has(p.id));
			target.wallSegments = target.wallSegments.filter((s) => !segmentIds.has(s.id));
		});
		this.wallChain = this.wallChain.filter((step) => !pointIds.has(step.pointId));
		if (this.selectedWallPointId && pointIds.has(this.selectedWallPointId)) this.selectWallPoint(null);
	}

	/** Bulk-sets the blocker type of every segment in `pointId`'s whole connected shape (info-panel type editor). */
	setWallPointBlockerType(pointId: string, type: VisionBlockerType): void {
		const shape = this.wallShapeOf(pointId);
		if (!shape) return;
		const { layer, segmentIds } = shape;
		this.update((data) => {
			const target = data.layers.find((l) => l.id === layer.id);
			if (!target) return;
			for (const segment of target.wallSegments) {
				if (segmentIds.has(segment.id)) segment.blockerType = type;
			}
		});
	}

	/** Every segment in `pointId`'s whole connected shape, for the info panel's type editor. */
	getSegmentsForPoint(pointId: string): { blockerType: VisionBlockerType }[] {
		const shape = this.wallShapeOf(pointId);
		if (!shape) return [];
		return shape.layer.wallSegments.filter((s) => shape.segmentIds.has(s.id));
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
		// A wall chain's points/segments all belong to whichever layer was active while drawing it
		// (see `commitWallPoint`) — switching layers mid-chain would connect a new point on the new
		// active layer to a previous point that only exists on the old one, so end the chain here.
		this.resetWallChain();
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

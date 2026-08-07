import { CellData, Marker, VisionBlockerType, WallPoint, WallSegment, createLayer, generateLocalId, getActiveLayer, Layer, MapFileData, Token } from "../data/mapData";
import { WallShapeKind, clamp, collinearOverlap, projectParam, segmentIntersection, wallShapeCorners } from "../grid/gridMath";

export type MapControllerListener = () => void;

export type MapMode = "edit" | "view";

export type EditTool = "none" | "brush" | "fill" | "wall";

/** Tolerance, as a fraction of a segment's own length, for treating a `t` parameter as landing "at" 0/1 (an endpoint) rather than strictly inside — see `addWallSegment`. */
const WALL_T_EPSILON = 1e-4;

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
	/** A single wall *segment* selected for editing (as opposed to `selectedWallPointId`, one of its endpoints) — see `selectWallSegment`. */
	selectedWallSegmentId: string | null = null;
	mode: MapMode;
	/** Whether the grid/cell overlay is shown in view mode (edit mode always shows it). Session-only, not persisted. */
	showCells = true;
	/** Whether the InfoPanel (whatever is currently selected) also renders on a player mirror window — see InfoPanel's "eye" button and `MapPlayerMirrorView`. Session-only, not persisted. */
	showInfoToPlayers = false;
	/**
	 * Which InfoPanel tab is currently previewed for the selected token (by tab id) — shared on the
	 * controller (rather than kept private to one InfoPanel instance) so a player mirror's InfoPanel
	 * follows the GM's tab clicks live, same as the selection itself. Reset to `null` (falls back to
	 * the first tab, see InfoPanel's `resolveActiveTab`) whenever the selection changes — see
	 * `selectToken`/`selectCell`/`selectMarker`/`selectWallPoint`. Session-only, not persisted.
	 */
	activeInfoTabId: string | null = null;
	/** Same idea as `activeInfoTabId`, for a cell/marker's linked-note tabs (by index). */
	activeInfoLinkIndex = 0;

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
	/**
	 * The in-progress wall chain: the id of each point placed so far, in order — each left-click
	 * while the "wall" tool is active pushes one more (see `commitWallPoint`). Session-only. Undoing
	 * a step (`undoLastWallPoint`) just pops this and reuses the generic undo stack to revert
	 * whatever that step's `update()` call did to the data, rather than re-deriving it — a single
	 * commit can touch an arbitrary number of points/segments once crossings/overlaps with existing
	 * walls are reconciled (see `addWallSegment`), so there's no fixed shape to reverse by hand.
	 */
	private wallChain: string[] = [];

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

	toggleShowInfoToPlayers(): void {
		this.showInfoToPlayers = !this.showInfoToPlayers;
		this.notify();
	}

	setActiveInfoTab(tabId: string): void {
		this.activeInfoTabId = tabId;
		this.notify();
	}

	setActiveInfoLinkIndex(index: number): void {
		this.activeInfoLinkIndex = index;
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

	/**
	 * Swaps in a whole new document loaded from disk after another open window saved a change to
	 * the same file — never calls `onSave` (that would just echo the write back). Undo/redo are
	 * cleared: their snapshots predate the external change, so undoing into them would silently
	 * discard whatever the other window just did.
	 */
	replaceData(newData: MapFileData): void {
		this.data = newData;
		this.exploredSetCache = null;
		this.undoStack = [];
		this.redoStack = [];
		this.notify();
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

	/** Whatever InfoPanel tab was being previewed belongs to the *previous* selection — see `activeInfoTabId`. */
	private resetInfoTabState(): void {
		this.activeInfoTabId = null;
		this.activeInfoLinkIndex = 0;
	}

	selectCell(key: string | null): void {
		if (
			this.selectedCellKey === key &&
			this.selectedTokenId === null &&
			this.selectedMarkerId === null &&
			this.selectedWallPointId === null &&
			this.selectedWallSegmentId === null
		)
			return;
		this.selectedCellKey = key;
		this.selectedTokenId = null;
		this.selectedMarkerId = null;
		this.selectedWallPointId = null;
		this.selectedWallSegmentId = null;
		this.resetInfoTabState();
		this.notify();
	}

	selectToken(tokenId: string | null): void {
		if (
			this.selectedTokenId === tokenId &&
			this.selectedCellKey === null &&
			this.selectedMarkerId === null &&
			this.selectedWallPointId === null &&
			this.selectedWallSegmentId === null
		)
			return;
		this.selectedTokenId = tokenId;
		this.selectedCellKey = null;
		this.selectedMarkerId = null;
		this.selectedWallPointId = null;
		this.selectedWallSegmentId = null;
		this.resetInfoTabState();
		this.notify();
	}

	selectMarker(markerId: string | null): void {
		if (
			this.selectedMarkerId === markerId &&
			this.selectedCellKey === null &&
			this.selectedTokenId === null &&
			this.selectedWallPointId === null &&
			this.selectedWallSegmentId === null
		)
			return;
		this.selectedMarkerId = markerId;
		this.selectedCellKey = null;
		this.selectedTokenId = null;
		this.selectedWallPointId = null;
		this.selectedWallSegmentId = null;
		this.resetInfoTabState();
		this.notify();
	}

	selectWallPoint(pointId: string | null): void {
		if (
			this.selectedWallPointId === pointId &&
			this.selectedCellKey === null &&
			this.selectedTokenId === null &&
			this.selectedMarkerId === null &&
			this.selectedWallSegmentId === null
		)
			return;
		this.selectedWallPointId = pointId;
		this.selectedCellKey = null;
		this.selectedTokenId = null;
		this.selectedMarkerId = null;
		this.selectedWallSegmentId = null;
		this.resetInfoTabState();
		this.notify();
	}

	/** Selects a single wall *segment* (the line between two `WallPoint`s), for editing just that edge's blocker type independently of the rest of its connected shape — see `setWallSegmentBlockerType`. */
	selectWallSegment(segmentId: string | null): void {
		if (
			this.selectedWallSegmentId === segmentId &&
			this.selectedCellKey === null &&
			this.selectedTokenId === null &&
			this.selectedMarkerId === null &&
			this.selectedWallPointId === null
		)
			return;
		this.selectedWallSegmentId = segmentId;
		this.selectedCellKey = null;
		this.selectedTokenId = null;
		this.selectedMarkerId = null;
		this.selectedWallPointId = null;
		this.resetInfoTabState();
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

	getSelectedWallSegment(): WallSegment | undefined {
		if (!this.selectedWallSegmentId) return undefined;
		return this.findWallSegment(this.selectedWallSegmentId);
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

	findWallSegment(segmentId: string): WallSegment | undefined {
		for (const layer of this.data.layers) {
			const segment = layer.wallSegments.find((s) => s.id === segmentId);
			if (segment) return segment;
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
		// after being switched off mid-chain/mid-placement. It also drops any leftover point/segment
		// selection — otherwise the info panel's blocker-type editor from whatever was selected
		// before would sit open the whole time you're placing new wall points, which reads as if it
		// were part of the placement flow itself. `commitWallPoint` deliberately doesn't reselect
		// while a chain is still in progress, for the same reason — see there.
		if (tool === "wall") {
			this.resetWallChain();
			this.cancelWallShapePlacement();
			this.selectWallPoint(null);
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

	/**
	 * Clears the in-progress chain (tool toggled off/on, shape re-armed, layer switched, chain
	 * finished, ...). A chain that's just a single point — started, then abandoned before a second
	 * click ever connected it to anything — has that lone, segment-less point deleted too (see
	 * `purgeIfOrphanedWallPoint`); a longer chain's points all have at least one segment by
	 * construction (`addWallSegment` runs for every point past the first), so there's nothing to
	 * check there.
	 */
	resetWallChain(): void {
		const lonelyId = this.wallChain.length === 1 ? this.wallChain[0] : undefined;
		this.wallChain = [];
		if (!lonelyId) return;
		this.update(
			(data) => {
				for (const layer of data.layers) this.purgeIfOrphanedWallPoint(layer, lonelyId);
			},
			{ history: false }
		);
	}

	/** The chain's current tail point (where the next click continues from), or `null` if no chain is in progress — used to draw the live preview line. */
	getWallChainTailId(): string | null {
		return this.wallChain[this.wallChain.length - 1] ?? null;
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
	 * every edge. Each edge goes through `addWallSegment` like a chain click would, so a shape that
	 * crosses/overlaps existing walls gets reconciled the same way.
	 *
	 * The shape itself stays armed afterward — only the "first corner already placed" half-state
	 * resets — so placing several of the same shape in a row doesn't need re-picking it from the
	 * toolbar each time. Toggle it off explicitly instead (the same button, or `startWallShapePlacement`
	 * arming a different one).
	 */
	placeWallShapeCorner(x: number, y: number): void {
		const shape = this.pendingWallShape;
		if (!shape) return;
		// Same "hide the info panel the instant a point goes down" rule as `commitWallPoint`.
		this.selectWallPoint(null);
		if (!this.wallShapeFirstCorner) {
			this.wallShapeFirstCorner = { x, y };
			this.notify();
			return;
		}
		const blockerType = this.wallDrawBlockerType;
		const corners = wallShapeCorners(shape, this.wallShapeFirstCorner, { x, y });
		this.wallShapeFirstCorner = null;
		this.update((data) => {
			const layer = getActiveLayer(data);
			const points: WallPoint[] = corners.map((c) => ({ id: generateLocalId("wallpoint"), x: c.x, y: c.y }));
			layer.wallPoints.push(...points);
			for (let i = 0; i < points.length; i++) {
				const a = points[i];
				const b = points[(i + 1) % points.length];
				if (!a || !b) continue;
				this.addWallSegment(layer, a.id, b.id, blockerType);
			}
		});
	}

	/**
	 * The single entry point for every left-click while the "wall" tool is active: resolves the
	 * clicked point (reusing `existingPointId` if the click snapped onto one, else creating a new
	 * point at `x,y`) and connects it to the chain's previous point with a segment if there is one.
	 * `existingPointId`, when given, must belong to a `WallPoint` already present on some layer
	 * (found via `resolveWallPlacement` in MapCanvas).
	 *
	 * Hides the info panel the instant this runs (see `setActiveTool`) and keeps it hidden even once
	 * the chain finishes — placing/finishing a wall is never itself a reason to pop the blocker-type
	 * editor open; that only happens from an explicit click on a point/segment with the tool off.
	 *
	 * The chain finishes right there, with nothing left to continue from, in three cases: clicking
	 * the chain's own most-recently-placed point again (like double-clicking to end a polyline
	 * elsewhere), closing the loop onto some *other* already-existing point, or landing on another
	 * wall's line entirely (a T-junction, reconciled by `addWallSegment` below).
	 */
	commitWallPoint(x: number, y: number, existingPointId?: string): void {
		this.selectWallPoint(null);

		const blockerType = this.wallDrawBlockerType;
		const previous = this.wallChain[this.wallChain.length - 1];

		if (existingPointId && previous && existingPointId === previous) {
			this.resetWallChain();
			return;
		}

		let joinedExisting = !!existingPointId && !!previous && previous !== existingPointId;
		this.update((data) => {
			const layer = getActiveLayer(data);
			let pointId = existingPointId;
			if (!pointId) {
				const point: WallPoint = { id: generateLocalId("wallpoint"), x, y };
				layer.wallPoints.push(point);
				pointId = point.id;
			}
			if (previous && previous !== pointId) {
				if (this.addWallSegment(layer, previous, pointId, blockerType)) joinedExisting = true;
			}
			this.wallChain.push(pointId);
		});
		if (joinedExisting) this.resetWallChain();
	}

	/**
	 * Adds a wall segment `aId`→`bId` to `layer`, reconciling it against every already-committed
	 * segment there first — walls aren't allowed to just cross or stack over each other invisibly:
	 *  - A transversal crossing gets a shared point dropped right where the two lines meet,
	 *    splitting the *existing* segment there so the two walls are actually joined, not just
	 *    visually overlapping; the new segment is likewise split into sub-segments between
	 *    crossings, so each sub-segment always sits between two real points.
	 *  - A run that's collinear with (and overlaps) an existing segment doesn't get a second,
	 *    stacked segment for the shared stretch — that stretch keeps a single segment, using
	 *    whichever of the two blocker types is more restrictive ("opaque" over "dim").
	 * Must run inside `update()`'s mutator (one history entry per commit, however many
	 * points/segments it ends up touching — see `commitWallPoint`).
	 *
	 * Returns whether `bId` — the point just placed, as opposed to `aId`, the chain's already-
	 * established previous point — ended up touching some *other* wall (its line, or one of its own
	 * points) in the process, which `commitWallPoint` treats as "joined a wall", finishing the chain.
	 */
	private addWallSegment(layer: Layer, aId: string, bId: string, blockerType: VisionBlockerType): boolean {
		if (aId === bId) return false;
		const pointsById = new Map(layer.wallPoints.map((p) => [p.id, p]));
		const a = pointsById.get(aId);
		const b = pointsById.get(bId);
		if (!a || !b) return false;

		const eps = WALL_T_EPSILON;
		/** Reuses whichever WallPoint already sits at `pt` (within a hair of floating-point noise) instead of stacking a near-duplicate. */
		const pointAt = (pt: { x: number; y: number }): string => {
			for (const p of layer.wallPoints) {
				if (Math.hypot(p.x - pt.x, p.y - pt.y) < 1e-4) return p.id;
			}
			const point: WallPoint = { id: generateLocalId("wallpoint"), x: pt.x, y: pt.y };
			layer.wallPoints.push(point);
			pointsById.set(point.id, point);
			return point.id;
		};

		// Every point the final a→b chain of sub-segments must pass through, keyed by its `t` along
		// a→b (0 = a, 1 = b) so they sort/dedupe naturally; the two ends are always included.
		const cuts = new Map<number, string>([
			[0, aId],
			[1, bId],
		]);
		// t-ranges of the new segment an existing wall already covers — resolved as part of that
		// existing wall's own rebuild below, so the final a→b pass must skip re-creating a stacked
		// duplicate there.
		const coveredRanges: { t0: number; t1: number }[] = [];
		let joinedOtherWall = false;

		const existingSegments = layer.wallSegments;
		const keptSegments: WallSegment[] = [];
		for (const existing of existingSegments) {
			const ea = pointsById.get(existing.aId);
			const eb = pointsById.get(existing.bId);
			if (!ea || !eb) {
				keptSegments.push(existing);
				continue;
			}

			const overlap = collinearOverlap(a, b, ea, eb);
			if (overlap) {
				const { t0, t1 } = overlap;
				const startPt = { x: a.x + t0 * (b.x - a.x), y: a.y + t0 * (b.y - a.y) };
				const endPt = { x: a.x + t1 * (b.x - a.x), y: a.y + t1 * (b.y - a.y) };
				const startId = t0 <= eps ? aId : t0 >= 1 - eps ? bId : pointAt(startPt);
				const endId = t1 <= eps ? aId : t1 >= 1 - eps ? bId : pointAt(endPt);
				cuts.set(t0, startId);
				cuts.set(t1, endId);
				coveredRanges.push({ t0, t1 });
				if (t1 >= 1 - eps) joinedOtherWall = true;

				// Rebuild `existing` around the overlap: whatever of its own extent sits outside
				// [t0, t1] keeps its original type as its own segment(s); the shared middle becomes
				// one merged segment, opaque winning over dim.
				const winningType: VisionBlockerType = existing.blockerType === "opaque" || blockerType === "opaque" ? "opaque" : "dim";
				const teA = projectParam(ea, a, b);
				const teB = projectParam(eb, a, b);
				const [loT, loId, hiT, hiId] = teA <= teB ? [teA, existing.aId, teB, existing.bId] : [teB, existing.bId, teA, existing.aId];
				if (loT < t0 - eps) keptSegments.push({ id: generateLocalId("wallsegment"), aId: loId, bId: startId, blockerType: existing.blockerType });
				if (hiT > t1 + eps) keptSegments.push({ id: generateLocalId("wallsegment"), aId: endId, bId: hiId, blockerType: existing.blockerType });
				keptSegments.push({ id: generateLocalId("wallsegment"), aId: startId, bId: endId, blockerType: winningType });
				continue;
			}

			const cross = segmentIntersection(a, b, ea, eb);
			if (!cross) {
				keptSegments.push(existing);
				continue;
			}
			const t = clamp(projectParam(cross, a, b), 0, 1);
			const u = clamp(projectParam(cross, ea, eb), 0, 1);
			const uInterior = u > eps && u < 1 - eps;

			if (t > eps && t < 1 - eps) {
				// A genuine interior crossing (an "X") — split both segments at a shared new point,
				// or route through whichever of the existing segment's own endpoints it lands on.
				if (uInterior) {
					const crossPointId = pointAt(cross);
					cuts.set(t, crossPointId);
					keptSegments.push(
						{ id: generateLocalId("wallsegment"), aId: existing.aId, bId: crossPointId, blockerType: existing.blockerType },
						{ id: generateLocalId("wallsegment"), aId: crossPointId, bId: existing.bId, blockerType: existing.blockerType }
					);
				} else {
					cuts.set(t, u <= 0.5 ? existing.aId : existing.bId);
					keptSegments.push(existing);
				}
			} else if (t >= 1 - eps && uInterior) {
				// `b` — the point just placed — lands mid-way along an existing wall's line: a
				// T-junction. Split the existing segment there (reusing `bId`, no new point needed)
				// and flag this as "joined an existing wall" for `commitWallPoint`.
				keptSegments.push(
					{ id: generateLocalId("wallsegment"), aId: existing.aId, bId, blockerType: existing.blockerType },
					{ id: generateLocalId("wallsegment"), aId: bId, bId: existing.bId, blockerType: existing.blockerType }
				);
				joinedOtherWall = true;
			} else if (t <= eps && uInterior) {
				// `a` — the chain's already-established point — sits mid-way along an existing wall's
				// line (typically because it was itself placed there via a T-junction snap). Split the
				// existing segment there too, for the same connectivity reason, but this doesn't count
				// as "just joined" — `a` wasn't the point placed by *this* click.
				keptSegments.push(
					{ id: generateLocalId("wallsegment"), aId: existing.aId, bId: aId, blockerType: existing.blockerType },
					{ id: generateLocalId("wallsegment"), aId, bId: existing.bId, blockerType: existing.blockerType }
				);
			} else {
				keptSegments.push(existing);
			}
		}

		const sortedTs = Array.from(cuts.keys()).sort((x, y) => x - y);
		const uniqueTs: number[] = [];
		for (const t of sortedTs) {
			if (uniqueTs.length === 0 || t - (uniqueTs[uniqueTs.length - 1] as number) > eps) uniqueTs.push(t);
		}
		const newSegments: WallSegment[] = [];
		for (let i = 0; i < uniqueTs.length - 1; i++) {
			const t0 = uniqueTs[i] as number;
			const t1 = uniqueTs[i + 1] as number;
			const mid = (t0 + t1) / 2;
			if (coveredRanges.some((r) => mid > r.t0 - eps && mid < r.t1 + eps)) continue;
			const fromId = cuts.get(t0);
			const toId = cuts.get(t1);
			if (!fromId || !toId) continue;
			newSegments.push({ id: generateLocalId("wallsegment"), aId: fromId, bId: toId, blockerType });
		}

		layer.wallSegments = [...keptSegments, ...newSegments];
		return joinedOtherWall;
	}

	/**
	 * Right-click handler: undoes just the last placed point, like a vector pen tool. Reuses the
	 * generic undo stack (`commitWallPoint`'s `update()` call pushed exactly one entry there) rather
	 * than manually reconstructing what changed — `addWallSegment` can touch an arbitrary number of
	 * points/segments once crossings/overlaps are reconciled, so there's nothing simpler to reverse
	 * by hand.
	 */
	undoLastWallPoint(): void {
		if (this.wallChain.length === 0) return;
		this.wallChain.pop();
		this.undo();
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
		this.wallChain = this.wallChain.filter((id) => !pointIds.has(id));
		if (this.selectedWallPointId && pointIds.has(this.selectedWallPointId)) this.selectWallPoint(null);
		if (this.selectedWallSegmentId && segmentIds.has(this.selectedWallSegmentId)) this.selectWallSegment(null);
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

	/** Sets the blocker type of exactly one segment — unlike `setWallPointBlockerType`, which acts on a whole connected shape, this is the info panel's per-segment type editor (e.g. one door-sized gap in an otherwise opaque wall). */
	setWallSegmentBlockerType(segmentId: string, type: VisionBlockerType): void {
		this.update((data) => {
			for (const layer of data.layers) {
				const segment = layer.wallSegments.find((s) => s.id === segmentId);
				if (segment) {
					segment.blockerType = type;
					return;
				}
			}
		});
	}

	/** Removes `pointId` from `layer` if nothing touches it anymore — a wall point with no segment left is dead weight (see `resetWallChain`/`removeWallSegment`). Must run inside `update()`'s mutator. */
	private purgeIfOrphanedWallPoint(layer: Layer, pointId: string): void {
		if (layer.wallSegments.some((s) => s.aId === pointId || s.bId === pointId)) return;
		layer.wallPoints = layer.wallPoints.filter((p) => p.id !== pointId);
		if (this.selectedWallPointId === pointId) this.selectedWallPointId = null;
	}

	/** Deletes exactly one segment, leaving its endpoint points in place — UNLESS that was the last segment touching one of them, in which case that point is dead weight and goes too (see `purgeIfOrphanedWallPoint`). The info panel's per-segment delete button. */
	removeWallSegment(segmentId: string): void {
		this.update((data) => {
			for (const layer of data.layers) {
				const segment = layer.wallSegments.find((s) => s.id === segmentId);
				if (!segment) continue;
				const { aId, bId } = segment;
				layer.wallSegments = layer.wallSegments.filter((s) => s.id !== segmentId);
				this.purgeIfOrphanedWallPoint(layer, aId);
				this.purgeIfOrphanedWallPoint(layer, bId);
				return;
			}
		});
		if (this.selectedWallSegmentId === segmentId) this.selectWallSegment(null);
	}

	/**
	 * Splits `segmentId` into two segments meeting at a new point at `(x, y)`, preserving the
	 * original segment's blocker type on both halves — lets a wall's line be reshaped by dragging a
	 * point out of what used to be its middle (see MapCanvas's double-click-on-a-segment handler).
	 * Returns the new point's id (so the caller can select it), or `null` if the segment couldn't be
	 * found.
	 */
	insertWallPointOnSegment(segmentId: string, x: number, y: number): string | null {
		const layer = this.data.layers.find((l) => l.wallSegments.some((s) => s.id === segmentId));
		if (!layer) return null;
		const newPointId = generateLocalId("wallpoint");
		this.update((data) => {
			const target = data.layers.find((l) => l.id === layer.id);
			if (!target) return;
			const segment = target.wallSegments.find((s) => s.id === segmentId);
			if (!segment) return;
			const { aId, bId, blockerType } = segment;
			target.wallPoints.push({ id: newPointId, x, y });
			target.wallSegments = target.wallSegments.filter((s) => s.id !== segmentId);
			target.wallSegments.push(
				{ id: generateLocalId("wallsegment"), aId, bId: newPointId, blockerType },
				{ id: generateLocalId("wallsegment"), aId: newPointId, bId, blockerType },
			);
		});
		if (this.selectedWallSegmentId === segmentId) this.selectedWallSegmentId = null;
		return newPointId;
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

	/** Forces every mounted UI piece to re-render without touching `data` — used to reflect a live plugin-settings change (zone types, token templates). */
	refresh(): void {
		this.notify();
	}

	private notify(): void {
		for (const cb of this.listeners) cb();
	}
}

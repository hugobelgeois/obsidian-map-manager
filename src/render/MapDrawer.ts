import { MapController, MapMode } from "../controller/MapController";
import { WallPoint, hexKey, squareKey, wallBlocksVision, wallPassableWithInteract } from "../data/mapData";
import { ViewTransform, getVisibleHexCells, getVisibleSquareCells, hexCellToWorldCenter, hexCorners } from "../grid/gridMath";
import { MapManagerSettings } from "../settings/types";
import { DraggingMarker, DraggingWallPoint } from "./canvasTypes";
import { HitTester } from "./HitTester";

/** Below this on-screen font size (in px), a cell's label hides and its stamp grows to fill the space instead. */
const MIN_LABEL_PIXELS = 9;

/**
 * Draws whatever part of the map has no dependency on `MapCanvas`'s own drag/gesture state: grid
 * lines, zone fills, cell stamps/labels/link badges, freeform markers, and committed walls. Anything
 * that needs to show up mid-drag at its live position instead of its committed one (a dragged marker,
 * a dragged wall point) takes that as an explicit parameter instead of reading shared mutable state —
 * `MapDrawer` owns none of its own, same as `FogRenderer.recomputeFrame(wallSegments)`'s snapshot-per-call
 * pattern. Constructed once by `MapCanvas` alongside its `HitTester`.
 */
export class MapDrawer {
	constructor(
		private controller: MapController,
		private settings: MapManagerSettings,
		// Same live-getter pattern as `FogRenderer`/`HitTester` — `MapCanvas.transform` is sometimes
		// reassigned wholesale rather than mutated in place.
		private getTransform: () => ViewTransform,
		private getViewportSize: () => { w: number; h: number },
		private hit: HitTester
	) {}

	private get transform(): ViewTransform {
		return this.getTransform();
	}

	/**
	 * `zonesVisible` gates only the zone-color tint (edit mode's "Zones" group toggle,
	 * `MapController.showZones`/`toggleShowZones`) — grid lines, stamps/labels, and link badges below
	 * are unaffected by it, always drawn whenever this whole method runs (see `MapCanvas.cellsCurrentlyVisible`).
	 * Computed by the caller (mirror-safe, via `effectiveMode()`) rather than read from
	 * `controller.mode`/`showZones` directly here, same pattern as `drawWalls`'s own `mode` parameter.
	 */
	drawGridAndCells(ctx: CanvasRenderingContext2D, zonesVisible: boolean): void {
		const data = this.controller.getData();
		if (data.gridType === "none") return;
		const cellSize = this.hit.effectiveCellSize();
		const gridColor = "rgba(127,127,127,0.4)";
		const visibleLayers = data.layers.filter((l) => l.visible);
		const { w: viewportW, h: viewportH } = this.getViewportSize();
		ctx.lineWidth = Math.max(0.5, 1 / this.transform.zoom);

		if (data.gridType === "square") {
			const cells = getVisibleSquareCells(this.transform, cellSize, viewportW, viewportH);
			for (const c of cells) {
				const key = squareKey(c.a, c.b);
				const x = c.a * cellSize;
				const y = c.b * cellSize;
				for (const layer of visibleLayers) {
					const cell = layer.cellsByGridType[data.gridType][key];
					if (cell?.zoneTypeId && zonesVisible) this.fillZone(ctx, this.settings.defaultZoneTypes, cell.zoneTypeId, () => ctx.rect(x, y, cellSize, cellSize));
				}
				ctx.strokeStyle = gridColor;
				ctx.strokeRect(x, y, cellSize, cellSize);
				for (const layer of visibleLayers) {
					const cell = layer.cellsByGridType[data.gridType][key];
					if (cell?.stamp || cell?.label) this.drawStampAndLabel(ctx, x + cellSize / 2, y + cellSize / 2, cellSize, cell.stamp, cell.label);
					if (cell?.links?.length) this.drawLinkBadge(ctx, x + cellSize * 0.12, y + cellSize * 0.12, cellSize);
				}
			}
		} else {
			const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
			const cells = getVisibleHexCells(this.transform, cellSize, orientation, viewportW, viewportH);
			for (const c of cells) {
				const key = hexKey(c.a, c.b);
				const center = hexCellToWorldCenter(c.a, c.b, cellSize, orientation);
				const corners = hexCorners(center.x, center.y, cellSize, orientation);
				const drawPath = () => {
					corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
					ctx.closePath();
				};
				for (const layer of visibleLayers) {
					const cell = layer.cellsByGridType[data.gridType][key];
					if (cell?.zoneTypeId && zonesVisible) this.fillZone(ctx, this.settings.defaultZoneTypes, cell.zoneTypeId, drawPath);
				}
				ctx.beginPath();
				drawPath();
				ctx.strokeStyle = gridColor;
				ctx.stroke();
				for (const layer of visibleLayers) {
					const cell = layer.cellsByGridType[data.gridType][key];
					if (cell?.stamp || cell?.label) this.drawStampAndLabel(ctx, center.x, center.y, cellSize, cell.stamp, cell.label);
					if (cell?.links?.length) this.drawLinkBadge(ctx, center.x - cellSize * 0.35, center.y - cellSize * 0.55, cellSize);
				}
			}
		}
	}

	private fillZone(ctx: CanvasRenderingContext2D, zoneTypes: { id: string; color: string }[], zoneTypeId: string, drawPath: () => void): void {
		const zone = zoneTypes.find((z) => z.id === zoneTypeId);
		if (!zone) return;
		ctx.beginPath();
		drawPath();
		ctx.fillStyle = zone.color;
		ctx.globalAlpha = 0.45;
		ctx.fill();
		ctx.globalAlpha = 1;
	}

	private drawStampAndLabel(ctx: CanvasRenderingContext2D, cx: number, cy: number, cellSize: number, stamp: string | undefined, label: string | undefined): void {
		const labelFontSize = Math.max(10, cellSize * 0.28);
		// Too zoomed out for the label to stay legible: hide it and let the stamp use the bigger, label-less size instead.
		const labelVisible = !!label && labelFontSize * this.transform.zoom >= MIN_LABEL_PIXELS;
		const stampFontSize = Math.max(10, cellSize * (stamp && labelVisible ? 0.65 : 0.85));
		ctx.textAlign = "center";
		ctx.fillStyle = "#000000";

		if (stamp && labelVisible) {
			ctx.textBaseline = "bottom";
			ctx.font = `${stampFontSize}px sans-serif`;
			ctx.fillText(stamp, cx, cy + stampFontSize * 0.32);
			ctx.textBaseline = "top";
			ctx.font = `bold ${labelFontSize}px sans-serif`;
			ctx.fillText(this.fitText(ctx, label, cellSize * 0.92), cx, cy + stampFontSize * 0.34);
		} else if (stamp) {
			ctx.textBaseline = "middle";
			ctx.font = `${stampFontSize}px sans-serif`;
			ctx.fillText(stamp, cx, cy);
		} else if (labelVisible && label) {
			ctx.textBaseline = "middle";
			ctx.font = `bold ${labelFontSize}px sans-serif`;
			ctx.fillText(this.fitText(ctx, label, cellSize * 0.92), cx, cy);
		}
	}

	private fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
		if (ctx.measureText(text).width <= maxWidth) return text;
		let truncated = text;
		while (truncated.length > 1 && ctx.measureText(`${truncated}…`).width > maxWidth) {
			truncated = truncated.slice(0, -1);
		}
		return `${truncated}…`;
	}

	private drawLinkBadge(ctx: CanvasRenderingContext2D, x: number, y: number, cellSize: number): void {
		const r = Math.max(2, cellSize * 0.08);
		ctx.beginPath();
		ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
		ctx.fillStyle = "#3b82f6";
		ctx.fill();
	}

	/** Grid type "none" only. `draggingMarker`, when set, draws that one marker again at its live drag position instead of its committed one. */
	drawMarkers(ctx: CanvasRenderingContext2D, draggingMarker: DraggingMarker | null): void {
		const data = this.controller.getData();
		const size = this.hit.cellVisualWidth();
		for (const layer of data.layers) {
			if (!layer.visible) continue;
			for (const marker of layer.markers) {
				if (draggingMarker?.marker.id === marker.id) continue;
				this.drawStampAndLabel(ctx, marker.x, marker.y, size, marker.stamp, marker.label);
				if (marker.links?.length) this.drawLinkBadge(ctx, marker.x - size * 0.35, marker.y - size * 0.55, size);
			}
		}
		if (draggingMarker) {
			const { marker, currentWorld } = draggingMarker;
			this.drawStampAndLabel(ctx, currentWorld.x, currentWorld.y, size, marker.stamp, marker.label);
		}
	}

	/** A wall point's drawn position — the live drag target while it's being dragged (`draggingWallPoint`), else its committed position. */
	wallPointPosition(point: WallPoint, draggingWallPoint: DraggingWallPoint | null): { x: number; y: number } {
		if (draggingWallPoint?.point.id === point.id) return draggingWallPoint.currentWorld;
		return { x: point.x, y: point.y };
	}

	/**
	 * Committed wall segments plus each point's handle, drawn whenever the grid/cell overlay would be
	 * (matches the old badges' visibility, hence the `cellsVisible` param — `MapCanvas.render()`
	 * already computes it once per frame). Point handles only show while actively placing walls or with
	 * one selected — otherwise just the lines, so authored walls read as map geometry. Never drawn on a
	 * player-mirror window (`isMirror`) — walls still block vision/line-of-sight there via
	 * `getWallSegments()` elsewhere, but the authored geometry itself must stay invisible to players.
	 * The GM's own tabs (edit and View) keep showing it, same as before.
	 *
	 * Two independent visual channels, matching `VisionBlockerType`'s own shape: color (`wallBlocksVision`
	 * — red if it blocks line of sight, teal if it doesn't) and line style (`wallPassableWithInteract` —
	 * solid if a token can never cross it by any means, dashed if the gamepad's interact-to-pass action
	 * can force a step through). So `"opaque"` draws solid red, `"see-through"` solid teal,
	 * `"pass-through"` dashed red, `"pass-see-through"` dashed teal.
	 */
	drawWalls(ctx: CanvasRenderingContext2D, cellsVisible: boolean, mode: MapMode, isMirror: boolean, draggingWallPoint: DraggingWallPoint | null): void {
		if (isMirror) return;
		const data = this.controller.getData();
		if (!cellsVisible && data.gridType !== "none") return;
		const showHandles =
			mode === "edit" && (this.controller.activeTool === "wall" || this.controller.selectedWallPointId !== null || this.controller.selectedWallSegmentId !== null);
		const pointRadius = Math.max(2, this.hit.wallPointHitRadius() * 0.35);
		for (const layer of data.layers) {
			if (!layer.visible) continue;
			const pointsById = new Map(layer.wallPoints.map((p) => [p.id, p]));
			for (const segment of layer.wallSegments) {
				const a = pointsById.get(segment.aId);
				const b = pointsById.get(segment.bId);
				if (!a || !b) continue;
				const aPos = this.wallPointPosition(a, draggingWallPoint);
				const bPos = this.wallPointPosition(b, draggingWallPoint);
				ctx.save();
				ctx.strokeStyle = wallBlocksVision(segment.blockerType) ? "#c0392b" : "#16a085";
				ctx.lineWidth = Math.max(1.5, 2.5 / this.transform.zoom);
				if (wallPassableWithInteract(segment.blockerType)) {
					ctx.setLineDash([Math.max(3, 6 / this.transform.zoom), Math.max(3, 6 / this.transform.zoom)]);
				}
				ctx.beginPath();
				ctx.moveTo(aPos.x, aPos.y);
				ctx.lineTo(bPos.x, bPos.y);
				ctx.stroke();
				ctx.restore();
			}
			if (showHandles) {
				for (const point of layer.wallPoints) {
					const pos = this.wallPointPosition(point, draggingWallPoint);
					ctx.beginPath();
					ctx.arc(pos.x, pos.y, pointRadius, 0, Math.PI * 2);
					ctx.fillStyle = point.id === this.controller.selectedWallPointId ? "#e0a020" : "#c0392b";
					ctx.fill();
				}
			}
		}
	}
}

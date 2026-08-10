import { Marker, WallPoint } from "../data/mapData";

/** An axis-aligned world-space rectangle — marquee/hit-test bounds (`*InRect`) and the visible/fog viewport rect (`visibleWorldRect`, `drawFog`, ...) alike. */
export interface WorldRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** World-space bounds of the loaded background image — see `computeVisibleImageBounds`/`clampPanToBounds`. */
export interface ImageBounds {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A marker (grid type "none" only) mid-drag — see `MapCanvas.draggingMarker`/`MapDrawer.drawMarkers`. */
export interface DraggingMarker {
	marker: Marker;
	currentWorld: { x: number; y: number };
}

/** A wall point mid-drag — see `MapCanvas.draggingWallPoint`/`MapDrawer.wallPointPosition`. */
export interface DraggingWallPoint {
	point: WallPoint;
	currentWorld: { x: number; y: number };
}

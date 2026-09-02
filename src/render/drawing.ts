import { DEFAULT_TOKEN_COLOR, MapFileData, Marker, Token, ZoneType } from "../data/mapData";
import { FogWorldRect, cellPolygon, cellVisualWidth, concaveCornerBlackTriangles, effectiveCellSize, exploredCellsInRect, worldPointToCellKey } from "../grid/fog";
import { Point } from "../grid/gridMath";

/** Below this on-screen font size (in px), a cell's label hides and its stamp grows to fill the space instead. */
export const MIN_LABEL_PIXELS = 9;

/** Fog opacity for ground that has never been in a player's vision. */
export const FOG_OPACITY_UNEXPLORED = 1;
/** Fog opacity for ground that has been seen before but isn't currently lit ("noir à 50 %"). */
export const FOG_OPACITY_EXPLORED = 0.5;

/** Mixes a #rrggbb color toward white by `ratio` (0 = unchanged, 1 = white). Used for the selected-token border. */
export function lightenColor(hex: string, ratio: number): string {
	const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
	if (!match || !match[1] || !match[2] || !match[3]) return hex;
	const mix = (channel: string) => Math.round(parseInt(channel, 16) + (255 - parseInt(channel, 16)) * ratio);
	return `rgb(${mix(match[1])}, ${mix(match[2])}, ${mix(match[3])})`;
}

/** Truncates `text` with an ellipsis so it fits within `maxWidth` under `ctx`'s current font. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let truncated = text;
	while (truncated.length > 1 && ctx.measureText(`${truncated}…`).width > maxWidth) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}…`;
}

export function drawZoneFill(ctx: CanvasRenderingContext2D, zoneTypes: ZoneType[], zoneTypeId: string, drawPath: () => void): void {
	const zone = zoneTypes.find((z) => z.id === zoneTypeId);
	if (!zone) return;
	ctx.beginPath();
	drawPath();
	ctx.fillStyle = zone.color;
	ctx.globalAlpha = 0.45;
	ctx.fill();
	ctx.globalAlpha = 1;
}

export function drawStampAndLabel(
	ctx: CanvasRenderingContext2D,
	cx: number,
	cy: number,
	cellSize: number,
	zoom: number,
	stamp: string | undefined,
	label: string | undefined
): void {
	const labelFontSize = Math.max(10, cellSize * 0.28);
	const labelVisible = !!label && labelFontSize * zoom >= MIN_LABEL_PIXELS;
	const stampFontSize = Math.max(10, cellSize * (stamp && labelVisible ? 0.65 : 0.85));
	ctx.textAlign = "center";
	ctx.fillStyle = "#000000";

	if (stamp && labelVisible) {
		ctx.textBaseline = "bottom";
		ctx.font = `${stampFontSize}px sans-serif`;
		ctx.fillText(stamp, cx, cy + stampFontSize * 0.32);
		ctx.textBaseline = "top";
		ctx.font = `bold ${labelFontSize}px sans-serif`;
		ctx.fillText(fitText(ctx, label, cellSize * 0.92), cx, cy + stampFontSize * 0.34);
	} else if (stamp) {
		ctx.textBaseline = "middle";
		ctx.font = `${stampFontSize}px sans-serif`;
		ctx.fillText(stamp, cx, cy);
	} else if (labelVisible && label) {
		ctx.textBaseline = "middle";
		ctx.font = `bold ${labelFontSize}px sans-serif`;
		ctx.fillText(fitText(ctx, label, cellSize * 0.92), cx, cy);
	}
}

export function drawLinkBadge(ctx: CanvasRenderingContext2D, x: number, y: number, cellSize: number): void {
	const r = Math.max(2, cellSize * 0.08);
	ctx.beginPath();
	ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
	ctx.fillStyle = "#3b82f6";
	ctx.fill();
}

export function drawMarker(ctx: CanvasRenderingContext2D, marker: Marker, cellSize: number, zoom: number): void {
	drawStampAndLabel(ctx, marker.x, marker.y, cellSize, zoom, marker.stamp, marker.label);
	if (marker.links?.length) drawLinkBadge(ctx, marker.x - cellSize * 0.35, marker.y - cellSize * 0.55, cellSize);
}

/**
 * Small arrowhead poking out of a token's rim, pointing wherever it's currently facing
 * (`token.rotation`, degrees, 0 = east, increasing clockwise). For an entity token this is also the
 * exact direction `castEntityConeRays` points its eye cone(s) — a single facing drives both, so the
 * arrow always shows exactly what the entity can see. Drawn on every token regardless of category or
 * whether `rotation` was ever explicitly set (defaults to facing east) — see `drawToken`. `rotation`
 * is no longer editable for "player" tokens (their fog reveal is omnidirectional, via `lightRadius`),
 * so their arrow just stays wherever it was left (east, unless set by an old map file).
 */
export function drawTokenFacingArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, rotationDeg: number, color: string): void {
	const rad = (rotationDeg * Math.PI) / 180;
	const dx = Math.cos(rad);
	const dy = Math.sin(rad);
	const px = -dy;
	const py = dx;
	const tip = { x: cx + dx * radius * 1.25, y: cy + dy * radius * 1.25 };
	const baseCx = cx + dx * radius * 0.75;
	const baseCy = cy + dy * radius * 0.75;
	const halfWidth = radius * 0.32;

	ctx.beginPath();
	ctx.moveTo(tip.x, tip.y);
	ctx.lineTo(baseCx + px * halfWidth, baseCy + py * halfWidth);
	ctx.lineTo(baseCx - px * halfWidth, baseCy - py * halfWidth);
	ctx.closePath();
	ctx.fillStyle = color;
	ctx.fill();
	ctx.lineWidth = Math.max(1, radius * 0.06);
	ctx.strokeStyle = "rgba(255,255,255,0.85)";
	ctx.stroke();
}

export function drawToken(
	ctx: CanvasRenderingContext2D,
	cx: number,
	cy: number,
	radius: number,
	token: Token,
	options: { selected: boolean; zoom: number; image?: HTMLImageElement | null }
): void {
	const diameter = radius * 2;
	const image = options.image ?? null;

	ctx.beginPath();
	ctx.arc(cx, cy, radius, 0, Math.PI * 2);
	if (image) {
		ctx.save();
		ctx.clip();
		ctx.drawImage(image, cx - radius, cy - radius, diameter, diameter);
		ctx.restore();
	} else {
		ctx.fillStyle = "rgba(250,250,250,0.92)";
		ctx.fill();
	}
	const baseColor = token.color ?? DEFAULT_TOKEN_COLOR;
	ctx.lineWidth = options.selected ? Math.max(2.5, 4 / options.zoom) : Math.max(1.5, 2.5 / options.zoom);
	ctx.strokeStyle = options.selected ? lightenColor(baseColor, 0.55) : baseColor;
	ctx.stroke();

	drawTokenFacingArrow(ctx, cx, cy, radius, token.rotation ?? 0, options.selected ? lightenColor(baseColor, 0.55) : baseColor);

	if (!image) {
		ctx.textAlign = "center";
		ctx.fillStyle = "#000000";
		ctx.textBaseline = token.label ? "bottom" : "middle";
		ctx.font = `${Math.max(10, diameter * 0.42)}px sans-serif`;
		ctx.fillText(token.icon, cx, token.label ? cy + diameter * 0.06 : cy);
	}
	if (token.label) {
		ctx.textBaseline = "top";
		ctx.font = `bold ${Math.max(10, diameter * 0.22)}px sans-serif`;
		ctx.fillText(fitText(ctx, token.label, diameter * 0.85), cx, cy + diameter * 0.08);
	}
}

/**
 * Static fog "memory" mask: fully opaque outside `exploredSet`, dimmed within it — no vision fans
 * (the public viewer never re-traces vision live, see `mapRedaction.ts`). `rect` is the world-space
 * area to cover (plus a small margin so no seam shows at the edges).
 */
export function drawFogMemoryMask(
	ctx: CanvasRenderingContext2D,
	rect: { minX: number; minY: number; maxX: number; maxY: number },
	bucketSize: number,
	isExplored: (worldX: number, worldY: number) => boolean
): void {
	const margin = bucketSize * 2;
	const bx0 = Math.floor((rect.minX - margin) / bucketSize);
	const bx1 = Math.ceil((rect.maxX + margin) / bucketSize);
	const by0 = Math.floor((rect.minY - margin) / bucketSize);
	const by1 = Math.ceil((rect.maxY + margin) / bucketSize);

	const exploredPath = new Path2D();
	let hasExplored = false;
	for (let by = by0; by <= by1; by++) {
		for (let bx = bx0; bx <= bx1; bx++) {
			const worldX = bx * bucketSize + bucketSize / 2;
			const worldY = by * bucketSize + bucketSize / 2;
			if (isExplored(worldX, worldY)) {
				hasExplored = true;
				exploredPath.rect(bx * bucketSize, by * bucketSize, bucketSize, bucketSize);
			}
		}
	}

	ctx.save();
	ctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_UNEXPLORED})`;
	ctx.fillRect(rect.minX - margin, rect.minY - margin, rect.maxX - rect.minX + margin * 2, rect.maxY - rect.minY + margin * 2);
	if (hasExplored) {
		ctx.globalCompositeOperation = "destination-out";
		ctx.fillStyle = "rgba(0, 0, 0, 1)";
		ctx.fill(exploredPath);
		ctx.globalCompositeOperation = "source-over";
		ctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_EXPLORED})`;
		ctx.fill(exploredPath);
	}
	ctx.restore();
}

/** Appends `poly` as one closed subpath of `path`. */
function polyToPath(path: Path2D, poly: Point[]): void {
	poly.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
	path.closePath();
}

/** Stable pseudo-random phase in `[0, 2π)` from a string key — de-syncs the soft fade band per cell edge. */
function edgePhase(key: string): number {
	let hash = 0;
	for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
	return (((hash >>> 0) % 1000) / 1000) * Math.PI * 2;
}

/**
 * "Avec grillage" fog for a celled grid type, the read-only export counterpart to
 * `FogRenderer.renderCellFog` — no light circles (the exported snapshot carries no live vision or
 * walls, just the explored-cell set): fog cells filled full black, explored cells half, concave
 * corners of explored cells cut on the diagonal (square grids), and, when `softening`, a soft fade
 * on the explored side of every explored/fog border (animated via `time`, seconds). Drawn crisp
 * under the caller's world transform, straight onto the given context with plain `source-over` fills
 * (no `destination-out`) so it's safe on a shared canvas that already has the map drawn under it.
 */
export function drawCellFogMask(
	ctx: CanvasRenderingContext2D,
	data: MapFileData,
	exploredSet: ReadonlySet<string>,
	rect: FogWorldRect,
	softening: boolean,
	time: number
): void {
	const margin = effectiveCellSize(data) * 2;
	const exploredKeys = exploredCellsInRect(data, exploredSet, rect, margin);

	const exploredPath = new Path2D();
	for (const key of exploredKeys) polyToPath(exploredPath, cellPolygon(data, key));
	const fogBackPath = new Path2D();
	if (data.gridType === "square") {
		for (const key of exploredKeys) {
			for (const tri of concaveCornerBlackTriangles(data, key, (nk) => !exploredSet.has(nk))) polyToPath(fogBackPath, tri);
		}
	}

	ctx.save();
	// Fog = the whole rect minus the explored cells, filled opaque via the even-odd rule (outer rect
	// as one subpath, each explored cell polygon as a hole) — no `destination-out`, so the map drawn
	// underneath survives everywhere the fog doesn't cover.
	const fogRegion = new Path2D();
	fogRegion.rect(rect.minX - margin, rect.minY - margin, rect.maxX - rect.minX + margin * 2, rect.maxY - rect.minY + margin * 2);
	for (const key of exploredKeys) polyToPath(fogRegion, cellPolygon(data, key));
	ctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_UNEXPLORED})`;
	ctx.fill(fogRegion, "evenodd");
	if (exploredKeys.length > 0) {
		ctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_EXPLORED})`;
		ctx.fill(exploredPath);
		// Diagonal concave-corner halves go back to full black.
		ctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_UNEXPLORED})`;
		ctx.fill(fogBackPath);
	}

	if (softening) {
		const cell = effectiveCellSize(data);
		const eps = cell * 0.1;
		const maxDepth = cell * 0.45;
		for (const key of exploredKeys) {
			const poly = cellPolygon(data, key);
			let sx = 0;
			let sy = 0;
			for (const p of poly) {
				sx += p.x;
				sy += p.y;
			}
			const ccx = sx / poly.length;
			const ccy = sy / poly.length;
			for (let i = 0; i < poly.length; i++) {
				const p = poly[i];
				const q = poly[(i + 1) % poly.length];
				if (!p || !q) continue;
				const mx = (p.x + q.x) / 2;
				const my = (p.y + q.y) / 2;
				let nx = mx - ccx;
				let ny = my - ccy;
				const nl = Math.hypot(nx, ny) || 1;
				nx /= nl;
				ny /= nl;
				if (exploredSet.has(worldPointToCellKey(data, mx + nx * eps, my + ny * eps))) continue;
				const phase = edgePhase(`${key}|${i}`);
				const wob = 0.8 + 0.3 * Math.sin(time * 1.4 + phase);
				const depth = Math.min(0.4 * cellVisualWidth(data) * wob, maxDepth);
				const edgeAlpha = FOG_OPACITY_EXPLORED * 0.8 * (0.85 + 0.15 * Math.sin(time * 1.1 + phase * 1.3));
				const ix = -nx;
				const iy = -ny;
				const grad = ctx.createLinearGradient(mx, my, mx + ix * depth, my + iy * depth);
				grad.addColorStop(0, `rgba(8, 8, 12, ${edgeAlpha})`);
				grad.addColorStop(1, "rgba(8, 8, 12, 0)");
				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(p.x, p.y);
				ctx.lineTo(q.x, q.y);
				ctx.lineTo(q.x + ix * depth, q.y + iy * depth);
				ctx.lineTo(p.x + ix * depth, p.y + iy * depth);
				ctx.closePath();
				ctx.fill();
			}
		}
	}
	ctx.restore();
}

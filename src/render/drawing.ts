import { DEFAULT_TOKEN_COLOR, Marker, Token, ZoneType } from "../data/mapData";

/** Below this on-screen font size (in px), a cell's label hides and its stamp grows to fill the space instead. */
export const MIN_LABEL_PIXELS = 9;

/** Fog opacity for ground that has never been in a player's vision. */
export const FOG_OPACITY_UNEXPLORED = 1;
/** Fog opacity for ground that has been seen before, isn't currently lit, or sits beyond a "dim" blocker. */
export const FOG_OPACITY_EXPLORED = 0.55;

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

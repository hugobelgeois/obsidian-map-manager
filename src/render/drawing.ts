import { DEFAULT_TOKEN_COLOR, MapFileData, Marker, Token, ZoneType } from "../data/mapData";
import { FogWorldRect, cellPolygon, concaveCornerBlackTriangles, effectiveCellSize, exploredCellsInRect, worldPointToCellKey } from "../grid/fog";
import { Point } from "../grid/gridMath";

/** Below this on-screen font size (in px), a cell's label hides and its stamp grows to fill the space instead. */
export const MIN_LABEL_PIXELS = 9;

/** Fog opacity for ground that has never been in a player's vision. */
export const FOG_OPACITY_UNEXPLORED = 1;
/** Fog opacity for ground that has been seen before but isn't currently lit ("noir à 50 %"). */
export const FOG_OPACITY_EXPLORED = 0.5;

/**
 * "Adoucir le brouillard" parameters at intensity `level` — a 0-10 slider: `0` disables the fade
 * entirely (crisp explored/fog border), `10` puts full black right against every fog-bordering edge.
 * The darkened band stays within the single explored cell that borders fog at every level — the
 * slider changes how dark that one-cell gradient starts, not how far it reaches. Returns `null` when
 * disabled. See `drawFogSofteningRamp` for how these are used.
 *
 * - `edgeAlpha` — opacity right against a fog-bordering edge; the per-cell gradient runs from there
 *   down to fully transparent at the cell's far side.
 * - `blurRatio` — blur radius as a fraction of a cell; only enough to connect adjacent cells'
 *   gradients across shared corners so the frontier doesn't stair-step.
 */
export function fogSofteningParams(level: number): { edgeAlpha: number; blurRatio: number } | null {
	if (!(level > 0)) return null;
	const t = Math.min(1, level / 10);
	return {
		edgeAlpha: 0.4 + 0.6 * t,
		blurRatio: 0.09 + 0.05 * t,
	};
}

let fogSoftMaskCanvas: HTMLCanvasElement | null = null;
let fogSoftBlurCanvas: HTMLCanvasElement | null = null;

/**
 * Draws the "Adoucir le brouillard" fade. On an offscreen scratch, for every explored cell that
 * borders fog: the fog region itself is filled solid at `edgeAlpha`, then each fog-bordering edge of
 * that cell gets a linear gradient running *into* the cell — `edgeAlpha` hard against the edge,
 * fading to fully transparent one cell width in — so the darkness starts black against the fog and
 * clears completely by the cell's far (explored/explored) edges. A corner cell with two fog edges
 * darkens in both directions, deepest in the corner. The scratch is then lightly blurred (just enough
 * to connect neighbouring cells' gradients across their shared corners so a diagonal frontier reads
 * continuous, not stair-stepped — `fogSofteningParams.blurRatio`) and composited back once.
 *
 * `ctx` must currently hold the world (pan/zoom) transform; its `getTransform()` scale is taken as
 * the world→device pixel factor. Safe on both an offscreen fog buffer (`FogRenderer.renderCellFog`)
 * and the shared main canvas mid-scene (public export `drawCellFogMask`): it only ever adds dark
 * pixels, and saves/restores the transform it was handed. `time` (seconds, `0` = static) drives a
 * slow breath on the darkness.
 */
export function drawFogSofteningRamp(
	ctx: CanvasRenderingContext2D,
	data: MapFileData,
	exploredSet: ReadonlySet<string>,
	exploredKeys: string[],
	rect: FogWorldRect,
	level: number,
	time: number
): void {
	const soft = fogSofteningParams(level);
	if (!soft || exploredKeys.length === 0) return;

	const target = ctx.canvas;
	const w = target.width;
	const h = target.height;
	if (w === 0 || h === 0) return;

	const mask = (fogSoftMaskCanvas ??= document.createElement("canvas"));
	const blur = (fogSoftBlurCanvas ??= document.createElement("canvas"));
	if (mask.width !== w || mask.height !== h) {
		mask.width = w;
		mask.height = h;
	}
	if (blur.width !== w || blur.height !== h) {
		blur.width = w;
		blur.height = h;
	}
	const mctx = mask.getContext("2d");
	const bctx = blur.getContext("2d");
	if (!mctx || !bctx) return;

	const xf = ctx.getTransform();
	const cell = effectiveCellSize(data);
	const eps = cell * 0.1;
	const margin = cell * 2;
	const breath = time > 0 ? 0.88 + 0.12 * Math.sin(time * 1.2) : 1;
	const alpha = Math.min(1, soft.edgeAlpha * breath);

	mctx.setTransform(1, 0, 0, 1, 0, 0);
	mctx.clearRect(0, 0, w, h);
	mctx.setTransform(xf.a, xf.b, xf.c, xf.d, xf.e, xf.f);

	// Fog side: solid at `alpha` (so the blur below has matching material across the frontier and the
	// gradient starts flush against it, not at half strength).
	const fogRegion = new Path2D();
	fogRegion.rect(rect.minX - margin, rect.minY - margin, rect.maxX - rect.minX + margin * 2, rect.maxY - rect.minY + margin * 2);
	for (const key of exploredKeys) polyToPath(fogRegion, cellPolygon(data, key));
	mctx.fillStyle = `rgba(8, 8, 12, ${alpha})`;
	mctx.fill(fogRegion, "evenodd");

	// Explored side: a per-cell, per-fog-edge gradient into the bordering cell.
	let anyFrontier = false;
	for (const key of exploredKeys) {
		const poly = cellPolygon(data, key);
		let cx = 0;
		let cy = 0;
		for (const p of poly) {
			cx += p.x;
			cy += p.y;
		}
		cx /= poly.length;
		cy /= poly.length;

		const cellPath = new Path2D();
		polyToPath(cellPath, poly);
		let clipped = false;
		for (let i = 0; i < poly.length; i++) {
			const a = poly[i];
			const b = poly[(i + 1) % poly.length];
			if (!a || !b) continue;
			const mx = (a.x + b.x) / 2;
			const my = (a.y + b.y) / 2;
			let nx = mx - cx;
			let ny = my - cy;
			const nl = Math.hypot(nx, ny) || 1;
			nx /= nl;
			ny /= nl;
			if (exploredSet.has(worldPointToCellKey(data, mx + nx * eps, my + ny * eps))) continue;
			if (!clipped) {
				mctx.save();
				mctx.clip(cellPath);
				clipped = true;
				anyFrontier = true;
			}
			const grad = mctx.createLinearGradient(mx, my, mx - nx * cell, my - ny * cell);
			grad.addColorStop(0, `rgba(8, 8, 12, ${alpha})`);
			grad.addColorStop(1, "rgba(8, 8, 12, 0)");
			mctx.fillStyle = grad;
			mctx.fill(cellPath);
		}
		if (clipped) mctx.restore();
	}
	if (!anyFrontier) return;

	// Light blur, world units → device px via the transform scale, so the connect-the-corners smoothing
	// is a fixed fraction of a cell however far the view is zoomed.
	const blurPx = Math.max(0.5, soft.blurRatio * cell * xf.a);
	bctx.setTransform(1, 0, 0, 1, 0, 0);
	bctx.clearRect(0, 0, w, h);
	bctx.filter = `blur(${blurPx}px)`;
	bctx.drawImage(mask, 0, 0);
	bctx.filter = "none";

	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = "source-over";
	ctx.drawImage(blur, 0, 0);
	ctx.restore();
}

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

/**
 * "Avec grillage" fog for a celled grid type, the read-only export counterpart to
 * `FogRenderer.renderCellFog` — no light circles (the exported snapshot carries no live vision or
 * walls, just the explored-cell set): fog cells filled full black, explored cells half, concave
 * corners of explored cells cut on the diagonal (square grids), and, when `softeningLevel > 0`, the
 * blur-connected softening ramp on the explored side of the whole frontier (`drawFogSofteningRamp` —
 * depth/darkness scaled by the 0-10 level, breathing via `time`, seconds). Drawn crisp under the
 * caller's world transform, straight onto the given context with plain `source-over` fills (no
 * `destination-out`) so it's safe on a shared canvas that already has the map drawn under it.
 */
export function drawCellFogMask(
	ctx: CanvasRenderingContext2D,
	data: MapFileData,
	exploredSet: ReadonlySet<string>,
	rect: FogWorldRect,
	softeningLevel: number,
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

	if (exploredKeys.length > 0) drawFogSofteningRamp(ctx, data, exploredSet, exploredKeys, rect, softeningLevel, time);
	ctx.restore();
}

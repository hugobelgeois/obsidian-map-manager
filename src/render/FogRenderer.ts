import { MapController, MapMode } from "../controller/MapController";
import { MapManagerSettings } from "../settings/types";
import { MapFileData, Token, resolveEyeCones, resolveLightRadius } from "../data/mapData";
import {
	Point,
	ViewTransform,
	getVisibleHexCells,
	getVisibleSquareCells,
	hexCellToWorldCenter,
	hexCellsInWorldRect,
	hexCorners,
	screenToWorld,
	squareCellsInWorldRect,
} from "../grid/gridMath";
import {
	ResolvedWallSegment,
	VisionRays,
	castEntityConeRays,
	castLightRays,
	cellPolygon,
	cellVisualWidth,
	cellsWallSeparated,
	clipLightToPlayerLineOfSight,
	concaveCornerBlackTriangles,
	effectiveCellSize,
	exploredCellsInRect,
	fogBucketSize as baseFogBucketSize,
	hasLineOfSight,
	isCellFullyLit,
	isPointLit,
	isWorldPointExplored,
	traceVisibilityPolygon,
} from "../grid/fog";
import { drawFogSofteningRamp } from "./drawing";
import { ImageBounds, WorldRect } from "./canvasTypes";

/** Fog opacity for ground that has never been in a player's vision. */
const FOG_OPACITY_UNEXPLORED = 1;
/** Fog opacity for ground that has been seen before but isn't currently lit ("noir à 50 %"). */
const FOG_OPACITY_EXPLORED = 0.5;

/**
 * Hard cap on how many fog-memory buckets get scanned per axis in one frame — see
 * `fogIterationBucketSize`. Keeps the scan (and its Path2D) bounded even when zoomed out so far
 * that the visible world rect would otherwise need far more of the fine `FOG_BUCKET_SCALE` grid.
 */
const FOG_MAX_BUCKETS_PER_AXIS = 160;
/**
 * Tremble amplitudes in fixed *screen* pixels (divided by zoom at use, see `drawFog`/`castLightRaysForToken`)
 * rather than a fraction of a world-space length — otherwise the wobble shrinks away right along with
 * everything else when zoomed out, which reads as "the animation stops". The memory (explored/
 * unexplored) frontier's amplitude is deliberately larger than the vision fan's.
 */
const FOG_TREMBLE_SCREEN_PX = 4;
const FOG_MEMORY_TREMBLE_SCREEN_PX = 10;
/** Angular speed (rad/s) of the tremble's sine wave. */
const FOG_TREMBLE_SPEED = 1.6;
/** Fixed screen-pixel blur radius for the fog buffer (see `drawFog`) — independent of zoom or the LOD tile size. */
const FOG_BLUR_SCREEN_PX = 22;
/** Fixed screen-pixel overdraw margin on the offscreen fog buffer — see `renderFogLayer`. Comfortably larger than `FOG_BLUR_SCREEN_PX`. */
const FOG_OVERDRAW_PX = FOG_BLUR_SCREEN_PX * 3;
/**
 * How far (fixed screen px) `drawFog` pulls a revealed shape's own edge inward before the blur runs,
 * wherever that edge borders unrevealed territory — see `dimInset`/`erosionInset` there. A CSS
 * `blur()` doesn't cut off sharply right at `FOG_BLUR_SCREEN_PX`, it only falls off *fast* past it, so
 * this needs real headroom past that nominal radius, not just a few px of slack.
 */
const FOG_LEAK_INSET_PX = FOG_BLUR_SCREEN_PX * 2.5;
/** Fog animation (the tremble/fade, and the render loop driving it) is force-disabled below this zoom — see `fogAnimationActive`. */
const FOG_ANIMATION_MIN_ZOOM = 0.5;

/**
 * Inner fraction of a light's (life-scaled) reach that stays fully clear before the vignette's
 * falloff begins — see `lightClearnessGradient`. The light-source flicker (`lightCoreRatio`) is the
 * *only* thing that animates: this plateau breathes between `0` and this value, nothing else moves.
 */
const LIGHT_CLEAR_CORE_RATIO = 0.2;
/**
 * Fixed screen-px band the vignette tint is stroked past every lit shape's own edge (`renderCellFog`),
 * so the tint fully covers the anti-aliased seam between the solid fog-clear and the vignette blit —
 * otherwise a faint 1px ring shows at the light's rim against dark unexplored fog.
 */
const LIGHT_EDGE_SEAL_PX = 2;

/**
 * Stable per-token phase seed in `[0, 1)` so several tokens' fog tremble / light flicker don't move
 * in lockstep. FNV-1a plus an avalanche mix at the end — a plain rolling hash mod N barely changes
 * between near-identical ids (sequential or timestamp-based), which left the flicker looking
 * synchronised; the final mix makes one-character-apart ids land far apart.
 */
function tremblePhase(tokenId: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < tokenId.length; i++) {
		hash ^= tokenId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	hash ^= hash >>> 15;
	hash = Math.imul(hash, 0x2c1b3c6d);
	hash ^= hash >>> 13;
	return (hash >>> 0) / 4294967296;
}

/** Appends `poly` as one closed subpath of `path`. */
function polyToPath(path: Path2D, poly: Point[]): void {
	poly.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
	path.closePath();
}

/** A player token's traced vision for the current frame: 0..360° rays fanning out from its center (see `../grid/fog.ts`). */
interface PlayerVisionRays extends VisionRays {
	/** Stable per-token phase for the *cosmetic* fan-edge tremble (see `appendVisionFan`) — never affects `rays` itself. */
	phase: number;
}

/**
 * Owns everything fog-of-war/vision/light: ray casting (and its per-frame cache), the offscreen fog
 * compositing pipeline (crisp draw → blur → blit back), the GM-only vision/light zone preview, and
 * the wall-shadow blackout patch. Constructed once by `MapCanvas` alongside its own canvas/ctx.
 *
 * Reads `transform` live (the same mutable `ViewTransform` object `MapCanvas` itself pans/zooms —
 * no separate sync step needed) and asks `MapCanvas`, via the constructor callbacks, for the two
 * other bits of live state it doesn't own itself: the current viewport size (changes on resize) and
 * a token's live interpolated "Animation" tween pose (owned by `MapCanvas`'s own path-animation
 * state, not a fog concern). `requestRender` lets its own tremble animation loop (`syncAnimationLoop`)
 * ask for a fresh frame the same way `MapCanvas.render()` already did before this was split out.
 */
export class FogRenderer {
	/** Every player token's traced light rays (their fog-reveal source — see `castLightRaysForToken`), recomputed once per `MapCanvas.render()` and reused by both `drawFog` and `MapCanvas.drawTokens`. */
	private frameVisionCache: PlayerVisionRays[] = [];
	/**
	 * Every non-player token's traced `lightRadius` reach, recomputed once per `MapCanvas.render()`,
	 * clipped down to only the parts actually visible to a player token (`clipLightToPlayerLineOfSight`
	 * — a wall between a player and a given part of the light hides that part just as much as a wall
	 * between the light and empty space does, see that function's own doc comment). Reused by
	 * `drawFog` (to hide fog without writing to `exploredCells` — see `drawFog`'s doc comment) and
	 * `isEntityRevealed` (so a lit entity is noticed regardless of any player's own light, but — same
	 * clipping — only once a player could actually see the light illuminating it). Player tokens are
	 * deliberately excluded: a player's `lightRadius` *is* its vision reach post-refactor, so
	 * `frameVisionCache` already traces and fans that exact same shape — including them here too would
	 * just re-trace/re-fan/re-punch identical geometry for nothing (and trivially pass their own
	 * line-of-sight check against themselves).
	 */
	private frameLightCache: PlayerVisionRays[] = [];
	/**
	 * Same tokens as `frameLightCache`, but each one's *raw* traced reach — before the
	 * `clipLightToPlayerLineOfSight` sampling that approximates the visible sub-area for the smooth
	 * fog-overlay fan. `isEntityRevealed` uses this instead of `frameLightCache` for its own
	 * "is this exact point lit" half of the check, then does an exact (unsampled) `hasLineOfSight`
	 * call itself for the "…and can a player actually see this exact point" half — a single point can
	 * afford an exact check that the whole-area fan (necessarily an approximation, sampled every 2°)
	 * can't, so entity visibility never inherits that approximation's edge cases. See
	 * `isEntityRevealed`'s own doc comment.
	 */
	private frameLightRawCache: PlayerVisionRays[] = [];
	/** This frame's player token centers and resolved wall segments, kept for `isEntityRevealed`'s own exact `hasLineOfSight` check — set alongside the two caches above in `recomputeFrame`. */
	private framePlayerCenters: Point[] = [];
	private frameWallSegments: ResolvedWallSegment[] = [];

	/**
	 * Memoizes the actual (expensive) ray/wall tracing behind `castLightRaysForToken`/`castEntityConeVision`,
	 * keyed against `MapController.dataVersion` — `render()` runs on every pan/zoom/hover/fog-tremble
	 * animation frame, none of which touch `data`, so re-tracing rays whose token/wall inputs haven't
	 * changed since the last `render()` was pure waste (the dominant cost of "several tokens with
	 * vision on" lagging view mode). Only the cheap, per-frame cosmetic tremble in `appendVisionFan`
	 * still runs unconditionally. Keyed by token id for lights, and `tokenId|direction|
	 * fullAngleDeg` for entities (multiple cones/tiers per token — see `drawEntityEyeCones`).
	 */
	private entityConeRaysCache: Map<string, { version: number; result: VisionRays }> = new Map();
	/** Same memoization as `entityConeRaysCache`, for `castLightRaysForToken` — keyed by token id, any category. */
	private lightRaysCache: Map<string, { version: number; result: VisionRays }> = new Map();
	/**
	 * Same memoization idea, for `clipLightToPlayerLineOfSight`'s own result — keyed by (light) token
	 * id. Distinct from `lightRaysCache`: that one memoizes the light's own raw wall-blocked trace,
	 * this one memoizes the *further* per-ray clipping against every player's line of sight, which
	 * costs `FOG_RAY_COUNT * LIGHT_LOS_SAMPLE_STEPS * playerCount * wallCount` — expensive enough that
	 * redoing it on every pan/zoom/hover frame (`recomputeFrame` runs on all of them) was visibly
	 * laggy once clipping stopped being a single cheap point check. `recomputeFrame` only reads this
	 * cache when neither the light itself nor any player token has a live "Animation" tween in flight
	 * (see the `pose`/`anyPlayerAnimated` checks there) — `dataVersion` alone doesn't change mid-tween,
	 * but the player positions clipping depends on very much do.
	 */
	private lightClipCache: Map<string, { version: number; result: VisionRays }> = new Map();

	/** Offscreen buffer fog is composited on before being drawn onto the main canvas as one image — see `renderFogLayer`. */
	private fogCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogCtx: CanvasRenderingContext2D;
	/** Second pass: `fogCanvas`'s crisp content, blurred under a plain (unscaled) transform — see `renderFogLayer`. */
	private fogBlurCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogBlurCtx: CanvasRenderingContext2D;
	/**
	 * Scratch buffer where `renderCellFog` accumulates every light's cosmetic vignette *before*
	 * blitting it onto `fogCanvas` in one pass — so overlapping lights' vignettes combine (each light
	 * only ever makes its overlap brighter, never darker) instead of stacking their dark tint the way
	 * painting them straight onto `fogCanvas` one-by-one would.
	 */
	private vignetteCanvas: HTMLCanvasElement = document.createElement("canvas");
	private vignetteCtx: CanvasRenderingContext2D;
	/** Non-null while the fog-tremble animation loop (settings.fogAnimationMode) is actively re-rendering every frame. */
	private animationFrameId: number | null = null;

	/**
	 * Signature of everything `renderCellFog`'s composited `fogCanvas` depends on (`dataVersion` +
	 * this frame's transform / viewport / `fogSoftening`), stamped after each full build. When a
	 * later `renderCellFog` call passes `allowReuse` and this still matches, the existing `fogCanvas`
	 * is reblitted rather than rebuilt — the point being a purely cosmetic token hop
	 * (`MapCanvas.cellHops`), whose ~11 frames would otherwise each re-trace every light's visibility
	 * polygon, rebuild the explored/concave `Path2D`s and re-run `drawFogSofteningRamp` only to
	 * produce a bit-for-bit identical frame. The light flicker (`lightCoreRatio`) and softening
	 * tremble just hold still for the ~180 ms the hop lasts.
	 */
	private cellFogSignature: string | null = null;

	/** Translucent fill color for a token's own `lightRadius` preview — warm/amber, distinct from the entity eye-cone red so it reads as "light" rather than "sight". */
	private static readonly TOKEN_LIGHT_ZONE_COLOR = "rgba(250, 204, 21, 0.2)";
	/**
	 * An entity eye cone's 3 tiers (see `resolveEyeCones`), listed widest-to-narrowest — the order
	 * `drawEntityEyeCones` draws them in, so the narrower/sharper tiers layer visibly on top of the
	 * wider/dimmer ones instead of underneath. Same red hue throughout, rising alpha per tier reads
	 * as a gradient of "how well the entity actually makes you out" rather than one flat wash.
	 */
	private static readonly ENTITY_EYE_TIERS: { key: "monocularAngle" | "binocularAngle" | "detectionAngle"; alpha: number }[] = [
		{ key: "monocularAngle", alpha: 0.1 },
		{ key: "binocularAngle", alpha: 0.16 },
		{ key: "detectionAngle", alpha: 0.28 },
	];

	constructor(
		private controller: MapController,
		private settings: MapManagerSettings,
		// A callback rather than a stored `ViewTransform` reference: `MapCanvas` sometimes
		// *reassigns* `this.transform` to a brand-new object (mirror-camera framing, `applyFraming`)
		// rather than mutating the existing one in place — a reference captured once at construction
		// would silently go stale the first time that happens. Reading it fresh through `transform`
		// (the getter just below) every time keeps this in sync regardless.
		private getTransform: () => ViewTransform,
		private isMirror: boolean,
		private forceFog: boolean,
		private getViewportSize: () => { w: number; h: number },
		private getAnimatedPose: (tokenId: string) => { center: Point; direction: number } | null,
		private requestRender: () => void
	) {
		const fogCtx = this.fogCanvas.getContext("2d");
		if (!fogCtx) throw new Error("Canvas 2D context unavailable");
		this.fogCtx = fogCtx;
		const fogBlurCtx = this.fogBlurCanvas.getContext("2d");
		if (!fogBlurCtx) throw new Error("Canvas 2D context unavailable");
		this.fogBlurCtx = fogBlurCtx;
		const vignetteCtx = this.vignetteCanvas.getContext("2d");
		if (!vignetteCtx) throw new Error("Canvas 2D context unavailable");
		this.vignetteCtx = vignetteCtx;
	}

	private get transform(): ViewTransform {
		return this.getTransform();
	}

	destroy(): void {
		if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
	}

	/**
	 * Fog is independent of the "Masquer les cases" toggle — that's for grid lines/zone content only.
	 * Still runs in grid type "none" (on the hidden square substrate — see `MapController.updateCell`),
	 * since fog doesn't depend on a visible grid, only on vision blockers and player tokens.
	 */
	isCurrentlyVisible(): boolean {
		if (this.forceFog) return this.controller.playerMirrorFogEnabled;
		const data = this.controller.getData();
		return data.fogEnabled && this.controller.mode === "view";
	}

	/**
	 * Whether fog should currently hide *entity* tokens from view (`MapCanvas.findTokenAtScreenPoint`/
	 * `tokensInRect`/`drawTokens`) — unlike the fog overlay itself (`isCurrentlyVisible`, which the
	 * GM's own canvas also draws, so they can track explored/unexplored ground and player vision),
	 * entity-hiding only ever applies on the actual player-facing mirror canvas (`isMirror`, see
	 * `MapPlayerMirrorView`): the GM always sees every entity token on their own canvas regardless of
	 * fog, player vision, or `lightRadius`.
	 */
	areEntitiesHidden(): boolean {
		return this.isMirror && this.isCurrentlyVisible();
	}

	/**
	 * A "light" category token is a pure light fixture, never a piece on the board — invisible on the
	 * player-facing mirror canvas unconditionally (fog on or off, lit or not, unlike an entity's own
	 * fog-gated visibility), while still fully visible/selectable on the GM's own canvas so it can be
	 * placed and moved. Its `lightRadius` effect itself is unaffected either way — this only gates the
	 * token's own on-canvas marker (`MapCanvas.drawTokens`/`findTokenAtScreenPoint`/`tokensInRect`).
	 */
	isLightTokenHidden(token: Token): boolean {
		return this.isMirror && (token.category ?? "entity") === "light";
	}

	/**
	 * Whether the fog should animate right now: "Adoucir le brouillard" (`settings.fogSoftening`, a
	 * 0-10 level) has to be above 0, and zoom can't be out past `FOG_ANIMATION_MIN_ZOOM` — the animation loop forcing a
	 * render every frame while zoomed out that far is the one combination that's shown fog visibly
	 * breaking near the edges, so it's disabled there as a hard safety net regardless of the cause.
	 * Drives both the celled-grid fade band (`drawCellFogSoftening`) and the legacy grid-"none" edge
	 * tremble (`drawFog`/`appendVisionFan`).
	 */
	private fogAnimationActive(): boolean {
		return this.settings.fogSoftening > 0 && this.transform.zoom >= FOG_ANIMATION_MIN_ZOOM;
	}

	/**
	 * Whether the light-source flicker (`lightCoreRatio`, breathing every light's clear-core plateau
	 * in `renderCellFog`) should run this frame: at least one light source in view and zoom
	 * not out past `FOG_ANIMATION_MIN_ZOOM`. Independent of "Adoucir le brouillard" — a torch gutters
	 * whether or not the fog edge is softened. Reads the per-frame caches, so call after
	 * `recomputeFrame`.
	 */
	private lightFlickerActive(): boolean {
		if (this.transform.zoom < FOG_ANIMATION_MIN_ZOOM) return false;
		return this.frameVisionCache.some((v) => v.radius > 0) || this.frameLightRawCache.some((l) => l.radius > 0);
	}

	/**
	 * Recomputes this frame's live vision/light reach — call once per `MapCanvas.render()` while fog
	 * is visible (`isCurrentlyVisible()`), before anything that reads `frameVisionCache`/
	 * `frameLightCache` (drawing, `isEntityRevealed`, `MapCanvas.drawTokens`). `clearFrame()` is the
	 * counterpart for when fog isn't visible at all this frame.
	 *
	 * A player token currently mid "Animation" tween (`getAnimatedPose`) casts from its live
	 * interpolated position/facing instead of its still-uncommitted `cellKey`/`x,y`/`rotation` —
	 * otherwise fog would only ever unlock once the whole move commits, well after the tween that's
	 * supposed to be revealing it as it goes has already finished playing.
	 */
	recomputeFrame(wallSegments: ResolvedWallSegment[]): void {
		const data = this.controller.getData();
		// Tracked while building `frameVisionCache` so the `frameLightCache` clipping below knows
		// whether it's safe to trust `lightClipCache` (keyed on `dataVersion` alone) or whether a
		// player's live tween position makes that stale this frame — see `lightClipCache`'s own doc
		// comment.
		let anyPlayerAnimated = false;
		this.frameVisionCache = data.tokens
			.filter((t) => (t.category ?? "entity") === "player")
			.map((t) => {
				const pose = this.getAnimatedPose(t.id);
				if (pose) anyPlayerAnimated = true;
				return this.castLightRaysForToken(t, wallSegments, pose ?? undefined);
			});
		const playerCenters = this.frameVisionCache.map((v) => v.center);
		this.framePlayerCenters = playerCenters;
		this.frameWallSegments = wallSegments;
		const version = this.controller.dataVersion;
		// Any non-player token with an effective light radius > 0 — see `frameLightCache`'s own doc
		// comment.
		const lightEntries = data.tokens
			.filter((t) => (t.category ?? "entity") !== "player" && resolveLightRadius(t) > 0)
			.map((t) => ({ token: t, raw: this.castLightRaysForToken(t, wallSegments, this.getAnimatedPose(t.id) ?? undefined) }));
		this.frameLightRawCache = lightEntries.map((e) => e.raw);
		this.frameLightCache = lightEntries.map(({ token: t, raw }) => {
			const pose = this.getAnimatedPose(t.id);
			if (pose || anyPlayerAnimated) return { ...clipLightToPlayerLineOfSight(raw, playerCenters, wallSegments), phase: raw.phase };
			const cached = this.lightClipCache.get(t.id);
			if (cached && cached.version === version) return { ...cached.result, phase: raw.phase };
			const clipped = clipLightToPlayerLineOfSight(raw, playerCenters, wallSegments);
			this.lightClipCache.set(t.id, { version, result: clipped });
			return { ...clipped, phase: raw.phase };
		});
	}

	clearFrame(): void {
		this.frameVisionCache = [];
		this.frameLightCache = [];
		this.frameLightRawCache = [];
		this.framePlayerCenters = [];
		this.frameWallSegments = [];
	}

	/**
	 * Keeps a `requestAnimationFrame` loop running for as long as (and only while) fog is visible and
	 * either the fog animation (`fogAnimationActive` — soft fade band / vision-edge tremble) or the
	 * light-source flicker (`lightFlickerActive`) is running; otherwise fog is fully static and this
	 * never fires, costing nothing when "Adoucir le brouillard" is off, no light is in view, or the
	 * view is zoomed out too far.
	 */
	syncAnimationLoop(): void {
		const shouldAnimate = this.isCurrentlyVisible() && (this.fogAnimationActive() || this.lightFlickerActive());
		if (shouldAnimate && this.animationFrameId === null) {
			const tick = () => {
				this.animationFrameId = requestAnimationFrame(tick);
				this.requestRender();
			};
			this.animationFrameId = requestAnimationFrame(tick);
		} else if (!shouldAnimate && this.animationFrameId !== null) {
			cancelAnimationFrame(this.animationFrameId);
			this.animationFrameId = null;
		}
	}

	// ---- Ray casting (path tracing — not tied to the visible grid) ----

	/**
	 * Same idea as `castEntityConeVision`, for a token's `lightRadius` reach (`castLightRays`, any
	 * category) — see `drawTokenLightZones`/`drawFog`'s `frameLightCache` use. Also what
	 * `frameVisionCache`/`isEntityRevealed` reads for player tokens now: a player's fog reveal is
	 * exactly their light, omnidirectional and wall-aware (see `castLightRays` in `../grid/fog.ts`),
	 * not a directional cone anymore.
	 *
	 * These reaches are the *true* vision extent for players: they gate what counts as lit for
	 * gameplay (`isLitByCache`) and what gets permanently written to fog memory (`markExplored`). The
	 * tremble animation must never perturb them — an earlier version wobbled `reach` here, which
	 * meant every outward wobble peak got permanently baked into explored memory (since a bucket
	 * once marked explored stays marked), slowly and permanently growing the explored area for as
	 * long as the animation ran, worse the more zoomed out (a larger wobble/reach ratio) — a lasting
	 * corruption, not a rendering glitch, hence surviving after the zoom/animation stopped. The
	 * tremble is now applied only in `appendVisionFan`, purely to the drawn shape.
	 *
	 * `pose`, when given (see `getAnimatedPose`), casts from that live interpolated
	 * position/facing instead of the token's own committed data — and always recomputes rather than
	 * reading/writing `lightRaysCache`, since that cache is keyed on `MapController.dataVersion`
	 * alone, which doesn't change while a tween is merely in flight (nothing's committed yet) and so
	 * would otherwise just keep returning the pre-tween rays for every frame of the animation.
	 */
	private castLightRaysForToken(token: Token, wallSegments: ResolvedWallSegment[], pose?: { center: Point; direction: number }): PlayerVisionRays {
		if (pose) return { ...castLightRays(this.controller.getData(), token, wallSegments, pose), phase: tremblePhase(token.id) };
		const version = this.controller.dataVersion;
		const cached = this.lightRaysCache.get(token.id);
		const result = cached && cached.version === version ? cached.result : castLightRays(this.controller.getData(), token, wallSegments);
		if (!cached || cached.version !== version) this.lightRaysCache.set(token.id, { version, result });
		return { ...result, phase: tremblePhase(token.id) };
	}

	/** Same idea as `castLightRaysForToken`, for one of an entity's `resolveEyeCones` cones — see `drawEntityEyeCones`. */
	private castEntityConeVision(token: Token, direction: number, fullAngleDeg: number, wallSegments: ResolvedWallSegment[]): PlayerVisionRays {
		const version = this.controller.dataVersion;
		const key = `${token.id}|${direction}|${fullAngleDeg}`;
		const cached = this.entityConeRaysCache.get(key);
		const result =
			cached && cached.version === version ? cached.result : castEntityConeRays(this.controller.getData(), token, direction, fullAngleDeg, wallSegments);
		if (!cached || cached.version !== version) this.entityConeRaysCache.set(key, { version, result });
		return { ...result, phase: tremblePhase(token.id) };
	}

	/**
	 * Appends one token's vision fan (a closed polygon through its ray endpoints) to `path`. The
	 * tremble (`mode`) is applied only to this drawn shape, never to `rays` themselves — see the
	 * comment on `castRaysForToken` for why baking it into the actual reach caused lasting corruption.
	 *
	 * `inset` (world units, default 0) pulls every ray's endpoint inward by that much before anything
	 * else — used only by `drawFog`'s own crisp shapes (see the comment there) to keep the blur applied
	 * afterward from ever visibly bleeding past a ray's *true* reach; every other caller (GM tactical
	 * previews, `buildRevealedPath`) leaves it at 0, the real, unshrunk reach.
	 */
	private appendVisionFan(path: Path2D, vision: PlayerVisionRays, useDim: boolean, animate: boolean, time: number, inset = 0): void {
		const { center, rays, phase } = vision;
		let started = false;
		for (let i = 0; i < rays.length; i++) {
			const ray = rays[i];
			if (!ray) continue;
			const angle = (360 / rays.length) * i;
			const rad = (angle * Math.PI) / 180;
			let dist = Math.max(0, (useDim ? ray.dimEnd : ray.clearEnd) - inset);
			if (animate && dist > 0) {
				// Fixed screen-pixel amplitude (divided by zoom) so it stays equally visible at any
				// zoom, capped to a fraction of `dist` so it can't push the drawn point past the
				// center (dividing a fixed px amount by a shrinking zoom is unbounded on its own).
				const wobblePx = Math.min(FOG_TREMBLE_SCREEN_PX / this.transform.zoom, dist * 0.3);
				dist += wobblePx * Math.sin(time * FOG_TREMBLE_SPEED + angle * 0.11 + phase);
			}
			const x = center.x + Math.cos(rad) * dist;
			const y = center.y + Math.sin(rad) * dist;
			if (!started) {
				path.moveTo(x, y);
				started = true;
			} else {
				path.lineTo(x, y);
			}
		}
		if (started) path.closePath();
	}

	/**
	 * Builds a `Path2D` around `verts` — a light's own visibility polygon from
	 * `traceVisibilityPolygon(center, radius, …)` — but any edge whose *both* endpoints sit on the
	 * light's rim (within a hair of `radius` from `center`, i.e. an unobstructed direction) is drawn
	 * as the true circular arc between those two angles instead of a straight chord. Edges with an
	 * endpoint pulled inward by a wall stay straight, so a wall keeps its hard shadow edge while the
	 * open part of the light reads as one clean circle rather than a `VIS_MAX_STEP` fan of facets.
	 */
	private lightCirclePath(center: Point, radius: number, verts: Point[]): Path2D {
		const path = new Path2D();
		const rimDist = radius - Math.max(0.5, radius * 0.02);
		const onRim = (p: Point) => Math.hypot(p.x - center.x, p.y - center.y) >= rimDist;
		const first = verts[0];
		if (!first) return path;
		path.moveTo(first.x, first.y);
		for (let i = 0; i < verts.length; i++) {
			const a = verts[i];
			const b = verts[(i + 1) % verts.length];
			if (!a || !b) continue;
			if (onRim(a) && onRim(b)) {
				const a0 = Math.atan2(a.y - center.y, a.x - center.x);
				let a1 = Math.atan2(b.y - center.y, b.x - center.x);
				while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
				while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
				path.arc(center.x, center.y, radius, a0, a1, a1 < a0);
			} else {
				path.lineTo(b.x, b.y);
			}
		}
		path.closePath();
		return path;
	}

	/**
	 * Radial "clearness" gradient for a light of reach `radius` at `center` — black, alpha `1` from the
	 * source through the `coreRatio` clear-core plateau, then a **linear** ramp down to `0` at the rim.
	 * Filled `destination-out` onto `vignetteCanvas` (which starts solid with the fog's own tint over
	 * every lit shape): it erases that tint fully within the core and not at all at the edge, so the
	 * vignette reads full-bright out to `coreRatio` then dims linearly to full fog tint at the rim.
	 * Because every light erases the *same* pre-filled tint, two overlapping lights only ever make
	 * their overlap brighter (each erases a bit more), never darker — the vignettes don't stack.
	 * Purely cosmetic: the real fog was already cleared straight on `fogCanvas`, and exploration/entity
	 * visibility use exact geometry, not this.
	 */
	private lightClearnessGradient(ctx: CanvasRenderingContext2D, center: Point, radius: number, coreRatio: number): CanvasGradient {
		const g = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, Math.max(radius, 1));
		const core = Math.max(0, Math.min(LIGHT_CLEAR_CORE_RATIO, coreRatio));
		g.addColorStop(0, "rgba(0, 0, 0, 1)");
		if (core > 0) g.addColorStop(core, "rgba(0, 0, 0, 1)");
		g.addColorStop(1, "rgba(0, 0, 0, 0)");
		return g;
	}

	/**
	 * The light-source flicker — the *only* animated part of a light. Returns the fraction of the
	 * reach that stays fully clear before the vignette falloff (fed to `lightClearnessGradient` as
	 * `coreRatio`): it breathes between `0` and `LIGHT_CLEAR_CORE_RATIO` (20%) on a gentle two-sine
	 * guttering. Each source gets both its own phase *and* its own rate (`phase01`, a well-mixed
	 * `tremblePhase` seed in `[0, 1)`), so sources genuinely drift apart instead of running as
	 * phase-shifted copies of one wave. Nothing else moves — the falloff shape, the reach, the
	 * fog-clearing circle and `isCellFullyLit` all stay rock-steady. `time` in seconds, or `0` when
	 * the loop isn't running (returns the steady full 20%).
	 */
	private lightCoreRatio(phase01: number, time: number): number {
		if (time === 0) return LIGHT_CLEAR_CORE_RATIO;
		const ph = phase01 * Math.PI * 2;
		const rate = 3.4 + phase01 * 2.8; // per-source rad/s, ~[3.4, 6.2]
		const n = Math.sin(time * rate + ph) * 0.6 + Math.sin(time * rate * 2.17 + ph * 3.1) * 0.4; // ~[-1, 1]
		return LIGHT_CLEAR_CORE_RATIO * (0.5 + 0.5 * n);
	}

	/** Whether `worldX,worldY` falls within any cached token's traced reach (dim reach if `useDim`, else clear-only). */
	private isLitByCache(cache: PlayerVisionRays[], worldX: number, worldY: number, useDim: boolean): boolean {
		return isPointLit(cache, worldX, worldY, useDim);
	}

	/**
	 * Whether an entity token at `center` should be shown despite fog: standing within any player
	 * token's own light reach (`isLitByCache` against `frameVisionCache` — a player's fog reveal, see
	 * `castLightRaysForToken`; this half already implies player line-of-sight, since a player's own
	 * vision is traced from their own position in the first place), or lit by a light source a player
	 * can actually see it by.
	 *
	 * That second half deliberately checks `frameLightRawCache` (a light's *raw* reach, not
	 * `frameLightCache`'s player-clipped one) plus its own exact `hasLineOfSight` call to `center`
	 * itself, rather than reusing `frameLightCache` the way `drawFog`'s area punch does: that fan is
	 * only an approximation (each ray sampled every 2°, then walked in `LIGHT_LOS_SAMPLE_STEPS` coarse
	 * steps — see `clipLightToPlayerLineOfSight`), acceptable for a smooth area of terrain but not for
	 * a single, gameplay-significant point like "is this monster visible" — a single point can always
	 * afford the exact, unsampled check instead. Callers still gate this on `fogActive` and `!isPlayer`
	 * themselves — see `MapCanvas.drawTokens`/`findTokenAtScreenPoint`/`tokensInRect`.
	 */
	isEntityRevealed(center: Point): boolean {
		if (this.isLitByCache(this.frameVisionCache, center.x, center.y, false)) return true;
		if (!this.isLitByCache(this.frameLightRawCache, center.x, center.y, false)) return false;
		return this.framePlayerCenters.some((p) => hasLineOfSight(p, center, this.frameWallSegments));
	}

	private effectiveMode(): MapMode {
		return this.isMirror ? "view" : this.controller.mode;
	}

	/**
	 * Normally a GM-only tactical hint: a token's own vision cone(s), drawn as translucent colored
	 * zone(s) so the GM can preview exactly what a token would notice without touching the real fog
	 * system at all: this never feeds `isLitByCache` (so it doesn't affect which entities the fog
	 * itself renders) and never calls `markExplored` (so it can't leak into a player's explored
	 * memory). The call site in `MapCanvas.render` excludes the player-mirror window by default
	 * (`isMirror`/`forceFog`), the one canvas real players actually see, except when the GM has
	 * explicitly opted in via the player-window dropdown (`MapController.showEntityVisionToPlayers`)
	 * — a mirror is always in "view" mode (see `effectiveMode`), so it only ever reaches the "every
	 * entity" branch below, never a selected token's own zone (see the "Public viewer" section of
	 * CLAUDE.md on why in-Obsidian "view" mode is otherwise still GM-only).
	 *
	 * In edit mode specifically, only the *selected* token's own zone is drawn, regardless of
	 * category — with every token's zone shown at once, a map with more than a couple of tokens
	 * placed turns into a wash of overlapping color; a player's cone is also otherwise invisible in
	 * edit mode (the real fog only ever renders in "view" mode, see `isCurrentlyVisible`), so this
	 * is the only way to preview it there at all. In "view" mode (live play, not actively
	 * placing/editing tokens) every entity's zone shows continuously instead, since there's no
	 * selection concept driving that same clutter there — a player's cone doesn't need the same
	 * treatment in "view" mode since the real fog overlay already shows it for free there.
	 *
	 * A player token has no directional cone anymore — only `drawTokenLightZones`'s amber wall-aware
	 * fan (any category, whenever `lightRadius` is set) previews what it reveals, matching the real
	 * fog reveal rule exactly (see `Token.lightRadius`/`isEntityRevealed`/`drawFog`'s `frameLightCache`
	 * use). An entity additionally draws both of `resolveEyeCones`'s cones via `drawEntityEyeCones`,
	 * each using `clearEnd` — an entity has no fog-memory concept, so a "partial" wall stops its sight
	 * exactly like an opaque one.
	 */
	drawVisionZones(ctx: CanvasRenderingContext2D, wallSegments: ResolvedWallSegment[]): void {
		if (this.effectiveMode() === "edit") {
			const selected = this.controller.getData().tokens.find((t) => t.id === this.controller.selectedTokenId);
			if (!selected) return;
			this.drawTokenLightZones([selected], wallSegments, ctx);
			// "light"/"player" tokens have no eye-cone shape of their own — only `drawTokenLightZones`
			// above applies to them (see `Token.category`'s doc comment).
			if ((selected.category ?? "entity") === "entity") {
				this.drawEntityEyeCones([selected], wallSegments, ctx);
			}
			return;
		}

		const allTokens = this.controller.getData().tokens;
		this.drawTokenLightZones(allTokens, wallSegments, ctx);
		this.drawEntityEyeCones(
			allTokens.filter((t) => (t.category ?? "entity") === "entity"),
			wallSegments,
			ctx
		);
	}

	/**
	 * Wall-aware (`castLightRaysForToken`/`castLightRays`, blocked by any vision-blocking wall —
	 * `wallBlocksVision`) fan preview of every `tokens` token's `lightRadius`, any category — batched into a single
	 * `Path2D`/fill regardless of how many tokens are on screen, same as `drawEntityEyeCones`. Tokens
	 * with no light radius set contribute nothing. This is the light's own raw reach — deliberately
	 * *not* clipped to player line-of-sight the way `frameLightCache` (what `drawFog` actually punches
	 * through the real fog overlay) is: this is a GM-only tactical preview of what a light source could
	 * reveal, useful while placing/tuning it regardless of where any player token currently stands —
	 * live-tracking a token's animated pose during an in-flight move the same way.
	 */
	private drawTokenLightZones(tokens: Token[], wallSegments: ResolvedWallSegment[], ctx: CanvasRenderingContext2D): void {
		const path = new Path2D();
		let any = false;
		for (const token of tokens) {
			if (resolveLightRadius(token) <= 0) continue;
			any = true;
			const vision = this.castLightRaysForToken(token, wallSegments, this.getAnimatedPose(token.id) ?? undefined);
			this.appendVisionFan(path, vision, false, false, 0);
		}
		if (!any) return;
		ctx.fillStyle = FogRenderer.TOKEN_LIGHT_ZONE_COLOR;
		ctx.fill(path);
	}

	/**
	 * Draws every one of `tokens`'s eye cones (see `resolveEyeCones` — 2 cones per token, mirrored
	 * around its facing by `sideEyeAngle` and collapsing onto a single visible cone when that's 0,
	 * each carrying its own 3-tier angle set sharing the token's own `visionRange`/`visionRadius`) as
	 * layered translucent wedges — see `ENTITY_EYE_TIERS`. One Path2D per tier, batched across every
	 * cone of every token, so each tier costs a single `ctx.fill` regardless of how many entities are
	 * on screen, same batching the old single-path per-category fill used.
	 */
	private drawEntityEyeCones(tokens: Token[], wallSegments: ResolvedWallSegment[], ctx: CanvasRenderingContext2D): void {
		if (tokens.length === 0) return;
		for (const { key, alpha } of FogRenderer.ENTITY_EYE_TIERS) {
			const path = new Path2D();
			for (const token of tokens) {
				for (const cone of resolveEyeCones(token)) {
					this.appendVisionFan(path, this.castEntityConeVision(token, cone.direction, cone[key], wallSegments), false, false, 0);
				}
			}
			ctx.fillStyle = `rgba(220, 38, 38, ${alpha})`;
			ctx.fill(path);
		}
	}

	// ---- Fog compositing ----

	/** World-space rectangle currently on screen, used to bound the fog-memory bucket scan. */
	private visibleWorldRect(): WorldRect {
		const { w, h } = this.getViewportSize();
		const tl = screenToWorld(0, 0, this.transform);
		const br = screenToWorld(w, h, this.transform);
		return { minX: Math.min(tl.x, br.x), minY: Math.min(tl.y, br.y), maxX: Math.max(tl.x, br.x), maxY: Math.max(tl.y, br.y) };
	}

	private fogBucketSize(): number {
		return baseFogBucketSize(this.controller.getData());
	}

	/**
	 * Bucket size actually iterated over to paint the "ever explored" memory layer — coarsened well
	 * past `fogBucketSize()` once the on-screen world rect would otherwise need more than
	 * `FOG_MAX_BUCKETS_PER_AXIS` buckets per axis. Zooming out a lot makes the *visible* world area
	 * huge while `fogBucketSize()` stays fixed (it's in world units), so without this cap the scan —
	 * and the Path2D it builds — grows unbounded and the fog visibly breaks up near the edges. Each
	 * coarse tile still looks up a single underlying `fogBucketSize()` cell's explored state (see
	 * `drawFog`), which is a fine approximation once tiles are this far zoomed out anyway.
	 */
	private fogIterationBucketSize(rect: WorldRect): number {
		const base = this.fogBucketSize();
		const spanCells = Math.max((rect.maxX - rect.minX) / base, (rect.maxY - rect.minY) / base);
		const scale = Math.max(1, Math.ceil(spanCells / FOG_MAX_BUCKETS_PER_AXIS));
		return base * scale;
	}

	/**
	 * Everything this frame considers explored-or-lit at all, as two different shapes unioned
	 * together, each matching what it represents — used only to subtract from `drawWallShadowBlackout`
	 * below, never drawn on its own:
	 *
	 * - Persisted "ever explored" memory has no shape of its own worth preserving (it's just "has a
	 *   token been here"), so it's built one whole grid cell at a time (a cell's center decides the
	 *   *entire* cell, revealed cells getting their own real square/hex shape) instead of off the
	 *   fog's own independent bucket grid — the memory boundary then always lands exactly on a grid
	 *   line instead of cutting across cells wherever a fog bucket happens to fall. Grid type "none"
	 *   has no visible cells to align to, so it falls back to that same bucket grid fog memory is
	 *   actually stored on (see `fogBucketSize`) — the hidden square substrate fog still runs on
	 *   there (see `MapController.updateCell`) has no on-screen lines to visibly misalign with.
	 * - Current live vision keeps its natural round/fan shape: the same precise, ungridded polygon
	 *   `drawFog` itself traces (`appendVisionFan`, unanimated) — snapping *this* part to cells too
	 *   would stair-step the field of view's own outline along the grid instead of leaving it smooth.
	 * - Current `lightRadius` reach (`frameLightCache`) is unioned in the same way as vision, for the
	 *   same reason: a wall standing at the edge of a lit-but-not-actually-seen area still needs its
	 *   shadow patch skipped there, or the blackout would visibly punch a hole back into the light.
	 *
	 * Deliberately independent of `drawFog`'s own drawing (no jitter/tremble, no `markExplored` side
	 * effect — that stays `drawFog`'s alone).
	 */
	private buildRevealedPath(): Path2D {
		const data = this.controller.getData();
		const exploredSet = this.controller.getExploredSet();
		const isExplored = (worldX: number, worldY: number) => isWorldPointExplored(exploredSet, data, worldX, worldY);
		const { w: viewportW, h: viewportH } = this.getViewportSize();

		const path = new Path2D();

		if (data.gridType === "none") {
			const rect = this.visibleWorldRect();
			const tile = this.fogIterationBucketSize(rect);
			const margin = tile * 2;
			const bx0 = Math.floor((rect.minX - margin) / tile);
			const bx1 = Math.ceil((rect.maxX + margin) / tile);
			const by0 = Math.floor((rect.minY - margin) / tile);
			const by1 = Math.ceil((rect.maxY + margin) / tile);
			for (let by = by0; by <= by1; by++) {
				for (let bx = bx0; bx <= bx1; bx++) {
					const worldX = bx * tile + tile / 2;
					const worldY = by * tile + tile / 2;
					if (isExplored(worldX, worldY)) path.rect(bx * tile, by * tile, tile, tile);
				}
			}
		} else {
			const cellSize = effectiveCellSize(data);
			if (data.gridType === "square") {
				for (const c of getVisibleSquareCells(this.transform, cellSize, viewportW, viewportH)) {
					const x = c.a * cellSize;
					const y = c.b * cellSize;
					if (isExplored(x + cellSize / 2, y + cellSize / 2)) path.rect(x, y, cellSize, cellSize);
				}
			} else {
				const orientation = data.gridType === "hex-pointy" ? "pointy" : "flat";
				for (const c of getVisibleHexCells(this.transform, cellSize, orientation, viewportW, viewportH)) {
					const center = hexCellToWorldCenter(c.a, c.b, cellSize, orientation);
					if (!isExplored(center.x, center.y)) continue;
					const corners = hexCorners(center.x, center.y, cellSize, orientation);
					corners.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
					path.closePath();
				}
			}
		}

		for (const vision of this.frameVisionCache) this.appendVisionFan(path, vision, true, false, 0);
		// A wall standing inside a light's own (already wall-blocked) reach must not get its shadow
		// patch redrawn over that same light — see `frameLightCache`.
		for (const vision of this.frameLightCache) this.appendVisionFan(path, vision, true, false, 0);
		return path;
	}

	/**
	 * Patches solid black back over `MapCanvas.drawBackgrounds`/`drawGridAndCells`'s own output, one
	 * cell wide (`cellVisualWidth`, so it visually reads as "the one grid square straddling the wall"
	 * rather than an unrelated-looking band) and centered on each actual wall segment, wherever
	 * `buildRevealedPath` doesn't already reveal it. Everywhere else — any open territory not near a
	 * wall at all — this touches nothing, leaving the original content exactly as drawn. Deliberately a
	 * fixed world-space (i.e. grid-relative) size — it never grows or shrinks on its own as the view is
	 * zoomed, same as the grid itself.
	 *
	 * A `stroke()` hugging every wall segment, then punched through wherever already revealed, patches
	 * that band back to opaque black — unblurred, so blurring *this* patch's own edges afterward can't
	 * reopen a leak. Keeping the blurred fog tint itself from ever bleeding *past* a wall in the first
	 * place (rather than growing this patch to chase it) is `drawFog`'s job — see the inset there.
	 *
	 * Drawn into `fogCanvas`/`fogCtx` (idle at this point in `MapCanvas.render()` — `renderFogLayer`
	 * further down starts by clearing and resizing it fresh for its own, unrelated use) and blitted
	 * back with the same world-rect-to-buffer-rect technique the fog overlay's own final blit uses,
	 * just without that blit's blur or overdraw margin — nothing here is filtered, so there's no blur
	 * radius that needs real pixels past the viewport's own edge to sample from.
	 */
	drawWallShadowBlackout(ctx: CanvasRenderingContext2D, dpr: number, imageBounds: ImageBounds | null, wallSegments: ResolvedWallSegment[]): void {
		if (wallSegments.length === 0) return;

		const rect = this.visibleWorldRect();
		const { w: viewportW, h: viewportH } = this.getViewportSize();
		const w = Math.max(1, Math.round(viewportW * dpr));
		const h = Math.max(1, Math.round(viewportH * dpr));
		if (this.fogCanvas.width !== w || this.fogCanvas.height !== h) {
			this.fogCanvas.width = w;
			this.fogCanvas.height = h;
		}

		const fctx = this.fogCtx;
		fctx.save();
		fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		fctx.clearRect(0, 0, viewportW, viewportH);
		fctx.translate(this.transform.panX, this.transform.panY);
		fctx.scale(this.transform.zoom, this.transform.zoom);

		fctx.lineCap = "round";
		fctx.lineJoin = "round";
		fctx.strokeStyle = "rgba(8, 8, 12, 1)";
		fctx.lineWidth = cellVisualWidth(this.controller.getData());
		fctx.beginPath();
		for (const seg of wallSegments) {
			fctx.moveTo(seg.a.x, seg.a.y);
			fctx.lineTo(seg.b.x, seg.b.y);
		}
		fctx.stroke();

		fctx.globalCompositeOperation = "destination-out";
		fctx.fillStyle = "rgba(0, 0, 0, 1)";
		fctx.fill(this.buildRevealedPath());
		fctx.restore();

		ctx.save();
		if (imageBounds) {
			ctx.beginPath();
			ctx.rect(imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h);
			ctx.clip();
		}
		ctx.drawImage(this.fogCanvas, rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
		ctx.restore();
	}

	/**
	 * Prepares the offscreen fog buffer and draws into it; returns the world rect the buffer ends
	 * up covering (`render()` blits it back with that same rect — see the comment there).
	 *
	 * The buffer is deliberately sized a bit *larger* than the viewport, not just pixel-for-pixel:
	 * the blur pass below only has real pixels to sample from within the buffer it's applied to —
	 * right at the buffer's own edge, it samples "off the edge" as transparent, fading the fog out
	 * there even though the underlying shape (which does extend further, via `drawFog`'s own
	 * margin) logically continues. `FOG_OVERDRAW_PX` gives the blur real data to read within the
	 * buffer at what would otherwise be the viewport's border.
	 *
	 * That overdraw is a *fixed screen-pixel* amount, and so is the buffer's own pixel size —
	 * neither depends on zoom. An earlier version sized the buffer from `tile * zoom` (the LOD
	 * bucket size in device pixels), which meant the buffer's width/height changed continuously
	 * while zooming and had to be reallocated (`canvas.width = ...`, which drops the buffer's
	 * content) on most frames of a zoom gesture. The buffer now only needs resizing when the
	 * viewport's own DOM size changes, exactly like the main canvas.
	 *
	 * `drawFog` itself draws crisp, unfiltered shapes into `fogCanvas` under the world (pan/zoom)
	 * transform; the blur is applied *here*, as a second pass copying that crisp content into
	 * `fogBlurCanvas` under a plain, unscaled transform. Combining `ctx.filter`'s blur radius with
	 * an active `ctx.scale()` leaves it ambiguous (to the code reader, and evidently in practice)
	 * whether the requested px length is itself affected by that scale — keeping the two passes
	 * separate means the blur radius here is always exactly `FOG_BLUR_SCREEN_PX` real buffer pixels,
	 * with nothing left to that ambiguity.
	 */
	private renderFogLayer(dpr: number, viewportRect: WorldRect): WorldRect {
		const zoom = this.transform.zoom;
		const overdrawWorld = FOG_OVERDRAW_PX / zoom;
		const fogRect = {
			minX: viewportRect.minX - overdrawWorld,
			minY: viewportRect.minY - overdrawWorld,
			maxX: viewportRect.maxX + overdrawWorld,
			maxY: viewportRect.maxY + overdrawWorld,
		};

		const { w: viewportW, h: viewportH } = this.getViewportSize();
		const cssW = viewportW + 2 * FOG_OVERDRAW_PX;
		const cssH = viewportH + 2 * FOG_OVERDRAW_PX;
		const w = Math.max(1, Math.round(cssW * dpr));
		const h = Math.max(1, Math.round(cssH * dpr));
		if (this.fogCanvas.width !== w || this.fogCanvas.height !== h) {
			this.fogCanvas.width = w;
			this.fogCanvas.height = h;
		}
		if (this.fogBlurCanvas.width !== w || this.fogBlurCanvas.height !== h) {
			this.fogBlurCanvas.width = w;
			this.fogBlurCanvas.height = h;
		}

		const fctx = this.fogCtx;
		fctx.save();
		fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		fctx.clearRect(0, 0, cssW, cssH);
		// Same pan/zoom as the main canvas, shifted so `fogRect`'s top-left lands at the buffer's
		// origin instead of the viewport's — i.e. the buffer is the same view, just re-centered
		// over a larger area.
		fctx.translate(this.transform.panX + zoom * overdrawWorld, this.transform.panY + zoom * overdrawWorld);
		fctx.scale(zoom, zoom);
		this.drawFog(fctx, fogRect);
		fctx.restore();

		const bctx = this.fogBlurCtx;
		bctx.save();
		bctx.setTransform(1, 0, 0, 1, 0, 0);
		bctx.clearRect(0, 0, w, h);
		bctx.filter = `blur(${FOG_BLUR_SCREEN_PX * dpr}px)`;
		bctx.drawImage(this.fogCanvas, 0, 0);
		bctx.restore();

		return fogRect;
	}

	/**
	 * Runs `renderFogLayer` and blits the finished, blurred result back onto `ctx` — was inlined in
	 * `MapCanvas.render()` before this class existed; pulled in here so callers just need the fog
	 * visible/not-visible branch, not the buffer bookkeeping.
	 */
	renderAndComposite(ctx: CanvasRenderingContext2D, dpr: number, imageBounds: ImageBounds | null): void {
		const viewportRect = this.visibleWorldRect();
		const fogRect = this.renderFogLayer(dpr, viewportRect);
		ctx.save();
		if (imageBounds) {
			ctx.beginPath();
			ctx.rect(imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h);
			ctx.clip();
		}
		// Drawn under the *same* world transform the buffer was rendered with (no switch to a
		// device-pixel transform) — the destination rect is just the exact world rect the fog
		// buffer covers (which extends a bit past the viewport — see `renderFogLayer`), so
		// there's no separate clip-across-transform-change behavior to rely on. `fogBlurCanvas`
		// (not `fogCanvas`) is the finished, already-blurred result — see `renderFogLayer`.
		ctx.drawImage(this.fogBlurCanvas, fogRect.minX, fogRect.minY, fogRect.maxX - fogRect.minX, fogRect.maxY - fogRect.minY);
		ctx.restore();
	}

	// ---- "Avec grillage" per-cell fog (celled grid types) ----

	/**
	 * Fog for celled grid types (`square`/`hex-pointy`/`hex-flat`), replacing the legacy ray-traced
	 * bucket fog (`renderAndComposite`, kept for grid type `"none"`):
	 *
	 * - the whole visible area starts fully black, every explored cell (`getExploredSet()`) punched
	 *   back to half opacity — a "fog" cell is thus full-opacity, an "explored" one half;
	 * - a concave corner of an explored cell (two orthogonally-adjacent fog neighbours, wall-separated
	 *   ones excluded) is cut on the diagonal, the half toward the corner going full black
	 *   (`concaveCornerBlackTriangles`);
	 * - each player token sees exactly "line of sight ∩ light": the real fog is cleared **solid** away
	 *   within every lit shape (the light fully wins over the fog out to its rim), then a cosmetic
	 *   radial vignette (bright at each source, full fog-tint at each rim) is accumulated on
	 *   `vignetteCanvas` and blitted back once — accumulated separately precisely so two overlapping
	 *   lights only ever brighten their overlap, never stack their dark tint (`lightClearnessGradient`).
	 *   A token's own light shape is `traceVisibilityPolygon` traced to exactly its `lightRadius` with
	 *   every unobstructed span snapped back onto the true circle arc (`lightCirclePath`) — a perfect
	 *   round rim where the light runs out, a straight edge only where a wall cuts it; every other
	 *   light source's own wall-clipped reach (`frameLightRawCache`) is clipped to the token's full
	 *   line-of-sight polygon (`traceVisibilityPolygon` traced well past the screen), so a distant lit
	 *   room shows only exactly where this player's line of sight reaches it;
	 * - when "Adoucir le brouillard" is on, a soft (animated, when zoom allows) fade on the explored
	 *   side of every explored/fog border, never spilling onto the fog cells;
	 * - a cell a player can wholly see right now (`isCellFullyLit` — lit by the player's own light or
	 *   by an outside light source in the player's line of sight) is written to
	 *   `exploredCellsByGridType` via `markExplored`, unless fog is frozen.
	 *
	 * All per-cell work is bounded by the explored cells actually on screen (`exploredCellsInRect`)
	 * plus a small neighbourhood around each light, so it stays cheap however far the view is zoomed
	 * out. Drawn crisp on the offscreen `fogCanvas` (no blur pass) and blitted back.
	 */
	renderCellFog(ctx: CanvasRenderingContext2D, dpr: number, imageBounds: ImageBounds | null, wallSegments: ResolvedWallSegment[], allowReuse = false): void {
		const data = this.controller.getData();
		if (data.gridType === "none") return;
		const rect = this.visibleWorldRect();
		const { w: viewportW, h: viewportH } = this.getViewportSize();
		const w = Math.max(1, Math.round(viewportW * dpr));
		const h = Math.max(1, Math.round(viewportH * dpr));

		// Cosmetic-only frame (a token hop mid-flight — see `cellFogSignature`) whose fog inputs are
		// all unchanged: reblit the last full build instead of redoing every trace/path/blur.
		const signature = `${this.controller.dataVersion}|${w}|${h}|${Math.round(this.transform.panX)}|${Math.round(this.transform.panY)}|${this.transform.zoom}|${this.settings.fogSoftening}`;
		if (allowReuse && signature === this.cellFogSignature && this.fogCanvas.width === w && this.fogCanvas.height === h) {
			this.blitCellFog(ctx, rect, imageBounds);
			return;
		}

		if (this.fogCanvas.width !== w || this.fogCanvas.height !== h) {
			this.fogCanvas.width = w;
			this.fogCanvas.height = h;
		}

		const fctx = this.fogCtx;
		fctx.save();
		fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		fctx.clearRect(0, 0, viewportW, viewportH);
		fctx.translate(this.transform.panX, this.transform.panY);
		fctx.scale(this.transform.zoom, this.transform.zoom);

		const exploredSet = this.controller.getExploredSet();
		const cellSize = effectiveCellSize(data);
		const margin = cellSize * 2;
		const exploredKeys = exploredCellsInRect(data, exploredSet, rect, margin);

		const exploredPath = new Path2D();
		for (const key of exploredKeys) polyToPath(exploredPath, cellPolygon(data, key));
		// Diagonal split at concave corners (square only — hex has no natural diagonal).
		const concavePath = new Path2D();
		if (data.gridType === "square") {
			for (const key of exploredKeys) {
				const isFogNeighbour = (nk: string) => !exploredSet.has(nk) && !cellsWallSeparated(data, key, nk, wallSegments);
				for (const tri of concaveCornerBlackTriangles(data, key, isFogNeighbour)) polyToPath(concavePath, tri);
			}
		}

		// Everything fogged first, then explored cells punched back to half opacity, then the
		// concave-corner halves back to full black.
		fctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_UNEXPLORED})`;
		fctx.fillRect(rect.minX - margin, rect.minY - margin, rect.maxX - rect.minX + margin * 2, rect.maxY - rect.minY + margin * 2);
		if (exploredKeys.length > 0) {
			fctx.globalCompositeOperation = "destination-out";
			fctx.fillStyle = "rgba(0, 0, 0, 1)";
			fctx.fill(exploredPath);
			fctx.globalCompositeOperation = "source-over";
			fctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_EXPLORED})`;
			fctx.fill(exploredPath);
			fctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_UNEXPLORED})`;
			fctx.fill(concavePath);
		}

		// Soft fade on the explored side of explored/fog borders (static shape when zoomed out, else
		// animated) — drawn before the light punch so a currently-lit border isn't darkened.
		if (this.settings.fogSoftening > 0) {
			drawFogSofteningRamp(fctx, data, exploredSet, exploredKeys, rect, this.settings.fogSoftening, this.fogAnimationActive() ? performance.now() / 1000 : 0);
		}

		// What the player sees = "line of sight ∩ light":
		//
		//  - own light — a *perfect circle* around the token, cut only where a wall physically blocks
		//    it (`traceVisibilityPolygon` traced to exactly `vision.radius`, every open span snapped
		//    back onto the true circle arc by `lightCirclePath` — a clean round rim, not a fan of
		//    facets angled against the explored/fog frontier);
		//  - every other light source (`frameLightRawCache`) — only where this token's own line of
		//    sight actually reaches it (`traceVisibilityPolygon` traced well past the screen), so a
		//    distant lit room shows through a doorway but nothing bleeds past a wall.
		//
		// Two steps: (1) clear the real fog fully away within every lit shape, straight on the fog
		// buffer; (2) accumulate every light's cosmetic vignette on its own `vignetteCanvas` (bright at
		// each source, fog-tint at each rim) and blit that back in one pass — so two overlapping lights
		// only ever brighten their overlap, never stack their dark tint.
		const losFar = Math.hypot(rect.maxX - rect.minX, rect.maxY - rect.minY) * 1.5 + 1;
		const torchFans = this.frameLightRawCache
			.filter((l) => l.radius > 0)
			.map((light) => {
				const fan = new Path2D();
				this.appendVisionFan(fan, light, false, false, 0);
				return { light, fan };
			});
		const players = this.frameVisionCache
			.filter((v) => v.radius > 0)
			.map((v) => {
				const lightPoly = traceVisibilityPolygon(v.center, v.radius, wallSegments);
				const circle = lightPoly.length >= 3 ? this.lightCirclePath(v.center, v.radius, lightPoly) : null;
				let los: Path2D | null = null;
				if (torchFans.length > 0) {
					const losPoly = traceVisibilityPolygon(v.center, losFar, wallSegments);
					if (losPoly.length >= 3) {
						los = new Path2D();
						losPoly.forEach((p, i) => (i === 0 ? los!.moveTo(p.x, p.y) : los!.lineTo(p.x, p.y)));
						los.closePath();
					}
				}
				return { center: v.center, radius: v.radius, phase: v.phase, circle, los };
			});
		// Seconds, or 0 when the flicker loop isn't running (see `lightFlickerActive`/`syncAnimationLoop`).
		const lightTime = this.lightFlickerActive() ? performance.now() / 1000 : 0;

		const fillTorchesPerPlayer = (context: CanvasRenderingContext2D, perLight: (t: { light: PlayerVisionRays; fan: Path2D }) => void) => {
			for (const p of players) {
				if (!p.los || torchFans.length === 0) continue;
				context.save();
				context.clip(p.los);
				for (const t of torchFans) perLight(t);
				context.restore();
			}
		};

		// (1) Clear the real fog fully within every lit shape.
		fctx.save();
		fctx.globalCompositeOperation = "destination-out";
		fctx.fillStyle = "rgba(0, 0, 0, 1)";
		for (const p of players) if (p.circle) fctx.fill(p.circle);
		fillTorchesPerPlayer(fctx, ({ fan }) => fctx.fill(fan));
		fctx.restore();

		// (2) Accumulate the cosmetic vignette on its own buffer, then blit once.
		const haveLight = players.some((p) => p.circle) || (torchFans.length > 0 && players.some((p) => p.los));
		if (haveLight) {
			if (this.vignetteCanvas.width !== w || this.vignetteCanvas.height !== h) {
				this.vignetteCanvas.width = w;
				this.vignetteCanvas.height = h;
			}
			const vctx = this.vignetteCtx;
			vctx.save();
			vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			vctx.clearRect(0, 0, viewportW, viewportH);
			vctx.translate(this.transform.panX, this.transform.panY);
			vctx.scale(this.transform.zoom, this.transform.zoom);

			// Solid fog tint over every lit shape — overlaps stay at alpha 1, they don't add up. Also
			// stroked a couple of screen px past each edge (`LIGHT_EDGE_SEAL_PX`) so the tint fully
			// covers the anti-aliased seam left by step (1)'s solid clear, which would otherwise read as
			// a faint ring at the light's rim.
			vctx.globalCompositeOperation = "source-over";
			vctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_UNEXPLORED})`;
			vctx.strokeStyle = `rgba(8, 8, 12, ${FOG_OPACITY_UNEXPLORED})`;
			vctx.lineJoin = "round";
			vctx.lineCap = "round";
			vctx.lineWidth = LIGHT_EDGE_SEAL_PX / (this.transform.zoom * dpr);
			for (const p of players)
				if (p.circle) {
					vctx.fill(p.circle);
					vctx.stroke(p.circle);
				}
			fillTorchesPerPlayer(vctx, ({ fan }) => {
				vctx.fill(fan);
				vctx.stroke(fan);
			});

			// Erase that one tint per light: full through the clear core, none at the rim. Every light
			// erases the *same* pre-filled tint, so overlapping lights only brighten their overlap. Only
			// the core plateau flickers (`lightCoreRatio` — breathes 0..20% of the reach); the reach,
			// the falloff shape and step (1)'s fog-clearing circle all stay steady.
			vctx.globalCompositeOperation = "destination-out";
			for (const p of players) {
				if (!p.circle) continue;
				vctx.fillStyle = this.lightClearnessGradient(vctx, p.center, p.radius, this.lightCoreRatio(p.phase, lightTime));
				vctx.fill(p.circle);
			}
			fillTorchesPerPlayer(vctx, ({ light, fan }) => {
				vctx.fillStyle = this.lightClearnessGradient(vctx, light.center, light.radius, this.lightCoreRatio(light.phase, lightTime));
				vctx.fill(fan);
			});
			vctx.restore();

			fctx.save();
			fctx.setTransform(1, 0, 0, 1, 0, 0);
			fctx.globalCompositeOperation = "source-over";
			fctx.drawImage(this.vignetteCanvas, 0, 0);
			fctx.restore();
		}
		fctx.globalCompositeOperation = "source-over";
		fctx.restore();

		this.cellFogSignature = signature;
		this.blitCellFog(ctx, rect, imageBounds);

		// Cells a player can wholly see right now — lit by the player's own light OR by an outside
		// light source the player has line of sight to — become permanently explored. Last, since
		// `markExplored` re-enters `MapCanvas.render()` synchronously (redraws + reblits this same
		// buffer). A no-op while `fogFrozen`. Only cells in some light's own neighbourhood are ever
		// tested, so this stays cheap regardless of zoom.
		if (!data.fogFrozen && this.frameVisionCache.length > 0) {
			const lightSources = [...this.frameVisionCache, ...this.frameLightRawCache];
			const viewerCenters = this.frameVisionCache.map((v) => v.center);
			const newlyExplored: string[] = [];
			const seen = new Set<string>();
			const consider = (center: Point, radius: number) => {
				if (radius <= 0) return;
				for (const key of this.cellKeysInDisc(data, center, radius)) {
					if (seen.has(key) || exploredSet.has(key)) continue;
					seen.add(key);
					if (isCellFullyLit(data, key, lightSources, viewerCenters, wallSegments)) newlyExplored.push(key);
				}
			};
			for (const vision of this.frameVisionCache) consider(vision.center, vision.radius);
			for (const light of this.frameLightRawCache) consider(light.center, light.radius);
			if (newlyExplored.length > 0) this.controller.markExplored(newlyExplored);
		}
	}

	/** Draws the already-composited `fogCanvas` onto the main context, clipped to `imageBounds` — the tail shared by a full `renderCellFog` build and its cheap `allowReuse` reblit. */
	private blitCellFog(ctx: CanvasRenderingContext2D, rect: WorldRect, imageBounds: ImageBounds | null): void {
		ctx.save();
		if (imageBounds) {
			ctx.beginPath();
			ctx.rect(imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h);
			ctx.clip();
		}
		ctx.drawImage(this.fogCanvas, rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
		ctx.restore();
	}

	/**
	 * Debug overlay (`settings.fogDebugVisionRays`): for every player token, strokes the rays out to
	 * its line-of-sight polygon vertices (`traceVisibilityPolygon`, unclamped — so rays that hit no
	 * wall visibly overshoot the light circle), the polygon outline itself, and its light-radius
	 * circle — straight onto the main canvas under the world transform. Only meaningful while fog is
	 * visible (`frameVisionCache` is populated); a no-op otherwise.
	 */
	drawDebugVisionRays(ctx: CanvasRenderingContext2D, wallSegments: ResolvedWallSegment[]): void {
		if (!this.settings.fogDebugVisionRays || this.frameVisionCache.length === 0) return;
		const zoom = this.transform.zoom;
		const r = this.visibleWorldRect();
		const losFar = Math.hypot(r.maxX - r.minX, r.maxY - r.minY) * 1.5 + 1;
		ctx.save();
		ctx.lineWidth = 1 / zoom;
		for (const vision of this.frameVisionCache) {
			const { x: cx, y: cy } = vision.center;
			// Same polygon the punch uses (`renderCellFog`) — rays run well past the screen.
			const verts = traceVisibilityPolygon(vision.center, losFar, wallSegments);

			ctx.strokeStyle = "rgba(0, 200, 255, 0.3)";
			ctx.beginPath();
			for (const p of verts) {
				ctx.moveTo(cx, cy);
				ctx.lineTo(p.x, p.y);
			}
			ctx.stroke();

			ctx.strokeStyle = "rgba(0, 200, 255, 0.9)";
			ctx.beginPath();
			verts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
			ctx.closePath();
			ctx.stroke();

			// Magenta wash over the region the fog punch actually clears for this player: inside its
			// line of sight, its own light circle plus every other light source's own reach.
			if (vision.radius > 0 && verts.length >= 3) {
				ctx.save();
				ctx.beginPath();
				verts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
				ctx.closePath();
				ctx.clip();
				ctx.fillStyle = "rgba(255, 0, 255, 0.18)";
				ctx.beginPath();
				ctx.arc(cx, cy, vision.radius, 0, Math.PI * 2);
				ctx.fill();
				for (const light of this.frameLightRawCache) {
					ctx.beginPath();
					light.rays.forEach((ray, i) => {
						const ang = (2 * Math.PI * i) / light.rays.length;
						const x = light.center.x + Math.cos(ang) * ray.clearEnd;
						const y = light.center.y + Math.sin(ang) * ray.clearEnd;
						return i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
					});
					ctx.closePath();
					ctx.fill();
				}
				ctx.restore();
			}

			if (vision.radius > 0) {
				ctx.strokeStyle = "rgba(255, 210, 0, 0.9)";
				ctx.beginPath();
				ctx.arc(cx, cy, vision.radius, 0, Math.PI * 2);
				ctx.stroke();
			}

			ctx.fillStyle = "rgba(255, 40, 40, 0.95)";
			ctx.beginPath();
			ctx.arc(cx, cy, 3 / zoom, 0, Math.PI * 2);
			ctx.fill();
		}

		// Every other light source's own wall-clipped reach (`frameLightRawCache`), before it is
		// clipped to any player's line of sight — outlined green so it's clear when one of those, not
		// the player's own vision, is what reveals an area, and how much of it the player can see.
		ctx.strokeStyle = "rgba(50, 220, 80, 0.9)";
		for (const light of this.frameLightRawCache) {
			const { center, rays } = light;
			ctx.beginPath();
			rays.forEach((ray, i) => {
				const ang = (2 * Math.PI * i) / rays.length;
				const x = center.x + Math.cos(ang) * ray.clearEnd;
				const y = center.y + Math.sin(ang) * ray.clearEnd;
				return i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
			});
			ctx.closePath();
			ctx.stroke();
		}
		ctx.restore();
	}

	/** Cell keys whose cell intersects the axis-aligned bounding box of the disc `center`/`radius`, current grid type. */
	private cellKeysInDisc(data: MapFileData, center: Point, radius: number): string[] {
		const size = effectiveCellSize(data);
		const cells =
			data.gridType === "square"
				? squareCellsInWorldRect(center.x - radius, center.y - radius, center.x + radius, center.y + radius, size)
				: hexCellsInWorldRect(
						center.x - radius,
						center.y - radius,
						center.x + radius,
						center.y + radius,
						size,
						data.gridType === "hex-pointy" ? "pointy" : "flat"
				  );
		return cells.map((c) => `${c.a},${c.b}`);
	}


	/**
	 * Scales a pair of insets eroding a tile's two *opposite* edges (e.g. west/east) down together,
	 * only when they'd otherwise overlap and flip the tile's width negative — a narrow corridor or an
	 * isolated tile facing unexplored space on both opposite sides at once, the one case where the
	 * fixed anti-bleed margin (`erosionInset` in `drawFog`, deliberately *not* capped on its own — see
	 * the comment there) is large enough relative to the tile to fully erase it. Left untouched
	 * (`[a, b]` unchanged) whenever there's room, which is the ordinary case — most eroded tiles border
	 * unexplored space on only one side, where the full margin was never at risk of collapsing
	 * anything and shrinking it would only needlessly weaken the anti-bleed protection near a real
	 * boundary (a wall, most importantly). A small floor (`span * 0.1`) is always left standing rather
	 * than letting the scale reach exactly 0, so a corridor thins down to a sliver instead of
	 * disappearing outright.
	 */
	private fitOpposingInsets(a: number, b: number, span: number): [number, number] {
		const avail = Math.max(0, span * 0.9);
		const sum = a + b;
		if (sum <= avail) return [a, b];
		const scale = avail / sum;
		return [a * scale, b * scale];
	}

	/**
	 * Renders fog as: a coarse "ever explored" memory layer (square buckets, independent of grid
	 * type/shape — see `FOG_BUCKET_SCALE`), with each player's traced vision fan punched out on top
	 * (fully lit within `clearEnd`, dimmed-but-visible out to `dimEnd`), then every token's
	 * `lightRadius` fan (`frameLightCache`) punched fully transparent on top of *that* — a light
	 * hides the fog exactly like being seen would, but deliberately never joins `newlyExplored` below,
	 * so it never gets written to `exploredCells`: unlike real vision, its reveal is temporary and
	 * disappears the moment the light source moves on or its `lightRadius` drops back to 0 (see
	 * `Token.lightRadius`'s own doc comment). No per-grid-cell shape work. Draws onto the offscreen
	 * fog buffer (see `renderFogLayer`), never the main canvas directly.
	 */
	private drawFog(ctx: CanvasRenderingContext2D, rect: WorldRect): void {
		const exploredSet = this.controller.getExploredSet();
		const cache = this.frameVisionCache;
		const lightCache = this.frameLightCache;
		const baseBucket = this.fogBucketSize();
		const tile = this.fogIterationBucketSize(rect);
		const animate = this.fogAnimationActive();
		const time = animate ? performance.now() / 1000 : 0;
		// A fixed screen-pixel amplitude, converted to world units by the current zoom, so the
		// tremble stays equally visible at any zoom instead of shrinking away when zoomed out (a
		// world-space amplitude like "a fraction of the tile size" shrinks on screen right along
		// with everything else once zoom drops, which read as "the animation stops"). Capped to a
		// fraction of `tile` so it can never exceed a sane range at extreme zoom. A single shared
		// offset applied uniformly to every tile's drawn position (not each tile's own size — see
		// `jitterX`/`jitterY` below), so adjacent tiles never separate; it doesn't touch which world
		// point is sampled for the persisted-memory lookup a few lines down, so resetting fog has no
		// bearing on the animation — it's purely cosmetic.
		const jitterAmplitude = animate ? Math.min(FOG_MEMORY_TREMBLE_SCREEN_PX / this.transform.zoom, tile * 0.4) : 0;
		const sharedJitterX = jitterAmplitude * Math.sin(time * FOG_TREMBLE_SPEED * 0.7);
		const sharedJitterY = jitterAmplitude * Math.cos(time * FOG_TREMBLE_SPEED * 0.9);
		// Generous, independent of the tile loop below: the whole visible area (plus this margin)
		// is unconditionally covered by the single base `fillRect` further down, so no bucket-count
		// cap or rounding in the loop can ever leave a gap at the screen edges — at worst the loop's
		// own bounds are a little off and a sliver near the very edge is mis-classified as
		// unexplored (invisible in practice), never left fully unfogged.
		const margin = tile * 2;

		const bx0 = Math.floor((rect.minX - margin) / tile);
		const bx1 = Math.ceil((rect.maxX + margin) / tile);
		const by0 = Math.floor((rect.minY - margin) / tile);
		const by1 = Math.ceil((rect.maxY + margin) / tile);

		// One extra ring of tiles all around, purely so every tile actually drawn below can look up
		// whether each of its 4 neighbors is revealed too (see `erosionInset` below) — including the
		// ones right at bx0/bx1/by0/by1's own edge, whose outward neighbor sits just outside that
		// range. `margin` (2 whole tiles) already comfortably covers the one extra ring this costs.
		const gbx0 = bx0 - 1;
		const gbx1 = bx1 + 1;
		const gby0 = by0 - 1;
		const gby1 = by1 + 1;
		const gridCols = gbx1 - gbx0 + 1;
		const revealedGrid = new Uint8Array(gridCols * (gby1 - gby0 + 1));
		const gridIndex = (bx: number, by: number) => (by - gby0) * gridCols + (bx - gbx0);

		const exploredPath = new Path2D();
		let hasExplored = false;
		const newlyExplored: string[] = [];

		for (let by = gby0; by <= gby1; by++) {
			for (let bx = gbx0; bx <= gbx1; bx++) {
				const worldX = bx * tile + tile / 2;
				const worldY = by * tile + tile / 2;
				// Persisted memory always keys off the fine `baseBucket` grid regardless of how
				// coarse `tile` got — a single sample at the tile's center is close enough once
				// tiles are this much bigger than a base bucket anyway.
				const key = `${Math.floor(worldX / baseBucket)},${Math.floor(worldY / baseBucket)}`;
				const already = exploredSet.has(key);
				const litNow = !already && this.isLitByCache(cache, worldX, worldY, true);
				// Only the tiles actually drawn below (not this loop's extra lookup-only ring) ever
				// get persisted — see the comment on `gbx0`/`gbx1`/`gby0`/`gby1` above.
				if (litNow && bx >= bx0 && bx <= bx1 && by >= by0 && by <= by1) newlyExplored.push(key);
				if (already || litNow) revealedGrid[gridIndex(bx, by)] = 1;
			}
		}
		const isRevealedTile = (bx: number, by: number) => revealedGrid[gridIndex(bx, by)] === 1;

		// A revealed tile's edge is eroded inward by roughly the blur radius (world units, so it
		// shrinks back down as the view zooms in) wherever it faces a tile that *isn't* revealed —
		// same reasoning as `dimInset` below: the blur applied to this whole buffer afterward then has
		// nowhere near that boundary left to visibly bleed light past. An edge shared with another
		// revealed tile is left untouched, so two neighboring revealed tiles always keep touching
		// seamlessly (no artificial grid lines cutting across an already fully-explored room).
		//
		// Deliberately *not* capped relative to `tile`: this is the same fixed screen-pixel margin
		// wherever it's applied, on purpose — a wall (or any other genuine unexplored boundary) needs
		// that full margin to keep the blur from visibly bleeding past it regardless of how coarse the
		// memory tile grid happens to be at the current zoom. Weakening it broadly (e.g. capping it to
		// a fraction of `tile`) was tried and made *that* leak worse — it doesn't just affect the rare
		// tile eroded on two opposite sides, it also shrinks the margin on the far more common tile
		// eroded on only one side, where there was never any risk of collapsing to begin with. Only the
		// two-opposite-sides case (a corridor/isolated tile narrower than twice this margin) needs
		// scaling down, and `fitOpposingInsets` below does that alone, per axis, only when it's
		// actually needed to keep the tile from vanishing — see its own doc comment.
		const erosionInset = FOG_LEAK_INSET_PX / this.transform.zoom;

		for (let by = by0; by <= by1; by++) {
			for (let bx = bx0; bx <= bx1; bx++) {
				if (!isRevealedTile(bx, by)) continue;
				hasExplored = true;
				// Every tile of the explored/unexplored frontier shifts together by one shared offset
				// (rather than only the vision fan near a token), so the whole fog boundary feels
				// alive; one shared offset moves every tile identically, so adjacent tiles never
				// separate and crack open a sliver of raw unexplored fog between them.
				const jitterX = sharedJitterX;
				const jitterY = sharedJitterY;
				const left = bx * tile + jitterX;
				const right = (bx + 1) * tile + jitterX;
				const top = by * tile + jitterY;
				const bottom = (by + 1) * tile + jitterY;
				const westInset = isRevealedTile(bx - 1, by) ? 0 : erosionInset;
				const eastInset = isRevealedTile(bx + 1, by) ? 0 : erosionInset;
				const northInset = isRevealedTile(bx, by - 1) ? 0 : erosionInset;
				const southInset = isRevealedTile(bx, by + 1) ? 0 : erosionInset;
				const [insetW, insetE] = this.fitOpposingInsets(westInset, eastInset, right - left);
				const [insetN, insetS] = this.fitOpposingInsets(northInset, southInset, bottom - top);
				const x0 = left + insetW;
				const x1 = right - insetE;
				const y0 = top + insetN;
				const y1 = bottom - insetS;
				exploredPath.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
			}
		}

		ctx.save();
		// Drawn crisp, with no `ctx.filter` here — the blur is applied afterward, as a separate pass
		// under an unscaled transform (see `renderFogLayer`), rather than mixed with `ctx.scale()` in
		// this call. Whether a canvas filter's px length is itself affected by the current transform
		// is exactly the kind of thing that's easy to get backwards, and this sidesteps needing to
		// know for sure: a blur radius specified with no scale active is unambiguous.

		// Base layer: the entire visible area (plus margin) starts fully fogged, via one rect —
		// see the `margin` comment above for why this can't be a per-tile loop.
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

		if (cache.length > 0) {
			const dimFan = new Path2D();
			const clearFan = new Path2D();
			// `dimFan`'s outer edge is the one that meets the opaque unexplored base right below —
			// pulling it inward by a bit more than the blur's own radius means the blur (applied to
			// this whole buffer afterward, in `renderFogLayer`) has nowhere near a wall/max-range edge
			// left to visibly bleed light *past* — its outward half of the softening now lands back on
			// roughly the true boundary instead of beyond it, at the cost of that same softening now
			// eating into the fan's own edge instead (a harmless vignette, since that's still legitimate,
			// already-revealed territory). `clearFan` gets the identical inset so it stays strictly
			// inside `dimFan` (dim reach is never shorter than clear reach — see `fog.ts` — so the same
			// subtraction preserves that ordering); insetting only one of the two would let the other
			// stick out past it and carve its own separate leak through the base layer.
			const dimInset = FOG_LEAK_INSET_PX / this.transform.zoom;
			for (const vision of cache) {
				this.appendVisionFan(dimFan, vision, true, animate, time, dimInset);
				this.appendVisionFan(clearFan, vision, false, animate, time, dimInset);
			}
			// Punch the full (dim) reach to transparent, repaint it at "explored" opacity, then punch
			// the inner (clear) reach again so it ends up fully see-through.
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = "rgba(0, 0, 0, 1)";
			ctx.fill(dimFan);
			ctx.globalCompositeOperation = "source-over";
			ctx.fillStyle = `rgba(8, 8, 12, ${FOG_OPACITY_EXPLORED})`;
			ctx.fill(dimFan);
			// `destination-out` only erases by the fill's alpha channel, not its color — must be fully
			// opaque here or the clear zone is left with a residual tint instead of being see-through.
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = "rgba(0, 0, 0, 1)";
			ctx.fill(clearFan);
		}

		if (lightCache.length > 0) {
			// A single tier, always fully see-through — unlike a player's own vision, a light source
			// has no "explored/dim" memory tint to fall back to once it moves on: it's either
			// currently reaching a point or it isn't. Same anti-bleed `dimInset` idea as the vision fan
			// above, so a wall-blocked light's own blurred edge can't visibly bleed past the wall it
			// already stopped at (`castLightRays`).
			const lightFan = new Path2D();
			const lightInset = FOG_LEAK_INSET_PX / this.transform.zoom;
			for (const vision of lightCache) this.appendVisionFan(lightFan, vision, false, animate, time, lightInset);
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = "rgba(0, 0, 0, 1)";
			ctx.fill(lightFan);
		}
		ctx.restore();

		// `newlyExplored`/`markExplored` are driven only by `cache` (real player vision) above — never
		// by `lightCache` — so a light source hides the fog for as long as it's around without ever
		// writing to `exploredCells` (see `Token.lightRadius`'s own doc comment).
		if (newlyExplored.length > 0) this.controller.markExplored(newlyExplored);
	}
}

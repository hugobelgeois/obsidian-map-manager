import { MapController, MapMode } from "../controller/MapController";
import { FogAnimationMode, MapManagerSettings } from "../settings/types";
import { DEFAULT_VISION_RADIUS, Token, resolveEyeCones, resolveLightRadius } from "../data/mapData";
import { Point, ViewTransform, getVisibleHexCells, getVisibleSquareCells, hexCellToWorldCenter, hexCorners, screenToWorld } from "../grid/gridMath";
import {
	ResolvedWallSegment,
	VisionRays,
	castEntityConeRays,
	castLightRays,
	castVisionRays,
	cellVisualWidth,
	effectiveCellSize,
	fogBucketSize as baseFogBucketSize,
	footprintCenter,
	isPointLit,
	isWorldPointExplored,
} from "../grid/fog";
import { ImageBounds, WorldRect } from "./canvasTypes";

/** Fog opacity for ground that has never been in a player's vision. */
const FOG_OPACITY_UNEXPLORED = 1;
/** Fog opacity for ground that has been seen before, isn't currently lit, or sits beyond a "dim" blocker. */
const FOG_OPACITY_EXPLORED = 0.55;

/**
 * Hard cap on how many fog-memory buckets get scanned per axis in one frame — see
 * `fogIterationBucketSize`. Keeps the scan (and its Path2D) bounded even when zoomed out so far
 * that the visible world rect would otherwise need far more of the fine `FOG_BUCKET_SCALE` grid.
 */
const FOG_MAX_BUCKETS_PER_AXIS = 160;
/**
 * Tremble amplitudes in fixed *screen* pixels (divided by zoom at use, see `drawFog`/`castRaysForToken`)
 * rather than a fraction of a world-space length — otherwise the wobble shrinks away right along with
 * everything else when zoomed out, which reads as "the animation stops". The memory (explored/
 * unexplored) frontier's amplitude is deliberately larger than the vision fan's.
 */
const FOG_TREMBLE_SCREEN_PX = 4;
const FOG_MEMORY_TREMBLE_SCREEN_PX = 10;
/** Angular speed (rad/s) of the tremble's sine wave. */
const FOG_TREMBLE_SPEED = 1.6;
/**
 * World-unit wavelength of the "advanced" memory-frontier tremble's spatial noise (see
 * `organicJitter2D`) — roughly the size of one independently-drifting "zone" of fog. Tiles much
 * closer together than this move almost identically (no seam at their shared edge); tiles farther
 * apart than this drift increasingly out of sync.
 */
const FOG_ORGANIC_WAVELENGTH = 260;
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
/** Fog animations (the tremble, and the render loop driving it) are force-disabled at or past this zoom — see `activeFogAnimationMode`. */
const FOG_ANIMATION_MIN_ZOOM = 0.5;

/** Stable per-token phase offset (radians) so several tokens' fog tremble doesn't move in lockstep. */
function tremblePhase(tokenId: string): number {
	let hash = 0;
	for (let i = 0; i < tokenId.length; i++) hash = (hash * 31 + tokenId.charCodeAt(i)) | 0;
	return (hash % 1000) / 1000;
}

/**
 * Smooth 2D pseudo-noise sampled at a world position and time, each axis roughly in [-1, 1] —
 * used only in "advanced" fog animation mode, for the memory frontier's per-tile drift (`drawFog`).
 *
 * This is deliberately a sum of a couple of *mismatched* sine waves (different spatial wavelengths,
 * different speeds, unrelated phase offsets) rather than either a single shared offset ("simple"
 * mode's `sharedJitterX`/`sharedJitterY`) or fully independent per-tile random phase. A single
 * offset moves the whole frontier as one rigid block — not what "advanced" asks for. Fully
 * independent per-tile randomness was tried first and looked like flickering static: neighboring
 * tiles got uncorrelated offsets, so gaps of raw unexplored-opacity fog flashed open between them
 * every frame as their offsets drifted apart. Because this function is continuous in `worldX`/
 * `worldY`, two points closer together than `FOG_ORGANIC_WAVELENGTH` come out nearly identical (no
 * seam at a shared tile edge), while points farther apart drift independently and out of phase —
 * which is what actually reads as "separate zones of fog, each alive on its own" instead of either
 * a single rigid shift or noise.
 */
function organicJitter2D(worldX: number, worldY: number, time: number): { x: number; y: number } {
	const k = (2 * Math.PI) / FOG_ORGANIC_WAVELENGTH;
	const x = Math.sin(worldX * k + time * 0.5) * 0.55 + Math.sin(worldY * k * 1.7 - time * 0.33 + 1.3) * 0.45;
	const y = Math.sin(worldY * k * 1.3 + time * 0.41 + 2.1) * 0.55 + Math.sin(worldX * k * 0.8 - time * 0.27 + 0.7) * 0.45;
	return { x, y };
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
	/** Every player token's traced vision rays, recomputed once per `MapCanvas.render()` and reused by both `drawFog` and `MapCanvas.drawTokens`. */
	private frameVisionCache: PlayerVisionRays[] = [];
	/**
	 * Every token's (any category) traced `lightRadius` reach, recomputed once per `MapCanvas.render()` —
	 * mirrors `frameVisionCache` but for `Token.lightRadius` instead of a player's own vision cone.
	 * Reused by `drawFog` (to hide fog without writing to `exploredCells` — see `drawFog`'s doc
	 * comment) and `isEntityRevealed` (so a lit entity is noticed regardless of any player's own
	 * vision). Wall-aware (`castLightRays`), unlike the plain distance check `visionRadius`'s own
	 * "rayon exploré" fallback still uses.
	 */
	private frameLightCache: PlayerVisionRays[] = [];

	/**
	 * Memoizes the actual (expensive) ray/wall tracing behind `castRaysForToken`/`castEntityConeVision`,
	 * keyed against `MapController.dataVersion` — `render()` runs on every pan/zoom/hover/fog-tremble
	 * animation frame, none of which touch `data`, so re-tracing rays whose token/wall inputs haven't
	 * changed since the last `render()` was pure waste (the dominant cost of "several tokens with
	 * vision on" lagging view mode). Only the cheap, per-frame cosmetic tremble in `appendVisionFan`
	 * still runs unconditionally. Keyed by token id for players (one cone), and `tokenId|direction|
	 * fullAngleDeg` for entities (multiple cones/tiers per token — see `drawEntityEyeCones`).
	 */
	private playerVisionRaysCache: Map<string, { version: number; result: VisionRays }> = new Map();
	private entityConeRaysCache: Map<string, { version: number; result: VisionRays }> = new Map();
	/** Same memoization as `playerVisionRaysCache`, for `castLightRaysForToken` — keyed by token id, any category. */
	private lightRaysCache: Map<string, { version: number; result: VisionRays }> = new Map();

	/** Offscreen buffer fog is composited on before being drawn onto the main canvas as one image — see `renderFogLayer`. */
	private fogCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogCtx: CanvasRenderingContext2D;
	/** Second pass: `fogCanvas`'s crisp content, blurred under a plain (unscaled) transform — see `renderFogLayer`. */
	private fogBlurCanvas: HTMLCanvasElement = document.createElement("canvas");
	private fogBlurCtx: CanvasRenderingContext2D;
	/** Non-null while the fog-tremble animation loop (settings.fogAnimationMode) is actively re-rendering every frame. */
	private animationFrameId: number | null = null;

	private static readonly PLAYER_VISION_ZONE_COLOR = "rgba(37, 99, 235, 0.28)";
	/** Translucent fill color for a token's own `lightRadius` preview — warm/amber, distinct from the vision-cone red/blue so it reads as "light" rather than "sight". */
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
	 * The active fog tremble mode right now: the setting has to be something other than "none", and
	 * zoom can't be out past `FOG_ANIMATION_MIN_ZOOM` — the animation loop forcing a render every
	 * frame while zoomed out that far is the one combination that's shown fog visibly breaking near
	 * the edges, so it's disabled there as a hard safety net regardless of the exact cause.
	 */
	private activeFogAnimationMode(): FogAnimationMode {
		if (this.settings.fogAnimationMode === "none" || this.transform.zoom < FOG_ANIMATION_MIN_ZOOM) return "none";
		return this.settings.fogAnimationMode;
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
		this.frameVisionCache = this.controller
			.getData()
			.tokens.filter((t) => (t.category ?? "entity") === "player")
			.map((t) => this.castRaysForToken(t, wallSegments, this.getAnimatedPose(t.id) ?? undefined));
		// Any token, any category, with an effective light radius > 0 — see `frameLightCache`'s own doc comment.
		this.frameLightCache = this.controller
			.getData()
			.tokens.filter((t) => resolveLightRadius(t) > 0)
			.map((t) => this.castLightRaysForToken(t, wallSegments, this.getAnimatedPose(t.id) ?? undefined));
	}

	clearFrame(): void {
		this.frameVisionCache = [];
		this.frameLightCache = [];
	}

	/**
	 * Keeps a `requestAnimationFrame` loop running for as long as (and only while) fog is visible
	 * and animations are actually active (see `activeFogAnimationMode`), so the vision edge's subtle
	 * tremble (see `appendVisionFan`) keeps redrawing; otherwise fog is static and this never fires,
	 * costing nothing when the setting is "none" (its default) or zoomed out too far.
	 */
	syncAnimationLoop(): void {
		const shouldAnimate = this.activeFogAnimationMode() !== "none" && this.isCurrentlyVisible();
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
	 * Traces every ray outward from a player token's center against `wallSegments` — see
	 * `castVisionRays` in `../grid/fog.ts` for the actual (canvas-agnostic) ray tracing.
	 *
	 * These reaches are the *true* vision extent: they gate what counts as lit for gameplay
	 * (`isLitByCache`) and what gets permanently written to fog memory (`markExplored`). The
	 * tremble animation must never perturb them — an earlier version wobbled `reach` here, which
	 * meant every outward wobble peak got permanently baked into explored memory (since a bucket
	 * once marked explored stays marked), slowly and permanently growing the explored area for as
	 * long as the animation ran, worse the more zoomed out (a larger wobble/reach ratio) — a lasting
	 * corruption, not a rendering glitch, hence surviving after the zoom/animation stopped. The
	 * tremble is now applied only in `appendVisionFan`, purely to the drawn shape.
	 *
	 * `pose`, when given (see `getAnimatedPose`), casts from that live interpolated
	 * position/facing instead of the token's own committed data — and always recomputes rather than
	 * reading/writing `playerVisionRaysCache`, since that cache is keyed on `MapController.dataVersion`
	 * alone, which doesn't change while a tween is merely in flight (nothing's committed yet) and so
	 * would otherwise just keep returning the pre-tween rays for every frame of the animation.
	 */
	private castRaysForToken(token: Token, wallSegments: ResolvedWallSegment[], pose?: { center: Point; direction: number }): PlayerVisionRays {
		if (pose) return { ...castVisionRays(this.controller.getData(), token, wallSegments, pose), phase: tremblePhase(token.id) };
		const version = this.controller.dataVersion;
		const cached = this.playerVisionRaysCache.get(token.id);
		const { center, rays } =
			cached && cached.version === version ? cached.result : castVisionRays(this.controller.getData(), token, wallSegments);
		if (!cached || cached.version !== version) this.playerVisionRaysCache.set(token.id, { version, result: { center, rays } });
		return { center, rays, phase: tremblePhase(token.id) };
	}

	/** Same idea as `castRaysForToken`, for a token's `lightRadius` reach (`castLightRays`, any category) — see `drawTokenLightZones`/`drawFog`'s `frameLightCache` use. */
	private castLightRaysForToken(token: Token, wallSegments: ResolvedWallSegment[], pose?: { center: Point; direction: number }): PlayerVisionRays {
		if (pose) return { ...castLightRays(this.controller.getData(), token, wallSegments, pose), phase: tremblePhase(token.id) };
		const version = this.controller.dataVersion;
		const cached = this.lightRaysCache.get(token.id);
		const { center, rays } = cached && cached.version === version ? cached.result : castLightRays(this.controller.getData(), token, wallSegments);
		if (!cached || cached.version !== version) this.lightRaysCache.set(token.id, { version, result: { center, rays } });
		return { center, rays, phase: tremblePhase(token.id) };
	}

	/** Same idea as `castRaysForToken`, for one of an entity's `resolveEyeCones` cones — see `drawEntityEyeCones`. */
	private castEntityConeVision(token: Token, direction: number, fullAngleDeg: number, wallSegments: ResolvedWallSegment[]): PlayerVisionRays {
		const version = this.controller.dataVersion;
		const key = `${token.id}|${direction}|${fullAngleDeg}`;
		const cached = this.entityConeRaysCache.get(key);
		const { center, rays } =
			cached && cached.version === version ? cached.result : castEntityConeRays(this.controller.getData(), token, direction, fullAngleDeg, wallSegments);
		if (!cached || cached.version !== version) this.entityConeRaysCache.set(key, { version, result: { center, rays } });
		return { center, rays, phase: tremblePhase(token.id) };
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
	private appendVisionFan(path: Path2D, vision: PlayerVisionRays, useDim: boolean, mode: FogAnimationMode, time: number, inset = 0): void {
		const { center, rays, phase } = vision;
		let started = false;
		for (let i = 0; i < rays.length; i++) {
			const ray = rays[i];
			if (!ray) continue;
			const angle = (360 / rays.length) * i;
			const rad = (angle * Math.PI) / 180;
			let dist = Math.max(0, (useDim ? ray.dimEnd : ray.clearEnd) - inset);
			if (mode !== "none" && dist > 0) {
				// Fixed screen-pixel amplitude (divided by zoom) so it stays equally visible at any
				// zoom, capped to a fraction of `dist` so it can't push the drawn point past the
				// center (dividing a fixed px amount by a shrinking zoom is unbounded on its own).
				const wobblePx = Math.min(FOG_TREMBLE_SCREEN_PX / this.transform.zoom, dist * 0.3);
				if (mode === "advanced") {
					// Sum of a few mismatched angular harmonics (integer multiples of `rad` — integer
					// so the closed fan shape still lines up seamlessly at the 0/360 wrap, no seam)
					// at different speeds and phases, instead of "simple"'s single traveling wave (one
					// direction, one speed for the whole edge — see the `else` branch, unchanged).
					// Summing mismatched harmonics makes different lobes of the fan edge bulge and
					// recede on their own schedule rather than one ripple sweeping uniformly around it.
					dist +=
						wobblePx *
						(Math.sin(time * 1.3 + rad * 3 + phase) * 0.5 +
							Math.sin(time * 0.8 + rad * 7 + phase * 1.7) * 0.3 +
							Math.sin(time * 1.9 + rad * 13 + phase * 2.3) * 0.2);
				} else {
					dist += wobblePx * Math.sin(time * FOG_TREMBLE_SPEED + angle * 0.11 + phase);
				}
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

	/** Whether `worldX,worldY` falls within any cached token's traced reach (dim reach if `useDim`, else clear-only). */
	private isLitByCache(cache: PlayerVisionRays[], worldX: number, worldY: number, useDim: boolean): boolean {
		return isPointLit(cache, worldX, worldY, useDim);
	}

	/**
	 * Whether an entity token at `center` should be shown despite fog: the ordinary raycast reach
	 * (`isLitByCache` against `frameVisionCache`, walls included), or simply standing within any
	 * player token's own "rayon exploré" (`visionRadius`) — a straight-line distance check, walls or
	 * not, so something right next to a player is always noticed even through a partial wall the
	 * raycast rule itself would otherwise still dim/block at a distance — or standing within any
	 * token's (any category) traced `lightRadius` reach (`isLitByCache` against `frameLightCache`),
	 * which unlike the other two *does* stop at a wall (see `castLightRays`). Callers still gate this
	 * on `fogActive` and `!isPlayer` themselves — see `MapCanvas.drawTokens`/`findTokenAtScreenPoint`/`tokensInRect`.
	 */
	isEntityRevealed(center: { x: number; y: number }): boolean {
		if (this.isLitByCache(this.frameVisionCache, center.x, center.y, false)) return true;
		if (this.isLitByCache(this.frameLightCache, center.x, center.y, false)) return true;
		const cellSize = cellVisualWidth(this.controller.getData());
		for (const player of this.controller.getData().tokens) {
			if ((player.category ?? "entity") !== "player") continue;
			const playerCenter = this.getAnimatedPose(player.id)?.center ?? footprintCenter(this.controller.getData(), player);
			const radius = (player.visionRadius ?? DEFAULT_VISION_RADIUS) * cellSize;
			if (Math.hypot(center.x - playerCenter.x, center.y - playerCenter.y) <= radius) return true;
		}
		return false;
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
	 * The two categories draw entirely differently below: a player token keeps the single blue cone
	 * this always drew (`castVisionRays`, `dimEnd` — reaches past a "dim"/partial wall, matching what
	 * its real fog memory would eventually show once explored); an entity token instead draws both of
	 * `resolveEyeCones`'s cones via `drawEntityEyeCones`, each using `clearEnd` — an entity has no
	 * fog-memory concept, so a "partial" wall stops its sight exactly like an opaque one. Either
	 * category also gets `drawTokenLightZones`'s amber wall-aware fan underneath when it has a
	 * `lightRadius` set — see `Token.lightRadius`/`isEntityRevealed`/`drawFog`'s `frameLightCache`
	 * use for the actual reveal rule this previews.
	 */
	drawVisionZones(ctx: CanvasRenderingContext2D, wallSegments: ResolvedWallSegment[]): void {
		if (this.effectiveMode() === "edit") {
			const selected = this.controller.getData().tokens.find((t) => t.id === this.controller.selectedTokenId);
			if (!selected) return;
			this.drawTokenLightZones([selected], wallSegments, ctx);
			const category = selected.category ?? "entity";
			// "light" tokens have no vision/eye-cone shape of their own — only `drawTokenLightZones`
			// above applies to them (see `Token.category`'s doc comment).
			if (category === "entity") {
				this.drawEntityEyeCones([selected], wallSegments, ctx);
			} else if (category === "player") {
				const path = new Path2D();
				this.appendVisionFan(path, this.castRaysForToken(selected, wallSegments), true, "none", 0);
				ctx.fillStyle = FogRenderer.PLAYER_VISION_ZONE_COLOR;
				ctx.fill(path);
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
	 * Wall-aware (`castLightRaysForToken`/`castLightRays`, blocked by opaque and "dim" walls alike)
	 * fan preview of every `tokens` token's `lightRadius`, any category — batched into a single
	 * `Path2D`/fill regardless of how many tokens are on screen, same as `drawEntityEyeCones`. Tokens
	 * with no light radius set contribute nothing. This is the exact shape `drawFog` also punches
	 * through the real fog overlay for (see `frameLightCache`), just drawn as a GM preview instead —
	 * live-tracking a token's animated pose during an in-flight move the same way.
	 */
	private drawTokenLightZones(tokens: Token[], wallSegments: ResolvedWallSegment[], ctx: CanvasRenderingContext2D): void {
		const path = new Path2D();
		let any = false;
		for (const token of tokens) {
			if (resolveLightRadius(token) <= 0) continue;
			any = true;
			const vision = this.castLightRaysForToken(token, wallSegments, this.getAnimatedPose(token.id) ?? undefined);
			this.appendVisionFan(path, vision, false, "none", 0);
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
					this.appendVisionFan(path, this.castEntityConeVision(token, cone.direction, cone[key], wallSegments), false, "none", 0);
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

		for (const vision of this.frameVisionCache) this.appendVisionFan(path, vision, true, "none", 0);
		// A wall standing inside a light's own (already wall-blocked) reach must not get its shadow
		// patch redrawn over that same light — see `frameLightCache`.
		for (const vision of this.frameLightCache) this.appendVisionFan(path, vision, true, "none", 0);
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
		const mode = this.activeFogAnimationMode();
		const animate = mode !== "none";
		const time = animate ? performance.now() / 1000 : 0;
		// A fixed screen-pixel amplitude, converted to world units by the current zoom, so the
		// tremble stays equally visible at any zoom instead of shrinking away when zoomed out (a
		// world-space amplitude like "a fraction of the tile size" shrinks on screen right along
		// with everything else once zoom drops, which read as "the animation stops"). Capped to a
		// fraction of `tile` so it can never exceed a sane range at extreme zoom.
		//
		// In "simple" mode this is a *single* offset applied uniformly to every tile's drawn
		// position (not each tile's own size — see `jitterX`/`jitterY` below); in "advanced" mode
		// each tile instead samples smooth spatial noise (see `organicJitter2D`) so different
		// patches of the frontier drift independently instead of the whole boundary moving in
		// lockstep. Neither mode touches which world point is sampled for the persisted-memory
		// lookup a few lines down. Perturbing each tile's own rect *size* (an earlier version of
		// this) could shrink a tile to zero or negative at extreme/changing zoom, which is what
		// actually broke near the edges; a position-only shift can't do that, and keeping the memory
		// lookup itself un-jittered means resetting fog has no bearing on the animation — it's
		// purely cosmetic.
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
				const worldX = bx * tile + tile / 2;
				const worldY = by * tile + tile / 2;
				// "simple": every tile of the explored/unexplored frontier shifts together a
				// little (rather than only the vision fan near a token), so the whole fog
				// boundary feels alive. "advanced": each tile instead samples smooth spatial
				// noise (see `organicJitter2D`) at its own world position, so different zones of
				// fog drift independently instead of the whole frontier moving as one block.
				let jitterX = sharedJitterX;
				let jitterY = sharedJitterY;
				// In "advanced" mode, neighboring tiles can end up with slightly different
				// offsets (that's the point — see above), which would otherwise crack open a
				// sliver of raw unexplored-opacity fog between them right at their shared edge.
				// `organicJitter2D` is built to keep that difference far smaller than
				// `jitterAmplitude` between adjacent tiles, but inflating every tile by that same
				// amplitude on all sides guarantees neighbors always overlap regardless, so nothing
				// in this loop depends on exactly how smooth the noise turns out to be. "simple"
				// needs none of this: one shared offset moves every tile identically, so adjacent
				// tiles never separate in the first place.
				let overlap = 0;
				if (mode === "advanced") {
					const n = organicJitter2D(worldX, worldY, time);
					jitterX = jitterAmplitude * n.x;
					jitterY = jitterAmplitude * n.y;
					overlap = jitterAmplitude;
				}
				const left = bx * tile + jitterX - overlap;
				const right = (bx + 1) * tile + jitterX + overlap;
				const top = by * tile + jitterY - overlap;
				const bottom = (by + 1) * tile + jitterY + overlap;
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
				this.appendVisionFan(dimFan, vision, true, mode, time, dimInset);
				this.appendVisionFan(clearFan, vision, false, mode, time, dimInset);
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
			for (const vision of lightCache) this.appendVisionFan(lightFan, vision, false, mode, time, lightInset);
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

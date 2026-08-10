import { ABS_MAX_ZOOM, ABS_MIN_ZOOM } from "../grid/gridMath";

export type GridType = "square" | "hex-pointy" | "hex-flat" | "none";

export const GRID_TYPES: GridType[] = ["square", "hex-pointy", "hex-flat", "none"];

/** Grid types that actually store cells. "none" has no cells: tokens/markers are freely positioned instead. */
export type CelledGridType = Exclude<GridType, "none">;

export const CELLED_GRID_TYPES: CelledGridType[] = ["square", "hex-pointy", "hex-flat"];

export interface ZoneType {
	id: string;
	name: string;
	color: string;
}

/**
 * Blocks line of sight for fog-of-war vision cones/radii (a wall, a door, ...), on a `WallSegment`.
 * "opaque" hides everything beyond it entirely; "dim" still stops direct/clear vision but lets
 * cells beyond be marked "explored" (dimly visible), like a window or a searched-but-unlit room.
 */
export type VisionBlockerType = "opaque" | "dim";

export interface CellData {
	zoneTypeId?: string;
	stamp?: string;
	label?: string;
	links?: string[];
}

/**
 * A link is a vault file path, optionally followed by "#Heading" to point at
 * a specific section (same convention as Obsidian's own wikilinks).
 */
export function splitLink(link: string): { path: string; subpath?: string } {
	const idx = link.indexOf("#");
	if (idx === -1) return { path: link };
	return { path: link.slice(0, idx), subpath: link.slice(idx + 1) };
}

export function makeLink(path: string, subpath?: string): string {
	return subpath ? `${path}#${subpath}` : path;
}

/** Short display label for a link tab (e.g. an info panel's linked-notes tabs): "Note" or "Note › Heading". */
export function linkTabLabel(link: string): string {
	const { path, subpath } = splitLink(link);
	const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
	return subpath ? `${basename} › ${subpath}` : basename;
}

/**
 * Extracts a `.map` file's vault path from a ` ```map ``` ` code block's raw source — either a
 * bare path or a `[[wikilink]]` (same convention as Obsidian's own embeds). Shared with
 * `src/view/customScript.ts`, which parses the same code block syntax client-side on the exported
 * site (see `publicSnapshotPath` below for the JSON it then fetches) — pure so it stays usable
 * there without any Obsidian dependency.
 */
export function parseMapBlockSource(source: string): string {
	const trimmed = source.trim();
	const linkMatch = trimmed.match(/^!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
	return linkMatch ? (linkMatch[1] ?? "").trim() : trimmed;
}

/** Sibling `<basename>.json` path for a `.map` file's vault path — where `publishPublicSnapshot` writes, and where `customScript.ts` fetches from. */
export function publicSnapshotPath(mapPath: string): string {
	const withoutExt = mapPath.endsWith(".map") ? mapPath.slice(0, -".map".length) : mapPath;
	return `${withoutExt}.json`;
}

export interface MapBackground {
	path: string;
	/**
	 * Position of the image's CENTER, in grid cells (not pixels), so it stays meaningful if the
	 * cell size changes. Anchoring on the center (rather than a corner) means changing `scale`
	 * never shifts where the image sits — it only grows/shrinks around the same point. New
	 * images default to (0,0), so every background naturally shares the same center unless
	 * manually repositioned.
	 */
	offsetX: number;
	offsetY: number;
	scale: number;
}

export interface TokenTemplate {
	id: string;
	name: string;
	fields: string[];
	/** Default tab names for a player token using this template (see `getTokenTabs`) — falls back to `DEFAULT_TOKEN_TAB_NAMES` when unset/empty. */
	defaultTabNames?: string[];
}

/**
 * "light" is a pure light fixture, not a character: it never renders on the player-facing mirror
 * canvas at all (see `MapCanvas.isLightTokenHiddenFromMirror`) — only its `lightRadius` effect
 * (hiding fog, revealing nearby entities) is ever felt there — and it has nothing to configure
 * beyond `lightRadius` itself (no icon/image/name/rotation/size/color/template/tabs/vision — see
 * `InfoPanel.renderTokenPanel`, which skips straight from the category picker to the light-radius
 * field for this category).
 */
export type TokenCategory = "player" | "entity" | "light";

/** One note tab on a player token (see `getTokenTabs`) — e.g. "Statistiques"/"Inventaire"/"Histoire", freely renamed/added/removed per token. */
export interface TokenTab {
	id: string;
	name: string;
	link?: string;
}

/** Fallback default tab names for a token with no template, or whose template doesn't customize them — see `getTokenTabs`. */
export const DEFAULT_TOKEN_TAB_NAMES: readonly string[] = ["Statistiques", "Inventaire", "Histoire"];

/**
 * A token's note tabs (any category — player or entity). `token.tabs` is left `undefined` until
 * someone actually edits a tab (rename/link/add/remove) — until then this returns the token's
 * template's configured default tab names (Settings → "Modèles de statistiques de pion" →
 * `defaultTabNames`), or `DEFAULT_TOKEN_TAB_NAMES` if the token has no template or its template
 * doesn't customize them, seeded with the token's legacy single `link` (if any) on the first tab,
 * so pre-existing tokens don't lose their note.
 * Once `token.tabs` is set (even to `[]`, e.g. every tab was deleted), it's authoritative.
 */
export function getTokenTabs(token: Token, templates: TokenTemplate[]): TokenTab[] {
	if (token.tabs !== undefined) return token.tabs;
	const template = templates.find((t) => t.id === token.templateId);
	const names = template?.defaultTabNames && template.defaultTabNames.length > 0 ? template.defaultTabNames : DEFAULT_TOKEN_TAB_NAMES;
	const tabs: TokenTab[] = names.map((name, i) => ({ id: `default-${i}`, name }));
	if (token.link && tabs[0]) tabs[0] = { ...tabs[0], link: token.link };
	return tabs;
}

/** The tab treated as the stats source for `renderTokenStats`/the public snapshot (matched by name, not a fixed id, so it survives the tab being deleted and re-added). */
export function findStatsTab(tabs: TokenTab[]): TokenTab | undefined {
	return tabs.find((t) => t.name.trim().toLowerCase() === "statistiques");
}

/** Link to resolve a token's stat-block frontmatter from: its "Statistiques" tab, regardless of category. */
export function tokenStatsSourceLink(token: Token, templates: TokenTemplate[]): string | undefined {
	return findStatsTab(getTokenTabs(token, templates))?.link;
}

export interface Token {
	id: string;
	/** Anchor cell (celled grid types only). For square grids with size > 1, this is the top-left cell of the footprint. */
	cellKey?: string;
	/** Free world position (grid type "none" only), in the same pixel space as everything else on the canvas. */
	x?: number;
	y?: number;
	icon: string;
	label?: string;
	/** Legacy single note link, from before per-tab links — superseded by `tabs` (see `getTokenTabs`), which seeds its first tab from this on first use. */
	link?: string;
	templateId?: string;
	/** Note tabs (Statistiques/Inventaire/Histoire by default), any token category — see `getTokenTabs`. */
	tabs?: TokenTab[];
	/** How many cells wide/tall the token occupies (square grids only; 1 = a single cell). Defaults to 1. */
	size?: number;
	/** Border color (hex string). Defaults to a neutral dark gray when unset. */
	color?: string;
	/**
	 * Fog of war category. Players always render and light up the fog with their vision cone;
	 * entities only render when inside a player's current vision cone. Defaults to "entity".
	 */
	category?: TokenCategory;
	/**
	 * Player-only vision cone full angle in degrees (see `castVisionRays`) — a player's cone both
	 * lights up the fog for real and shows the same GM-only tactical preview as an entity's
	 * (`MapCanvas.drawTokenVisionZones`). An entity token ignores this field entirely; its own vision
	 * shape instead comes from `sideEyeAngle`/`detectionAngle`/`binocularAngle`/`monocularAngle` (see
	 * `resolveEyeCones`) — never touching fog either way, purely a GM-only tactical overlay.
	 */
	visionAngle?: number;
	/** Vision range in cells, shared by both categories' vision shapes — see `visionAngle` (player) and `resolveEyeCones` (entity). */
	visionRange?: number;
	/** Omnidirectional "always lit" radius, in cells, regardless of facing — shared by both categories, see `visionAngle` (player) and `resolveEyeCones` (entity). */
	visionRadius?: number;
	/**
	 * Radius (in cells), any category, within which this token's own "light" reveals every entity
	 * token inside it, even when none of them sit inside any player's vision cone — wall-aware
	 * (opaque or "dim" alike; see `castLightRays` in `fog.ts`), unlike the walls-blind straight-line
	 * `visionRadius` fallback it otherwise resembles (see `MapCanvas.isEntityRevealedByFog`). Also
	 * visually hides the fog overlay whether or not a player can actually see that far (`drawFog`'s
	 * `frameLightCache` punch), but deliberately never feeds `exploredCells`: the area goes dark
	 * again the moment the light source moves away or is removed, unlike real vision. `0`/unset (the
	 * default) means the token casts no light.
	 */
	lightRadius?: number;
	/**
	 * Whether this token's light is currently switched on — defaults to `true` (on) when unset, so
	 * existing `lightRadius` values keep behaving exactly as they did before this field existed.
	 * Deliberately separate from `lightRadius` itself so flipping it off/on (e.g. a torch being
	 * doused/relit mid-session, editable in "Vue" mode too — see `InfoPanel.renderLightRadiusField`)
	 * never loses the configured radius the way setting `lightRadius` back to `0` would. See
	 * `resolveLightRadius`, the one place that actually combines this with `lightRadius`/
	 * `lightRadiusLinkedToVision` into the effective reach everything else reads.
	 */
	lightEnabled?: boolean;
	/**
	 * Player-only: when `true`, the *effective* light radius (`resolveLightRadius`) always tracks
	 * this token's own `visionRadius` ("rayon exploré") instead of its stored `lightRadius` — so a
	 * player is exactly as visible as far as they can see. Toggled from the "🔗" button next to
	 * `lightRadius` in `InfoPanel` (player tokens only — an entity/light token has no "rayon exploré"
	 * concept worth linking to). `lightRadius` itself is left untouched while linked (dormant, not
	 * overwritten) so unlinking has something sensible to fall back to.
	 */
	lightRadiusLinkedToVision?: boolean;
	/**
	 * Entity-only: how far each of the token's two eye cones sits from its facing (`rotation`), in
	 * degrees, one clockwise and one counter-clockwise — `0` (the default) puts both cones on top of
	 * each other pointing straight ahead, like a single forward-facing cone; larger values spread
	 * them out to either side, like a prey animal's eyes. Overrides `DEFAULT_SIDE_EYE_ANGLE`. See
	 * `resolveEyeCones`.
	 */
	sideEyeAngle?: number;
	/** Full angle (degrees) of the narrowest, sharpest tier of an entity's eye cone(s) — overrides `DEFAULT_EYE_TIER_ANGLES.detectionAngle`. See `resolveEyeCones`. */
	detectionAngle?: number;
	/** Full angle (degrees) of the middle tier — overrides `DEFAULT_EYE_TIER_ANGLES.binocularAngle`. See `resolveEyeCones`. */
	binocularAngle?: number;
	/** Full angle (degrees) of the widest tier — overrides `DEFAULT_EYE_TIER_ANGLES.monocularAngle`. See `resolveEyeCones`. */
	monocularAngle?: number;
	/** Vault path to a custom image shown instead of `icon` once loaded. */
	image?: string;
	/**
	 * Which way the token is drawn facing (a small arrow on its rim — see `drawTokenFacingArrow`),
	 * in degrees, 0 = east, increasing clockwise. Any category. For player tokens this is also the
	 * fog vision cone's facing (see `castVisionRays`); for entities it's what `resolveEyeCones`
	 * points its own cone(s) relative to. There's a single facing per token, not one for the arrow
	 * and a separate one for vision; pre-v14 files stored that as `visionDirection`, folded into
	 * this field on load (see `parseToken`).
	 */
	rotation?: number;
}

export const DEFAULT_TOKEN_COLOR = "#1e1e1e";

export const TOKEN_SIZES = [1, 2, 3];

export const DEFAULT_VISION_ANGLE = 90;
export const DEFAULT_VISION_RANGE = 6;
export const DEFAULT_VISION_RADIUS = 1;
export const DEFAULT_TOKEN_ROTATION = 0;

/** Default `Token.lightRadius` — `0` means the entity casts no light. */
export const DEFAULT_LIGHT_RADIUS = 0;

/** Default `Token.sideEyeAngle` — how far each of an entity's two eye cones sits from its facing, in degrees. `0` collapses them onto a single forward direction. See `resolveEyeCones`. */
export const DEFAULT_SIDE_EYE_ANGLE = 0;

/** An entity eye cone's 3-tier angles (degrees, full angle) — see `resolveEyeCones`. */
export interface EyeTierAngles {
	detectionAngle: number;
	binocularAngle: number;
	monocularAngle: number;
}

/**
 * Default tier angles for every entity's eye cones, real-world-inspired for a side-eyed creature
 * (eyes towards the sides of the head, e.g. a prey animal): a narrow sharp-detail zone
 * ("détection"), a wider zone with depth perception ("binoculaire"), and the widest zone where only
 * shape/motion registers ("monoculaire"). See `resolveEyeCones`.
 */
export const DEFAULT_EYE_TIER_ANGLES: EyeTierAngles = { detectionAngle: 20, binocularAngle: 50, monocularAngle: 150 };

/** One of an entity's eye cones — a facing direction (same convention as `Token.rotation`) plus its own resolved 3-tier angles. */
export interface EntityEyeCone extends EyeTierAngles {
	direction: number;
}

/**
 * Resolves an entity token's eye layout into its two cones, mirrored around its facing (`rotation`)
 * by `token.sideEyeAngle` (defaults to `DEFAULT_SIDE_EYE_ANGLE`, i.e. `0` — both cones pointing the
 * same way, reading as a single forward cone) — one clockwise, one counter-clockwise, both sharing
 * the token's own facing point/`visionRange`/`visionRadius` (see `Token.rotation` and
 * `castVisionRays` callers). Each per-tier angle field on the token overrides
 * `DEFAULT_EYE_TIER_ANGLES` individually, so customizing e.g. just `detectionAngle` leaves the other
 * two at their default. Player tokens never call this — see `Token.visionAngle`.
 */
export function resolveEyeCones(token: Token): EntityEyeCone[] {
	const tierAngles: EyeTierAngles = {
		detectionAngle: token.detectionAngle ?? DEFAULT_EYE_TIER_ANGLES.detectionAngle,
		binocularAngle: token.binocularAngle ?? DEFAULT_EYE_TIER_ANGLES.binocularAngle,
		monocularAngle: token.monocularAngle ?? DEFAULT_EYE_TIER_ANGLES.monocularAngle,
	};
	const facing = token.rotation ?? DEFAULT_TOKEN_ROTATION;
	const sideAngle = token.sideEyeAngle ?? DEFAULT_SIDE_EYE_ANGLE;
	return [
		{ direction: facing - sideAngle, ...tierAngles },
		{ direction: facing + sideAngle, ...tierAngles },
	];
}

/**
 * The radius `token`'s light is *configured* to use whenever it's switched on — a linked player
 * token's own `visionRadius` ("rayon exploré", see `lightRadiusLinkedToVision`'s own doc comment)
 * instead of its stored `lightRadius`, or `lightRadius` itself (defaulting to `DEFAULT_LIGHT_RADIUS`)
 * otherwise. Deliberately ignores `lightEnabled` — see `resolveLightRadius`, which layers that gate
 * on top — so a temporarily switched-off light still reports the number it'll come back on at
 * (`InfoPanel.renderLightRadiusField`'s radius input reads this, not `resolveLightRadius`, so
 * toggling the light off never makes that field flash to `0`).
 */
export function configuredLightRadius(token: Token): number {
	if ((token.category ?? "entity") === "player" && token.lightRadiusLinkedToVision) {
		return token.visionRadius ?? DEFAULT_VISION_RADIUS;
	}
	return token.lightRadius ?? DEFAULT_LIGHT_RADIUS;
}

/**
 * The light radius actually in effect for `token` right now (cells) — `configuredLightRadius`,
 * gated by `lightEnabled`. Every reader of a token's *actual* light (`castLightRays`, `MapCanvas`'s
 * `frameLightCache`/`drawTokenLightZones`) calls this instead of reading `lightRadius` directly.
 */
export function resolveLightRadius(token: Token): number {
	if (token.lightEnabled === false) return 0;
	return configuredLightRadius(token);
}

export type CellsByGridType = Record<CelledGridType, Record<string, CellData>>;

/** A free-floating "tampon" (stamp), used only in the "no grid" grid type. */
export interface Marker {
	id: string;
	x: number;
	y: number;
	stamp?: string;
	label?: string;
	links?: string[];
}

/** A freeform vision-blocking wall vertex, in world coordinates — independent of grid type/cells. */
export interface WallPoint {
	id: string;
	x: number;
	y: number;
}

/** A vision-blocking line between two `WallPoint`s (by id, both on the same layer). */
export interface WallSegment {
	id: string;
	aId: string;
	bId: string;
	blockerType: VisionBlockerType;
}

export interface Layer {
	id: string;
	name: string;
	visible: boolean;
	background?: MapBackground;
	cellsByGridType: CellsByGridType;
	/** Free-floating stamps for the "no grid" mode; unused for celled grid types. */
	markers: Marker[];
	/** Freeform vision-blocking wall vertices/segments, independent of grid type. */
	wallPoints: WallPoint[];
	wallSegments: WallSegment[];
}

export interface MapFileData {
	version: 14;
	gridType: GridType;
	cellSize: number;
	layers: Layer[];
	activeLayerId: string;
	/**
	 * Tokens are not tied to a layer or a grid type: they always render on top and stay
	 * visible when switching between square/hex grids (their cellKey is simply reinterpreted
	 * under whichever grid is active).
	 */
	tokens: Token[];
	/** Per-map zoom range, editable in the toolbar. Clamped to [ABS_MIN_ZOOM, ABS_MAX_ZOOM]. */
	minZoom: number;
	maxZoom: number;
	/** Fog of war, active in view mode only. */
	fogEnabled: boolean;
	/**
	 * "Brouillard figé" ("frozen fog", toolbar fog dropdown): while `true`, `MapController.markExplored`
	 * is a no-op — a player's own vision still lights up their immediate surroundings live exactly as
	 * always (`MapCanvas`'s `frameVisionCache` punch-through doesn't read this at all), but none of it
	 * gets written into `exploredCells` any more, so ground they've already walked back out of goes
	 * dark again instead of staying revealed. Independent of `fogEnabled` itself (freezing while fog
	 * is off does nothing observable) and of `Token.lightRadius` (which already never touched
	 * `exploredCells` either way). Defaults to `false`.
	 */
	fogFrozen: boolean;
	/**
	 * "Ever explored" fog memory, as coarse world-space bucket keys ("bx,by") — not grid cells.
	 * Fog is traced by ray/path tracing rather than tested per grid cell (see MapCanvas), and this
	 * memory grid is deliberately coarser than the visible grid and independent of grid type/shape.
	 */
	exploredCells: string[];
}

export interface MapDefaults {
	gridType: GridType;
	cellSize: number;
	minZoom: number;
	maxZoom: number;
}

export function isCellEmpty(cell: CellData | undefined): boolean {
	if (!cell) return true;
	return !cell.zoneTypeId && !cell.stamp && !cell.label && (!cell.links || cell.links.length === 0);
}

function emptyCellsByGridType(): CellsByGridType {
	return { square: {}, "hex-pointy": {}, "hex-flat": {} };
}

let idCounter = 0;
export function generateLocalId(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function createLayer(name: string): Layer {
	return {
		id: generateLocalId("layer"),
		name,
		visible: true,
		cellsByGridType: emptyCellsByGridType(),
		markers: [],
		wallPoints: [],
		wallSegments: [],
	};
}

function clampZoomSetting(value: number): number {
	return Math.min(ABS_MAX_ZOOM, Math.max(ABS_MIN_ZOOM, value));
}

export function createDefaultMapData(defaults: MapDefaults): MapFileData {
	const layer = createLayer("Calque 1");
	return {
		version: 14,
		gridType: defaults.gridType,
		cellSize: defaults.cellSize,
		layers: [layer],
		activeLayerId: layer.id,
		tokens: [],
		minZoom: clampZoomSetting(defaults.minZoom),
		maxZoom: clampZoomSetting(defaults.maxZoom),
		fogEnabled: false,
		fogFrozen: false,
		exploredCells: [],
	};
}

export function getActiveLayer(data: MapFileData): Layer {
	return data.layers.find((l) => l.id === data.activeLayerId) ?? data.layers[0] ?? createLayer("Calque 1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function parseCellsByGridType(raw: unknown): CellsByGridType {
	const cellsByGridType = emptyCellsByGridType();
	const rawCellsByGridType = isRecord(raw) ? raw : {};
	for (const gt of CELLED_GRID_TYPES) {
		const src = rawCellsByGridType[gt];
		if (isRecord(src)) {
			for (const key of Object.keys(src)) {
				const c = src[key];
				if (isRecord(c)) {
					const cell: CellData = {
						zoneTypeId: isString(c.zoneTypeId) ? c.zoneTypeId : undefined,
						stamp: isString(c.stamp) ? c.stamp : undefined,
						label: isString(c.label) ? c.label : undefined,
						links: Array.isArray(c.links) ? c.links.filter(isString) : undefined,
					};
					if (!isCellEmpty(cell)) cellsByGridType[gt][key] = cell;
				}
			}
		}
	}
	return cellsByGridType;
}

function isVisionBlockerType(value: unknown): value is VisionBlockerType {
	return value === "opaque" || value === "dim";
}

function parseWallPoint(value: unknown): WallPoint | null {
	if (!isRecord(value) || !isString(value.id) || typeof value.x !== "number" || typeof value.y !== "number") return null;
	return { id: value.id, x: value.x, y: value.y };
}

function parseWallPointArray(raw: unknown): WallPoint[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(parseWallPoint).filter((p): p is WallPoint => p !== null);
}

function parseWallSegment(value: unknown): WallSegment | null {
	if (!isRecord(value) || !isString(value.id) || !isString(value.aId) || !isString(value.bId) || !isVisionBlockerType(value.blockerType)) return null;
	return { id: value.id, aId: value.aId, bId: value.bId, blockerType: value.blockerType };
}

/** Drops segments referencing a point that doesn't exist among `points` (e.g. hand-edited/corrupted files). */
function parseWallSegmentArray(raw: unknown, points: WallPoint[]): WallSegment[] {
	if (!Array.isArray(raw)) return [];
	const pointIds = new Set(points.map((p) => p.id));
	return raw
		.map(parseWallSegment)
		.filter((s): s is WallSegment => s !== null)
		.filter((s) => pointIds.has(s.aId) && pointIds.has(s.bId));
}

function isTokenCategory(value: unknown): value is TokenCategory {
	return value === "player" || value === "entity" || value === "light";
}

function parseTokenTab(value: unknown): TokenTab | null {
	if (!isRecord(value) || !isString(value.id) || !isString(value.name)) return null;
	return { id: value.id, name: value.name, link: isString(value.link) ? value.link : undefined };
}

function parseTokenTabArray(raw: unknown): TokenTab[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	return raw.map(parseTokenTab).filter((t): t is TokenTab => t !== null);
}

function parseToken(value: unknown): Token | null {
	if (!isRecord(value) || !isString(value.id) || !isString(value.icon)) return null;
	return {
		id: value.id,
		cellKey: isString(value.cellKey) ? value.cellKey : undefined,
		x: typeof value.x === "number" ? value.x : undefined,
		y: typeof value.y === "number" ? value.y : undefined,
		icon: value.icon,
		label: isString(value.label) ? value.label : undefined,
		link: isString(value.link) ? value.link : undefined,
		templateId: isString(value.templateId) ? value.templateId : undefined,
		tabs: parseTokenTabArray(value.tabs),
		size: typeof value.size === "number" && value.size > 0 ? value.size : undefined,
		color: isString(value.color) ? value.color : undefined,
		category: isTokenCategory(value.category) ? value.category : undefined,
		visionAngle: typeof value.visionAngle === "number" ? value.visionAngle : undefined,
		visionRange: typeof value.visionRange === "number" ? value.visionRange : undefined,
		visionRadius: typeof value.visionRadius === "number" && value.visionRadius >= 0 ? value.visionRadius : undefined,
		lightRadius: typeof value.lightRadius === "number" && value.lightRadius >= 0 ? value.lightRadius : undefined,
		lightEnabled: typeof value.lightEnabled === "boolean" ? value.lightEnabled : undefined,
		lightRadiusLinkedToVision: typeof value.lightRadiusLinkedToVision === "boolean" ? value.lightRadiusLinkedToVision : undefined,
		sideEyeAngle: typeof value.sideEyeAngle === "number" ? value.sideEyeAngle : undefined,
		detectionAngle: typeof value.detectionAngle === "number" ? value.detectionAngle : undefined,
		binocularAngle: typeof value.binocularAngle === "number" ? value.binocularAngle : undefined,
		monocularAngle: typeof value.monocularAngle === "number" ? value.monocularAngle : undefined,
		image: isString(value.image) ? value.image : undefined,
		// Pre-v14 files kept the vision cone's facing separate from the token's own rotation
		// (`visionDirection`); `rotation` takes over both, so a legacy file with no `rotation` yet
		// but a `visionDirection` inherits it, keeping the cone pointing exactly where it did before.
		rotation: typeof value.rotation === "number" ? value.rotation : typeof value.visionDirection === "number" ? value.visionDirection : undefined,
	};
}

function parseTokenArray(raw: unknown): Token[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(parseToken).filter((t): t is Token => t !== null);
}

function parseMarker(value: unknown): Marker | null {
	if (!isRecord(value) || !isString(value.id) || typeof value.x !== "number" || typeof value.y !== "number") return null;
	return {
		id: value.id,
		x: value.x,
		y: value.y,
		stamp: isString(value.stamp) ? value.stamp : undefined,
		label: isString(value.label) ? value.label : undefined,
		links: Array.isArray(value.links) ? value.links.filter(isString) : undefined,
	};
}

function parseMarkerArray(raw: unknown): Marker[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(parseMarker).filter((m): m is Marker => m !== null);
}

function isMarkerEmpty(marker: Marker): boolean {
	return !marker.stamp && !marker.label && (!marker.links || marker.links.length === 0);
}

function purgeEmptyMarkers(markers: Marker[]): Marker[] {
	return markers.filter((m) => !isMarkerEmpty(m));
}

/** v4 (per-layer) and v5 (map-level) both stored tokens as one array per grid type. */
function flattenLegacyTokensByGridType(raw: unknown): Token[] {
	if (!isRecord(raw)) return [];
	const out: Token[] = [];
	for (const gt of GRID_TYPES) out.push(...parseTokenArray(raw[gt]));
	return out;
}

/**
 * `convertFromPixels` handles map files saved before v3, where background offsets were
 * stored in raw pixels instead of grid cells.
 */
function parseBackground(raw: unknown, cellSize: number, convertFromPixels: boolean): MapBackground | undefined {
	if (!isRecord(raw) || !isString(raw.path)) return undefined;
	const rawOffsetX = typeof raw.offsetX === "number" ? raw.offsetX : 0;
	const rawOffsetY = typeof raw.offsetY === "number" ? raw.offsetY : 0;
	return {
		path: raw.path,
		offsetX: convertFromPixels ? rawOffsetX / cellSize : rawOffsetX,
		offsetY: convertFromPixels ? rawOffsetY / cellSize : rawOffsetY,
		scale: typeof raw.scale === "number" && raw.scale > 0 ? raw.scale : 1,
	};
}

function parseLayer(value: unknown, fallbackName: string, cellSize: number, convertFromPixels: boolean): Layer | null {
	if (!isRecord(value)) return null;
	const wallPoints = parseWallPointArray(value.wallPoints);
	return {
		id: isString(value.id) ? value.id : generateLocalId("layer"),
		name: isString(value.name) ? value.name : fallbackName,
		visible: typeof value.visible === "boolean" ? value.visible : true,
		background: parseBackground(value.background, cellSize, convertFromPixels),
		cellsByGridType: parseCellsByGridType(value.cellsByGridType),
		markers: parseMarkerArray(value.markers),
		wallPoints,
		wallSegments: parseWallSegmentArray(value.wallSegments, wallPoints),
	};
}

export function parseMapData(raw: string, defaults: MapDefaults): MapFileData {
	if (!raw || !raw.trim()) {
		return createDefaultMapData(defaults);
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return normalizeMapData(parsed, defaults);
	} catch {
		return createDefaultMapData(defaults);
	}
}

function normalizeMapData(parsed: unknown, defaults: MapDefaults): MapFileData {
	const p = isRecord(parsed) ? parsed : {};

	const gridType: GridType = isString(p.gridType) && (GRID_TYPES as string[]).includes(p.gridType) ? (p.gridType as GridType) : defaults.gridType;
	const cellSize = typeof p.cellSize === "number" && p.cellSize > 0 ? p.cellSize : defaults.cellSize;

	const version = typeof p.version === "number" ? p.version : 0;
	// Files saved before v3 stored background offsets in pixels; convert them to grid cells.
	const convertFromPixels = version < 3;

	let layers: Layer[];
	let tokens: Token[] = [];
	if (Array.isArray(p.layers) && p.layers.length > 0) {
		layers = p.layers.map((l, i) => parseLayer(l, `Calque ${i + 1}`, cellSize, convertFromPixels)).filter((l): l is Layer => l !== null);
		if (version < 5) {
			// Tokens used to live per-layer, split by grid type; merge them all into one flat list.
			for (const rawLayer of p.layers) {
				if (isRecord(rawLayer)) tokens.push(...flattenLegacyTokensByGridType(rawLayer.tokensByGridType));
			}
		}
	} else if (p.cellsByGridType || p.background) {
		// Legacy (pre-layers) map file: fold the single flat layer into "Calque 1".
		const legacyLayer: Layer = {
			id: generateLocalId("layer"),
			name: "Calque 1",
			visible: true,
			background: parseBackground(p.background, cellSize, true),
			cellsByGridType: parseCellsByGridType(p.cellsByGridType),
			markers: [],
			wallPoints: [],
			wallSegments: [],
		};
		layers = [legacyLayer];
	} else {
		layers = [];
	}
	if (layers.length === 0) layers = [createLayer("Calque 1")];

	if (version === 5) {
		// Tokens lived at the map level but were still split by grid type; flatten them.
		tokens = flattenLegacyTokensByGridType(p.tokensByGridType);
	} else if (version >= 6) {
		tokens = parseTokenArray(p.tokens);
	}

	const activeLayerId = isString(p.activeLayerId) && layers.some((l) => l.id === p.activeLayerId) ? p.activeLayerId : (layers[0]?.id ?? "");

	const minZoom = clampZoomSetting(typeof p.minZoom === "number" ? p.minZoom : defaults.minZoom);
	const maxZoom = clampZoomSetting(typeof p.maxZoom === "number" ? p.maxZoom : defaults.maxZoom);

	const fogEnabled = typeof p.fogEnabled === "boolean" ? p.fogEnabled : false;
	const fogFrozen = typeof p.fogFrozen === "boolean" ? p.fogFrozen : false;
	// Pre-v11 files stored `exploredCells` as grid-cell keys (grid tracing); v11 switched to coarse
	// world-space bucket keys (ray tracing), a different coordinate system, so old memory is dropped
	// rather than misinterpreted — it simply gets re-explored as players move around.
	const exploredCells = version >= 11 && Array.isArray(p.exploredCells) ? p.exploredCells.filter(isString) : [];

	return { version: 14, gridType, cellSize, layers, activeLayerId, tokens, minZoom, maxZoom, fogEnabled, fogFrozen, exploredCells };
}

function purgeEmptyCells(cells: Record<string, CellData>): Record<string, CellData> {
	const out: Record<string, CellData> = {};
	for (const key of Object.keys(cells)) {
		const cell = cells[key];
		if (cell && !isCellEmpty(cell)) out[key] = cell;
	}
	return out;
}

/** Defense in depth: the controller should never produce a segment referencing a missing point. */
function purgeOrphanWallSegments(points: WallPoint[], segments: WallSegment[]): WallSegment[] {
	const pointIds = new Set(points.map((p) => p.id));
	return segments.filter((s) => pointIds.has(s.aId) && pointIds.has(s.bId));
}

export function serializeMapData(data: MapFileData): string {
	const cleaned: MapFileData = {
		...data,
		layers: data.layers.map((layer) => ({
			...layer,
			cellsByGridType: {
				square: purgeEmptyCells(layer.cellsByGridType.square),
				"hex-pointy": purgeEmptyCells(layer.cellsByGridType["hex-pointy"]),
				"hex-flat": purgeEmptyCells(layer.cellsByGridType["hex-flat"]),
			},
			markers: purgeEmptyMarkers(layer.markers),
			wallSegments: purgeOrphanWallSegments(layer.wallPoints, layer.wallSegments),
		})),
	};
	return JSON.stringify(cleaned, null, "\t");
}

export function squareKey(col: number, row: number): string {
	return `${col},${row}`;
}

export function hexKey(q: number, r: number): string {
	return `${q},${r}`;
}

export function parseCellKey(key: string): { a: number; b: number } {
	const [a, b] = key.split(",").map(Number);
	return { a: a ?? 0, b: b ?? 0 };
}

export const GRID_TYPE_LABELS: Record<GridType, string> = {
	square: "Carrée",
	"hex-pointy": "Hexagone (pointe en bas)",
	"hex-flat": "Hexagone (face en bas)",
	none: "Pas de grille",
};

/** Pre-rendered, link-stripped HTML for a linked note (or note section) — safe to inject directly, client-side. */
export interface PublicNoteContent {
	html: string;
}

export interface PublicTokenStat {
	field: string;
	value: string;
}

/**
 * The shape of a `<map>.json` file (see `publishPublicSnapshot`) for a read-only, external
 * (non-Obsidian) viewer — see `buildPublicSnapshot` (redaction) and `renderNoteSnapshot` (note
 * content baking). `map` has everything hidden by fog already stripped out, and
 * `notes`/`tokenStats`/`zoneTypes` carry pre-resolved content so the viewer never needs vault or
 * plugin-settings access. `zoneTypes` is a frozen-at-publish-time copy of `settings.defaultZoneTypes`
 * (zone types are no longer part of `MapFileData` itself — see CLAUDE.md's "Settings" section).
 * `tokenTemplates` needs no equivalent field: `tokenStats` already carries pre-resolved field/value
 * pairs per token, so the public viewer never needs to look a template up.
 */
export interface PublicMapSnapshot {
	map: MapFileData;
	notes: Record<string, PublicNoteContent>;
	tokenStats: Record<string, PublicTokenStat[]>;
	zoneTypes: ZoneType[];
}

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
}

export type TokenCategory = "player" | "entity";

export interface Token {
	id: string;
	/** Anchor cell (celled grid types only). For square grids with size > 1, this is the top-left cell of the footprint. */
	cellKey?: string;
	/** Free world position (grid type "none" only), in the same pixel space as everything else on the canvas. */
	x?: number;
	y?: number;
	icon: string;
	label?: string;
	link?: string;
	templateId?: string;
	/** How many cells wide/tall the token occupies (square grids only; 1 = a single cell). Defaults to 1. */
	size?: number;
	/** Border color (hex string). Defaults to a neutral dark gray when unset. */
	color?: string;
	/**
	 * Fog of war category. Players always render and light up the fog with their vision cone;
	 * entities only render when inside a player's current vision cone. Defaults to "entity".
	 */
	category?: TokenCategory;
	/** Vision cone full angle in degrees (player tokens only). */
	visionAngle?: number;
	/** Vision range in cells (player tokens only). */
	visionRange?: number;
	/** Facing direction in degrees, 0 = east, increasing clockwise (player tokens only). */
	visionDirection?: number;
	/** Omnidirectional "always lit" radius around the player, in cells, regardless of facing (player tokens only). */
	visionRadius?: number;
	/** Vault path to a custom image shown instead of `icon` once loaded. */
	image?: string;
}

export const DEFAULT_TOKEN_COLOR = "#1e1e1e";

export const TOKEN_SIZES = [1, 2, 3];

export const DEFAULT_VISION_ANGLE = 90;
export const DEFAULT_VISION_RANGE = 6;
export const DEFAULT_VISION_DIRECTION = 0;
export const DEFAULT_VISION_RADIUS = 1;

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
	version: 13;
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
		version: 13,
		gridType: defaults.gridType,
		cellSize: defaults.cellSize,
		layers: [layer],
		activeLayerId: layer.id,
		tokens: [],
		minZoom: clampZoomSetting(defaults.minZoom),
		maxZoom: clampZoomSetting(defaults.maxZoom),
		fogEnabled: false,
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
	return value === "player" || value === "entity";
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
		size: typeof value.size === "number" && value.size > 0 ? value.size : undefined,
		color: isString(value.color) ? value.color : undefined,
		category: isTokenCategory(value.category) ? value.category : undefined,
		visionAngle: typeof value.visionAngle === "number" ? value.visionAngle : undefined,
		visionRange: typeof value.visionRange === "number" ? value.visionRange : undefined,
		visionDirection: typeof value.visionDirection === "number" ? value.visionDirection : undefined,
		visionRadius: typeof value.visionRadius === "number" && value.visionRadius >= 0 ? value.visionRadius : undefined,
		image: isString(value.image) ? value.image : undefined,
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
	// Pre-v11 files stored `exploredCells` as grid-cell keys (grid tracing); v11 switched to coarse
	// world-space bucket keys (ray tracing), a different coordinate system, so old memory is dropped
	// rather than misinterpreted — it simply gets re-explored as players move around.
	const exploredCells = version >= 11 && Array.isArray(p.exploredCells) ? p.exploredCells.filter(isString) : [];

	return { version: 13, gridType, cellSize, layers, activeLayerId, tokens, minZoom, maxZoom, fogEnabled, exploredCells };
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

import { DEFAULT_MAX_ZOOM, DEFAULT_MIN_ZOOM } from "../grid/gridMath";
import { GridType, TokenTemplate, ZoneType } from "../data/mapData";

/**
 * `"none"` — static fog, no redraw loop.
 * `"simple"` — the previous boolean `fogAnimations: true` behavior: the whole explored/unexplored
 * frontier trembles together as one shared shift, plus each player's vision-fan edge wobbles.
 * `"advanced"` — the frontier trembles per-tile instead of as one shared shift, so different patches
 * of fog drift independently ("chaque zone bouge individuellement") instead of the whole boundary
 * moving in lockstep — see `organicJitter2D` in `MapCanvas.ts`.
 */
export type FogAnimationMode = "none" | "simple" | "advanced";

export interface MapManagerSettings {
	defaultGridType: GridType;
	defaultCellSize: number;
	defaultZoneTypes: ZoneType[];
	defaultTokenTemplates: TokenTemplate[];
	assetsFolder: string;
	embedHeight: number;
	/** Info panel width in pixels, dragged via its resize handle (see InfoPanel) — shared globally across every open map. */
	infoPanelWidth: number;
	defaultMinZoom: number;
	defaultMaxZoom: number;
	/** Subtle animated flicker on the fog of war's vision edge ("none" by default — a continuous redraw loop while active). */
	fogAnimationMode: FogAnimationMode;
	/** Seconds of inactivity after a map edit before `<map>.json` (see `publishPublicSnapshot`) is regenerated automatically — see `wireAutoPublish`. `0` disables auto-publishing entirely. */
	autoPublishDelaySeconds: number;
	/** Degree increment for a token's rotation dial (see `InfoPanel.makeRotationDialField`) — both its jog-dial slider and its paired number input step by this amount. */
	tokenRotationStep: number;
}

export const DEFAULT_ZONE_TYPES: ZoneType[] = [
	{ id: "plain", name: "Plaine", color: "#8bc34a" },
	{ id: "forest", name: "Forêt", color: "#2e7d32" },
	{ id: "water", name: "Eau", color: "#1976d2" },
	{ id: "mountain", name: "Montagne", color: "#757575" },
	{ id: "desert", name: "Désert", color: "#d4a017" },
	{ id: "town", name: "Ville", color: "#ff9800" },
	{ id: "danger", name: "Danger", color: "#c62828" },
];

export const DEFAULT_TOKEN_TEMPLATES: TokenTemplate[] = [
	{ id: "character", name: "Personnage", fields: ["vie", "magie", "force"] },
	{ id: "monster", name: "Monstre", fields: ["vie", "degats", "defense"] },
];

export const DEFAULT_SETTINGS: MapManagerSettings = {
	defaultGridType: "square",
	defaultCellSize: 48,
	defaultZoneTypes: DEFAULT_ZONE_TYPES.map((z) => ({ ...z })),
	defaultTokenTemplates: DEFAULT_TOKEN_TEMPLATES.map((t) => ({ ...t, fields: [...t.fields] })),
	assetsFolder: "Map Assets",
	embedHeight: 500,
	infoPanelWidth: 280,
	defaultMinZoom: DEFAULT_MIN_ZOOM,
	defaultMaxZoom: DEFAULT_MAX_ZOOM,
	fogAnimationMode: "none",
	autoPublishDelaySeconds: 10,
	tokenRotationStep: 10,
};

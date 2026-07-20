import { DEFAULT_MAX_ZOOM, DEFAULT_MIN_ZOOM } from "../grid/gridMath";
import { GridType, TokenTemplate, ZoneType } from "../data/mapData";

export interface MapManagerSettings {
	defaultGridType: GridType;
	defaultCellSize: number;
	defaultZoneTypes: ZoneType[];
	defaultTokenTemplates: TokenTemplate[];
	assetsFolder: string;
	embedHeight: number;
	defaultMinZoom: number;
	defaultMaxZoom: number;
	/** Subtle animated flicker on the fog of war's vision edge (off by default — a continuous redraw loop while active). */
	fogAnimations: boolean;
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
	defaultMinZoom: DEFAULT_MIN_ZOOM,
	defaultMaxZoom: DEFAULT_MAX_ZOOM,
	fogAnimations: false,
};

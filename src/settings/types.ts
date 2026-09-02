import { DEFAULT_MAX_ZOOM, DEFAULT_MIN_ZOOM } from "../grid/gridMath";
import { GridType, TokenTemplate, ZoneType } from "../data/mapData";

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
	/**
	 * "Adoucir le brouillard" — when on (the default), the celled-grid fog (`FogRenderer.renderCellFog`)
	 * draws a light animated fade on the explored side of every explored/fog cell border (fog cells stay
	 * fully black), and grid type "none" keeps its legacy edge tremble; a continuous redraw loop runs
	 * while a map with fog is open. When off, fog is crisp and fully static (no redraw loop). Replaces
	 * the old 3-way `fogAnimationMode`.
	 */
	fogSoftening: boolean;
	/** Debug overlay: strokes each player token's line-of-sight polygon, the rays to its vertices, and its light-radius circle over the celled-grid fog (view mode). Off by default. */
	fogDebugVisionRays: boolean;
	/** Seconds of inactivity after a map edit before `<map>.json` (see `publishPublicSnapshot`) is regenerated automatically — see `wireAutoPublish`. `0` disables auto-publishing entirely. */
	autoPublishDelaySeconds: number;
	/** Degree increment for a token's rotation dial (see `InfoPanel.makeRotationDialField`) — both its jog-dial slider and its paired number input step by this amount. */
	tokenRotationStep: number;
	/** Side length (px) a vault image is downscaled/cropped to when picked as a pion "logo" — see `resizeImageToSquare`/`InfoPanel.pickVaultTokenImage`. */
	tokenImageSize: number;
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

/**
 * Reserved id for the one template every "player" category token is locked to (see
 * `InfoPanel.renderTokenPanel`'s "Modèle de statistiques" field) — modifiable like any other
 * template (name/fields/default tabs) from Settings, but never removable from there (see
 * `SettingsTab`), since a player token always needs to resolve to *some* template.
 */
export const PLAYER_TEMPLATE_ID = "player";

export const DEFAULT_TOKEN_TEMPLATES: TokenTemplate[] = [
	{ id: PLAYER_TEMPLATE_ID, name: "Joueur", fields: ["vie", "classe", "niveau"], reserved: true },
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
	fogSoftening: true,
	fogDebugVisionRays: false,
	autoPublishDelaySeconds: 10,
	tokenRotationStep: 10,
	tokenImageSize: 256,
};

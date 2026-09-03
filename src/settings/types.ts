import { DEFAULT_MAX_ZOOM, DEFAULT_MIN_ZOOM } from "../grid/gridMath";
import { GridType, TokenTemplate, ZoneType } from "../data/mapData";
import { DEFAULT_GAMEPAD_ACTIONS, GamepadAction, cloneGamepadActions } from "../data/gamepadActions";

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
	 * "Adoucir le brouillard" — intensity of the fog/explored transition fade, a 0-10 slider. `0`
	 * disables it: fog is crisp and fully static (no redraw loop). `1-10` has the celled-grid fog
	 * (`FogRenderer.renderCellFog`) draw a light animated fade on the explored side of every
	 * explored/fog cell border (fog cells stay fully black), and grid type "none" keep its legacy edge
	 * tremble, with a continuous redraw loop while a map with fog is open; the higher the level, the
	 * deeper and darker the band — `10` takes the explored side of a border almost to full black over
	 * more than a cell width (see `fogSofteningParams`). Replaces the old 3-way `fogAnimationMode`, then
	 * the on/off boolean.
	 */
	fogSoftening: number;
	/** Debug overlay: strokes each player token's line-of-sight polygon, the rays to its vertices, and its light-radius circle over the celled-grid fog (view mode). Off by default. */
	fogDebugVisionRays: boolean;
	/** Seconds of inactivity after a map edit before `<map>.json` (see `publishPublicSnapshot`) is regenerated automatically — see `wireAutoPublish`. `0` disables auto-publishing entirely. */
	autoPublishDelaySeconds: number;
	/** Degree increment for a token's rotation dial (see `InfoPanel.makeRotationDialField`) — both its jog-dial slider and its paired number input step by this amount. */
	tokenRotationStep: number;
	/** Side length (px) a vault image is downscaled/cropped to when picked as a pion "logo" — see `resizeImageToSquare`/`InfoPanel.pickVaultTokenImage`. */
	tokenImageSize: number;
	/**
	 * "Actions manette" — the entries a player can pick from the Triangle/Y popup menu in view mode
	 * (see `GamepadAction` and `MapCanvas.handleGamepadActionButton`). Shared globally like
	 * `defaultZoneTypes` (not per-map). Empty by default.
	 */
	gamepadActions: GamepadAction[];
	/** Points of `Token.lightLife` drained from the acting player token per cursor move inside the gamepad action menu. Default 1. */
	actionMenuNavCost: number;
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
	fogSoftening: 3,
	fogDebugVisionRays: false,
	autoPublishDelaySeconds: 10,
	tokenRotationStep: 10,
	tokenImageSize: 256,
	gamepadActions: cloneGamepadActions(DEFAULT_GAMEPAD_ACTIONS),
	actionMenuNavCost: 1,
};

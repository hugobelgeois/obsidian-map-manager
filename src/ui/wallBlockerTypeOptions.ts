import { VisionBlockerType } from "../data/mapData";

/**
 * Shared value/label list for every "type de mur" `<select>` in the UI (Toolbar's wall tool, and
 * InfoPanel's single wall-point/wall-segment/mass-selection editors) — one place so the four dropdowns
 * can't drift out of sync with each other or with `VisionBlockerType`'s own doc comment.
 */
export const WALL_BLOCKER_TYPE_OPTIONS: { value: VisionBlockerType; label: string }[] = [
	{ value: "opaque", label: "Opaque (cache tout au-delà, infranchissable)" },
	{ value: "see-through", label: "Transparent (on voit au-delà, mais infranchissable)" },
	{ value: "pass-through", label: "Passage (pas de vue au-delà, franchissable en interagissant)" },
	{ value: "pass-see-through", label: "Passage vitré (on voit au-delà, franchissable en interagissant)" },
];

/** Type guard for a `<select>`'s raw `.value` string against `WALL_BLOCKER_TYPE_OPTIONS`. */
export function isWallBlockerTypeValue(value: string): value is VisionBlockerType {
	return WALL_BLOCKER_TYPE_OPTIONS.some((o) => o.value === value);
}

import { VisionBlockerType } from "./mapData";

/**
 * Gamepad "action menu" — the popup a player opens with Triangle/Y in view mode (see
 * `MapCanvas.handleGamepadActionButton` / `GamepadInputPoller`). Each `GamepadAction` is a
 * user-configured entry (Settings → "Actions manette", stored on `MapManagerSettings.gamepadActions`,
 * shared globally like `defaultZoneTypes` — not per-map, no `MapFileData` migration): a name, a
 * *contact condition* deciding when it's offered, an *effect* run on confirm, and a light-life cost.
 *
 * Resolution (`MapCanvas.resolveAvailableActions`): a single action can produce several concrete
 * menu entries — a `wall` contact yields one entry per matching wall segment touching the player's
 * cell, each labelled with its direction; a `token` contact yields one entry per matching token on
 * the player's cell or an adjacent one.
 *
 * This file is pure (no `obsidian` import) so it can sit anywhere in the import graph.
 */

/** When a `GamepadAction` is offered. `wall`/`token` are contact-based; `none` is always available. */
export type GamepadActionContact =
	| { kind: "none" }
	/**
	 * Offered while a *franchissable* wall segment (`pass-through`/`pass-see-through` — a door/curtain,
	 * the only walls a gamepad action ever acts on) separates the player's cell from a neighbour.
	 */
	| { kind: "wall" }
	/** Offered while a token of `category` sits on the player's cell or an adjacent one ("entity" covers "token ennemi"). */
	| { kind: "token"; category: "light" | "player" | "entity" };

/** What a `GamepadAction` does on confirm. `pass-through`/`change-wall-type` only make sense with a `wall` contact. */
export type GamepadActionEffect =
	/** Step the player token across the contacted wall (like the old interact-to-pass), rolling its clock trigger. */
	| { kind: "pass-through" }
	/** Rewrite the contacted wall segment's `blockerType` to `to`, rolling its clock trigger. */
	| { kind: "change-wall-type"; to: VisionBlockerType }
	/** Toggle the acting player's light (or a co-located "light" fixture): `lightLife` 100 ⇄ 0. */
	| { kind: "toggle-light" }
	/** Open a read-only sidebar rendering the vault note (or heading) at `link` (`path` or `path#heading` — see `MapCanvas.syncActionNoteOverlay`). */
	| { kind: "open-note"; link: string };

export interface GamepadAction {
	id: string;
	name: string;
	contact: GamepadActionContact;
	effect: GamepadActionEffect;
	/** Percent of `Token.lightLife` removed from the acting player token when this action runs (0..100). */
	lightCost: number;
}

/** New maps/installs start with no gamepad actions configured. */
export const DEFAULT_GAMEPAD_ACTIONS: GamepadAction[] = [];

/** Deep-copies the action list (for `DEFAULT_SETTINGS` and settings hydration). */
export function cloneGamepadActions(actions: GamepadAction[]): GamepadAction[] {
	return actions.map((a) => ({ ...a, contact: { ...a.contact }, effect: { ...a.effect } }));
}

/**
 * French compass label for a world-space direction angle (same atan2/y-down convention as
 * `GamepadInputPoller`), snapped to the 4 square-grid directions or the 6 hex-grid ones per
 * `hex`. Used to label a per-wall menu entry ("Ouvrir la porte (gauche)").
 */
export function directionLabelFr(angleDeg: number, hex: boolean): string {
	const a = ((angleDeg % 360) + 360) % 360;
	if (hex) {
		const sectors: { at: number; label: string }[] = [
			{ at: 270, label: "haut" },
			{ at: 330, label: "haut-droite" },
			{ at: 30, label: "bas-droite" },
			{ at: 90, label: "bas" },
			{ at: 150, label: "bas-gauche" },
			{ at: 210, label: "haut-gauche" },
		];
		let best = sectors[0]!;
		let bestDiff = Infinity;
		for (const s of sectors) {
			const diff = Math.min(Math.abs(a - s.at), 360 - Math.abs(a - s.at));
			if (diff < bestDiff) {
				bestDiff = diff;
				best = s;
			}
		}
		return best.label;
	}
	if (a >= 315 || a < 45) return "droite";
	if (a < 135) return "bas";
	if (a < 225) return "gauche";
	return "haut";
}

/**
 * Gamepad support for controlling player tokens live (view mode only — see `MapCanvas`'s
 * `GamepadInputPoller` wiring and `MapController.gamepadAssignments`). Pure browser Gamepad API
 * wrapper, no Obsidian dependency (this file is part of the portable public-viewer bundle's import
 * surface — see `eslint.config.mts` — even though the public viewer itself never actually uses it).
 */

/** One currently-connected gamepad, for the assignment dropdown (see `InfoPanel`'s "Manette" field). */
export interface GamepadInfo {
	index: number;
	id: string;
}

/**
 * Every gamepad the browser currently reports as connected. Per the Gamepad API, a gamepad only
 * starts appearing here once at least one of its buttons/axes has been touched at least once since
 * the page loaded — nothing this plugin can do about that, it's a browser privacy quirk, not a bug.
 */
export function listConnectedGamepads(): GamepadInfo[] {
	if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
	const result: GamepadInfo[] = [];
	for (const pad of navigator.getGamepads()) {
		if (pad) result.push({ index: pad.index, id: pad.id });
	}
	return result;
}

/** Below this magnitude (0..1), a stick reads as centered/neutral rather than a held direction. */
const STICK_DEADZONE = 0.35;

/** D-pad button indices (standard Gamepad API mapping) and the world-space angle each points at — same atan2/y-down convention as `MapCanvas`'s neighbor-angle math, so the two line up directly. */
const DPAD_BUTTONS: { index: number; angleDeg: number }[] = [
	{ index: 12, angleDeg: 270 }, // up
	{ index: 15, angleDeg: 0 }, // right
	{ index: 13, angleDeg: 90 }, // down
	{ index: 14, angleDeg: 180 }, // left
];

/**
 * "Triangle"/"Y" — the standard Gamepad API mapping's button index 3 (top face button, whichever
 * label the physical pad uses for it) — the action-menu button: every press fires `onAction`, which
 * opens (or, with a single available entry, directly runs) the gamepad action menu — see
 * `MapCanvas.handleGamepadActionButton` / `GamepadAction`.
 */
const INTERACT_BUTTON_INDEX = 3;
/** "Croix"/"A" — standard mapping index 0 — confirms the highlighted entry of an open action menu (`onConfirm`). */
const CONFIRM_BUTTON_INDEX = 0;
/** "Rond"/"B" — standard mapping index 1 — closes an open action menu without running anything (`onCancel`). */
const CANCEL_BUTTON_INDEX = 1;
/** How long L1 must be held before `onLightExtinguish` fires (life → 0), ms — long enough that a stray tap doesn't snuff a torch. */
const LIGHT_EXTINGUISH_HOLD_MS = 1500;
/** L1/LB — standard mapping index 4 — held for `LIGHT_EXTINGUISH_HOLD_MS` snuffs a player's light (`onLightExtinguish`). */
const L1_BUTTON_INDEX = 4;
/** R1/RB — standard mapping index 5 — each press refills a player's light life (`onLightRefill`). */
const R1_BUTTON_INDEX = 5;

/**
 * `pad`'s currently-held movement direction, combining the left stick (past `STICK_DEADZONE`) and the
 * d-pad — `null` when neither is pushed. D-pad buttons contribute unit vectors that are summed rather
 * than switched between, so a diagonal press (e.g. up+right together) still yields a usable in-between
 * angle, which matters for picking one of a hex grid's 6 neighbor directions rather than just a square
 * grid's 4.
 */
function readLeftStickDirection(pad: Gamepad): number | null {
	let dx = 0;
	let dy = 0;
	const stickX = pad.axes[0] ?? 0;
	const stickY = pad.axes[1] ?? 0;
	if (Math.hypot(stickX, stickY) >= STICK_DEADZONE) {
		dx += stickX;
		dy += stickY;
	}
	for (const { index, angleDeg } of DPAD_BUTTONS) {
		if (pad.buttons[index]?.pressed) {
			dx += Math.cos((angleDeg * Math.PI) / 180);
			dy += Math.sin((angleDeg * Math.PI) / 180);
		}
	}
	if (dx === 0 && dy === 0) return null;
	const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
	return angle < 0 ? angle + 360 : angle;
}

/** `pad`'s right stick angle (axes 2/3 — standard mapping), same atan2/y-down convention as `readLeftStickDirection`, or `null` while it sits within `STICK_DEADZONE` of center. */
function readRightStickDirection(pad: Gamepad): number | null {
	const stickX = pad.axes[2] ?? 0;
	const stickY = pad.axes[3] ?? 0;
	if (Math.hypot(stickX, stickY) < STICK_DEADZONE) return null;
	const angle = (Math.atan2(stickY, stickX) * 180) / Math.PI;
	return angle < 0 ? angle + 360 : angle;
}

/** How long a freshly-pushed direction waits before it starts auto-repeating, ms. */
const MOVE_REPEAT_DELAY_MS = 320;
/** Once repeating, how often a held direction fires another move, ms. */
const MOVE_REPEAT_INTERVAL_MS = 170;

interface GamepadPollState {
	/** Whether the last poll saw the left stick/d-pad pushed past the deadzone — a direction only ever fires on the poll it first becomes true (then again per the repeat timer), never continuously, so tapping the stick yields exactly one step. */
	moveActive: boolean;
	moveNextFireAt: number;
	/** Last-seen pressed state of the interact button, for edge-detecting `onAction`. */
	interactPressed: boolean;
	/** Last-seen pressed state of the confirm button (Croix/A), for edge-detecting `onConfirm`. */
	confirmPressed: boolean;
	/** Last-seen pressed state of the cancel button (Rond/B), for edge-detecting `onCancel`. */
	cancelPressed: boolean;
	/** When L1 most recently went from released to held (`performance.now()`), or `null` while it's up — the basis for `onLightExtinguish`'s `LIGHT_EXTINGUISH_HOLD_MS` long-press gate. */
	l1PressedAt: number | null;
	/** Whether `onLightExtinguish` has already fired for L1's current hold, so it fires exactly once per press-and-hold. */
	l1Fired: boolean;
	/** Last-seen pressed state of R1, for edge-detecting `onLightRefill`. */
	r1Pressed: boolean;
}

/** Every event `GamepadInputPoller` can report — see the class doc comment for how each fires. */
export interface GamepadCallbacks {
	/**
	 * A held left-stick/d-pad direction, edge-triggered (fires once the instant a direction is first
	 * pushed) with auto-repeat while held (`MOVE_REPEAT_DELAY_MS`/`MOVE_REPEAT_INTERVAL_MS`), the same
	 * one-tap-one-step-then-hold-to-keep-going feel as a keyboard's own key-repeat. Drives token
	 * movement normally, or the cursor of an open action menu — see `MapCanvas.handleGamepadMove`.
	 */
	onMove: (gamepadIndex: number, inputAngleDeg: number) => void;
	/**
	 * The action-menu button (triangle/Y) pressed, edge-triggered (fires once the instant it goes
	 * down, whatever else is held) — opens or directly runs the gamepad action menu.
	 */
	onAction: (gamepadIndex: number) => void;
	/** The confirm button (Croix/A) pressed, edge-triggered — runs the highlighted action-menu entry. */
	onConfirm: (gamepadIndex: number) => void;
	/** The cancel button (Rond/B) pressed, edge-triggered — closes an open action menu. */
	onCancel: (gamepadIndex: number) => void;
	/** R1 pressed, edge-triggered — refill the player's light life (see `MapCanvas.handleGamepadLightRefill`). */
	onLightRefill: (gamepadIndex: number) => void;
	/** L1 held continuously for `LIGHT_EXTINGUISH_HOLD_MS`, once per press-and-hold — snuff the player's light (life → 0). */
	onLightExtinguish: (gamepadIndex: number) => void;
	/**
	 * The right stick's current angle, reported on *every* poll tick — `null` every tick it sits
	 * within the deadzone of center, a real angle every tick it doesn't. Continuous rather than
	 * edge-triggered (unlike every other callback here) so a caller can drive a live "look" direction
	 * frame by frame and knows exactly which tick it first returned to center (the `null` right after a
	 * run of real angles) to commit/drop that live state — see `MapCanvas.handleGamepadAim`.
	 */
	onAim: (gamepadIndex: number, angleDeg: number | null) => void;
}

/**
 * Polls `navigator.getGamepads()` every animation frame and turns each connected gamepad's input into
 * the events described on `GamepadCallbacks`. Knows nothing about tokens, grids, or walls — every
 * callback (in `MapCanvas`) is the one place that turns a gamepad index + input into an actual token
 * action.
 */
export class GamepadInputPoller {
	private frameId: number | null = null;
	private state = new Map<number, GamepadPollState>();

	constructor(private callbacks: GamepadCallbacks) {}

	start(): void {
		if (this.frameId !== null) return;
		const tick = () => {
			this.poll();
			this.frameId = requestAnimationFrame(tick);
		};
		this.frameId = requestAnimationFrame(tick);
	}

	stop(): void {
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		this.frameId = null;
		this.state.clear();
	}

	private poll(): void {
		if (typeof navigator === "undefined" || !navigator.getGamepads) return;
		const now = performance.now();
		const seen = new Set<number>();
		for (const pad of navigator.getGamepads()) {
			if (!pad) continue;
			seen.add(pad.index);
			let entry = this.state.get(pad.index);
			if (!entry) {
				entry = { moveActive: false, moveNextFireAt: 0, interactPressed: false, confirmPressed: false, cancelPressed: false, l1PressedAt: null, l1Fired: false, r1Pressed: false };
				this.state.set(pad.index, entry);
			}

			const interactHeld = pad.buttons[INTERACT_BUTTON_INDEX]?.pressed ?? false;
			if (interactHeld && !entry.interactPressed) this.callbacks.onAction(pad.index);
			entry.interactPressed = interactHeld;

			const confirmHeld = pad.buttons[CONFIRM_BUTTON_INDEX]?.pressed ?? false;
			if (confirmHeld && !entry.confirmPressed) this.callbacks.onConfirm(pad.index);
			entry.confirmPressed = confirmHeld;

			const cancelHeld = pad.buttons[CANCEL_BUTTON_INDEX]?.pressed ?? false;
			if (cancelHeld && !entry.cancelPressed) this.callbacks.onCancel(pad.index);
			entry.cancelPressed = cancelHeld;

			const l1Held = pad.buttons[L1_BUTTON_INDEX]?.pressed ?? false;
			if (l1Held && entry.l1PressedAt === null) {
				entry.l1PressedAt = now;
				entry.l1Fired = false;
			}
			if (!l1Held) {
				entry.l1PressedAt = null;
				entry.l1Fired = false;
			} else if (!entry.l1Fired && entry.l1PressedAt !== null && now - entry.l1PressedAt >= LIGHT_EXTINGUISH_HOLD_MS) {
				this.callbacks.onLightExtinguish(pad.index);
				entry.l1Fired = true;
			}

			const r1Held = pad.buttons[R1_BUTTON_INDEX]?.pressed ?? false;
			if (r1Held && !entry.r1Pressed) this.callbacks.onLightRefill(pad.index);
			entry.r1Pressed = r1Held;

			this.callbacks.onAim(pad.index, readRightStickDirection(pad));

			const angle = readLeftStickDirection(pad);
			if (angle === null) {
				entry.moveActive = false;
				continue;
			}
			if (!entry.moveActive) {
				entry.moveActive = true;
				entry.moveNextFireAt = now + MOVE_REPEAT_DELAY_MS;
				this.callbacks.onMove(pad.index, angle);
			} else if (now >= entry.moveNextFireAt) {
				entry.moveNextFireAt = now + MOVE_REPEAT_INTERVAL_MS;
				this.callbacks.onMove(pad.index, angle);
			}
		}
		// Drop bookkeeping for gamepads that disconnected since the last poll, so a reconnect (possibly
		// under the same index) starts clean rather than resuming mid-repeat.
		for (const index of this.state.keys()) {
			if (!seen.has(index)) this.state.delete(index);
		}
	}
}

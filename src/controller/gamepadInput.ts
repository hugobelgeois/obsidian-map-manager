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
 * label the physical pad uses for it) — the interact button (see `MapCanvas.handleGamepadInteract`):
 * toggles a light on a long press (`INTERACT_HOLD_MS`), or forces a step through a `"pass-through"`
 * wall when held (any duration) alongside a direction.
 */
const INTERACT_BUTTON_INDEX = 3;
/** How long the interact button must be held before `onInteract` fires (toggling a light), ms — long enough that a quick tap (e.g. one that only meant to force a step through a `"pass-through"` wall) doesn't also toggle a light. */
const INTERACT_HOLD_MS = 1500;
/** L1/LB — standard mapping index 4 — dims a player token's light by one cell (see `MapCanvas.handleGamepadLightStep`). */
const L1_BUTTON_INDEX = 4;
/** R1/RB — standard mapping index 5 — brightens a player token's light by one cell (see `MapCanvas.handleGamepadLightStep`). */
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
	/** Last-seen pressed state of each edge-triggered button, for edge-detecting `onLightStep`. */
	interactPressed: boolean;
	/** When the interact button most recently went from released to held (`performance.now()`), or `null` while it's up — the basis for `onInteract`'s `INTERACT_HOLD_MS` long-press gate. */
	interactPressedAt: number | null;
	/** Whether `onInteract` has already fired for the interact button's current hold, so it fires exactly once per press-and-hold rather than on every poll past `INTERACT_HOLD_MS`. */
	interactFired: boolean;
	l1Pressed: boolean;
	r1Pressed: boolean;
}

/** Every event `GamepadInputPoller` can report — see the class doc comment for how each fires. */
export interface GamepadCallbacks {
	/**
	 * A held left-stick/d-pad direction, edge-triggered (fires once the instant a direction is first
	 * pushed) with auto-repeat while held (`MOVE_REPEAT_DELAY_MS`/`MOVE_REPEAT_INTERVAL_MS`), the same
	 * one-tap-one-step-then-hold-to-keep-going feel as a keyboard's own key-repeat. `interactHeld` is
	 * whether the interact button happens to be held down on this same poll — read fresh alongside the
	 * direction rather than tracked separately, so this always sees the two in sync.
	 */
	onMove: (gamepadIndex: number, inputAngleDeg: number, interactHeld: boolean) => void;
	/**
	 * The interact button held continuously for `INTERACT_HOLD_MS`, firing once per press-and-hold (not
	 * on release, and not again while still held past the threshold) — independent of whatever direction
	 * (if any) is also held. A quick tap (below the threshold) never fires this at all.
	 */
	onInteract: (gamepadIndex: number) => void;
	/** L1/R1's own press, edge-triggered — `delta` is `-1` for L1 ("dim"), `1` for R1 ("brighten"). */
	onLightStep: (gamepadIndex: number, delta: -1 | 1) => void;
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
				entry = { moveActive: false, moveNextFireAt: 0, interactPressed: false, interactPressedAt: null, interactFired: false, l1Pressed: false, r1Pressed: false };
				this.state.set(pad.index, entry);
			}

			const interactHeld = pad.buttons[INTERACT_BUTTON_INDEX]?.pressed ?? false;
			if (interactHeld && !entry.interactPressed) {
				entry.interactPressedAt = now;
				entry.interactFired = false;
			}
			if (!interactHeld) {
				entry.interactPressedAt = null;
				entry.interactFired = false;
			} else if (!entry.interactFired && entry.interactPressedAt !== null && now - entry.interactPressedAt >= INTERACT_HOLD_MS) {
				this.callbacks.onInteract(pad.index);
				entry.interactFired = true;
			}
			entry.interactPressed = interactHeld;

			const l1Held = pad.buttons[L1_BUTTON_INDEX]?.pressed ?? false;
			if (l1Held && !entry.l1Pressed) this.callbacks.onLightStep(pad.index, -1);
			entry.l1Pressed = l1Held;

			const r1Held = pad.buttons[R1_BUTTON_INDEX]?.pressed ?? false;
			if (r1Held && !entry.r1Pressed) this.callbacks.onLightStep(pad.index, 1);
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
				this.callbacks.onMove(pad.index, angle, interactHeld);
			} else if (now >= entry.moveNextFireAt) {
				entry.moveNextFireAt = now + MOVE_REPEAT_INTERVAL_MS;
				this.callbacks.onMove(pad.index, angle, interactHeld);
			}
		}
		// Drop bookkeeping for gamepads that disconnected since the last poll, so a reconnect (possibly
		// under the same index) starts clean rather than resuming mid-repeat.
		for (const index of this.state.keys()) {
			if (!seen.has(index)) this.state.delete(index);
		}
	}
}

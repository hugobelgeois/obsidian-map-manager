import { MapController } from "../controller/MapController";
import { Clock } from "../data/mapData";

export interface ClockBarDeps {
	/**
	 * `false` for the read-only player-mirror window ("Vue joueur"): wedges are pure display (no
	 * click-to-toggle), the name label doesn't open the InfoPanel editor, and there's no "+" button to
	 * create a clock. The GM manages clocks from their own edit/embed-view window instead — same split
	 * as walls being invisible on a mirror while still affecting it (`MapDrawer.drawWalls`'s `isMirror`
	 * check), just the other way around: clocks *do* show on a mirror, only editing them doesn't.
	 */
	interactive: boolean;
}

/**
 * Renders every `MapFileData.clock` as a small "flag" (a name label above a wedge-divided circle) in a
 * row across the top of the map — "suspendu à un drapeau", left to right in `data.clocks`'s own array
 * order. A standalone component, same shape as `Toolbar`/`InfoPanel` (subscribes to
 * `MapController.onChange`, owns its own `el`, has `destroy()`), mounted as a DOM child of whichever
 * `canvas-host` container also holds the `MapCanvas` it overlays — see `styles.css`'s
 * `.map-manager-clock-bar` for how it's positioned (absolute, pinned to the top) without needing any
 * of `MapCanvas`'s own per-frame render loop: it only rebuilds on an actual data/selection change.
 */
export class ClockBar {
	el: HTMLElement;
	private unsubscribe: () => void;

	constructor(container: HTMLElement, private controller: MapController, private deps: ClockBarDeps) {
		this.el = container.createDiv({ cls: "map-manager-clock-bar" });
		this.render();
		this.unsubscribe = this.controller.onChange(() => this.render());
	}

	destroy(): void {
		this.unsubscribe();
		this.el.remove();
	}

	private render(): void {
		this.el.empty();
		// A non-interactive (player-mirror) bar only ever shows clocks the GM opted into showing players
		// (`visibleToPlayers`, default true when unset) — the GM's own edit/embed windows always show
		// every clock regardless, so a hidden one can still be managed (see `renderClockFlag`).
		const clocks = this.controller.getData().clocks.filter((c) => this.deps.interactive || c.visibleToPlayers !== false);
		// Nothing to show a player and no way for them to add one either — collapse the bar entirely
		// rather than leaving an empty strip of dead space across the top of their screen.
		if (clocks.length === 0 && !this.deps.interactive) return;

		for (const clock of clocks) this.renderClockFlag(clock);

		if (this.deps.interactive) {
			const addBtn = this.el.createEl("button", { cls: "map-manager-clock-add-btn", text: "+" });
			addBtn.title = "Nouvelle horloge";
			addBtn.onclick = () => this.controller.addClock();
		}
	}

	private renderClockFlag(clock: Clock): void {
		const flag = this.el.createDiv({ cls: "map-manager-clock-flag" });
		// Only the GM's own view ever renders a clock that's hidden from players at all (see `render`) —
		// dimmed there as a reminder it won't show on the "Vue joueur" mirror.
		if (this.deps.interactive && clock.visibleToPlayers === false) flag.addClass("is-hidden-from-players");

		// The pole is the flag's own "handle": always present and always the click target that opens
		// the InfoPanel editor (`selectClock`), regardless of whether a name label is shown below it —
		// a nameless clock (see `Clock`'s own doc comment) still needs *some* way back into its editor.
		const pole = flag.createDiv({ cls: "map-manager-clock-pole" });
		if (clock.id === this.controller.selectedClockId) pole.addClass("is-active");
		if (this.deps.interactive) {
			pole.addClass("is-clickable");
			pole.onclick = () => this.controller.selectClock(clock.id);
		}

		// The GM's own view always shows the name (if any) regardless of `nameVisibleToPlayers` — that
		// flag only ever hides the name label on the read-only mirror, never from the GM themselves; see
		// `Clock.nameVisibleToPlayers`'s own doc comment. `visibleToPlayers === false` already dropped
		// the whole clock from a non-interactive bar in `render`, so this only ever further hides just
		// the name there, never the wedges.
		const name = clock.name.trim();
		const showName = name && (this.deps.interactive || clock.nameVisibleToPlayers !== false);
		if (showName) {
			const nameEl = flag.createDiv({ cls: "map-manager-clock-name", text: name });
			if (clock.id === this.controller.selectedClockId) nameEl.addClass("is-active");
			if (this.deps.interactive) {
				nameEl.addClass("is-clickable");
				nameEl.onclick = () => this.controller.selectClock(clock.id);
			}
		}

		this.renderWedges(flag, clock);
	}

	/** The clock's own pie, divided into `clock.segments.length` equal wedges via simple polar-to-cartesian arc math — self-contained here since nothing else in the codebase draws a pie chart. Filled state is derived from `i < clock.currentSegments` — see `Clock`'s own doc comment on why there's no per-wedge boolean any more. A click here goes through `clickClockWedgeOnBar` (not `clickClockSegment`, the InfoPanel row's own jump-to-wedge behaviour) — see that method's doc comment for why the bar's click behaviour is deliberately coarser. */
	private renderWedges(container: HTMLElement, clock: Clock): void {
		const size = 36;
		const center = size / 2;
		const radius = size / 2 - 1.5;
		const svg = container.createSvg("svg", { cls: "map-manager-clock-svg", attr: { viewBox: `0 0 ${size} ${size}`, width: String(size), height: String(size) } });

		const count = clock.segments.length;
		const pointAt = (angle: number) => ({ x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) });

		clock.segments.forEach((segment, i) => {
			const startAngle = (i / count) * Math.PI * 2 - Math.PI / 2;
			const endAngle = ((i + 1) / count) * Math.PI * 2 - Math.PI / 2;
			const start = pointAt(startAngle);
			const end = pointAt(endAngle);
			const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
			const d = count === 1 ? `M ${center} ${center} m -${radius} 0 a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 -${radius * 2} 0` : `M ${center} ${center} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
			const path = svg.createSvg("path", { attr: { d } });
			path.toggleClass("is-filled", i < clock.currentSegments);
			if (segment.link) path.addClass("has-link");
			if (this.deps.interactive) {
				path.addClass("is-clickable");
				path.onclick = () => this.controller.clickClockWedgeOnBar(clock.id, i);
			}
		});
	}
}

import { ItemView, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MapManagerPlugin from "../main";
import { MapController, PlayerMirrorCameraMode } from "../controller/MapController";
import { footprintCenter } from "../grid/fog";
import { getMirrorSource, MirrorSource, onMirrorSourceChange } from "../platform/mirrorRegistry";
import { MapCanvas } from "../render/MapCanvas";
import { ClockBar } from "../ui/ClockBar";
import { InfoPanel } from "../ui/InfoPanel";

export const VIEW_TYPE_MAP_PLAYER_MIRROR = "map-manager-player-mirror-view";

/**
 * Read-only, menu-less mirror of a map already open in a normal Obsidian window/tab — meant to be
 * dragged onto a second monitor for players (see `openPlayerWindow`). Shares the exact same
 * `MapController` as its source (`mirrorRegistry`), so token/wall/layer edits appear instantly with
 * no polling; camera pan/zoom is pushed explicitly via `onViewportChange` since panning doesn't
 * otherwise touch `MapController`. Fog here follows its own toggle, independent of the source's own
 * fog setting (see `MapCanvasOptions.forceFog`/`MapController.playerMirrorFogEnabled`), and entity
 * token vision zones only show here while the GM has separately opted in (both toggled from the
 * player-window dropdown in `Toolbar`, defaulting to fog-on/vision-off) — this is also the only
 * canvas where fog actually hides entity tokens at all; the GM's own source canvas always shows
 * every one of them (see `MapCanvas.entitiesHiddenByFog`). "light" category tokens never render
 * here regardless of any of that (`MapCanvas.isLightTokenHiddenFromMirror`) — only their light
 * itself is ever felt by a player. The InfoPanel itself only appears here while the GM has
 * it toggled on (the "eye" button in `InfoPanel`, `MapController.showInfoToPlayers`) — since that
 * flag and the current selection both live on the shared controller, this just mirrors it live too.
 * It's also the one InfoPanel instance built with `forPlayers: true`, so regardless of what the GM's
 * own copy of that same selection would show them (full edit controls, or the reduced-but-still-GM-facing
 * "Vue" panel — see `InfoPanel.renderPlayerPanel`), this one only ever shows a selected token's stat
 * block and tabs, nothing else.
 *
 * Camera behavior is one of `PlayerMirrorCameraMode` (the segmented control in `Toolbar`'s
 * player-window dropdown, `MapController.playerMirrorCameraMode`), applied by `applyCameraForMode` —
 * see its own doc comment.
 */
export class MapPlayerMirrorView extends ItemView {
	private filePath: string | null = null;
	private source: MirrorSource | null = null;
	private controller: MapController | null = null;
	private canvasComp: MapCanvas | null = null;
	private clockBarComp: ClockBar | null = null;
	private infoPanelComp: InfoPanel | null = null;
	private unsubscribeViewport: (() => void) | null = null;
	private unsubscribeController: (() => void) | null = null;
	private unsubscribeScroll: (() => void) | null = null;
	private unsubscribePing: (() => void) | null = null;
	private unsubscribePathAnimation: (() => void) | null = null;
	private unsubscribeCellHop: (() => void) | null = null;
	private unsubscribeAim: (() => void) | null = null;
	/** Watches the mirror registry so this view re-attaches by itself when the GM window reopens the same map (see `onMirrorSourceChange`). Keyed to `filePath`, kept alive across `mount()` calls, torn down only on close. */
	private unsubscribeRegistry: (() => void) | null = null;
	private rootEl: HTMLElement;
	private bodyEl: HTMLElement | null = null;
	/** The `playerMirrorCameraMode` last applied by `applyCameraForMode` — lets a switch *into* "center" force a fresh fit even when `dataVersion` hasn't changed since the last time that mode ran. */
	private lastAppliedCameraMode: PlayerMirrorCameraMode | null = null;
	/** The `controller.dataVersion` the "center" camera mode was last fitted against — see `applyCameraForMode`. */
	private centeredDataVersion: number | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: MapManagerPlugin) {
		super(leaf);
		this.contentEl.addClass("map-manager-view");
		this.rootEl = this.contentEl.createDiv({ cls: "map-manager-root" });
	}

	getViewType(): string {
		return VIEW_TYPE_MAP_PLAYER_MIRROR;
	}

	getDisplayText(): string {
		return "Vue joueur";
	}

	getIcon(): string {
		return "monitor";
	}

	getState(): Record<string, unknown> {
		return { file: this.filePath };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const file = (state as { file?: unknown } | null)?.file;
		if (typeof file === "string" && file !== this.filePath) {
			this.filePath = file;
			this.unsubscribeRegistry?.();
			this.unsubscribeRegistry = onMirrorSourceChange(file, () => this.handleRegistryChange());
		}
		await super.setState(state, result);
		this.mount();
	}

	/**
	 * Re-attaches to a freshly-registered shared controller when the map's GM window (re)opens while
	 * this view stays put. A source *disappearing* (GM window closed) is deliberately ignored: the
	 * canvas keeps rendering the last frame it had — the shared `MapController` object stays alive in
	 * memory as long as this view holds its reference — rather than collapsing to the "reopen this map
	 * first" placeholder. `mount()` only runs again once a real source comes back.
	 */
	private handleRegistryChange(): void {
		const next = this.filePath ? getMirrorSource(this.filePath) : undefined;
		if (!next || next === this.source) return;
		this.mount();
	}

	private mount(): void {
		this.destroyComponents();
		this.rootEl.empty();
		this.bodyEl = null;
		this.controller = null;
		this.source = null;

		const source = this.filePath ? getMirrorSource(this.filePath) : undefined;
		if (!source) {
			this.rootEl.createDiv({
				cls: "map-manager-embed-error",
				text: "Ouvrez d'abord cette carte dans une fenêtre normale d'Obsidian, puis rouvrez la vue joueur.",
			});
			return;
		}

		this.source = source;
		this.controller = source.controller;
		this.bodyEl = this.rootEl.createDiv({ cls: "map-manager-body" });
		const canvasHost = this.bodyEl.createDiv({ cls: "map-manager-canvas-host" });
		this.canvasComp = new MapCanvas(canvasHost, source.controller, this.app, this.plugin.settings, {
			isMirror: true,
			forceFog: true,
		});
		this.clockBarComp = new ClockBar(canvasHost, source.controller, { interactive: false });
		this.lastAppliedCameraMode = null;
		this.centeredDataVersion = null;
		this.applyCameraForMode();
		// The canvas's real viewport size may not be measured yet on this very first pass (layout
		// hasn't run) — "mirror" mode doesn't care (its camera is a world-space point, re-derived once
		// the viewport is real), but "center" mode's fit does. One retry next frame catches that case
		// without needing a dedicated resize hook.
		requestAnimationFrame(() => this.applyCameraForMode());
		// Only re-read the source's camera when it actually pans/zooms — not on every render this
		// canvas does for unrelated reasons (a token move, a selection) — see the note on
		// `MapCanvasOptions.isMirror` for why re-reading it on a schedule would leak the GM's
		// InfoPanel opening/closing (which narrows their viewport) into an unwanted camera shift here.
		this.unsubscribeViewport = source.onViewportChange(() => this.applyCameraForMode());
		this.unsubscribePing = source.onPing((x, y) => this.canvasComp?.triggerPing(x, y));
		this.unsubscribePathAnimation = source.onPathAnimationStart((routes, speedWorldPerMs) => this.canvasComp?.playPathAnimationEcho(routes, speedWorldPerMs));
		this.unsubscribeCellHop = source.onCellHop((tokenId, from, to) => this.canvasComp?.playCellHopEcho(tokenId, from, to));
		this.unsubscribeAim = source.onAim((tokenId, angleDeg) => this.canvasComp?.playAimEcho(tokenId, angleDeg));
		this.unsubscribeController = source.controller.onChange(() => {
			this.syncInfoPanel();
			this.applyCameraForMode();
		});
		this.syncInfoPanel();
	}

	/**
	 * Applies whichever camera behavior `controller.playerMirrorCameraMode` currently selects (see
	 * `PlayerMirrorCameraMode`): "mirror" keeps re-reading the source's own live camera; "freeze"
	 * touches nothing, leaving the camera exactly where it last was; "center" fits every player token's
	 * current position into view (`MapCanvas.computeFitCamera`), recomputed only when the underlying
	 * data actually changed (`MapController.dataVersion`) or the mode was just switched into — not on
	 * every selection-only notify, so the camera doesn't visibly jump while the GM is just clicking
	 * around.
	 */
	private applyCameraForMode(): void {
		if (!this.controller || !this.source || !this.canvasComp) return;
		const mode = this.controller.playerMirrorCameraMode;
		const modeChanged = mode !== this.lastAppliedCameraMode;
		this.lastAppliedCameraMode = mode;

		if (mode === "freeze") return;

		if (mode === "mirror") {
			this.canvasComp.setMirrorCamera(this.source.getView());
			return;
		}

		if (!modeChanged && this.centeredDataVersion === this.controller.dataVersion) return;
		this.centeredDataVersion = this.controller.dataVersion;
		const data = this.controller.getData();
		const playerPoints = data.tokens.filter((t) => t.category === "player").map((t) => footprintCenter(data, t));
		const camera = this.canvasComp.computeFitCamera(playerPoints);
		if (camera) this.canvasComp.setMirrorCamera(camera);
	}

	/** Mounts/unmounts the InfoPanel to match `controller.showInfoToPlayers`, live (see the class comment), following the source's scroll position while mounted. */
	private syncInfoPanel(): void {
		if (!this.controller || !this.bodyEl || !this.source) return;
		const shouldShow = this.controller.showInfoToPlayers;
		if (shouldShow && !this.infoPanelComp) {
			this.infoPanelComp = new InfoPanel(
				this.bodyEl,
				this.app,
				{ assetsFolder: this.plugin.settings.assetsFolder, settings: this.plugin.settings, forPlayers: true },
				this.controller
			);
			this.unsubscribeScroll = this.source.onScrollChange((scrollTop) => this.infoPanelComp?.setScrollTop(scrollTop));
		} else if (!shouldShow && this.infoPanelComp) {
			this.infoPanelComp.destroy();
			this.infoPanelComp = null;
			this.unsubscribeScroll?.();
			this.unsubscribeScroll = null;
		}
	}

	private destroyComponents(): void {
		this.canvasComp?.destroy();
		this.clockBarComp?.destroy();
		this.infoPanelComp?.destroy();
		this.unsubscribeViewport?.();
		this.unsubscribeController?.();
		this.unsubscribeScroll?.();
		this.unsubscribePing?.();
		this.unsubscribePathAnimation?.();
		this.unsubscribeCellHop?.();
		this.unsubscribeAim?.();
		this.canvasComp = null;
		this.clockBarComp = null;
		this.infoPanelComp = null;
		this.unsubscribeViewport = null;
		this.unsubscribeController = null;
		this.unsubscribeScroll = null;
		this.unsubscribePing = null;
		this.unsubscribePathAnimation = null;
		this.unsubscribeCellHop = null;
		this.unsubscribeAim = null;
	}

	async onClose(): Promise<void> {
		this.destroyComponents();
		this.unsubscribeRegistry?.();
		this.unsubscribeRegistry = null;
	}
}

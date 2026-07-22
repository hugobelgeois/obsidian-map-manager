import { ItemView, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MapManagerPlugin from "../main";
import { MapController } from "../controller/MapController";
import { getMirrorSource, MirrorSource } from "../platform/mirrorRegistry";
import { MapCanvas } from "../render/MapCanvas";
import { InfoPanel } from "../ui/InfoPanel";

export const VIEW_TYPE_MAP_PLAYER_MIRROR = "map-manager-player-mirror-view";

/**
 * Read-only, menu-less mirror of a map already open in a normal Obsidian window/tab — meant to be
 * dragged onto a second monitor for players (see `openPlayerWindow`). Shares the exact same
 * `MapController` as its source (`mirrorRegistry`), so token/wall/layer edits appear instantly with
 * no polling; camera pan/zoom is pushed explicitly via `onViewportChange` since panning doesn't
 * otherwise touch `MapController`. Fog always renders here regardless of the source's own fog
 * toggle (see `MapCanvasOptions.forceFog`). The InfoPanel itself only appears here while the GM has
 * it toggled on (the "eye" button in `InfoPanel`, `MapController.showInfoToPlayers`) — since that
 * flag and the current selection both live on the shared controller, this just mirrors it live too.
 */
export class MapPlayerMirrorView extends ItemView {
	private filePath: string | null = null;
	private source: MirrorSource | null = null;
	private controller: MapController | null = null;
	private canvasComp: MapCanvas | null = null;
	private infoPanelComp: InfoPanel | null = null;
	private unsubscribeViewport: (() => void) | null = null;
	private unsubscribeController: (() => void) | null = null;
	private unsubscribeScroll: (() => void) | null = null;
	private unsubscribePing: (() => void) | null = null;
	private rootEl: HTMLElement;
	private bodyEl: HTMLElement | null = null;

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
		if (typeof file === "string") this.filePath = file;
		await super.setState(state, result);
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
		this.canvasComp.setMirrorCamera(source.getView());
		// Only re-read the source's camera when it actually pans/zooms — not on every render this
		// canvas does for unrelated reasons (a token move, a selection) — see the note on
		// `MapCanvasOptions.isMirror` for why re-reading it on a schedule would leak the GM's
		// InfoPanel opening/closing (which narrows their viewport) into an unwanted camera shift here.
		this.unsubscribeViewport = source.onViewportChange(() => this.canvasComp?.setMirrorCamera(source.getView()));
		this.unsubscribePing = source.onPing((x, y) => this.canvasComp?.triggerPing(x, y));
		this.unsubscribeController = source.controller.onChange(() => this.syncInfoPanel());
		this.syncInfoPanel();
	}

	/** Mounts/unmounts the InfoPanel to match `controller.showInfoToPlayers`, live (see the class comment), following the source's scroll position while mounted. */
	private syncInfoPanel(): void {
		if (!this.controller || !this.bodyEl || !this.source) return;
		const shouldShow = this.controller.showInfoToPlayers;
		if (shouldShow && !this.infoPanelComp) {
			this.infoPanelComp = new InfoPanel(
				this.bodyEl,
				this.app,
				{ assetsFolder: this.plugin.settings.assetsFolder, settings: this.plugin.settings },
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
		this.infoPanelComp?.destroy();
		this.unsubscribeViewport?.();
		this.unsubscribeController?.();
		this.unsubscribeScroll?.();
		this.unsubscribePing?.();
		this.canvasComp = null;
		this.infoPanelComp = null;
		this.unsubscribeViewport = null;
		this.unsubscribeController = null;
		this.unsubscribeScroll = null;
		this.unsubscribePing = null;
	}

	async onClose(): Promise<void> {
		this.destroyComponents();
	}
}

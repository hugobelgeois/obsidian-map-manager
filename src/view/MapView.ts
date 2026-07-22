import { Notice, TextFileView, WorkspaceLeaf } from "obsidian";
import type MapManagerPlugin from "../main";
import { MapController } from "../controller/MapController";
import { parseMapData, serializeMapData } from "../data/mapData";
import { registerMirrorSource } from "../platform/mirrorRegistry";
import { openPlayerWindow } from "../platform/openPlayerWindow";
import { wireAutoPublish } from "../platform/autoPublish";
import { publishPublicSnapshot } from "../platform/publishPublicSnapshot";
import { MapCanvas } from "../render/MapCanvas";
import { InfoPanel } from "../ui/InfoPanel";
import { Toolbar } from "../ui/Toolbar";

export const VIEW_TYPE_MAP = "map-manager-map-view";

export class MapView extends TextFileView {
	private controller: MapController | null = null;
	private canvasComp: MapCanvas | null = null;
	private toolbarComp: Toolbar | null = null;
	private infoPanelComp: InfoPanel | null = null;
	private unsubscribeAutoPublish: (() => void) | null = null;
	private unsubscribeSettings: (() => void) | null = null;
	private unregisterMirror: (() => void) | null = null;
	/** Player mirror windows subscribed to this view's camera via `registerMirrorSource`'s `onViewportChange`. */
	private viewportListeners: Set<() => void> = new Set();
	/** Player mirror windows subscribed to this view's InfoPanel scroll via `registerMirrorSource`'s `onScrollChange`. */
	private scrollListeners: Set<(scrollTop: number) => void> = new Set();
	/** Player mirror windows subscribed to this view's "look here" pings via `registerMirrorSource`'s `onPing`. */
	private pingListeners: Set<(x: number, y: number) => void> = new Set();
	private rootEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: MapManagerPlugin) {
		super(leaf);
		this.contentEl.addClass("map-manager-view");
		this.rootEl = this.contentEl.createDiv({ cls: "map-manager-root" });
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file === this.file) void this.handleExternalModify();
		}));
	}

	/** Reloads from disk when another open window saved a change to this same file (e.g. this map opened in a second normal tab elsewhere). No-op if the file on disk still matches what we already hold in memory (an echo of our own debounced save). A player mirror window doesn't need this — it shares this instance's `MapController` object directly (see `mirrorRegistry`). */
	private async handleExternalModify(): Promise<void> {
		if (!this.file || !this.controller) return;
		const raw = await this.app.vault.read(this.file);
		const current = serializeMapData(this.controller.getData());
		if (raw === current) return;
		const parsed = parseMapData(raw, this.plugin.getMapDefaults());
		this.controller.replaceData(parsed);
	}

	getViewType(): string {
		return VIEW_TYPE_MAP;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Carte";
	}

	getIcon(): string {
		return "map";
	}

	getViewData(): string {
		return this.controller ? serializeMapData(this.controller.getData()) : "";
	}

	setViewData(data: string, _clear: boolean): void {
		this.destroyComponents();
		const parsed = parseMapData(data, this.plugin.getMapDefaults());
		this.controller = new MapController(parsed, () => this.requestSave());
		if (this.file) this.unsubscribeAutoPublish = wireAutoPublish(this.app, this.file, this.controller, this.plugin.settings);
		this.unsubscribeSettings = this.plugin.onSettingsChanged(() => this.controller?.refresh());
		this.mountComponents();
	}

	clear(): void {
		this.destroyComponents();
		this.controller = null;
	}

	private mountComponents(): void {
		if (!this.controller) return;
		this.rootEl.empty();
		this.toolbarComp = new Toolbar(
			this.rootEl,
			this.app,
			{ assetsFolder: this.plugin.settings.assetsFolder, settings: this.plugin.settings },
			this.controller,
			{
				recenter: () => this.canvasComp?.recenter(),
				publish: () => void this.publishView(),
				openPlayerWindow: () => {
					this.controller?.setMode("view");
					if (this.file) void openPlayerWindow(this.app, this.file);
				},
			}
		);
		const body = this.rootEl.createDiv({ cls: "map-manager-body" });
		const canvasHost = body.createDiv({ cls: "map-manager-canvas-host" });
		this.canvasComp = new MapCanvas(canvasHost, this.controller, this.app, this.plugin.settings, {
			onViewportChange: () => {
				for (const cb of this.viewportListeners) cb();
			},
			onPing: (x, y) => {
				for (const cb of this.pingListeners) cb(x, y);
			},
		});
		if (this.file) {
			this.unregisterMirror = registerMirrorSource(this.file.path, {
				controller: this.controller,
				getView: () => this.canvasComp!.getViewCenter(),
				onViewportChange: (cb) => {
					this.viewportListeners.add(cb);
					return () => this.viewportListeners.delete(cb);
				},
				onScrollChange: (cb) => {
					this.scrollListeners.add(cb);
					return () => this.scrollListeners.delete(cb);
				},
				onPing: (cb) => {
					this.pingListeners.add(cb);
					return () => this.pingListeners.delete(cb);
				},
			});
		}
		this.infoPanelComp = new InfoPanel(
			body,
			this.app,
			{
				assetsFolder: this.plugin.settings.assetsFolder,
				settings: this.plugin.settings,
				onResizePanel: (width) => {
					this.plugin.settings.infoPanelWidth = width;
					void this.plugin.saveSettings();
				},
				onScroll: (scrollTop) => {
					for (const cb of this.scrollListeners) cb(scrollTop);
				},
			},
			this.controller
		);
	}

	private async publishView(): Promise<void> {
		if (!this.controller || !this.file) return;
		try {
			const target = await publishPublicSnapshot(this.app, this.file, this.controller.getData(), this.plugin.settings);
			new Notice(`Vue publique mise à jour : ${target.path}`);
		} catch (e) {
			console.error("Map Manager: échec de la publication de la vue publique", e);
			new Notice("Échec de la publication de la vue publique.");
		}
	}

	private destroyComponents(): void {
		this.canvasComp?.destroy();
		this.toolbarComp?.destroy();
		this.infoPanelComp?.destroy();
		this.unsubscribeAutoPublish?.();
		this.unsubscribeSettings?.();
		this.unregisterMirror?.();
		this.canvasComp = null;
		this.toolbarComp = null;
		this.infoPanelComp = null;
		this.unsubscribeAutoPublish = null;
		this.unsubscribeSettings = null;
		this.unregisterMirror = null;
		this.viewportListeners.clear();
		this.scrollListeners.clear();
		this.pingListeners.clear();
	}

	async onClose(): Promise<void> {
		this.destroyComponents();
	}
}

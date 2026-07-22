import { Notice, TextFileView, WorkspaceLeaf } from "obsidian";
import type MapManagerPlugin from "../main";
import { MapController } from "../controller/MapController";
import { parseMapData, serializeMapData } from "../data/mapData";
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
	private rootEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: MapManagerPlugin) {
		super(leaf);
		this.contentEl.addClass("map-manager-view");
		this.rootEl = this.contentEl.createDiv({ cls: "map-manager-root" });
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
			}
		);
		const body = this.rootEl.createDiv({ cls: "map-manager-body" });
		const canvasHost = body.createDiv({ cls: "map-manager-canvas-host" });
		this.canvasComp = new MapCanvas(canvasHost, this.controller, this.app, this.plugin.settings);
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
		this.canvasComp = null;
		this.toolbarComp = null;
		this.infoPanelComp = null;
		this.unsubscribeAutoPublish = null;
		this.unsubscribeSettings = null;
	}

	async onClose(): Promise<void> {
		this.destroyComponents();
	}
}

import { TextFileView, WorkspaceLeaf } from "obsidian";
import type MapManagerPlugin from "../main";
import { MapController } from "../controller/MapController";
import { parseMapData, serializeMapData } from "../data/mapData";
import { MapCanvas } from "../render/MapCanvas";
import { InfoPanel } from "../ui/InfoPanel";
import { Toolbar } from "../ui/Toolbar";

export const VIEW_TYPE_MAP = "map-manager-map-view";

export class MapView extends TextFileView {
	private controller: MapController | null = null;
	private canvasComp: MapCanvas | null = null;
	private toolbarComp: Toolbar | null = null;
	private infoPanelComp: InfoPanel | null = null;
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
		this.mountComponents();
	}

	clear(): void {
		this.destroyComponents();
		this.controller = null;
	}

	private mountComponents(): void {
		if (!this.controller) return;
		this.rootEl.empty();
		this.toolbarComp = new Toolbar(this.rootEl, this.app, { assetsFolder: this.plugin.settings.assetsFolder }, this.controller, {
			recenter: () => this.canvasComp?.recenter(),
			getCenterCellKey: () => this.canvasComp?.getCenterCellKey() ?? "0,0",
			getCenterWorld: () => this.canvasComp?.getCenterWorld() ?? { x: 0, y: 0 },
		});
		const body = this.rootEl.createDiv({ cls: "map-manager-body" });
		const canvasHost = body.createDiv({ cls: "map-manager-canvas-host" });
		this.canvasComp = new MapCanvas(canvasHost, this.controller, this.app, this.plugin.settings);
		this.infoPanelComp = new InfoPanel(body, this.app, { assetsFolder: this.plugin.settings.assetsFolder }, this.controller);
	}

	private destroyComponents(): void {
		this.canvasComp?.destroy();
		this.toolbarComp?.destroy();
		this.infoPanelComp?.destroy();
		this.canvasComp = null;
		this.toolbarComp = null;
		this.infoPanelComp = null;
	}

	async onClose(): Promise<void> {
		this.destroyComponents();
	}
}

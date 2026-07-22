import { MarkdownPostProcessorContext, MarkdownRenderChild, Notice, TFile, debounce } from "obsidian";
import type MapManagerPlugin from "../main";
import { MapController } from "../controller/MapController";
import { parseMapBlockSource, parseMapData, serializeMapData } from "../data/mapData";
import { registerMirrorSource } from "../platform/mirrorRegistry";
import { openPlayerWindow } from "../platform/openPlayerWindow";
import { wireAutoPublish } from "../platform/autoPublish";
import { publishPublicSnapshot } from "../platform/publishPublicSnapshot";
import { MapCanvas } from "../render/MapCanvas";
import { InfoPanel } from "../ui/InfoPanel";
import { Toolbar } from "../ui/Toolbar";

class MapEmbedChild extends MarkdownRenderChild {
	constructor(containerEl: HTMLElement, private cleanup: () => void) {
		super(containerEl);
	}

	onunload(): void {
		this.cleanup();
	}
}

export async function renderMapEmbed(plugin: MapManagerPlugin, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
	const app = plugin.app;
	const linkPath = parseMapBlockSource(source);

	if (!linkPath) {
		el.createDiv({ cls: "map-manager-embed-error", text: "Bloc de carte vide : indiquez le chemin d'un fichier .map (ou utilisez la commande d'insertion)." });
		return;
	}

	const file = app.metadataCache.getFirstLinkpathDest(linkPath, ctx.sourcePath) ?? app.vault.getAbstractFileByPath(linkPath);
	if (!(file instanceof TFile)) {
		el.createDiv({ cls: "map-manager-embed-error", text: `Carte introuvable : ${linkPath}` });
		return;
	}

	const host = el.createDiv({ cls: "map-manager-embed map-manager-root" });
	host.style.height = `${plugin.settings.embedHeight}px`;

	const raw = await app.vault.read(file);
	const data = parseMapData(raw, plugin.getMapDefaults());

	const save = debounce(
		(d: ReturnType<typeof parseMapData>) => {
			void app.vault.process(file, () => serializeMapData(d));
		},
		500,
		true
	);

	const controller = new MapController(data, save, "view");
	const unsubscribeAutoPublish = wireAutoPublish(app, file, controller, plugin.settings);
	const unsubscribeSettings = plugin.onSettingsChanged(() => controller.refresh());
	let canvasRef: MapCanvas | null = null;

	// Reloads from disk when another open window (e.g. the GM's own tab, or another popped-out
	// player window) saved a change to this same file — no-op if the file already matches what we
	// hold in memory (an echo of our own debounced `save`).
	const handleExternalModify = async (changed: TFile) => {
		if (changed.path !== file.path) return;
		const raw = await app.vault.read(file);
		const current = serializeMapData(controller.getData());
		if (raw === current) return;
		const parsed = parseMapData(raw, plugin.getMapDefaults());
		controller.replaceData(parsed);
	};
	const modifyRef = app.vault.on("modify", (f) => {
		if (f instanceof TFile) void handleExternalModify(f);
	});

	const publishView = async () => {
		try {
			const target = await publishPublicSnapshot(app, file, controller.getData(), plugin.settings);
			new Notice(`Vue publique mise à jour : ${target.path}`);
		} catch (e) {
			console.error("Map Manager: échec de la publication de la vue publique", e);
			new Notice("Échec de la publication de la vue publique.");
		}
	};

	const toolbar = new Toolbar(host, app, { assetsFolder: plugin.settings.assetsFolder, settings: plugin.settings }, controller, {
		recenter: () => canvasRef?.recenter(),
		publish: () => void publishView(),
		openPlayerWindow: () => {
			controller.setMode("view");
			void openPlayerWindow(app, file);
		},
	});
	const body = host.createDiv({ cls: "map-manager-body" });
	const canvasHost = body.createDiv({ cls: "map-manager-canvas-host" });
	const viewportListeners = new Set<() => void>();
	const pingListeners = new Set<(x: number, y: number) => void>();
	const canvas = new MapCanvas(canvasHost, controller, app, plugin.settings, {
		onViewportChange: () => {
			for (const cb of viewportListeners) cb();
		},
		onPing: (x, y) => {
			for (const cb of pingListeners) cb(x, y);
		},
	});
	canvasRef = canvas;
	const scrollListeners = new Set<(scrollTop: number) => void>();
	const unregisterMirror = registerMirrorSource(file.path, {
		controller,
		getView: () => canvas.getViewCenter(),
		onViewportChange: (cb) => {
			viewportListeners.add(cb);
			return () => viewportListeners.delete(cb);
		},
		onScrollChange: (cb) => {
			scrollListeners.add(cb);
			return () => scrollListeners.delete(cb);
		},
		onPing: (cb) => {
			pingListeners.add(cb);
			return () => pingListeners.delete(cb);
		},
	});
	const infoPanel = new InfoPanel(
		body,
		app,
		{
			assetsFolder: plugin.settings.assetsFolder,
			settings: plugin.settings,
			onResizePanel: (width) => {
				plugin.settings.infoPanelWidth = width;
				void plugin.saveSettings();
			},
			onScroll: (scrollTop) => {
				for (const cb of scrollListeners) cb(scrollTop);
			},
		},
		controller
	);

	ctx.addChild(
		new MapEmbedChild(host, () => {
			canvas.destroy();
			toolbar.destroy();
			infoPanel.destroy();
			unsubscribeAutoPublish();
			unsubscribeSettings();
			unregisterMirror();
			app.vault.offref(modifyRef);
		})
	);
}

import { MarkdownPostProcessorContext, MarkdownRenderChild, Notice, TFile, debounce } from "obsidian";
import type MapManagerPlugin from "../main";
import { MapController } from "../controller/MapController";
import { parseMapBlockSource, parseMapData, serializeMapData } from "../data/mapData";
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
	});
	const body = host.createDiv({ cls: "map-manager-body" });
	const canvasHost = body.createDiv({ cls: "map-manager-canvas-host" });
	const canvas = new MapCanvas(canvasHost, controller, app, plugin.settings);
	canvasRef = canvas;
	const infoPanel = new InfoPanel(body, app, { assetsFolder: plugin.settings.assetsFolder, settings: plugin.settings }, controller);

	ctx.addChild(
		new MapEmbedChild(host, () => {
			canvas.destroy();
			toolbar.destroy();
			infoPanel.destroy();
			unsubscribeAutoPublish();
			unsubscribeSettings();
		})
	);
}

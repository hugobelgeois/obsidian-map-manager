import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { createDefaultMapData, MapDefaults, parseMapData, serializeMapData } from "./data/mapData";
import { openPlayerWindow } from "./platform/openPlayerWindow";
import { publishPublicSnapshot } from "./platform/publishPublicSnapshot";
import { MapManagerSettingsTab } from "./settings/SettingsTab";
import { DEFAULT_SETTINGS, MapManagerSettings } from "./settings/types";
import { FileSuggestModal } from "./ui/FileSuggestModal";
import { MapView, VIEW_TYPE_MAP } from "./view/MapView";
import { MapPlayerMirrorView, VIEW_TYPE_MAP_PLAYER_MIRROR } from "./view/MapPlayerMirrorView";
import { renderMapEmbed } from "./view/MapEmbed";

export default class MapManagerPlugin extends Plugin {
	settings: MapManagerSettings;
	private settingsChangeListeners: Set<() => void> = new Set();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_MAP, (leaf) => new MapView(leaf, this));
		this.registerView(VIEW_TYPE_MAP_PLAYER_MIRROR, (leaf) => new MapPlayerMirrorView(leaf, this));
		this.registerExtensions(["map"], VIEW_TYPE_MAP);
		this.registerMarkdownCodeBlockProcessor("map", (source, el, ctx) => renderMapEmbed(this, source, el, ctx));

		this.addRibbonIcon("map", "Nouvelle carte", () => {
			void this.createNewMap();
		});

		this.addCommand({
			id: "map-manager-new-map",
			name: "Créer une nouvelle carte",
			callback: () => {
				void this.createNewMap();
			},
		});

		this.addCommand({
			id: "map-manager-insert-map",
			name: "Insérer une carte dans la note",
			editorCallback: (editor) => {
				const files = this.app.vault.getFiles().filter((f) => f.extension === "map");
				if (files.length === 0) {
					new Notice("Aucune carte trouvée. Créez-en une d'abord.");
					return;
				}
				new FileSuggestModal(
					this.app,
					files,
					(file) => {
						editor.replaceSelection(`\`\`\`map\n${file.path}\n\`\`\`\n`);
					},
					"Choisir une carte à insérer..."
				).open();
			},
		});

		this.addCommand({
			id: "map-manager-publish-public-snapshot",
			name: "Publier la vue publique de la carte active",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const isMap = file instanceof TFile && file.extension === "map";
				if (checking) return isMap;
				if (file instanceof TFile) void this.publishMap(file);
				return true;
			},
		});

		this.addCommand({
			id: "map-manager-open-player-window",
			name: "Ouvrir la vue joueur dans une nouvelle fenêtre",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const isMap = file instanceof TFile && file.extension === "map";
				if (checking) return isMap;
				if (file instanceof TFile) void openPlayerWindow(this.app, file);
				return true;
			},
		});

		this.addSettingTab(new MapManagerSettingsTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				const folder = file instanceof TFolder ? file : file.parent;
				if (!folder) return;
				menu.addItem((item) => {
					item.setTitle("Nouvelle carte")
						.setIcon("map")
						.onClick(() => {
							void this.createNewMap(folder);
						});
				});
			})
		);
	}

	getMapDefaults(): MapDefaults {
		return {
			gridType: this.settings.defaultGridType,
			cellSize: this.settings.defaultCellSize,
			minZoom: this.settings.defaultMinZoom,
			maxZoom: this.settings.defaultMaxZoom,
		};
	}

	/** Notifies every open map (view or embed) that plugin settings changed, so zone types / token templates — read live, not copied per-map — refresh immediately. See `MapController.refresh`. */
	onSettingsChanged(cb: () => void): () => void {
		this.settingsChangeListeners.add(cb);
		return () => this.settingsChangeListeners.delete(cb);
	}

	private async createNewMap(targetFolder?: TFolder): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		const folder = targetFolder ?? this.app.fileManager.getNewFileParent(activeFile?.path ?? "");
		const baseName = "Carte sans titre";
		let path = normalizePath(`${folder.path}/${baseName}.map`);
		let index = 1;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(`${folder.path}/${baseName} ${index}.map`);
			index++;
		}

		const data = createDefaultMapData(this.getMapDefaults());
		const file: TFile = await this.app.vault.create(path, serializeMapData(data));
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	private async publishMap(file: TFile): Promise<void> {
		try {
			const raw = await this.app.vault.read(file);
			const data = parseMapData(raw, this.getMapDefaults());
			const target = await publishPublicSnapshot(this.app, file, data, this.settings);
			new Notice(`Vue publique mise à jour : ${target.path}`);
		} catch (e) {
			console.error("Map Manager: échec de la publication de la vue publique", e);
			new Notice("Échec de la publication de la vue publique.");
		}
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<MapManagerSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		for (const cb of this.settingsChangeListeners) cb();
	}
}

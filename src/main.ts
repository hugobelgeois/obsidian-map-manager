import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { createDefaultMapData, MapDefaults, serializeMapData } from "./data/mapData";
import { MapManagerSettingsTab } from "./settings/SettingsTab";
import { DEFAULT_SETTINGS, MapManagerSettings } from "./settings/types";
import { FileSuggestModal } from "./ui/FileSuggestModal";
import { MapView, VIEW_TYPE_MAP } from "./view/MapView";
import { renderMapEmbed } from "./view/MapEmbed";

export default class MapManagerPlugin extends Plugin {
	settings: MapManagerSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_MAP, (leaf) => new MapView(leaf, this));
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
			zoneTypes: this.settings.defaultZoneTypes.map((z) => ({ ...z })),
			tokenTemplates: this.settings.defaultTokenTemplates.map((t) => ({ ...t, fields: [...t.fields] })),
			minZoom: this.settings.defaultMinZoom,
			maxZoom: this.settings.defaultMaxZoom,
		};
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

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<MapManagerSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

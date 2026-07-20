import { App, PluginSettingTab, Setting } from "obsidian";
import type MapManagerPlugin from "../main";
import { GRID_TYPE_LABELS, GRID_TYPES, GridType } from "../data/mapData";
import { generateId } from "../utils";

export class MapManagerSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: MapManagerPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName("Type de grille par défaut")
			.setDesc("Utilisé pour toute nouvelle carte.")
			.addDropdown((dd) => {
				for (const gt of GRID_TYPES) dd.addOption(gt, GRID_TYPE_LABELS[gt]);
				dd.setValue(settings.defaultGridType);
				dd.onChange(async (value) => {
					settings.defaultGridType = value as GridType;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Taille de case par défaut")
			.setDesc("En pixels, avant zoom.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(settings.defaultCellSize));
				text.onChange(async (value) => {
					const n = parseFloat(value);
					if (!Number.isNaN(n) && n > 0) {
						settings.defaultCellSize = n;
						await this.plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Zoom minimum par défaut")
			.setDesc("Niveau de dézoom maximal pour toute nouvelle carte (modifiable ensuite par carte).")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.step = "0.01";
				text.setValue(String(settings.defaultMinZoom));
				text.onChange(async (value) => {
					const n = parseFloat(value);
					if (!Number.isNaN(n) && n > 0) {
						settings.defaultMinZoom = n;
						await this.plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Zoom maximum par défaut")
			.setDesc("Niveau de zoom maximal pour toute nouvelle carte (modifiable ensuite par carte).")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.step = "0.1";
				text.setValue(String(settings.defaultMaxZoom));
				text.onChange(async (value) => {
					const n = parseFloat(value);
					if (!Number.isNaN(n) && n > 0) {
						settings.defaultMaxZoom = n;
						await this.plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Dossier des images importées")
			.setDesc("Chemin dans le vault où sont copiées les images de fond importées depuis l'ordinateur.")
			.addText((text) => {
				text.setValue(settings.assetsFolder);
				text.onChange(async (value) => {
					settings.assetsFolder = value.trim() || "Map Assets";
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Hauteur des cartes intégrées")
			.setDesc("Hauteur par défaut (en pixels) d'une carte insérée dans une note via le bloc `map`.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(settings.embedHeight));
				text.onChange(async (value) => {
					const n = parseFloat(value);
					if (!Number.isNaN(n) && n > 0) {
						settings.embedHeight = n;
						await this.plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Palette de zones par défaut")
			.setDesc("Utilisée pour toute nouvelle carte. Chaque carte garde ensuite sa propre copie, modifiable indépendamment.")
			.setHeading();

		for (const zone of settings.defaultZoneTypes) {
			new Setting(containerEl)
				.addText((text) => {
					text.setValue(zone.name);
					text.onChange(async (value) => {
						zone.name = value;
						await this.plugin.saveSettings();
					});
				})
				.addColorPicker((cp) => {
					cp.setValue(zone.color);
					cp.onChange(async (value) => {
						zone.color = value;
						await this.plugin.saveSettings();
					});
				})
				.addExtraButton((btn) => {
					btn.setIcon("trash").setTooltip("Supprimer").onClick(async () => {
						settings.defaultZoneTypes = settings.defaultZoneTypes.filter((z) => z.id !== zone.id);
						await this.plugin.saveSettings();
						this.display();
					});
				});
		}

		new Setting(containerEl).addButton((btn) => {
			btn.setButtonText("Ajouter un type de zone").onClick(async () => {
				settings.defaultZoneTypes.push({ id: generateId(), name: "Nouvelle zone", color: "#888888" });
				await this.plugin.saveSettings();
				this.display();
			});
		});

		new Setting(containerEl)
			.setName("Modèles de statistiques de pion")
			.setDesc(
				"Chaque modèle liste les propriétés (frontmatter YAML) de la note liée à afficher sur le pion, séparées par des virgules. Utilisée pour toute nouvelle carte ; chaque carte garde ensuite sa propre copie."
			)
			.setHeading();

		for (const template of settings.defaultTokenTemplates) {
			new Setting(containerEl)
				.addText((text) => {
					text.setValue(template.name);
					text.setPlaceholder("Nom du modèle");
					text.onChange(async (value) => {
						template.name = value;
						await this.plugin.saveSettings();
					});
				})
				.addText((text) => {
					text.setValue(template.fields.join(", "));
					text.setPlaceholder("Propriétés séparées par des virgules");
					text.onChange(async (value) => {
						template.fields = value
							.split(",")
							.map((f) => f.trim())
							.filter((f) => f.length > 0);
						await this.plugin.saveSettings();
					});
				})
				.addExtraButton((btn) => {
					btn.setIcon("trash")
						.setTooltip("Supprimer")
						.onClick(async () => {
							settings.defaultTokenTemplates = settings.defaultTokenTemplates.filter((t) => t.id !== template.id);
							await this.plugin.saveSettings();
							this.display();
						});
				});
		}

		new Setting(containerEl).addButton((btn) => {
			btn.setButtonText("Ajouter un modèle").onClick(async () => {
				settings.defaultTokenTemplates.push({ id: generateId(), name: "Nouveau modèle", fields: [] });
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}
}

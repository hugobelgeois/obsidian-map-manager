import { App, PluginSettingTab, Setting } from "obsidian";
import type MapManagerPlugin from "../main";
import { DEFAULT_TOKEN_TAB_NAMES, GRID_TYPE_LABELS, GRID_TYPES, GridType } from "../data/mapData";
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
			.setName("Activer les animations")
			.setDesc("Fait légèrement trembler le bord du brouillard de guerre (lumière vacillante), au prix d'un rafraîchissement continu tant qu'une carte avec brouillard actif est ouverte.")
			.addToggle((toggle) => {
				toggle.setValue(settings.fogAnimations);
				toggle.onChange(async (value) => {
					settings.fogAnimations = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Délai de republication automatique de la vue publique")
			.setDesc(
				"Après ce délai d'inactivité (en secondes) suivant une modification d'une carte, son <carte>.json (vue publique pour le site externe) est régénéré automatiquement — plus besoin de cliquer sur « Publier la vue » à chaque fois. 0 désactive la republication automatique."
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.setValue(String(settings.autoPublishDelaySeconds));
				text.onChange(async (value) => {
					const n = parseFloat(value);
					if (!Number.isNaN(n) && n >= 0) {
						settings.autoPublishDelaySeconds = n;
						await this.plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Palette de zones (types de terrain)")
			.setDesc("Partagée par toutes les cartes : toute modification ici (nom, couleur, ajout, suppression) se répercute immédiatement dans leurs menus, y compris sur une carte déjà ouverte.")
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
				"Chaque modèle liste les propriétés (frontmatter YAML) de la note liée à afficher sur le pion, séparées par des virgules, ainsi que les onglets par défaut proposés à un pion joueur utilisant ce modèle (ex. \"statistiques, inventaire, histoire\"), tant qu'il n'a pas personnalisé ses propres onglets. Partagée par toutes les cartes, en direct : toute modification ici se répercute immédiatement dans leurs menus, y compris sur une carte déjà ouverte."
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
				.addText((text) => {
					text.setValue((template.defaultTabNames ?? []).join(", "));
					text.setPlaceholder(`Onglets par défaut (ex. ${DEFAULT_TOKEN_TAB_NAMES.join(", ")})`);
					text.onChange(async (value) => {
						const names = value
							.split(",")
							.map((n) => n.trim())
							.filter((n) => n.length > 0);
						template.defaultTabNames = names.length > 0 ? names : undefined;
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

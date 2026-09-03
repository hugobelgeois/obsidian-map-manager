import { App, PluginSettingTab, Setting } from "obsidian";
import type MapManagerPlugin from "../main";
import { DEFAULT_TOKEN_TAB_NAMES, GRID_TYPE_LABELS, GRID_TYPES, GridType, VisionBlockerType, makeLink, splitLink } from "../data/mapData";
import { GamepadAction, GamepadActionContact, GamepadActionEffect } from "../data/gamepadActions";
import { FileSuggestModal } from "../ui/FileSuggestModal";
import { HeadingSuggestModal } from "../ui/HeadingSuggestModal";
import { WALL_BLOCKER_TYPE_OPTIONS } from "../ui/wallBlockerTypeOptions";
import { generateId } from "../utils";

export class MapManagerSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: MapManagerPlugin) {
		super(app, plugin);
	}

	/**
	 * Rebuilds the whole tab (`display`) while keeping the scroll position — every structural edit
	 * (add/remove a zone, change a gamepad action's contact/effect, …) has to re-`display()` to show
	 * the new controls, and a bare `display()` empties `containerEl` and snaps the view back to the top.
	 */
	private redraw(): void {
		const scroller: HTMLElement = this.containerEl.closest<HTMLElement>(".vertical-tab-content") ?? this.containerEl;
		const top = scroller.scrollTop;
		this.display();
		scroller.scrollTop = top;
		window.requestAnimationFrame(() => (scroller.scrollTop = top));
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
			.setName("Adoucir le brouillard")
			.setDesc(
				"Intensité du fondu entre cases explorées et cases brouillard (le fondu reste du côté des cases explorées, les cases brouillard restent entièrement noires). 0 : désactivé, rendu net et statique, aucune animation. 1 à 10 : le fondu devient de plus en plus long et sombre ; à 10 la case explorée au bord du brouillard est presque noire. Un rafraîchissement continu tourne tant qu'une carte avec brouillard actif est ouverte."
			)
			.addSlider((slider) => {
				slider.setLimits(0, 10, 1);
				slider.setValue(settings.fogSoftening);
				slider.setDynamicTooltip();
				slider.onChange(async (value) => {
					settings.fogSoftening = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Afficher les rayons de vision (debug)")
			.setDesc("Trace, en mode vue avec brouillard, le polygone de ligne de vue de chaque pion joueur, les rayons vers ses sommets et son cercle de lumière. À n'activer que pour diagnostiquer le brouillard.")
			.addToggle((toggle) => {
				toggle.setValue(settings.fogDebugVisionRays);
				toggle.onChange(async (value) => {
					settings.fogDebugVisionRays = value;
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
			.setName("Pas de rotation des tokens")
			.setDesc("Incrément (en degrés) de la molette de rotation d'un pion dans le panneau d'infos.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "180";
				text.setValue(String(settings.tokenRotationStep));
				text.onChange(async (value) => {
					const n = parseFloat(value);
					if (!Number.isNaN(n) && n > 0) {
						settings.tokenRotationStep = n;
						await this.plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Taille des images de pion")
			.setDesc("Côté (en pixels) auquel une image du vault choisie comme logo de pion est redimensionnée/recadrée avant d'être enregistrée.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "16";
				text.setValue(String(settings.tokenImageSize));
				text.onChange(async (value) => {
					const n = parseFloat(value);
					if (!Number.isNaN(n) && n > 0) {
						settings.tokenImageSize = n;
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
						this.redraw();
					});
				});
		}

		new Setting(containerEl).addButton((btn) => {
			btn.setButtonText("Ajouter un type de zone").onClick(async () => {
				settings.defaultZoneTypes.push({ id: generateId(), name: "Nouvelle zone", color: "#888888" });
				await this.plugin.saveSettings();
				this.redraw();
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
					// Every "player" category token is locked to this template (see
					// `InfoPanel.renderTokenPanel`) — it always needs to resolve to something, so it's
					// modifiable here like any other template, but never removable — see `TokenTemplate.reserved`.
					btn.setIcon("trash").setTooltip(template.reserved ? "Modèle réservé aux pions Joueur — non supprimable" : "Supprimer");
					btn.setDisabled(!!template.reserved);
					if (!template.reserved) {
						btn.onClick(async () => {
							settings.defaultTokenTemplates = settings.defaultTokenTemplates.filter((t) => t.id !== template.id);
							await this.plugin.saveSettings();
							this.redraw();
						});
					}
				});
		}

		new Setting(containerEl).addButton((btn) => {
			btn.setButtonText("Ajouter un modèle").onClick(async () => {
				settings.defaultTokenTemplates.push({ id: generateId(), name: "Nouveau modèle", fields: [] });
				await this.plugin.saveSettings();
				this.redraw();
			});
		});

		this.renderGamepadActions(containerEl);
	}

	/**
	 * "Actions manette" — CRUD for `settings.gamepadActions` (the Triangle/Y popup menu entries — see
	 * `GamepadAction`). Same live-shared-list pattern as the zone palette above (`this.display()` after
	 * any structural change).
	 */
	private renderGamepadActions(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName("Actions manette")
			.setDesc(
				"Entrées du menu d'action qui s'ouvre en mode vue quand un joueur appuie sur le bouton du haut de sa manette. Chaque action : un nom, la condition de contact qui la rend disponible, l'effet exécuté à la validation et son coût en vie de lumière. Partagée par toutes les cartes."
			)
			.setHeading();

		new Setting(containerEl)
			.setName("Coût de navigation dans le menu d'action")
			.setDesc("Points de vie de lumière retirés au pion joueur à chaque déplacement du curseur (flèches) dans le menu.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.setValue(String(settings.actionMenuNavCost));
				text.onChange(async (value) => {
					const n = parseFloat(value);
					if (!Number.isNaN(n) && n >= 0) {
						settings.actionMenuNavCost = n;
						await this.plugin.saveSettings();
					}
				});
			});

		for (const action of settings.gamepadActions) {
			this.renderOneGamepadAction(containerEl, action);
		}

		new Setting(containerEl).addButton((btn) => {
			btn.setButtonText("Ajouter une action").onClick(async () => {
				settings.gamepadActions.push({
					id: generateId(),
					name: "Nouvelle action",
					contact: { kind: "none" },
					effect: { kind: "open-note", link: "" },
					lightCost: 0,
				});
				await this.plugin.saveSettings();
				this.redraw();
			});
		});
	}

	/**
	 * One `GamepadAction`, all controls on a single `Setting` row (`.setClass` + CSS hides the empty
	 * info column and lets the controls wrap): name, contact, effect, effect parameter (target wall
	 * type / linked note, per effect), light cost, delete.
	 */
	private renderOneGamepadAction(containerEl: HTMLElement, action: GamepadAction): void {
		const settings = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		// Which effects a given contact allows: wall effects need a wall contact, `toggle-light` needs a
		// "token lumière" contact, `open-note` fits anything.
		const effectFitsContact = (contact: GamepadActionContact, effect: GamepadActionEffect): boolean => {
			if (effect.kind === "pass-through" || effect.kind === "change-wall-type") return contact.kind === "wall";
			if (effect.kind === "toggle-light") return contact.kind === "token" && contact.category === "light";
			return true;
		};
		const setContact = (contact: GamepadActionContact) => {
			action.contact = contact;
			if (!effectFitsContact(contact, action.effect)) action.effect = { kind: "open-note", link: "" };
		};

		const row = new Setting(containerEl).setClass("map-manager-gamepad-action");

		row.addText((text) => {
			text.setValue(action.name).setPlaceholder("Nom");
			text.onChange(async (value) => {
				action.name = value;
				await save();
			});
		});

		row.addDropdown((dd) => {
			dd.addOption("none", "Contact : rien");
			dd.addOption("wall", "Contact : mur");
			dd.addOption("token:light", "Contact : token lumière");
			dd.addOption("token:player", "Contact : token joueur");
			dd.addOption("token:entity", "Contact : token ennemi");
			dd.setValue(action.contact.kind === "token" ? `token:${action.contact.category}` : action.contact.kind);
			dd.onChange(async (value) => {
				if (value === "wall") setContact({ kind: "wall" });
				else if (value.startsWith("token:")) setContact({ kind: "token", category: value.slice("token:".length) as "light" | "player" | "entity" });
				else setContact({ kind: "none" });
				await save();
				this.redraw();
			});
		});

		row.addDropdown((dd) => {
			if (action.contact.kind === "wall") {
				dd.addOption("pass-through", "Effet : passer outre le mur");
				dd.addOption("change-wall-type", "Effet : changer le type du mur");
			}
			if (action.contact.kind === "token" && action.contact.category === "light") {
				dd.addOption("toggle-light", "Effet : allumer/éteindre la lumière du token");
			}
			dd.addOption("open-note", "Effet : ouvrir une note");
			dd.setValue(action.effect.kind);
			dd.onChange(async (value) => {
				if (value === "pass-through") action.effect = { kind: "pass-through" };
				else if (value === "change-wall-type") action.effect = { kind: "change-wall-type", to: "opaque" };
				else if (value === "toggle-light") action.effect = { kind: "toggle-light" };
				else action.effect = { kind: "open-note", link: "" };
				await save();
				this.redraw();
			});
		});

		if (action.effect.kind === "change-wall-type") {
			const effect = action.effect;
			row.addDropdown((dd) => {
				for (const opt of WALL_BLOCKER_TYPE_OPTIONS) dd.addOption(opt.value, `→ ${opt.label.replace(/\s*\(.*\)\s*$/, "")}`);
				dd.setValue(effect.to);
				dd.onChange(async (value) => {
					effect.to = value as VisionBlockerType;
					await save();
				});
			});
		} else if (action.effect.kind === "open-note") {
			const effect = action.effect;
			row.addButton((btn) => {
				const { path, subpath } = splitLink(effect.link);
				const base = path ? path.split("/").pop()!.replace(/\.md$/, "") : "";
				btn.setButtonText(effect.link ? (subpath ? `${base} › ${subpath}` : base) : "Lier une note…");
				btn.onClick(() => {
					new FileSuggestModal(
						this.app,
						this.app.vault.getMarkdownFiles(),
						(file) => {
							const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
							const commit = async (link: string) => {
								effect.link = link;
								await save();
								this.redraw();
							};
							if (headings.length === 0) {
								void commit(makeLink(file.path));
								return;
							}
							new HeadingSuggestModal(this.app, headings, (heading) => void commit(makeLink(file.path, heading?.heading))).open();
						},
						"Lier une note…"
					).open();
				});
			});
		}

		row.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.min = "0";
			text.inputEl.max = "100";
			text.setValue(String(action.lightCost));
			text.setPlaceholder("Coût");
			text.inputEl.title = "Coût en vie de lumière";
			text.onChange(async (value) => {
				const n = parseFloat(value);
				if (!Number.isNaN(n) && n >= 0) {
					action.lightCost = n;
					await save();
				}
			});
		});

		row.addExtraButton((btn) => {
			btn.setIcon("trash").setTooltip("Supprimer").onClick(async () => {
				settings.gamepadActions = settings.gamepadActions.filter((a) => a.id !== action.id);
				await save();
				this.redraw();
			});
		});
	}
}

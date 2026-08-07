import { App, Modal } from "obsidian";
import { MagicWallsResult } from "../platform/detectMagicWalls";

/**
 * Confirmation step for "Murs magiques" (see Toolbar's wall dropdown and `detectMagicWalls`): the
 * detected wall network is only a preview until the user confirms here — nothing is written to the
 * map until `onConfirm` runs (`MapController.applyMagicWalls`, from the Toolbar's click handler).
 */
export class MagicWallsModal extends Modal {
	constructor(app: App, private result: MagicWallsResult, private onConfirm: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("map-manager-magic-walls-modal");
		contentEl.createEl("h2", { text: "Murs magiques" });

		const summary = contentEl.createDiv({ cls: "map-manager-magic-walls-summary" });
		const swatch = summary.createDiv({ cls: "map-manager-magic-walls-swatch" });
		swatch.style.setProperty("--map-manager-magic-walls-color", this.result.color);
		const count = this.result.wallSegments.length;
		const colorLabel = this.result.manual ? "Couleur choisie" : "Couleur détectée";
		summary.createSpan({ text: `${colorLabel} : ${this.result.color} — ${count} segment${count > 1 ? "s" : ""} de mur détecté${count > 1 ? "s" : ""}.` });

		contentEl.createEl("p", {
			cls: "map-manager-magic-walls-hint",
			text: "Ces murs seront ajoutés au calque actif et fusionnés avec les murs déjà présents (croisements et chevauchements résolus automatiquement).",
		});

		const buttonRow = contentEl.createDiv({ cls: "map-manager-magic-walls-buttons" });
		const cancelBtn = buttonRow.createEl("button", { text: "Annuler", cls: "map-manager-btn" });
		cancelBtn.onclick = () => this.close();
		const confirmBtn = buttonRow.createEl("button", { text: "Appliquer", cls: "map-manager-btn mod-cta" });
		confirmBtn.onclick = () => {
			this.onConfirm();
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

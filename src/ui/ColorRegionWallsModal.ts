import { App, Modal } from "obsidian";
import { ColorRegionWallsResult } from "../platform/detectColorRegionWalls";

/**
 * Confirmation step for "Seau à murs" (see Toolbar's wall-shapes dropdown and
 * `detectColorRegionWalls`), mirroring `MagicWallsModal`: the flood-filled region's boundary is only
 * a preview until the user confirms here — nothing is written to the map until `onConfirm` runs
 * (`MapController.applyMagicWalls`, from `MapCanvas`'s click handler).
 */
export class ColorRegionWallsModal extends Modal {
	constructor(app: App, private result: ColorRegionWallsResult, private onConfirm: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("map-manager-magic-walls-modal");
		contentEl.createEl("h2", { text: "Seau à murs" });

		const summary = contentEl.createDiv({ cls: "map-manager-magic-walls-summary" });
		const swatch = summary.createDiv({ cls: "map-manager-magic-walls-swatch" });
		swatch.style.setProperty("--map-manager-magic-walls-color", this.result.color);
		const segCount = this.result.wallSegments.length;
		summary.createSpan({
			text: `Couleur cliquée : ${this.result.color} — zone de ${this.result.cellCount} case${this.result.cellCount > 1 ? "s" : ""}, ${segCount} segment${segCount > 1 ? "s" : ""} de mur détecté${segCount > 1 ? "s" : ""}.`,
		});

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

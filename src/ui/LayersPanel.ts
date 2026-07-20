import { MapController } from "../controller/MapController";

export class LayersPanel {
	el: HTMLElement;
	private unsubscribe: () => void;
	private collapsed = false;

	constructor(container: HTMLElement, private controller: MapController) {
		this.el = container.createDiv({ cls: "map-manager-layerspanel" });
		this.render();
		this.unsubscribe = this.controller.onChange(() => this.render());
	}

	destroy(): void {
		this.unsubscribe();
	}

	private render(): void {
		this.el.empty();
		this.el.toggleClass("is-collapsed", this.collapsed);

		const header = this.el.createDiv({ cls: "map-manager-layerspanel-header" });
		header.createEl("h5", { text: "Calques" });
		const collapseBtn = header.createEl("button", { text: this.collapsed ? "▸" : "▾", cls: "map-manager-btn map-manager-btn-icon" });
		collapseBtn.setAttribute("aria-label", this.collapsed ? "Déplier les calques" : "Replier les calques");
		collapseBtn.onclick = () => {
			this.collapsed = !this.collapsed;
			this.render();
		};

		if (this.collapsed) return;

		const data = this.controller.getData();
		const editing = this.controller.mode === "edit";
		const list = this.el.createDiv({ cls: "map-manager-layers-list" });

		// Top of the visual stack is shown first (matches typical layer-panel conventions).
		const layers = [...data.layers].reverse();
		layers.forEach((layer, displayIndex) => {
			const row = list.createDiv({ cls: "map-manager-layer-row" });
			if (layer.id === data.activeLayerId) row.addClass("is-active");

			const visBtn = row.createEl("button", { text: layer.visible ? "👁" : "🚫", cls: "map-manager-btn map-manager-btn-icon" });
			visBtn.setAttribute("aria-label", layer.visible ? "Masquer le calque" : "Afficher le calque");
			visBtn.onclick = () => this.controller.toggleLayerVisibility(layer.id);

			if (editing) {
				const activeBtn = row.createEl("button", { text: layer.id === data.activeLayerId ? "●" : "○", cls: "map-manager-btn map-manager-btn-icon" });
				activeBtn.setAttribute("aria-label", "Calque actif (modifiable)");
				activeBtn.onclick = () => this.controller.setActiveLayer(layer.id);

				const nameInput = row.createEl("input", { type: "text", cls: "map-manager-layer-name-input" });
				nameInput.value = layer.name;
				nameInput.onchange = () => this.controller.renameLayer(layer.id, nameInput.value);

				const upBtn = row.createEl("button", { text: "↑", cls: "map-manager-btn map-manager-btn-icon" });
				upBtn.disabled = displayIndex === 0;
				upBtn.onclick = () => this.controller.moveLayer(layer.id, 1);

				const downBtn = row.createEl("button", { text: "↓", cls: "map-manager-btn map-manager-btn-icon" });
				downBtn.disabled = displayIndex === layers.length - 1;
				downBtn.onclick = () => this.controller.moveLayer(layer.id, -1);

				const deleteBtn = row.createEl("button", { text: "🗑", cls: "map-manager-btn map-manager-btn-icon map-manager-btn-danger" });
				deleteBtn.disabled = data.layers.length <= 1;
				deleteBtn.onclick = () => this.controller.removeLayer(layer.id);
			} else {
				row.createSpan({ text: layer.name, cls: "map-manager-layer-name" });
			}
		});

		if (editing) {
			const addBtn = this.el.createEl("button", { text: "Nouveau calque", cls: "map-manager-btn" });
			addBtn.onclick = () => this.controller.addLayer(`Calque ${data.layers.length + 1}`);
		}
	}
}

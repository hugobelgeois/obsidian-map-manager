export interface PublicToolbarActions {
	zoomIn: () => void;
	zoomOut: () => void;
	recenter: () => void;
}

/**
 * Read-only counterpart to `Toolbar`: zoom +/− and recenter only — no fog toggle, no layer
 * switcher, no tools (per the "impossible de jouer depuis le site" requirement). Zero Obsidian
 * dependency, plain DOM only.
 */
export class PublicToolbar {
	el: HTMLElement;

	constructor(container: HTMLElement, actions: PublicToolbarActions) {
		this.el = document.createElement("div");
		this.el.className = "map-manager-toolbar map-manager-public-toolbar";
		container.appendChild(this.el);

		const zoomOutBtn = this.makeButton("−", "Zoom arrière");
		zoomOutBtn.onclick = () => actions.zoomOut();

		const zoomInBtn = this.makeButton("+", "Zoom avant");
		zoomInBtn.onclick = () => actions.zoomIn();

		const recenterBtn = document.createElement("button");
		recenterBtn.className = "map-manager-btn";
		recenterBtn.textContent = "Recentrer";
		recenterBtn.onclick = () => actions.recenter();
		this.el.appendChild(recenterBtn);
	}

	private makeButton(text: string, title: string): HTMLButtonElement {
		const btn = document.createElement("button");
		btn.className = "map-manager-btn map-manager-btn-icon";
		btn.textContent = text;
		btn.title = title;
		this.el.appendChild(btn);
		return btn;
	}

	destroy(): void {
		this.el.remove();
	}
}

import { PublicMapSnapshot } from "../data/mapData";
import { PublicMapCanvas, PublicMapCanvasOptions } from "./PublicMapCanvas";
import { PublicInfoPanel } from "./PublicInfoPanel";
import { PublicToolbar } from "./PublicToolbar";
import { PublicViewController } from "./PublicViewController";

export type MountPublicMapViewerOptions = PublicMapCanvasOptions;

export interface PublicMapViewerHandle {
	controller: PublicViewController;
	destroy(): void;
}

/**
 * Single entry point for embedding the read-only public viewer (e.g. from the exported Svelte
 * site): mounts canvas + toolbar + info panel over `snapshot` (the redacted, note-content-baked
 * export produced by `buildPublicSnapshot`/`renderNoteSnapshot`/`publishPublicSnapshot`) into
 * `container`. Zero Obsidian dependency.
 */
export function mountPublicMapViewer(container: HTMLElement, snapshot: PublicMapSnapshot, options: MountPublicMapViewerOptions = {}): PublicMapViewerHandle {
	const root = document.createElement("div");
	root.className = "map-manager-root map-manager-public-root";
	container.appendChild(root);

	const controller = new PublicViewController(snapshot);

	const body = document.createElement("div");
	body.className = "map-manager-body";

	const canvasHost = document.createElement("div");
	canvasHost.className = "map-manager-canvas-host";
	body.appendChild(canvasHost);
	const canvas = new PublicMapCanvas(canvasHost, controller, options);

	const toolbar = new PublicToolbar(root, {
		zoomIn: () => canvas.zoomBy(1.25),
		zoomOut: () => canvas.zoomBy(0.8),
		recenter: () => canvas.recenter(),
	});
	root.appendChild(body);
	const infoPanel = new PublicInfoPanel(body, controller);

	return {
		controller,
		destroy() {
			canvas.destroy();
			toolbar.destroy();
			infoPanel.destroy();
			root.remove();
		},
	};
}

import { PublicMapSnapshot } from "../data/mapData";
import { PublicMapCanvas, PublicMapCanvasOptions } from "./PublicMapCanvas";
import { PublicInfoPanel } from "./PublicInfoPanel";
import { PublicViewController } from "./PublicViewController";
import { PUBLIC_VIEWER_CSS } from "./publicViewerStyles";

export type MountPublicMapViewerOptions = PublicMapCanvasOptions;

export interface PublicMapViewerHandle {
	controller: PublicViewController;
	canvas: PublicMapCanvas;
	destroy(): void;
}

const STYLE_EL_ID = "map-manager-public-viewer-styles";

/** Injects `PUBLIC_VIEWER_CSS` into `<head>` once, no matter how many maps get mounted on the page. */
function ensureStylesInjected(): void {
	if (document.getElementById(STYLE_EL_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_EL_ID;
	style.textContent = PUBLIC_VIEWER_CSS;
	document.head.appendChild(style);
}

/**
 * Single entry point for embedding the read-only public viewer (e.g. from the exported Svelte
 * site): mounts canvas + info panel over `snapshot` (the redacted, note-content-baked export
 * produced by `buildPublicSnapshot`/`renderNoteSnapshot`/`publishPublicSnapshot`) into `container`,
 * along with default styling (see `publicViewerStyles.ts`). Zero Obsidian dependency. No toolbar —
 * pan (drag) and zoom (wheel) are built into the canvas itself; `canvas`'s `zoomBy`/`recenter` stay
 * available on the returned handle for a host that wants its own controls.
 */
export function mountPublicMapViewer(container: HTMLElement, snapshot: PublicMapSnapshot, options: MountPublicMapViewerOptions = {}): PublicMapViewerHandle {
	ensureStylesInjected();

	const root = document.createElement("div");
	root.className = "map-manager-root map-manager-public-root";
	container.appendChild(root);

	const controller = new PublicViewController(snapshot);

	const body = document.createElement("div");
	body.className = "map-manager-body";
	root.appendChild(body);

	const canvasHost = document.createElement("div");
	canvasHost.className = "map-manager-canvas-host";
	body.appendChild(canvasHost);
	const canvas = new PublicMapCanvas(canvasHost, controller, options);

	const infoPanel = new PublicInfoPanel(body, controller);

	return {
		controller,
		canvas,
		destroy() {
			canvas.destroy();
			infoPanel.destroy();
			root.remove();
		},
	};
}

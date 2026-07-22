import { MapController } from "../controller/MapController";

/**
 * One GM window/tab currently displaying a given map file, looked up by `MapPlayerMirrorView` (see
 * `openPlayerWindow`) so it can share the exact same `MapController` (no polling/lag for token,
 * wall, or layer changes) and follow its live camera. Registered by `MapView`/`MapEmbed` while
 * mounted, unregistered on close — relies on Obsidian popout windows sharing the same plugin
 * instance/JS heap as the main window, so this in-memory registry is visible from any window.
 */
export interface MirrorSource {
	controller: MapController;
	/** The source canvas's current world-space camera (see `MapCanvas.getViewCenter`) — read fresh on every mirror render. */
	getView: () => { zoom: number; x: number; y: number };
	/** Subscribes to the source canvas's pan/zoom changes (see `MapCanvasOptions.onViewportChange`); returns an unsubscribe function. */
	onViewportChange: (cb: () => void) => () => void;
	/** Subscribes to the source InfoPanel's scroll position (see `InfoPanelDeps.onScroll`); returns an unsubscribe function. */
	onScrollChange: (cb: (scrollTop: number) => void) => () => void;
	/** Subscribes to the source canvas's "look here" pings (see `MapCanvasOptions.onPing`); returns an unsubscribe function. */
	onPing: (cb: (x: number, y: number) => void) => () => void;
}

const sources = new Map<string, MirrorSource>();

/** Registers `source` as the mirror target for `path`, replacing any previous one for the same file. Returns an unregister function to call on unmount (a no-op if a newer source has since replaced this one). */
export function registerMirrorSource(path: string, source: MirrorSource): () => void {
	sources.set(path, source);
	return () => {
		if (sources.get(path) === source) sources.delete(path);
	};
}

export function getMirrorSource(path: string): MirrorSource | undefined {
	return sources.get(path);
}

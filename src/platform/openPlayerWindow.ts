import { App, Notice, TFile } from "obsidian";
import { VIEW_TYPE_MAP_PLAYER_MIRROR } from "../view/MapPlayerMirrorView";

/**
 * Pops open a menu-less, read-only mirror of `file` (see `MapPlayerMirrorView`) in a new OS window,
 * meant to be dragged onto a second monitor for players. It shares the same live `MapController` as
 * whichever normal window/tab currently has this file open (see `mirrorRegistry`) — if none does yet,
 * the mirror shows a message asking to open the map normally first.
 */
export async function openPlayerWindow(app: App, file: TFile): Promise<void> {
	try {
		const leaf = app.workspace.openPopoutLeaf({ size: { width: 1280, height: 800 } });
		await leaf.setViewState({ type: VIEW_TYPE_MAP_PLAYER_MIRROR, state: { file: file.path }, active: true });
	} catch (e) {
		console.error("Map Manager: échec de l'ouverture de la fenêtre joueur", e);
		new Notice("Impossible d'ouvrir une nouvelle fenêtre (fonctionnalité desktop uniquement).");
	}
}

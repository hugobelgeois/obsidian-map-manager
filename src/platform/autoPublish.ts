import { App, TFile, debounce } from "obsidian";
import { MapController } from "../controller/MapController";
import { MapManagerSettings } from "../settings/types";
import { publishPublicSnapshot } from "./publishPublicSnapshot";

/**
 * Debounce-regenerates `<map>.json` (see `publishPublicSnapshot`) after `settings.autoPublishDelaySeconds`
 * of inactivity following any change to `controller`'s data, so editors don't have to remember to
 * click "Publier la vue" after every edit. A delay `<= 0` disables this (returns a no-op cleanup).
 * Returns a cleanup function the host component must call on teardown.
 */
export function wireAutoPublish(app: App, file: TFile, controller: MapController, settings: MapManagerSettings): () => void {
	if (settings.autoPublishDelaySeconds <= 0) return () => {};
	const publish = debounce(
		() => {
			publishPublicSnapshot(app, file, controller.getData(), settings).catch((e) => {
				console.error("Map Manager: échec de la republication automatique de la vue publique", e);
			});
		},
		settings.autoPublishDelaySeconds * 1000,
		true
	);
	return controller.onChange(publish);
}

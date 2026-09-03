import { Notice, TextFileView, WorkspaceLeaf } from "obsidian";
import type MapManagerPlugin from "../main";
import { MapController } from "../controller/MapController";
import { parseMapData, serializeMapData } from "../data/mapData";
import { Point } from "../grid/gridMath";
import { extractLayerToNewMap } from "../platform/extractLayerToNewMap";
import { registerMirrorSource } from "../platform/mirrorRegistry";
import { isPlayerWindowOpen, openPlayerWindow } from "../platform/openPlayerWindow";
import { wireAutoPublish } from "../platform/autoPublish";
import { publishPublicSnapshot } from "../platform/publishPublicSnapshot";
import { MapCanvas, PathAnimationRoute } from "../render/MapCanvas";
import { ClockBar } from "../ui/ClockBar";
import { InfoPanel } from "../ui/InfoPanel";
import { Toolbar } from "../ui/Toolbar";

export const VIEW_TYPE_MAP = "map-manager-map-view";

export class MapView extends TextFileView {
	private controller: MapController | null = null;
	private canvasComp: MapCanvas | null = null;
	private clockBarComp: ClockBar | null = null;
	private toolbarComp: Toolbar | null = null;
	private infoPanelComp: InfoPanel | null = null;
	private unsubscribeAutoPublish: (() => void) | null = null;
	private unsubscribeSettings: (() => void) | null = null;
	private unregisterMirror: (() => void) | null = null;
	/** Player mirror windows subscribed to this view's camera via `registerMirrorSource`'s `onViewportChange`. */
	private viewportListeners: Set<() => void> = new Set();
	/** Player mirror windows subscribed to this view's InfoPanel scroll via `registerMirrorSource`'s `onScrollChange`. */
	private scrollListeners: Set<(scrollTop: number) => void> = new Set();
	/** Player mirror windows subscribed to this view's "look here" pings via `registerMirrorSource`'s `onPing`. */
	private pingListeners: Set<(x: number, y: number) => void> = new Set();
	/** Player mirror windows subscribed to this view's "Animation" token-movement tweens via `registerMirrorSource`'s `onPathAnimationStart`. */
	private pathAnimationListeners: Set<(routes: PathAnimationRoute[], speedWorldPerMs: number) => void> = new Set();
	/** Player mirror windows subscribed to this view's gamepad-driven "jump" hops via `registerMirrorSource`'s `onCellHop`. */
	private cellHopListeners: Set<(tokenId: string, from: Point, to: Point) => void> = new Set();
	/** Player mirror windows subscribed to this view's live gamepad right-stick "look" ticks via `registerMirrorSource`'s `onAim`. */
	private aimListeners: Set<(tokenId: string, angleDeg: number | null) => void> = new Set();
	private rootEl: HTMLElement;
	/**
	 * The exact file content we ourselves last wrote to disk (`save`) or loaded from it
	 * (`setViewData`/`handleExternalModify`). `handleExternalModify` compares against *this*, not the
	 * live in-memory state, to tell "another window saved the file" apart from an echo of our own
	 * debounced save.
	 */
	private lastSyncedRaw: string | null = null;
	/**
	 * What `getViewData()` last returned, promoted to `lastSyncedRaw` by `save()` once the write it
	 * feeds has actually landed. Kept separate because Obsidian also calls `getViewData()` when *not*
	 * saving (leaf serialization, tab switches) — writing straight to `lastSyncedRaw` there would let
	 * a late `modify` event from an earlier save read back now-stale disk content that no longer
	 * matches, and `replaceData` every move made since.
	 */
	private pendingSaveRaw: string | null = null;
	/** `controller.dataVersion` captured when `getViewData()` produced `pendingSaveRaw` — promoted to `lastSavedDataVersion` by `save()` once that write lands. */
	private pendingSaveDataVersion = 0;
	/**
	 * `controller.dataVersion` as of our last *completed* save (or the initial load). When the live
	 * `dataVersion` is ahead of this we have edits not yet on disk, so a `modify` event now is our own
	 * still-in-flight (debounced) save echoing back — never an external change to pull in. This is the
	 * real fix for the "gamepad move, token teleports back" bug: while driving a token, moves land
	 * faster than the 2s save debounce, and every `modify` from an earlier save would otherwise
	 * `replaceData` the controller (both the GM tab and the shared player-mirror window) back to that
	 * older snapshot.
	 */
	private lastSavedDataVersion = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: MapManagerPlugin) {
		super(leaf);
		this.contentEl.addClass("map-manager-view");
		this.rootEl = this.contentEl.createDiv({ cls: "map-manager-root" });
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file === this.file) void this.handleExternalModify();
		}));
		// A player-mirror window opening/closing doesn't touch this view's MapController (it's a
		// separate leaf), but the toolbar's player-window button needs to flip between "open" and its
		// options dropdown when that happens — see `isPlayerWindowOpen`/`renderPlayerWindowControl`.
		this.registerEvent(this.app.workspace.on("layout-change", () => this.controller?.refresh()));
	}

	/** Reloads from disk when another open window saved a change to this same file (e.g. this map opened in a second normal tab elsewhere). No-op if the file on disk still matches what we already hold in memory (an echo of our own debounced save). A player mirror window doesn't need this — it shares this instance's `MapController` object directly (see `mirrorRegistry`). */
	private async handleExternalModify(): Promise<void> {
		if (!this.file || !this.controller) return;
		// We have local edits not yet flushed to disk (the save debounce hasn't fired, or its write
		// is still in flight) — this `modify` is our own save echoing back, not an external change.
		// Pulling from disk here would drop everything edited since that write was queued.
		if (this.controller.dataVersion !== this.lastSavedDataVersion) return;
		const raw = await this.app.vault.read(this.file);
		if (raw === this.lastSyncedRaw || raw === serializeMapData(this.controller.getData())) return;
		this.lastSyncedRaw = raw;
		const parsed = parseMapData(raw, this.plugin.getMapDefaults());
		this.controller.replaceData(parsed);
		this.lastSavedDataVersion = this.controller.dataVersion;
	}

	getViewType(): string {
		return VIEW_TYPE_MAP;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Carte";
	}

	getIcon(): string {
		return "map";
	}

	getViewData(): string {
		if (!this.controller) return "";
		const data = serializeMapData(this.controller.getData());
		// Not `lastSyncedRaw`/`lastSavedDataVersion` directly — Obsidian also calls this outside of
		// saving. `save()` promotes both once the write actually lands (see `pendingSaveRaw`).
		this.pendingSaveRaw = data;
		this.pendingSaveDataVersion = this.controller.dataVersion;
		return data;
	}

	async save(clear?: boolean): Promise<void> {
		await super.save(clear);
		// `super.save()` called `getViewData()` and wrote its result — that string is now on disk, so
		// the `modify` event it triggers should read back as our own echo (see `handleExternalModify`).
		if (this.pendingSaveRaw !== null) {
			this.lastSyncedRaw = this.pendingSaveRaw;
			this.lastSavedDataVersion = this.pendingSaveDataVersion;
		}
	}

	setViewData(data: string, _clear: boolean): void {
		this.destroyComponents();
		this.lastSyncedRaw = data;
		const parsed = parseMapData(data, this.plugin.getMapDefaults());
		this.controller = new MapController(parsed, () => this.requestSave());
		this.lastSavedDataVersion = this.controller.dataVersion;
		if (this.file) this.unsubscribeAutoPublish = wireAutoPublish(this.app, this.file, this.controller, this.plugin.settings);
		this.unsubscribeSettings = this.plugin.onSettingsChanged(() => this.controller?.refresh());
		this.mountComponents();
	}

	clear(): void {
		this.destroyComponents();
		this.controller = null;
	}

	private mountComponents(): void {
		if (!this.controller) return;
		this.rootEl.empty();
		this.toolbarComp = new Toolbar(
			this.rootEl,
			this.app,
			{ assetsFolder: this.plugin.settings.assetsFolder, settings: this.plugin.settings },
			this.controller,
			{
				recenter: () => this.canvasComp?.recenter(),
				publish: () => void this.publishView(),
				openPlayerWindow: () => {
					this.controller?.setMode("view");
					if (this.file) void openPlayerWindow(this.app, this.file);
				},
				isPlayerWindowOpen: () => (this.file ? isPlayerWindowOpen(this.app, this.file) : false),
				extractLayer: (layerId) => void this.extractLayer(layerId),
			}
		);
		const body = this.rootEl.createDiv({ cls: "map-manager-body" });
		const canvasHost = body.createDiv({ cls: "map-manager-canvas-host" });
		this.canvasComp = new MapCanvas(canvasHost, this.controller, this.app, this.plugin.settings, {
			onViewportChange: () => {
				for (const cb of this.viewportListeners) cb();
			},
			onPing: (x, y) => {
				for (const cb of this.pingListeners) cb(x, y);
			},
			onPathAnimation: (routes, speedWorldPerMs) => {
				for (const cb of this.pathAnimationListeners) cb(routes, speedWorldPerMs);
			},
			onCellHop: (tokenId, from, to) => {
				for (const cb of this.cellHopListeners) cb(tokenId, from, to);
			},
			onAim: (tokenId, angleDeg) => {
				for (const cb of this.aimListeners) cb(tokenId, angleDeg);
			},
		});
		this.clockBarComp = new ClockBar(canvasHost, this.controller, { interactive: true });
		if (this.file) {
			this.unregisterMirror = registerMirrorSource(this.file.path, {
				controller: this.controller,
				getView: () => this.canvasComp!.getViewCenter(),
				onViewportChange: (cb) => {
					this.viewportListeners.add(cb);
					return () => this.viewportListeners.delete(cb);
				},
				onScrollChange: (cb) => {
					this.scrollListeners.add(cb);
					return () => this.scrollListeners.delete(cb);
				},
				onPing: (cb) => {
					this.pingListeners.add(cb);
					return () => this.pingListeners.delete(cb);
				},
				onPathAnimationStart: (cb) => {
					this.pathAnimationListeners.add(cb);
					return () => this.pathAnimationListeners.delete(cb);
				},
				onCellHop: (cb) => {
					this.cellHopListeners.add(cb);
					return () => this.cellHopListeners.delete(cb);
				},
				onAim: (cb) => {
					this.aimListeners.add(cb);
					return () => this.aimListeners.delete(cb);
				},
			});
		}
		this.infoPanelComp = new InfoPanel(
			body,
			this.app,
			{
				assetsFolder: this.plugin.settings.assetsFolder,
				settings: this.plugin.settings,
				onResizePanel: (width) => {
					this.plugin.settings.infoPanelWidth = width;
					void this.plugin.saveSettings();
				},
				onScroll: (scrollTop) => {
					for (const cb of this.scrollListeners) cb(scrollTop);
				},
			},
			this.controller
		);
	}

	private async publishView(): Promise<void> {
		if (!this.controller || !this.file) return;
		try {
			const target = await publishPublicSnapshot(this.app, this.file, this.controller.getData(), this.plugin.settings);
			new Notice(`Vue publique mise à jour : ${target.path}`);
		} catch (e) {
			console.error("Map Manager: échec de la publication de la vue publique", e);
			new Notice("Échec de la publication de la vue publique.");
		}
	}

	private async extractLayer(layerId: string): Promise<void> {
		if (!this.controller || !this.file) return;
		try {
			const created = await extractLayerToNewMap(this.app, this.file, this.controller.getData(), layerId);
			if (!created) return;
			new Notice(`Calque extrait vers ${created.path}`);
			await this.app.workspace.getLeaf(true).openFile(created);
		} catch (e) {
			console.error("Map Manager: échec de l'extraction du calque", e);
			new Notice("Échec de l'extraction du calque.");
		}
	}

	private destroyComponents(): void {
		this.canvasComp?.destroy();
		this.clockBarComp?.destroy();
		this.toolbarComp?.destroy();
		this.infoPanelComp?.destroy();
		this.unsubscribeAutoPublish?.();
		this.unsubscribeSettings?.();
		this.unregisterMirror?.();
		this.canvasComp = null;
		this.clockBarComp = null;
		this.toolbarComp = null;
		this.infoPanelComp = null;
		this.unsubscribeAutoPublish = null;
		this.unsubscribeSettings = null;
		this.unregisterMirror = null;
		this.viewportListeners.clear();
		this.scrollListeners.clear();
		this.pingListeners.clear();
	}

	async onClose(): Promise<void> {
		this.destroyComponents();
	}
}

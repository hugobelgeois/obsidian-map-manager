import { PublicMapSnapshot } from "../data/mapData";

export type PublicSelection = { type: "cell"; key: string } | { type: "token"; id: string } | { type: "marker"; id: string } | null;

/**
 * Tiny read-only counterpart to `MapController`: holds which cell/token/marker is selected in the
 * public viewer and fans out change notifications, with zero mutation of the underlying snapshot
 * (nothing here is ever written back — see the plan's "impossible de jouer depuis le site").
 */
export class PublicViewController {
	selected: PublicSelection = null;
	private listeners: Set<() => void> = new Set();

	constructor(public readonly snapshot: PublicMapSnapshot) {}

	select(selection: PublicSelection): void {
		const same = JSON.stringify(this.selected) === JSON.stringify(selection);
		if (same) return;
		this.selected = selection;
		this.notify();
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private notify(): void {
		for (const cb of this.listeners) cb();
	}
}

import { Token, isRecord, parseToken } from "../data/mapData";

/**
 * One copied token, stripped of everything that's specific to where it sat on the map it was copied
 * from (`id`/`cellKey`/`x`/`y`) in favor of a world-pixel offset from the copied selection's own
 * centroid — see `offsetX`/`offsetY`. That's what lets a paste drop the whole group anywhere, on any
 * map/grid type/cell size, while keeping their relative layout intact — see `MapController.pasteTokens`.
 */
export interface ClipboardToken extends Omit<Token, "id" | "cellKey" | "x" | "y"> {
	offsetX: number;
	offsetY: number;
}

/** Strips a token's placement-specific fields (`id`/`cellKey`/`x`/`y`) — see `ClipboardToken`. Shared by `MapController.copySelectedTokens` and `parseClipboardTokens`. */
export function stripPlacementFields(token: Token): Omit<Token, "id" | "cellKey" | "x" | "y"> {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop these placement fields.
	const { id, cellKey, x, y, ...rest } = token;
	return rest;
}

/**
 * The token clipboard, shared across every open `MapController` in this Obsidian process — a
 * deliberate exception to "no shared/global state between multiple open instances" (see this
 * plugin's CLAUDE.md): a clipboard is conceptually outside any one map's document, and is exactly
 * what lets "copy on map A, paste on map B" work across two independent `MapController` instances.
 * Session-only (module-level, not persisted) — closing Obsidian clears it, like any OS clipboard
 * would on logout.
 */
let clipboard: ClipboardToken[] = [];

export function setTokenClipboard(tokens: ClipboardToken[]): void {
	clipboard = tokens;
}

export function getTokenClipboard(): ClipboardToken[] {
	return clipboard;
}

export function hasTokenClipboard(): boolean {
	return clipboard.length > 0;
}

/** Tags a Ctrl+C JSON payload as this plugin's own token clipboard format — see `parseClipboardTokens`. */
const CLIPBOARD_KIND = "obsidian-map-manager/tokens";
const CLIPBOARD_VERSION = 1;

interface ClipboardPayload {
	kind: typeof CLIPBOARD_KIND;
	version: number;
	tokens: ClipboardToken[];
}

/**
 * Serializes copied tokens into the JSON written to the real OS clipboard on Ctrl+C (see
 * `MapCanvas`'s keydown handler) — tagged with `kind`/`version` so `parseClipboardTokens` can tell a
 * genuine paste of tokens copied from this plugin apart from anything else that might be on the
 * clipboard (arbitrary text, another app's JSON, ...) rather than guessing from shape alone.
 */
export function serializeClipboardTokens(tokens: ClipboardToken[]): string {
	const payload: ClipboardPayload = { kind: CLIPBOARD_KIND, version: CLIPBOARD_VERSION, tokens };
	return JSON.stringify(payload);
}

/**
 * Inverse of `serializeClipboardTokens` — `null` if `text` isn't (or no longer looks like) tokens
 * copied from this plugin, so a Ctrl+V with unrelated clipboard content is silently ignored rather
 * than crashing on malformed data. Each token itself is validated by reusing `parseToken` (a
 * clipboard token is a `.map` file's own `Token` shape minus `id`/`cellKey`/`x`/`y`, plus
 * `offsetX`/`offsetY` — see `ClipboardToken`) against a synthesized placeholder id, since `parseToken`
 * requires one but a clipboard token never carries its old id forward.
 */
export function parseClipboardTokens(text: string): ClipboardToken[] | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(data) || data.kind !== CLIPBOARD_KIND || !Array.isArray(data.tokens)) return null;
	const tokens: ClipboardToken[] = [];
	for (const raw of data.tokens) {
		if (!isRecord(raw) || typeof raw.offsetX !== "number" || typeof raw.offsetY !== "number") continue;
		const token = parseToken({ ...raw, id: "clipboard" });
		if (!token) continue;
		tokens.push({ ...stripPlacementFields(token), offsetX: raw.offsetX, offsetY: raw.offsetY });
	}
	return tokens;
}

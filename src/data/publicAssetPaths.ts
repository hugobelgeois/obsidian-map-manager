import { MapFileData } from "./mapData";

/**
 * Vault-relative asset paths (backgrounds, token images, note-embedded media) become site-root
 * references — the site-export plugin copies every vault attachment into the Svelte project's
 * `static/` folder *flattened by filename*, dropping the original vault subfolder, so the site
 * reference is always `/<basename>`, never the full vault-relative path.
 */
export function toSiteAssetPath(vaultPath: string): string {
	const basename = vaultPath.split("/").pop();
	return `/${basename || vaultPath}`;
}

/**
 * Vault-relative note path -> site page path. Unlike `toSiteAssetPath`, note pages are NOT
 * flattened: the site-export plugin mirrors the vault's folder structure for notes (the same
 * assumption `customScript.ts`'s `./`/`../` map-path resolution already relies on), so the full
 * relative path survives, just with the `.md` extension stripped (clean-URL routing) and each
 * segment percent-encoded. The site's routes are trailing-slash-only — without it the page 404s —
 * so the returned path always ends in `/`, even when a `#subpath` anchor is appended after it.
 */
export function toSiteNotePath(vaultPath: string): string {
	const withoutExt = vaultPath.endsWith(".md") ? vaultPath.slice(0, -".md".length) : vaultPath;
	const encoded = withoutExt
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `/${encoded}/`;
}

/**
 * Rewrites every background/token image path in `data` to a site-root-absolute reference (see
 * `toSiteAssetPath`) — run on the redacted snapshot (see `buildPublicSnapshot`) before it's baked
 * into `<map>.json`, so `PublicMapCanvas`'s default asset resolution just works without the
 * external site needing any path-rewriting logic of its own.
 */
export function rewriteAssetPathsForSite(data: MapFileData): MapFileData {
	return {
		...data,
		layers: data.layers.map((layer) =>
			layer.background ? { ...layer, background: { ...layer.background, path: toSiteAssetPath(layer.background.path) } } : layer
		),
		tokens: data.tokens.map((token) => (token.image ? { ...token, image: toSiteAssetPath(token.image) } : token)),
	};
}

import { MapFileData } from "./mapData";

/**
 * Vault-relative asset paths (backgrounds, token images) become site-root-absolute references —
 * the site-export plugin copies vault attachments under the Svelte project's `static/` folder,
 * which SvelteKit serves at the site root with the `static/` segment stripped, so "root-absolute"
 * and "path inside `static/`" are the same thing.
 */
function toSiteAssetPath(vaultPath: string): string {
	return vaultPath.startsWith("/") ? vaultPath : `/${vaultPath}`;
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

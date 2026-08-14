import { App } from "obsidian";
import { ensureFolder, sanitizeFileName } from "../utils";
import { loadImage } from "./detectMagicWalls";

/**
 * Loads `sourcePath` (a vault image) and writes a downscaled `size`×`size` square PNG copy under
 * `assetsFolder`, cropped to a centered "cover" square (the shorter source dimension sets the crop,
 * so nothing gets stretched/distorted) — used when picking a vault image as a pion "logo" (see
 * `InfoPanel.pickVaultTokenImage`), so a large source image (a full-resolution character portrait,
 * say) doesn't end up stored and reloaded at full resolution just to be drawn as a small icon.
 * Reuses `loadImage` from `detectMagicWalls.ts` rather than duplicating vault image loading. Returns
 * the new file's vault path.
 */
export async function resizeImageToSquare(app: App, sourcePath: string, size: number, assetsFolder: string): Promise<string> {
	const img = await loadImage(app, sourcePath);
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Impossible de redimensionner l'image (contexte de rendu indisponible).");
	const srcSize = Math.min(img.naturalWidth, img.naturalHeight);
	const srcX = (img.naturalWidth - srcSize) / 2;
	const srcY = (img.naturalHeight - srcSize) / 2;
	ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, size, size);

	const blob = await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Échec de l'export de l'image redimensionnée."))), "image/png");
	});
	const buffer = await blob.arrayBuffer();
	const folder = assetsFolder || "Map Assets";
	await ensureFolder(app, folder);
	const baseName = sourcePath.split("/").pop() ?? "image";
	const path = `${folder}/${Date.now()}-${sanitizeFileName(baseName)}.png`;
	const created = await app.vault.createBinary(path, buffer);
	return created.path;
}

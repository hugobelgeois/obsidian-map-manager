import { App, normalizePath, TFolder } from "obsidian";

export async function ensureFolder(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (!normalized || normalized === "/") return;
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFolder) return;
	if (existing) return;
	await app.vault.createFolder(normalized).catch(() => undefined);
}

export function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_");
}

export function generateId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

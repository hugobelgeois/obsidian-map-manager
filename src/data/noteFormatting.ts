/** Drops a leading YAML frontmatter block (`---\n...\n---`) from raw note Markdown, if present. */
export function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/** Renders a frontmatter value (used for a token's stat-block fields) as plain text. */
export function formatFrontmatterValue(value: unknown): string {
	if (value === undefined || value === null) return "—";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(formatFrontmatterValue).join(", ");
	return JSON.stringify(value);
}

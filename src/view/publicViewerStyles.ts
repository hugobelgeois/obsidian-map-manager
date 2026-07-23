/**
 * Self-contained default styling for the public viewer, just enough to lay out the canvas + info
 * panel like the in-Obsidian view (info panel docked right, in its own bordered pane) instead of
 * stacking as unstyled blocks. Injected once by `mountPublicMapViewer`. Every rule is scoped under
 * `.map-manager-public-root`/`-canvas`/`-infopanel` (never the bare `.map-manager-*` classes
 * Obsidian's own `styles.css` targets), and uses normal specificity, so the host site's own CSS can
 * override any of it freely.
 *
 * Colors reference real Obsidian CSS variables (--background-primary, --text-normal, etc.) with
 * the plugin's old hardcoded light-theme values as fallbacks. Inside Obsidian these variables are
 * always defined, so the viewer now follows the user's actual theme instead of a fixed palette. A
 * site-export plugin that mirrors Obsidian's variable names in its own site-wide CSS (as
 * obsidian-svelte-export's app.css does) gets correct theming on the exported site for free too, in
 * both light and dark mode, with no plugin-specific CSS needed on that end — which is also why
 * there's no `@media (prefers-color-scheme: dark)` block here anymore: dark mode is just whichever
 * values these variables resolve to under `.theme-dark`.
 */
export const PUBLIC_VIEWER_CSS = `
.map-manager-public-root {
	display: flex;
	flex-direction: column;
	width: 100%;
	height: 100%;
	background: var(--background-primary, #f5f5f4);
	color: var(--text-normal, #1b1b1b);
	font-family: var(--font-interface, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
.map-manager-public-root .map-manager-body {
	display: flex;
	flex: 1 1 auto;
	min-height: 0;
}
.map-manager-public-root .map-manager-canvas-host {
	flex: 1 1 auto;
	position: relative;
	overflow: hidden;
	background: var(--background-secondary, #e8e6e1);
}
.map-manager-public-canvas {
	display: block;
	touch-action: none;
	cursor: grab;
}
.map-manager-public-canvas:active {
	cursor: grabbing;
}
.map-manager-public-infopanel {
	flex: 0 0 0;
	width: 0;
	overflow: hidden;
	border-left: 1px solid var(--background-modifier-border, #d8d5cf);
	/* The docked panel reads as a sidebar, not page content — --background-secondary
	   (the same tone used for the canvas-host area) rather than --background-primary-alt. */
	background: var(--background-secondary, #1e1e1e);
	transition: width 0.15s ease, flex-basis 0.15s ease;
}
.map-manager-public-infopanel.is-open {
	flex: 0 0 var(--map-manager-infopanel-width, 300px);
	width: var(--map-manager-infopanel-width, 300px);
	overflow-y: auto;
	padding: 0.9em;
	box-sizing: border-box;
}
.map-manager-public-infopanel-resize-handle {
	flex: 0 0 0;
	width: 0;
	cursor: ew-resize;
	position: relative;
}
.map-manager-public-infopanel-resize-handle.is-open {
	flex: 0 0 5px;
	width: 5px;
}
.map-manager-public-infopanel-resize-handle.is-open:hover,
.map-manager-public-infopanel-resize-handle.is-open:active {
	background: var(--interactive-accent, #4f9eff);
}
.map-manager-public-infopanel .map-manager-infopanel-empty {
	display: none;
}
.map-manager-public-infopanel .map-manager-infopanel-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 0.6em;
}
.map-manager-public-infopanel .map-manager-infopanel-header h4 {
	margin: 0;
	font-size: 1.05em;
}
.map-manager-public-infopanel .map-manager-btn,
.map-manager-public-infopanel .map-manager-btn-icon {
	/* --interactive-accent is the variable actually meant for a button's own
	   surface (as opposed to --background-primary-alt/-secondary, which are
	   page/panel surface tiers a theme may color completely independently —
	   e.g. as a decorative frame accent unrelated to interactive elements). */
	background: var(--interactive-accent, #eeece7);
	color: var(--text-on-accent, inherit);
	border: 1px solid var(--interactive-accent, #d8d5cf);
	border-radius: 4px;
	padding: 0.3em 0.55em;
	font-size: 0.85em;
	cursor: pointer;
}
.map-manager-public-infopanel .map-manager-btn:hover {
	background: var(--interactive-accent-hover, #e2dfd9);
}
.map-manager-public-infopanel .map-manager-field {
	margin-bottom: 0.9em;
	font-size: 0.85em;
	color: var(--text-muted, #55524a);
}
.map-manager-public-infopanel .map-manager-view-summary {
	display: flex;
	align-items: center;
	gap: 0.5em;
	margin-bottom: 0.75em;
	font-size: 0.95em;
}
.map-manager-public-infopanel .map-manager-view-stamp {
	font-size: 1.6em;
	line-height: 1;
}
.map-manager-public-infopanel .map-manager-view-label {
	font-weight: 600;
}
.map-manager-public-infopanel .map-manager-view-empty,
.map-manager-public-infopanel .map-manager-view-error {
	color: var(--text-muted, #86827a);
	font-size: 0.9em;
}
.map-manager-public-infopanel .map-manager-view-tabs {
	display: flex;
	flex-wrap: wrap;
	gap: 0.25em;
	border-bottom: 1px solid var(--background-modifier-border, #d8d5cf);
	margin-bottom: 0.75em;
	padding-bottom: 0.5em;
}
.map-manager-public-infopanel .map-manager-tab {
	background: transparent;
	border: 1px solid var(--background-modifier-border, #d8d5cf);
	border-radius: 4px;
	padding: 0.2em 0.6em;
	font-size: 0.8em;
	cursor: pointer;
	color: var(--text-muted, #55524a);
}
.map-manager-public-infopanel .map-manager-tab.is-active {
	background: var(--interactive-accent, #4f9eff);
	color: var(--text-on-accent, #fff);
	border-color: var(--interactive-accent, #4f9eff);
}
.map-manager-public-infopanel .map-manager-view-content {
	font-size: 0.9em;
	line-height: 1.5;
}
.map-manager-public-infopanel .map-manager-view-content :first-child {
	margin-top: 0;
}
/*
 * Generic styling for a linked note's rendered content (see renderNoteSnapshot.ts) — this is
 * arbitrary Markdown HTML that may rely on the vault's own theme/CSS snippets for its exact look;
 * these rules just keep it readable (spacing, borders, sizing) using the same Obsidian CSS
 * variables as the rest of this stylesheet, rather than attempting to replicate any specific
 * Obsidian theme's markdown rendering rule-for-rule.
 */
.map-manager-public-infopanel .map-manager-view-content h1,
.map-manager-public-infopanel .map-manager-view-content h2,
.map-manager-public-infopanel .map-manager-view-content h3,
.map-manager-public-infopanel .map-manager-view-content h4,
.map-manager-public-infopanel .map-manager-view-content h5,
.map-manager-public-infopanel .map-manager-view-content h6 {
	margin: 0.9em 0 0.4em;
	line-height: 1.25;
}
.map-manager-public-infopanel .map-manager-view-content p {
	margin: 0.5em 0;
}
.map-manager-public-infopanel .map-manager-view-content img {
	max-width: 100%;
	height: auto;
	border-radius: 4px;
}
.map-manager-public-infopanel .map-manager-view-content ul,
.map-manager-public-infopanel .map-manager-view-content ol {
	margin: 0.4em 0;
	padding-left: 1.4em;
}
.map-manager-public-infopanel .map-manager-view-content hr {
	border: none;
	border-top: 1px solid var(--background-modifier-border, #d8d5cf);
	margin: 1em 0;
}
.map-manager-public-infopanel .map-manager-view-content a.internal-link,
.map-manager-public-infopanel .map-manager-view-content a.external-link {
	color: var(--link-color, var(--interactive-accent, #705dcf));
	text-decoration: var(--link-decoration, underline);
	cursor: pointer;
}
.map-manager-public-infopanel .map-manager-view-content a.internal-link:hover,
.map-manager-public-infopanel .map-manager-view-content a.external-link:hover {
	color: var(--link-color-hover, var(--interactive-accent-hover, #8875e8));
	text-decoration: var(--link-decoration-hover, underline);
}
.map-manager-public-infopanel .map-manager-view-content code {
	font-family: var(--font-monospace, ui-monospace, SFMono-Regular, Menlo, monospace);
	font-size: 0.85em;
	background: var(--code-background, #eeece7);
	color: var(--code-normal, inherit);
	border-radius: 3px;
	padding: 0.1em 0.3em;
}
.map-manager-public-infopanel .map-manager-view-content blockquote {
	margin: 0.5em 0;
	padding: 0.2em 0.8em;
	border-left: 3px solid var(--blockquote-border-color, #d8d5cf);
	color: var(--blockquote-color, #55524a);
}
.map-manager-public-infopanel .map-manager-view-content table {
	width: 100%;
	border-collapse: collapse;
	margin: 0.6em 0;
	font-size: 0.85em;
	table-layout: fixed;
}
.map-manager-public-infopanel .map-manager-view-content th,
.map-manager-public-infopanel .map-manager-view-content td {
	border: 1px solid var(--background-modifier-border, #d8d5cf);
	padding: 0.3em 0.5em;
	overflow-wrap: break-word;
}
.map-manager-public-infopanel .map-manager-view-content th {
	/* Same variable (and fallback chain) as an ordinary markdown table's <th>
	   (see markdown.css) — themes that give table headers their own accent
	   color (e.g. a light red distinct from every surface tier) apply it
	   here too, instead of this falling back to a surface color that may
	   clash with or blend into the panel background. */
	background: var(--table-header-background, var(--background-secondary));
}
.map-manager-public-infopanel .map-manager-view-content tr:nth-child(even) td {
	/* Same rule (and variable) as markdown.css's .markdown-rendered tr:nth-child(even) td —
	   that site-wide rule only targets .markdown-rendered, which this baked note content
	   never carries (it's rendered under .map-manager-view-content instead), so without this
	   the zebra-striping a theme defines for ordinary tables never showed up here. */
	background: var(--table-row-even-background, transparent);
}
.map-manager-public-infopanel .map-manager-token-stats {
	margin-bottom: 0.75em;
	border: 1px solid var(--background-modifier-border, #d8d5cf);
	border-radius: 4px;
	overflow: hidden;
}
.map-manager-public-infopanel .map-manager-token-stat-row {
	display: flex;
	justify-content: space-between;
	gap: 0.5em;
	padding: 0.25em 0.5em;
	font-size: 0.85em;
}
.map-manager-public-infopanel .map-manager-token-stat-row:nth-child(even) {
	/* Same variable (and transparent fallback) as ordinary markdown table
	   zebra-striping — a surface-tier color like --background-secondary-alt
	   is an absolute value some themes set far apart from
	   --background-primary-alt (this panel's own background), which can
	   read as a jarring, near-inverted block instead of a subtle stripe. */
	background: var(--table-row-even-background, transparent);
}
.map-manager-public-infopanel .map-manager-token-stat-key {
	color: var(--text-muted, #86827a);
	text-transform: capitalize;
}
.map-manager-public-infopanel .map-manager-token-stat-value {
	font-weight: 600;
}
`;

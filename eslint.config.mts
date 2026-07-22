import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Files bundled into the portable, read-only public map viewer (see src/view/customScript.ts,
		// built to map-manager-viewer.js) must stay importable outside Obsidian — never let an
		// `obsidian` import creep back in here.
		files: [
			"src/grid/**/*.ts",
			"src/data/**/*.ts",
			"src/controller/**/*.ts",
			"src/render/drawing.ts",
			"src/view/PublicMapCanvas.ts",
			"src/view/PublicInfoPanel.ts",
			"src/view/PublicViewController.ts",
			"src/view/publicViewerStyles.ts",
			"src/view/mountPublicMapViewer.ts",
			"src/view/customScript.ts",
		],
		rules: {
			"no-restricted-imports": ["error", { paths: [{ name: "obsidian", message: "This module is part of the portable public viewer and must stay Obsidian-independent." }] }],
			// `setCssProps` (Obsidian's recommended alternative) isn't available outside Obsidian — these files render in plain browsers too.
			"obsidianmd/no-static-styles-assignment": "off",
			// There's no plugin-managed `styles.css` on the external site — mountPublicMapViewer injects its own `<style>` (see publicViewerStyles.ts).
			"obsidianmd/no-forbidden-elements": "off",
			// `requestUrl` (Obsidian's recommended alternative) isn't available outside Obsidian either — customScript.ts fetches from the visitor's own browser.
			"no-restricted-globals": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"map-manager-viewer.js",
	]),
);

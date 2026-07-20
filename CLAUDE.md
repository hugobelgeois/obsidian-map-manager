# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Obsidian plugin (`obsidian-map-manager`) that lets users design interactive square/hexagonal grid maps with a background image, zone coloring, stamps, tokens, and note links, either in a dedicated file view or embedded in a note via a `map` code block. Map data is stored as JSON in `.map` files inside the vault (a custom file extension registered by the plugin). UI strings in the source are in French (this is the plugin's actual UI language, not a placeholder).

## Commands

- `npm run dev` — compile `src/main.ts` → `main.js` in watch mode (esbuild).
- `npm run build` — type-check (`tsc -noEmit -skipLibCheck`) then produce a minified production `main.js`.
- `npm run lint` — run ESLint (`eslint-plugin-obsidianmd` recommended rules + typescript-eslint).
- There is no test suite in this repo.
- To try changes in Obsidian: this plugin's repo lives directly inside a vault's `.obsidian/plugins/obsidian-map-manager` folder, so `npm run dev` + reloading Obsidian (or disabling/re-enabling the plugin) is the whole dev loop. `main.js` is gitignored — it's built locally, not committed.

## Architecture

**Data flow:** `MapFileData` (in [src/data/mapData.ts](src/data/mapData.ts)) is the single serialized JSON shape for a `.map` file. `parseMapData`/`serializeMapData` are the only read/write boundary — all migration logic for old file versions lives in `normalizeMapData` (see "Versioning" below). Everything else — controller, canvas, UI panels — operates on the in-memory `MapFileData` object, never on raw JSON.

**MapController** ([src/controller/MapController.ts](src/controller/MapController.ts)) owns one open map's `MapFileData` plus UI-only session state (selection, active tool, brush settings, undo/redo stack). It's the sole mutation point: all edits go through `update()`, which snapshots history, runs the mutator, notifies listeners, and triggers save. Both the full-tab view and embedded-in-note view construct their own `MapController` instance around the same data shape — there's no shared/global state between multiple open instances of the same map.

**Two hosts, one component tree:** [src/view/MapView.ts](src/view/MapView.ts) (a `TextFileView` for `.map` files opened as a tab, mode `"edit"`) and [src/view/MapEmbed.ts](src/view/MapEmbed.ts) (a markdown code-block processor for `` ```map `` blocks, mode `"view"`, read/written via `app.vault.process` with a debounced save) both wire up the same four UI components against a `MapController`: `Toolbar`, `LayersPanel`, `MapCanvas`, `InfoPanel`. When changing how these fit together, keep both call sites in sync.

**MapCanvas** ([src/render/MapCanvas.ts](src/render/MapCanvas.ts), ~1200 lines) is a hand-rolled `<canvas>` 2D renderer and input handler — no framework, no virtual DOM. It owns pan/zoom (`ViewTransform`), hit-testing, drag state for tokens/markers, brush/fill painting, and fog-of-war (line-of-sight + vision cones). Grid math (coordinate conversions, hex/square cell lookup, visible-cell culling) is factored out into [src/grid/gridMath.ts](src/grid/gridMath.ts) and is pure/stateless — prefer adding new coordinate math there rather than inline in the canvas.

**Grid types:** `"square"`, `"hex-pointy"`, `"hex-flat"`, `"none"` (freeform, no cells — tokens/markers get free `x,y` world coordinates instead of a `cellKey`). Most cell-keyed data (`CellData`) is stored per-grid-type in `cellsByGridType` so switching grid types on a map doesn't lose data from the other type. Tokens are map-level (not per-layer or per-grid-type) so they persist across layer/grid-type switches; their `cellKey` is just reinterpreted under whichever grid is currently active.

**Layers:** each `Layer` has its own background image, `cellsByGridType`, and freeform `markers`; tokens are layer-independent (see above). Only one layer is "active" (edited) at a time via `activeLayerId`.

**Fog of war:** `exploredCells` persists which cells have ever been lit by a player token's vision cone (view mode only). In grid type `"none"`, fog still runs on a hidden `square` cell substrate even though there's no visible/editable grid — see the comment on `MapController.updateCell`.

**Versioning:** `MapFileData.version` is bumped whenever the stored shape changes; `normalizeMapData` in [src/data/mapData.ts](src/data/mapData.ts) contains the full migration chain (pixel-vs-cell background offsets pre-v3, per-layer vs. map-level tokens pre-v5/v6, boolean vs. string vision blockers pre-v10, etc.). When changing `MapFileData`, bump `version` and add a migration branch rather than assuming old files match the new shape.

**Settings** ([src/settings/types.ts](src/settings/types.ts)) hold the *defaults* applied to newly-created maps (grid type, cell size, zone types, token templates, zoom range) plus the assets folder and embed height — they don't affect existing `.map` files after creation.

## Conventions

- Tabs for indentation, LF line endings, UTF-8 (see [.editorconfig](.editorconfig)).
- `noUncheckedIndexedAccess` and `strictNullChecks` are on — index access into records/arrays returns possibly-`undefined`; handle it rather than asserting.
- `main.js` is a generated bundle (esbuild banner points back to source) — never hand-edit it; edit `src/` and rebuild.
- ESLint config extends `eslint-plugin-obsidianmd`'s recommended rules — follow Obsidian-specific API guidance it enforces (e.g. around `normalizePath`, detached DOM, etc.).

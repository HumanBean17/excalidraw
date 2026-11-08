# Excalidraw MCP

A local, persistent Model Context Protocol server for agent-driven Excalidraw drawings. One HTTP server owns the store and browser synchronization; MCP clients and agents share it without maintaining separate scene caches.

Version 3 uses an agent-first API by default: concise batch creation, compact mutation results, summary scene reads, paginated element queries, validation, and SVG/PNG rendering. Raw Excalidraw element tools remain available in the `advanced` profile.

## Requirements

- Node.js 20 or newer.
- This repository's Excalidraw app for live browser display (optional for storage and editing through MCP).
- Rendering uses the optional `@excalidraw/excalidraw`, `esbuild`, and `jsdom` dependencies. PNG rendering additionally uses Playwright Chromium. If Chromium is not already installed, run `npx playwright install chromium`.

Optional dependencies are installed by default. If they were disabled, storage and editing still work, but `render_drawing` returns an actionable dependency error.

## Start

Install and run the standalone package:

```sh
npm install -g excalidraw-mcp
excalidraw-mcp serve
```

Or run this checkout without installing it globally:

```sh
cd mcp-server
npm ci
npm start
```

For rendering from a checkout, build the local Excalidraw packages first from the repository root:

```sh
yarn build:packages
```

The MCP endpoint is `http://127.0.0.1:3845/mcp`. Drawings are stored in `~/.excalidraw` by default. On first launch, an existing default `~/.excalidraw-mcp` store is moved there automatically; the server refuses to overwrite an existing `~/.excalidraw` directory. To use another location or port:

```sh
excalidraw-mcp serve --data-dir /path/to/store --port 3845
```

Start the browser app separately from the repository root:

```sh
yarn start
```

The app connects to `http://127.0.0.1:3845`. Set `VITE_APP_MCP_URL` before launching Vite if the bridge uses a different origin. A browser does not need to be open for MCP tools, including rendering, to work; open or reload it later and it receives the active persisted drawing.

Open **Main menu → Projects** to create, select, open, and delete projects and drawings in the browser. The dialog refreshes when connected agents change the store. Creating, opening, or deleting the active drawing first flushes pending browser edits so a drawing switch cannot discard the save debounce.

## MCP client configuration

For clients with Streamable HTTP support, use:

```json
{
  "mcpServers": {
    "excalidraw": {
      "url": "http://127.0.0.1:3845/mcp"
    }
  }
}
```

For stdio-only clients, keep the HTTP server running and configure the proxy:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "excalidraw-mcp",
      "args": ["stdio", "--url", "http://127.0.0.1:3845/mcp"]
    }
  }
}
```

The stdio command deliberately does not start an independent store. Start `excalidraw-mcp serve` first so all clients share the same data and mutation queue.

## Agent workflow

1. `create_project` with a name.
2. `create_drawing` with the returned `projectId` and a drawing name. It opens in connected browsers by default.
3. Call `create_elements` with concise element specs. The server generates Excalidraw IDs, defaults, text metrics, versions, and geometry; do not relay full elements through `draw_shape`.
4. Inspect with `get_scene` summaries or paginated element views, then call `validate_scene` and `render_drawing`.
5. Use the returned `drawingId` and `revision` in subsequent calls. Pass the last known revision as `expectedRevision` for read-modify-write workflows.

A single creation call can establish containers, frames, groups, and arrow bindings through local `ref` values:

```json
{
  "drawingId": "drawing-1",
  "expectedRevision": 0,
  "elements": [
    {
      "ref": "service",
      "type": "rectangle",
      "x": 100,
      "y": 100,
      "width": 180,
      "height": 80,
      "group": "services"
    },
    {
      "ref": "label",
      "type": "text",
      "x": 120,
      "y": 125,
      "container": "service",
      "text": "API\nGateway"
    },
    {
      "ref": "target",
      "type": "rectangle",
      "x": 400,
      "y": 100,
      "width": 180,
      "height": 80,
      "group": "services"
    },
    {
      "ref": "edge",
      "type": "arrow",
      "x": 280,
      "y": 140,
      "points": [
        [0, 0],
        [120, 0]
      ],
      "startBinding": "service",
      "endBinding": "target"
    }
  ]
}
```

The result contains only mutation metadata and the created `id`/`ref` pairs. In JSON, `\n` encodes an actual newline. `\\n` encodes a literal backslash followed by `n`; the server deliberately does not unescape it.

For linear elements, dimensions are derived from point bounds. Points are canonicalized relative to the first point. Text additions and text patches populate or update `originalText`, dimensions, baseline, and line-height fields consistently.

Updates and deletions are atomic: an unknown element ID rejects the whole call. Empty patches and other no-op mutations do not increment the drawing revision.

## Token-efficient inspection

`get_scene` defaults to a summary containing drawing metadata, element counts by type, bounds, and revision. It does not return elements, app state, or embedded file data.

Use `detail: "elements"` for a projected page:

```json
{
  "drawingId": "drawing-1",
  "detail": "elements",
  "limit": 50,
  "fields": ["id", "type", "x", "y", "width", "height", "text"],
  "type": "rectangle",
  "search": "gateway"
}
```

Pass the returned `nextCursor` to retrieve the next page. Filters include `ids`, `type`, case-insensitive text `search`, and a bounding `region`. `includeAppState` and `includeFiles` are explicit opt-ins. Embedded files can otherwise contain large base64 payloads.

Use `detail: "full"` only when complete raw elements, app state, and files are required. `get_active_drawing` similarly defaults to metadata and accepts `detail: "full"`.

## Validation and rendering

`validate_scene` reports invalid geometry, broken containers/frames/bindings, duplicate IDs, empty or overlapping text, and elements outside optional requested bounds. Diagnostics are bounded by `limit` and identify the drawing revision.

`render_drawing` writes an SVG or PNG under `~/.excalidraw/exports` and returns its path, dimensions, element count, and revision. Options include `scale`, `padding`, `background`, and selected element `ids`. For visual agent inspection, request `format: "png"` with `preview: true`; the response then includes MCP image content. Preview data is never duplicated into structured JSON.

## Tools

The default `agent` profile contains:

- Projects: `list_projects`, `create_project`, `delete_project`.
- Drawings: `list_drawings`, `create_drawing`, `open_drawing`, `delete_drawing`, `get_active_drawing`.
- Authoring: `create_elements`, `update_elements`, `delete_elements`, `clear_scene`.
- Inspection and view: `get_scene`, `validate_scene`, `render_drawing`, `set_viewport`.

Start with `--tool-profile advanced` or set `EXCALIDRAW_MCP_TOOL_PROFILE=advanced` to additionally expose `draw_shape`, `add_elements`, and `update_scene` for raw Excalidraw interoperability. Raw inputs use the same text and linear-element normalization.

Every mutation returns a drawing revision. Mutations are serialized per drawing, so concurrent additions do not overwrite each other. A stale `expectedRevision` is rejected instead of silently overwriting newer work. Browser reports use the same conflict protection.

The file layout is intentionally transparent:

```text
~/.excalidraw/
  active.json
  exports/
  projects/
    <project-id>/
      project.json
      drawings/
        <drawing-id>.json
```

Writes use a synced temporary file and atomic rename. Elements, app state, and embedded files are persisted. Keep backups of the store directory for important work.

`delete_project` only accepts an empty, inactive project. To remove a project, open a drawing in another project, delete all drawings in the unwanted project, and then delete the project.

## Configuration and security

Environment variables: `EXCALIDRAW_MCP_HOST`, `EXCALIDRAW_MCP_PORT`, `EXCALIDRAW_MCP_DATA_DIR`, `EXCALIDRAW_MCP_URL`, `EXCALIDRAW_MCP_ALLOWED_ORIGINS`, and `EXCALIDRAW_MCP_TOOL_PROFILE`.

The server has no authentication and only binds to a loopback address. Do not expose it to a shared or public network. Browser CORS accepts loopback origins by default; additional exact origins can be supplied with `--allowed-origins`. Anyone or any process with local access can modify the store.

`GET /health` returns service health. `GET /scene` and the SSE endpoint `/events` are used by the browser bridge; `POST /report` persists revisioned browser changes.

## Verify

```sh
cd mcp-server
npm test
npm pack --dry-run
```

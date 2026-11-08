# Excalidraw MCP

A local, persistent Model Context Protocol server for Excalidraw. One HTTP server owns the store and browser synchronization; MCP clients and agents share it without maintaining separate scene caches.

## Requirements

- Node.js 20 or newer
- This repository's Excalidraw app for live browser display (optional for storage and editing through MCP)

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

The MCP endpoint is `http://127.0.0.1:3845/mcp`. Drawings are stored in `~/.excalidraw` by default. On first launch, an existing default `~/.excalidraw-mcp` store is moved there automatically; the server refuses to overwrite an existing `~/.excalidraw` directory. To use another location or port:

```sh
excalidraw-mcp serve --data-dir /path/to/store --port 3845
```

Start the browser app separately from the repository root:

```sh
yarn start
```

The app connects to `http://127.0.0.1:3845`. Set `VITE_APP_MCP_URL` before launching Vite if the bridge uses a different origin. A browser does not need to be open for MCP tools to work; open or reload it later and it receives the active persisted drawing.

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

## Projects and drawings

A typical workflow is:

1. `create_project` with a name.
2. `create_drawing` with the returned `projectId` and a drawing name. It opens in connected browsers by default.
3. Use `draw_shape` to construct elements and `add_elements` to commit them.
4. Use the returned `drawingId` in subsequent scene calls. This avoids ambiguity when several agents work concurrently.
5. Use `list_projects`, `list_drawings`, and `open_drawing` to navigate the store.

Every mutation increments a drawing revision. Mutations are serialized per drawing, so concurrent additions do not overwrite each other. For replacement or read-modify-write workflows, pass the last known revision as `expectedRevision`; a stale update is rejected instead of silently overwriting newer work. Browser reports use the same conflict protection.

The file layout is intentionally transparent:

```text
~/.excalidraw/
  active.json
  projects/
    <project-id>/
      project.json
      drawings/
        <drawing-id>.json
```

Writes use a synced temporary file and atomic rename. Elements, app state, and embedded files are persisted. Keep backups of the store directory for important work.

## Tools

- Projects: `list_projects`, `create_project`, `delete_project`
- Drawings: `list_drawings`, `create_drawing`, `open_drawing`, `delete_drawing`, `get_active_drawing`
- Scenes: `get_scene`, `update_scene`, `add_elements`, `update_elements`, `delete_elements`, `clear_scene`
- Construction and view: `draw_shape`, `set_viewport`

`delete_project` only accepts an empty, inactive project. To remove a project, open a drawing in another project, delete all drawings in the unwanted project, and then delete the project.

## Configuration and security

Environment variables: `EXCALIDRAW_MCP_HOST`, `EXCALIDRAW_MCP_PORT`, `EXCALIDRAW_MCP_DATA_DIR`, `EXCALIDRAW_MCP_URL`, and `EXCALIDRAW_MCP_ALLOWED_ORIGINS`.

The server has no authentication and only binds to a loopback address. Do not expose it to a shared or public network. Browser CORS accepts loopback origins by default; additional exact origins can be supplied with `--allowed-origins`. Anyone or any process with local access can modify the store.

`GET /health` returns service health. `GET /scene` and the SSE endpoint `/events` are used by the browser bridge; `POST /report` persists revisioned browser changes.

## Verify

```sh
cd mcp-server
npm test
npm pack --dry-run
```

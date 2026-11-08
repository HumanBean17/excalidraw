#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_PORT = Number(process.env.EXCALIDRAW_MCP_PORT || 3845);
const BRIDGE_ORIGIN = `http://localhost:${BRIDGE_PORT}`;

// ---------------------------------------------------------------------------
// Scene state.
//
// Every MCP tool call must reach the open Excalidraw page, no matter which
// process instance handles it. Only one process can hold the SSE bridge
// port; the rest become secondaries and proxy all state through the
// primary's HTTP endpoints, so N instances behave like one.
// ---------------------------------------------------------------------------

let sceneCache = { elements: [], appState: null };
let isPrimary = true;

const sseClients = new Set();

const sendSse = (payload) => {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const getScene = async () => {
  if (isPrimary) {
    return sceneCache;
  }
  let res;
  try {
    res = await fetch(`${BRIDGE_ORIGIN}/scene`);
  } catch {
    throw new Error(
      `excalidraw bridge unreachable at ${BRIDGE_ORIGIN} — the MCP server instance holding the port is not running`,
    );
  }
  return res.json();
};

const commitScene = async (elements, appState) => {
  if (isPrimary) {
    sceneCache = { elements, appState: appState ?? sceneCache.appState };
    sendSse({ type: "scene", ...sceneCache });
    return;
  }
  let res;
  try {
    res = await fetch(`${BRIDGE_ORIGIN}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elements, appState }),
    });
  } catch {
    throw new Error(
      `excalidraw bridge unreachable at ${BRIDGE_ORIGIN} — the MCP server instance holding the port is not running`,
    );
  }
  if (!res.ok) {
    throw new Error(`excalidraw bridge rejected the update (${res.status})`);
  }
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const bridge = createServer(async (req, res) => {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, BRIDGE_ORIGIN);

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/broadcast") {
    const body = await readBody(req);
    if (Array.isArray(body.elements)) {
      sceneCache = {
        elements: body.elements,
        appState: body.appState ?? sceneCache.appState,
      };
      sendSse({ type: "scene", ...sceneCache });
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    return;
  }

  if (req.method === "POST" && url.pathname === "/broadcast-viewport") {
    const body = await readBody(req);
    if (body.appState) {
      sendSse({ type: "viewport", appState: body.appState });
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    return;
  }

  if (req.method === "POST" && url.pathname === "/report") {
    const body = await readBody(req);
    if (Array.isArray(body.elements)) {
      sceneCache = {
        elements: body.elements,
        appState: body.appState ?? sceneCache.appState,
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    return;
  }

  if (req.method === "GET" && url.pathname === "/scene") {
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(sceneCache));
    return;
  }

  res.writeHead(404).end();
});

bridge.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    isPrimary = false;
    console.error(
      `excalidraw-mcp: bridge port ${BRIDGE_PORT} held by another instance — running in secondary (proxy) mode`,
    );
    return;
  }
  console.error(`excalidraw-mcp bridge error: ${error.message}`);
});

bridge.listen(BRIDGE_PORT, () => {
  console.error(`excalidraw-mcp bridge listening on ${BRIDGE_ORIGIN}`);
});

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

const now = () => Date.now();

// Excalidraw reconciles by version: an edit must win over the copy the page
// already holds, so bump it above the cached one.
const bumpVersion = (element, cached) => {
  const baseVersion = Math.max(element.version || 1, cached?.version || 1);
  return { ...element, version: baseVersion + 1, updated: now() };
};

// Incoming elements whose ids already exist must carry a higher version or
// the page silently keeps its copy.
const withBumpedVersions = (incoming, existing) =>
  incoming.map((el) => {
    const cached = existing.find((c) => c.id === el.id);
    return cached ? bumpVersion(el, cached) : el;
  });

const SHAPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "text",
  "freedraw",
];

const makeShape = (spec) => {
  const {
    type,
    x,
    y,
    width,
    height,
    text,
    points,
    angle = 0,
    ...style
  } = spec;

  const element = {
    id: `mcp-${now()}-${Math.floor(Math.random() * 1e6)}`,
    type,
    x,
    y,
    width: width ?? 100,
    height: height ?? 100,
    angle,
    strokeColor: style.strokeColor ?? "#1e1e1e",
    backgroundColor: style.backgroundColor ?? "transparent",
    fillStyle: style.fillStyle ?? "solid",
    strokeWidth: style.strokeWidth ?? 2,
    strokeStyle: style.strokeStyle ?? "solid",
    roughness: style.roughness ?? 1,
    opacity: style.opacity ?? 100,
    groupIds: [],
    frameId: style.frameId ?? null,
    roundness: style.roundness ?? null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: style.link ?? null,
    locked: style.locked ?? false,
  };

  switch (type) {
    case "rectangle":
      element.roundness = style.roundness ?? { type: 3 };
      break;
    case "line":
    case "arrow":
      element.points = points ?? [
        [0, 0],
        [width ?? 100, height ?? 100],
      ];
      element.startBinding = null;
      element.endBinding = null;
      element.startArrowhead = style.startArrowhead ?? null;
      element.endArrowhead =
        style.endArrowhead ?? (type === "arrow" ? "arrow" : null);
      if (type === "arrow") {
        element.focus = style.focus ?? 0;
        element.gap = style.gap ?? 4;
      }
      break;
    case "text": {
      const fontSize = style.fontSize ?? 20;
      element.text = text ?? "";
      element.originalText = element.text;
      element.fontSize = fontSize;
      element.fontFamily = style.fontFamily ?? 1;
      element.textAlign = style.textAlign ?? "left";
      element.verticalAlign = style.verticalAlign ?? "top";
      element.containerId = null;
      element.lineHeight = style.lineHeight ?? 1.25;
      element.baseline = Math.round(fontSize * 0.95);
      element.strokeWidth = 1;
      // size to fit the text unless explicit dimensions were given
      element.width =
        width ?? Math.ceil(element.text.length * fontSize * 0.6) + 10;
      element.height = height ?? Math.ceil(fontSize * 1.25);
      break;
    }
    case "freedraw":
      element.points = points ?? [
        [0, 0],
        [width ?? 100, height ?? 100],
      ];
      element.simulatePressure = true;
      element.pressures = element.points.map(() => 0.5);
      break;
  }

  return element;
};

// ---------------------------------------------------------------------------
// MCP server (stdio)
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "excalidraw-mcp",
  version: "0.3.0",
});

const jsonResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const elementSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    x: z.number(),
    y: z.number(),
  })
  .passthrough();

server.registerTool(
  "get_scene",
  {
    description:
      "Get the current Excalidraw scene (elements and appState) as last reported by the open Excalidraw page.",
  },
  async () => jsonResult(await getScene()),
);

server.registerTool(
  "update_scene",
  {
    description:
      "Replace the scene on the open Excalidraw page with the given elements (full ExcalidrawElement objects) and optional appState. WARNING: overwrites any manual edits made on the board since the last report.",
    inputSchema: {
      elements: z.array(elementSchema),
      appState: z.record(z.string(), z.unknown()).optional(),
    },
  },
  async ({ elements, appState }) => {
    const current = await getScene();
    const next = withBumpedVersions(elements, current.elements);
    await commitScene(next, appState);
    return jsonResult({ ok: true, elementCount: next.length });
  },
);

server.registerTool(
  "add_elements",
  {
    description:
      "Append elements to the current scene on the open Excalidraw page. Build elements with draw_shape, then commit them in one call.",
    inputSchema: { elements: z.array(elementSchema) },
  },
  async ({ elements }) => {
    const current = await getScene();
    const next = [
      ...current.elements,
      ...withBumpedVersions(elements, current.elements),
    ];
    await commitScene(next);
    return jsonResult({ ok: true, elementCount: next.length });
  },
);

server.registerTool(
  "update_elements",
  {
    description:
      "Patch specific fields of existing elements on the open Excalidraw page, by id. Only the listed fields change; everything else (and every other element) is untouched.",
    inputSchema: {
      updates: z.array(
        z.object({
          id: z.string(),
          changes: z.record(z.string(), z.unknown()),
        }),
      ),
    },
  },
  async ({ updates }) => {
    const current = await getScene();
    const touched = [];
    const missing = [];
    const elements = current.elements.map((el) => {
      const update = updates.find((u) => u.id === el.id);
      if (!update) {
        return el;
      }
      touched.push(el.id);
      return bumpVersion({ ...el, ...update.changes }, el);
    });
    for (const { id } of updates) {
      if (!touched.includes(id)) {
        missing.push(id);
      }
    }
    await commitScene(elements);
    return jsonResult({ ok: true, updated: touched, notFound: missing });
  },
);

server.registerTool(
  "delete_elements",
  {
    description: "Remove elements from the open Excalidraw page, by id.",
    inputSchema: { ids: z.array(z.string()) },
  },
  async ({ ids }) => {
    const current = await getScene();
    const elements = current.elements.filter((el) => !ids.includes(el.id));
    await commitScene(elements);
    return jsonResult({ ok: true, deleted: current.elements.length - elements.length });
  },
);

server.registerTool(
  "draw_shape",
  {
    description:
      "Build one Excalidraw element with correct defaults (no scene change). Collect the results, then commit them with add_elements. Types: rectangle, ellipse, diamond, line, arrow, text, freedraw.",
    inputSchema: {
      type: z.enum(SHAPES),
      x: z.number(),
      y: z.number(),
      width: z.number().optional(),
      height: z.number().optional(),
      text: z.string().optional(),
      points: z.array(z.array(z.number())).optional(),
      angle: z.number().optional(),
      strokeColor: z.string().optional(),
      backgroundColor: z.string().optional(),
      fillStyle: z.string().optional(),
      strokeWidth: z.number().optional(),
      strokeStyle: z.string().optional(),
      roughness: z.number().optional(),
      opacity: z.number().optional(),
      roundness: z.unknown().optional(),
      fontSize: z.number().optional(),
      fontFamily: z.number().optional(),
      endArrowhead: z.string().nullable().optional(),
    },
  },
  async (spec) => jsonResult(makeShape(spec)),
);

server.registerTool(
  "set_viewport",
  {
    description:
      "Pan/zoom the open Excalidraw page to the given scroll position and zoom level (zoom 1 = 100%).",
    inputSchema: {
      scrollX: z.number().optional(),
      scrollY: z.number().optional(),
      zoom: z.number().optional(),
    },
  },
  async ({ scrollX, scrollY, zoom }) => {
    const appState = {
      ...(scrollX !== undefined ? { scrollX } : {}),
      ...(scrollY !== undefined ? { scrollY } : {}),
      ...(zoom !== undefined ? { zoom: { value: zoom } } : {}),
    };
    if (isPrimary) {
      sendSse({ type: "viewport", appState });
    } else {
      let res;
      try {
        res = await fetch(`${BRIDGE_ORIGIN}/broadcast-viewport`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appState }),
        });
      } catch {
        throw new Error(
          `excalidraw bridge unreachable at ${BRIDGE_ORIGIN} — the MCP server instance holding the port is not running`,
        );
      }
      if (!res.ok) {
        throw new Error(`excalidraw bridge rejected the update (${res.status})`);
      }
    }
    return jsonResult({ ok: true, appState });
  },
);

server.registerTool(
  "clear_scene",
  {
    description: "Remove all elements from the open Excalidraw page.",
  },
  async () => {
    await commitScene([]);
    return jsonResult({ ok: true });
  },
);

const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0);
await server.connect(transport);
console.error("excalidraw-mcp stdio server connected");

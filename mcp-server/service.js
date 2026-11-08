import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { DrawingStore } from "./store.js";
import { registerTools } from "./tools.js";

export const VERSION = "2.0.0";
const MAX_REPORT_BYTES = 50 * 1024 * 1024;

const json = (res, status, value) => {
  if (res.headersSent) {
    return;
  }
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify(value));
};

const isLoopbackOrigin = (origin) => {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

const applyCors = (req, res, allowedOrigins) => {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (!isLoopbackOrigin(origin) && !allowedOrigins.has(origin)) {
    json(res, 403, { error: "Origin is not allowed" });
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Mcp-Protocol-Version",
  );
  return true;
};

const readBody = (req, maxBytes = MAX_REPORT_BYTES) =>
  new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const error = new Error("Request body is too large");
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        const parseError = new Error(
          `Invalid JSON request body: ${error.message}`,
        );
        parseError.statusCode = 400;
        reject(parseError);
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });

const sendEvent = (res, payload) => {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    res.destroy();
  }
};

const sendDrawing = (res, drawing) => {
  sendEvent(res, {
    type: "scene",
    projectId: drawing.projectId,
    drawingId: drawing.id,
    name: drawing.name,
    revision: drawing.revision,
    elements: drawing.elements,
    appState: drawing.appState,
    files: drawing.files,
  });
};

export const createHttpService = async ({
  host = "127.0.0.1",
  port = 3845,
  dataDir,
  allowedOrigins = [],
} = {}) => {
  if (!dataDir) {
    throw new Error("dataDir is required");
  }
  const store = await new DrawingStore(dataDir).initialize();
  const allowedOriginSet = new Set(allowedOrigins);
  const sseClients = new Set();
  const server = createServer(async (req, res) => {
    try {
      if (!applyCors(req, res, allowedOriginSet)) {
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      const url = new URL(req.url ?? "/", `http://${host}`);

      if (url.pathname === "/mcp") {
        const mcpServer = new McpServer({
          name: "excalidraw-mcp",
          version: VERSION,
        });
        registerTools(mcpServer, store);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void mcpServer.close();
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { status: "ok", version: VERSION });
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        res.mcpClientId = url.searchParams.get("clientId");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        sendEvent(res, { type: "hello", version: VERSION });
        sendDrawing(res, store.getActiveDrawing());
        return;
      }

      if (url.pathname === "/projects" && req.method === "GET") {
        json(res, 200, { projects: store.listProjects() });
        return;
      }

      if (url.pathname === "/projects" && req.method === "POST") {
        const body = await readBody(req);
        json(res, 201, { project: await store.createProject(body.name) });
        return;
      }

      const projectRoute = url.pathname.match(
        /^\/projects\/([^/]+)(\/drawings)?$/,
      );
      if (projectRoute && req.method === "DELETE" && !projectRoute[2]) {
        json(res, 200, await store.deleteProject(projectRoute[1]));
        return;
      }
      if (projectRoute && projectRoute[2] === "/drawings") {
        if (req.method === "GET") {
          json(res, 200, { drawings: store.listDrawings(projectRoute[1]) });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const drawing = await store.createDrawing(
            body.name,
            projectRoute[1],
            body.open ?? false,
          );
          json(res, 201, { drawing });
          return;
        }
      }

      const openDrawingRoute = url.pathname.match(
        /^\/drawings\/([^/]+)\/open$/,
      );
      if (openDrawingRoute && req.method === "POST") {
        json(res, 200, {
          drawing: await store.openDrawing(openDrawingRoute[1]),
        });
        return;
      }

      const drawingRoute = url.pathname.match(/^\/drawings\/([^/]+)$/);
      if (drawingRoute && req.method === "DELETE") {
        json(res, 200, await store.deleteDrawing(drawingRoute[1]));
        return;
      }

      if (req.method === "GET" && url.pathname === "/scene") {
        json(
          res,
          200,
          store.getDrawing(url.searchParams.get("drawingId") ?? undefined),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/report") {
        const body = await readBody(req);
        if (
          typeof body.drawingId !== "string" ||
          !Number.isInteger(body.baseRevision) ||
          !Array.isArray(body.elements) ||
          typeof body.files !== "object" ||
          body.files === null
        ) {
          json(res, 400, {
            error:
              "drawingId, baseRevision, elements, and files are required; appState is optional",
          });
          return;
        }
        try {
          const drawing = await store.mutateDrawing(
            body.drawingId,
            () => ({
              elements: body.elements,
              appState: body.appState ?? null,
              files: body.files,
            }),
            body.baseRevision,
            { sourceClientId: body.clientId },
          );
          json(res, 200, { ok: true, drawing });
        } catch (error) {
          if (error.statusCode !== 409) {
            throw error;
          }
          json(res, 409, {
            error: error.message,
            drawing: store.getDrawing(body.drawingId),
          });
        }
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, error.statusCode ?? 500, { error: error.message });
    }
  });

  const onDrawingUpdated = (drawing, { sourceClientId } = {}) => {
    if (drawing.id !== store.getActiveDrawing().id) {
      return;
    }
    for (const client of sseClients) {
      if (sourceClientId && client.mcpClientId === sourceClientId) {
        continue;
      }
      sendDrawing(client, drawing);
    }
  };
  const onDrawingOpened = (drawing) => {
    for (const client of sseClients) {
      sendDrawing(client, drawing);
    }
  };
  const onStoreChanged = () => {
    for (const client of sseClients) {
      sendEvent(client, { type: "store-changed" });
    }
  };
  store.on("drawing-updated", onDrawingUpdated);
  store.on("drawing-opened", onDrawingOpened);
  store.on("store-changed", onStoreChanged);

  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      client.write(": keepalive\n\n");
    }
  }, 25000);
  heartbeat.unref();

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  const origin = `http://${displayHost}:${actualPort}`;
  let closed = false;

  return {
    origin,
    store,
    server,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      store.off("drawing-updated", onDrawingUpdated);
      store.off("drawing-opened", onDrawingOpened);
      store.off("store-changed", onStoreChanged);
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
};

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EventSource } from "eventsource";

import { createHttpService } from "./service.js";
import { migrateLegacyDataDir } from "./store.js";

let dataDir;
let service;
let client;

const element = (id) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
});

const connectHttpClient = async () => {
  const nextClient = new Client({ name: "test-client", version: "1.0.0" });
  await nextClient.connect(
    new StreamableHTTPClientTransport(new URL(`${service.origin}/mcp`)),
  );
  return nextClient;
};

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return result.structuredContent;
};

const waitForScene = (events, predicate = () => true) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      events.close();
      reject(new Error("Timed out waiting for scene event"));
    }, 5000);
    events.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "scene" && predicate(message)) {
        clearTimeout(timer);
        events.close();
        resolve(message);
      }
    });
  });

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "excalidraw-mcp-test-"));
  service = await createHttpService({ port: 0, dataDir });
  client = await connectHttpClient();
});

afterEach(async () => {
  await client?.close();
  await service?.close();
  await rm(dataDir, { recursive: true, force: true });
  client = null;
  service = null;
});

test("legacy data directory migrates without overwriting an existing store", async () => {
  const legacyDataDir = join(dataDir, "legacy");
  const migratedDataDir = join(dataDir, "migrated");
  await mkdir(legacyDataDir);
  await writeFile(join(legacyDataDir, "active.json"), "legacy");

  assert.equal(
    await migrateLegacyDataDir(legacyDataDir, migratedDataDir),
    true,
  );
  assert.equal(
    await readFile(join(migratedDataDir, "active.json"), "utf8"),
    "legacy",
  );
  assert.equal(
    await migrateLegacyDataDir(legacyDataDir, migratedDataDir),
    false,
  );

  await mkdir(legacyDataDir);
  await writeFile(join(legacyDataDir, "active.json"), "other");
  await assert.rejects(
    migrateLegacyDataDir(legacyDataDir, migratedDataDir),
    /already exists/,
  );
  assert.equal(
    await readFile(join(migratedDataDir, "active.json"), "utf8"),
    "legacy",
  );
});

test("HTTP MCP persists concurrent edits across a full server restart", async () => {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 16);

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      call("add_elements", { elements: [element(`element-${index}`)] }),
    ),
  );
  const before = await call("get_scene");
  assert.equal(before.elements.length, 20);
  assert.equal(before.revision, 20);

  await client.close();
  await service.close();
  service = await createHttpService({ port: 0, dataDir });
  client = await connectHttpClient();

  const after = await call("get_scene");
  assert.deepEqual(after.elements, before.elements);
  assert.equal(after.revision, before.revision);
});

test("projects and drawings are isolated and explicitly addressable", async () => {
  const original = await call("get_active_drawing");
  const { project } = await call("create_project", { name: "Architecture" });
  const { drawing } = await call("create_drawing", {
    name: "System",
    projectId: project.id,
  });
  await call("add_elements", {
    drawingId: drawing.id,
    elements: [element("project-element")],
  });

  const active = await call("get_active_drawing");
  assert.equal(active.id, drawing.id);
  const originalScene = await call("get_scene", { drawingId: original.id });
  assert.equal(originalScene.elements.length, 0);
  const defaultDrawings = await call("list_drawings", {
    projectId: original.projectId,
  });
  assert.equal(defaultDrawings.drawings.length, 1);

  const projects = await call("list_projects");
  assert.equal(projects.projects.length, 2);
  assert.ok(projects.projects.some((item) => item.name === "Architecture"));
});

test("expectedRevision rejects stale replacement scenes", async () => {
  await call("add_elements", { elements: [element("current")] });
  const result = await client.callTool({
    name: "update_scene",
    arguments: { expectedRevision: 0, elements: [element("stale")] },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Revision conflict/);
  const current = await call("get_scene");
  assert.equal(current.elements[0].id, "current");
});

test("browser reports return conflicts without losing the server scene", async () => {
  await call("add_elements", { elements: [element("server")] });
  const response = await fetch(`${service.origin}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      drawingId: service.store.getActiveDrawing().id,
      baseRevision: 0,
      elements: [element("browser")],
      files: {},
    }),
  });
  assert.equal(response.status, 409);
  const conflict = await response.json();
  assert.equal(conflict.drawing.elements[0].id, "server");
  assert.equal(service.store.getActiveDrawing().elements[0].id, "server");
});

test("SSE replays persisted scenes on connection and broadcasts later edits", async () => {
  let events = new EventSource(`${service.origin}/events`);
  const initial = await waitForScene(events);
  assert.equal(initial.revision, 0);

  events = new EventSource(`${service.origin}/events`);
  const liveScene = waitForScene(events, (message) => message.revision === 1);
  await call("add_elements", { elements: [element("live")] });
  assert.equal((await liveScene).elements[0].id, "live");

  events = new EventSource(`${service.origin}/events`);
  const replayed = await waitForScene(
    events,
    (message) => message.revision === 1,
  );
  assert.equal(replayed.elements[0].id, "live");
});

test("malformed requests and disallowed origins do not crash the service", async () => {
  const malformed = await fetch(`${service.origin}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);

  const forbidden = await fetch(`${service.origin}/scene`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(forbidden.status, 403);

  const health = await fetch(`${service.origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", version: "2.0.0" });
});

test("stdio proxies the same running HTTP server", async () => {
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: ["index.js", "stdio", "--url", `${service.origin}/mcp`],
    cwd: new URL(".", import.meta.url).pathname,
    env: process.env,
    stderr: "ignore",
  });
  const proxyClient = new Client({ name: "stdio-test", version: "1.0.0" });
  await proxyClient.connect(stdio);
  await proxyClient.callTool({
    name: "add_elements",
    arguments: { elements: [element("through-stdio")] },
  });
  const result = await proxyClient.callTool({
    name: "get_scene",
    arguments: {},
  });
  assert.equal(result.structuredContent.elements[0].id, "through-stdio");
  await proxyClient.close();
});

test("browser API manages projects and drawings", async () => {
  const original = service.store.getActiveDrawing();
  const projectResponse = await fetch(`${service.origin}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Browser project" }),
  });
  assert.equal(projectResponse.status, 201);
  const { project } = await projectResponse.json();

  const drawingResponse = await fetch(
    `${service.origin}/projects/${project.id}/drawings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Browser drawing", open: true }),
    },
  );
  assert.equal(drawingResponse.status, 201);
  const { drawing } = await drawingResponse.json();
  assert.equal(service.store.getActiveDrawing().id, drawing.id);

  const projects = await (await fetch(`${service.origin}/projects`)).json();
  assert.equal(
    projects.projects.find((item) => item.id === project.id).drawingCount,
    1,
  );
  const drawings = await (
    await fetch(`${service.origin}/projects/${project.id}/drawings`)
  ).json();
  assert.equal(drawings.drawings[0].name, "Browser drawing");
  assert.equal(drawings.drawings[0].active, true);

  const openResponse = await fetch(
    `${service.origin}/drawings/${original.id}/open`,
    { method: "POST" },
  );
  assert.equal(openResponse.status, 200);
  const deleteDrawingResponse = await fetch(
    `${service.origin}/drawings/${drawing.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleteDrawingResponse.status, 200);
  const deleteProjectResponse = await fetch(
    `${service.origin}/projects/${project.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleteProjectResponse.status, 200);
  assert.equal(service.store.listProjects().length, 1);
});

test("browser reports do not echo back to their originating SSE client", async () => {
  const source = new EventSource(`${service.origin}/events?clientId=browser-a`);
  await new Promise((resolve) => {
    source.addEventListener("message", function initial(event) {
      if (JSON.parse(event.data).type === "scene") {
        source.removeEventListener("message", initial);
        resolve();
      }
    });
  });
  let echoed = false;
  source.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "scene" && message.revision === 1) {
      echoed = true;
    }
  });

  const other = new EventSource(`${service.origin}/events?clientId=browser-b`);
  await waitForScene(
    new EventSource(`${service.origin}/events?clientId=browser-c`),
  );
  const otherUpdate = waitForScene(other, (message) => message.revision === 1);
  const response = await fetch(`${service.origin}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: "browser-a",
      drawingId: service.store.getActiveDrawing().id,
      baseRevision: 0,
      elements: [element("browser-edit")],
      files: {},
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await otherUpdate).elements[0].id, "browser-edit");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(echoed, false);
  source.close();
});

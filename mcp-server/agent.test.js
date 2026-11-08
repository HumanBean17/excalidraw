import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createHttpService } from "./service.js";

let dataDir;
let service;
let client;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "excalidraw-mcp-agent-test-"));
  service = await createHttpService({ port: 0, dataDir });
  client = new Client({ name: "agent-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${service.origin}/mcp`)),
  );
});

afterEach(async () => {
  await client?.close();
  await service?.close();
  await rm(dataDir, { recursive: true, force: true });
  client = null;
  service = null;
});

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return result;
};

const data = async (name, args = {}) =>
  (await call(name, args)).structuredContent;

test("agent profile creates referenced normalized elements without raw round trips", async () => {
  const { tools } = await client.listTools();
  assert.equal(
    tools.some((tool) => tool.name === "create_elements"),
    true,
  );
  assert.equal(
    tools.some((tool) => tool.name === "draw_shape"),
    false,
  );
  assert.equal(
    tools.some((tool) => tool.name === "add_elements"),
    false,
  );
  assert.equal(
    tools.some((tool) => tool.name === "update_scene"),
    false,
  );

  const result = await call("create_elements", {
    elements: [
      {
        ref: "service",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 180,
        height: 80,
        group: "nodes",
      },
      {
        ref: "target",
        type: "rectangle",
        x: 300,
        y: 0,
        width: 180,
        height: 80,
        group: "nodes",
      },
      {
        ref: "label",
        type: "text",
        x: 20,
        y: 20,
        container: "service",
        text: "API\nGateway",
      },
      {
        ref: "edge",
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [5, 5],
          [95, 5],
        ],
        startBinding: "service",
        endBinding: "target",
      },
    ],
  });
  assert.equal(result.content[0].text, "Created 4 elements at revision 1");
  assert.equal(result.content[0].text.includes("strokeColor"), false);
  const created = Object.fromEntries(
    result.structuredContent.created.map((element) => [
      element.ref,
      element.id,
    ]),
  );
  const scene = await data("get_scene", { detail: "full" });
  const byId = new Map(scene.elements.map((element) => [element.id, element]));
  const arrow = byId.get(created.edge);
  assert.equal(arrow.width, 90);
  assert.equal(arrow.height, 0);
  assert.equal(arrow.x, 5);
  assert.equal(arrow.y, 5);
  assert.deepEqual(arrow.points, [
    [0, 0],
    [90, 0],
  ]);
  assert.equal(arrow.startBinding.elementId, created.service);
  assert.equal(arrow.endBinding.elementId, created.target);
  const label = byId.get(created.label);
  assert.equal(label.originalText, "API\nGateway");
  assert.equal(label.containerId, created.service);
  assert.equal(label.textAlign, "center");
  assert.equal(label.verticalAlign, "middle");
  assert.ok(label.width > 0);
  assert.ok(label.height > 0);
  assert.ok(label.baseline > 0);
  assert.equal(
    byId
      .get(created.service)
      .boundElements.some((bound) => bound.id === created.label),
    true,
  );
  assert.deepEqual(
    byId.get(created.service).groupIds,
    byId.get(created.target).groupIds,
  );
});

test("text patches are normalized and edits are atomic with no-op revisions", async () => {
  const { created } = await data("create_elements", {
    elements: [
      { ref: "first", type: "text", x: 0, y: 0, text: "Short" },
      { ref: "second", type: "rectangle", x: 200, y: 0 },
    ],
  });
  const first = created[0];
  const updated = await data("update_elements", {
    updates: [{ id: first.id, changes: { text: "A much longer\nlabel" } }],
  });
  assert.equal(updated.revision, 2);
  let scene = await data("get_scene", { detail: "full" });
  let text = scene.elements.find((element) => element.id === first.id);
  assert.equal(text.originalText, "A much longer\nlabel");
  assert.equal(text.text, text.originalText);

  const noOp = await data("update_elements", {
    updates: [{ id: first.id, changes: { text: "A much longer\nlabel" } }],
  });
  assert.equal(noOp.revision, 2);
  assert.deepEqual(noOp.updated, []);

  const failure = await client.callTool({
    name: "update_elements",
    arguments: {
      updates: [
        { id: first.id, changes: { text: "must not persist" } },
        { id: "missing", changes: { text: "missing" } },
      ],
    },
  });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /Elements not found: missing/);
  scene = await data("get_scene", { detail: "full" });
  text = scene.elements.find((element) => element.id === first.id);
  assert.equal(text.text, "A much longer\nlabel");
  assert.equal(scene.revision, 2);

  const deleteFailure = await client.callTool({
    name: "delete_elements",
    arguments: { ids: [first.id, "missing"] },
  });
  assert.equal(deleteFailure.isError, true);
  assert.equal((await data("get_scene")).elementCount, 2);
});

test("scene reads default to summaries and paginate projected 130-element scenes", async () => {
  await data("create_elements", {
    elements: Array.from({ length: 130 }, (_, index) => ({
      ref: `node-${index}`,
      type: "rectangle",
      x: (index % 10) * 100,
      y: Math.floor(index / 10) * 60,
      width: 80,
      height: 40,
    })),
  });
  await data("set_viewport", { scrollX: 25, zoom: 1.5 });
  await service.store.mutateDrawing(undefined, (current) => ({
    files: {
      ...current.files,
      asset: { id: "asset", dataURL: "data:image/png;base64,AA==" },
    },
  }));

  const summary = await data("get_scene");
  assert.equal(summary.elementCount, 130);
  assert.equal(summary.byType.rectangle, 130);
  assert.equal("elements" in summary, false);
  assert.equal("files" in summary, false);
  assert.equal("appState" in summary, false);

  const first = await data("get_scene", {
    detail: "elements",
    limit: 25,
    fields: ["id", "type"],
    type: "rectangle",
  });
  assert.equal(first.elements.length, 25);
  assert.deepEqual(Object.keys(first.elements[0]), ["id", "type"]);
  assert.ok(first.nextCursor);
  assert.equal(first.matchedCount, 130);
  assert.ok(JSON.stringify(first).length < 50000);
  const second = await data("get_scene", {
    detail: "elements",
    cursor: first.nextCursor,
    limit: 200,
  });
  assert.equal(second.elements.length, 105);
  assert.equal(second.nextCursor, null);
  assert.equal(second.elements[0].text, undefined);

  const active = await data("get_active_drawing");
  assert.equal(active.elementCount, 130);
  assert.equal("elements" in active, false);
  const full = await data("get_scene", { detail: "full" });
  assert.equal(full.elements.length, 130);
  assert.equal(full.files.asset.id, "asset");
  assert.equal(full.appState.scrollX, 25);
});

test("scene validation returns bounded actionable diagnostics", async () => {
  const { created } = await data("create_elements", {
    elements: [
      { ref: "empty", type: "text", x: 0, y: 0, text: "" },
      { ref: "overlap", type: "text", x: 5, y: 5, text: "Overlap" },
      { ref: "other", type: "text", x: 10, y: 10, text: "Other" },
    ],
  });
  await service.store.mutateDrawing(undefined, (current) => ({
    elements: current.elements.map((element) =>
      element.id === created[1].id
        ? { ...element, containerId: "missing-container" }
        : element,
    ),
  }));
  const result = await data("validate_scene", {
    bounds: { x: -10, y: -10, width: 20, height: 20 },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "missing-container"));
  assert.ok(result.warnings.some((warning) => warning.code === "empty-text"));
  assert.ok(result.warnings.some((warning) => warning.code === "text-overlap"));
  assert.ok(
    result.warnings.some((warning) => warning.code === "outside-bounds"),
  );
});

test("SVG and PNG rendering return real artifacts with optional image previews", async () => {
  await data("create_elements", {
    elements: [
      { ref: "box", type: "rectangle", x: 0, y: 0, width: 120, height: 60 },
      { ref: "label", type: "text", x: 15, y: 20, text: "Rendered" },
      {
        ref: "arrow",
        type: "arrow",
        x: 120,
        y: 30,
        points: [
          [0, 0],
          [80, 0],
        ],
      },
    ],
  });
  const [svg, concurrent] = await Promise.all([
    data("render_drawing", { format: "svg", background: "#ffffff" }),
    data("render_drawing", { format: "svg", background: "#ffffff" }),
  ]);
  assert.equal(concurrent.elementCount, 3);
  assert.equal("Element" in global, false);
  assert.equal(svg.format, "svg");
  assert.equal(svg.revision, 1);
  assert.equal(svg.elementCount, 3);
  assert.ok((await stat(svg.path)).size > 500);
  const svgText = await readFile(svg.path, "utf8");
  assert.match(svgText, /<svg/);
  assert.match(svgText, /Rendered/);
  assert.match(svgText, /@font-face/);

  const pngResult = await call("render_drawing", {
    format: "png",
    preview: true,
    scale: 1,
  });
  const png = pngResult.structuredContent;
  assert.equal(png.format, "png");
  assert.equal("preview" in png, false);
  const bytes = await readFile(png.path);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  const image = pngResult.content.find((item) => item.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(
    Buffer.from(image.data, "base64").subarray(1, 4).toString(),
    "PNG",
  );
});

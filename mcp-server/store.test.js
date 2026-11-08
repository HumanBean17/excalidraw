import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { DrawingStore, StoreError } from "./store.js";

let dataDir;
let store;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "excalidraw-store-test-"));
  store = await new DrawingStore(dataDir).initialize();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("initializes a default project and drawing", () => {
  assert.equal(store.listProjects().length, 1);
  assert.equal(store.listDrawings().length, 1);
  assert.equal(store.getActiveDrawing().revision, 0);
});

test("serializes mutations without losing concurrent additions", async () => {
  const drawingId = store.getActiveDrawing().id;
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      store.mutateDrawing(drawingId, (current) => ({
        elements: [
          ...current.elements,
          { id: `element-${index}`, type: "rectangle", x: 0, y: 0 },
        ],
      })),
    ),
  );
  const drawing = store.getDrawing(drawingId);
  assert.equal(drawing.elements.length, 50);
  assert.equal(drawing.revision, 50);
  assert.equal(new Set(drawing.elements.map((item) => item.id)).size, 50);
});

test("uses optimistic revision checks and ignores no-op mutations", async () => {
  await store.mutateDrawing(undefined, () => ({ elements: [] }));
  assert.equal(store.getActiveDrawing().revision, 0);
  await store.mutateDrawing(undefined, (current) => ({
    elements: [{ id: "element", type: "rectangle", x: 0, y: 0 }],
    appState: current.appState,
  }));
  await assert.rejects(
    store.mutateDrawing(undefined, () => ({ elements: [] }), 0),
    (error) => error instanceof StoreError && error.statusCode === 409,
  );
  assert.equal(store.getActiveDrawing().revision, 1);
});

test("restores active selection and all drawing data after restart", async () => {
  const project = await store.createProject("Research");
  const created = await store.createDrawing("Notes", project.id, true);
  await store.mutateDrawing(created.id, () => ({
    elements: [{ id: "image", type: "image", x: 0, y: 0 }],
    appState: { scrollX: 12, zoom: { value: 1.5 } },
    files: {
      "file-1": { id: "file-1", dataURL: "data:image/png;base64,AA==" },
    },
  }));

  const reopened = await new DrawingStore(dataDir).initialize();
  const drawing = reopened.getActiveDrawing();
  assert.equal(drawing.id, created.id);
  assert.equal(drawing.elements[0].id, "image");
  assert.equal(drawing.appState.scrollX, 12);
  assert.equal(drawing.files["file-1"].id, "file-1");
});

test("does not leave temporary files after atomic writes", async () => {
  await store.mutateDrawing(undefined, () => ({ elements: [] }));
  const active = store.getActiveDrawing();
  const directory = join(dataDir, "projects", active.projectId, "drawings");
  assert.deepEqual(await readdir(directory), [`${active.id}.json`]);
});

test("fails clearly instead of discarding corrupt persisted data", async () => {
  const active = store.getActiveDrawing();
  const path = join(
    dataDir,
    "projects",
    active.projectId,
    "drawings",
    `${active.id}.json`,
  );
  await writeFile(path, "{", "utf8");
  await assert.rejects(new DrawingStore(dataDir).initialize(), /Invalid JSON/);
});

test("empty inactive projects can be deleted and stay deleted after restart", async () => {
  const project = await store.createProject("Temporary");
  await store.deleteProject(project.id);
  const reopened = await new DrawingStore(dataDir).initialize();
  assert.equal(reopened.listProjects().length, 1);
});

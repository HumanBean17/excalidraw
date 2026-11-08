import { z } from "zod";

import {
  SHAPES,
  assertUniqueElements,
  bumpVersion,
  makeShape,
  withBumpedVersions,
} from "./elements.js";

const jsonResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const pointSchema = z.array(z.number().finite()).length(2);
const roundnessSchema = z
  .object({ type: z.number().finite() })
  .nullable()
  .optional();
const bindingSchema = z
  .object({
    elementId: z.string(),
    focus: z.number().finite(),
    gap: z.number().finite(),
    fixedPoint: pointSchema.nullable().optional(),
    mode: z.string().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const optionalElementFields = {
  width: z.number().nonnegative().finite().optional(),
  height: z.number().nonnegative().finite().optional(),
  angle: z.number().finite().optional(),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: z.string().optional(),
  strokeWidth: z.number().nonnegative().finite().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().nonnegative().finite().optional(),
  opacity: z.number().min(0).max(100).finite().optional(),
  groupIds: z.array(z.string()).optional(),
  frameId: z.string().nullable().optional(),
  roundness: roundnessSchema,
  seed: z.number().int().optional(),
  version: z.number().int().optional(),
  versionNonce: z.number().int().optional(),
  isDeleted: z.boolean().optional(),
  boundElements: z
    .array(z.object({ id: z.string(), type: z.string() }).passthrough())
    .nullable()
    .optional(),
  updated: z.number().finite().optional(),
  link: z.string().nullable().optional(),
  locked: z.boolean().optional(),
  points: z.array(pointSchema).optional(),
  startBinding: bindingSchema,
  endBinding: bindingSchema,
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  focus: z.number().finite().optional(),
  gap: z.number().finite().optional(),
  simulatePressure: z.boolean().optional(),
  pressures: z.array(z.number().finite()).optional(),
  text: z.string().optional(),
  originalText: z.string().optional(),
  fontSize: z.number().positive().finite().optional(),
  fontFamily: z.number().int().optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  containerId: z.string().nullable().optional(),
  lineHeight: z.number().positive().finite().optional(),
  baseline: z.number().finite().optional(),
};

const elementSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
    ...optionalElementFields,
  })
  .passthrough();

const elementChangesSchema = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    ...optionalElementFields,
  })
  .passthrough();

const drawingTarget = {
  drawingId: z.string().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
};

const nameSchema = z.string().trim().min(1).max(200);
const appStateSchema = z.record(z.string(), z.unknown());
const filesSchema = z.record(z.string(), z.unknown());

const mutationResult = (drawing, extra = {}) => ({
  ok: true,
  projectId: drawing.projectId,
  drawingId: drawing.id,
  revision: drawing.revision,
  ...extra,
});

export const registerTools = (server, store) => {
  server.registerTool(
    "list_projects",
    {
      description: "List all projects in the persistent Excalidraw store.",
    },
    async () => jsonResult({ projects: store.listProjects() }),
  );

  server.registerTool(
    "create_project",
    {
      description:
        "Create a project. Create and open a drawing inside it to start drawing.",
      inputSchema: { name: nameSchema },
    },
    async ({ name }) =>
      jsonResult({ project: await store.createProject(name) }),
  );

  server.registerTool(
    "delete_project",
    {
      description:
        "Delete an empty, inactive project. Drawings must be deleted first.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => jsonResult(await store.deleteProject(projectId)),
  );

  server.registerTool(
    "list_drawings",
    {
      description:
        "List drawings in a project, or in the active project by default.",
      inputSchema: { projectId: z.string().optional() },
    },
    async ({ projectId }) =>
      jsonResult({ drawings: store.listDrawings(projectId) }),
  );

  server.registerTool(
    "create_drawing",
    {
      description:
        "Create a persistent drawing and open it in connected browsers by default.",
      inputSchema: {
        name: nameSchema,
        projectId: z.string().optional(),
        open: z.boolean().optional(),
      },
    },
    async ({ name, projectId, open }) => {
      const drawing = await store.createDrawing(name, projectId, open ?? true);
      return jsonResult({ drawing });
    },
  );

  server.registerTool(
    "open_drawing",
    {
      description:
        "Make a drawing active and display it in connected browsers.",
      inputSchema: { drawingId: z.string() },
    },
    async ({ drawingId }) =>
      jsonResult({ drawing: await store.openDrawing(drawingId) }),
  );

  server.registerTool(
    "delete_drawing",
    {
      description:
        "Permanently delete a drawing. Open another project before deleting the active project's last drawing.",
      inputSchema: { drawingId: z.string() },
    },
    async ({ drawingId }) => jsonResult(await store.deleteDrawing(drawingId)),
  );

  server.registerTool(
    "get_active_drawing",
    {
      description: "Get metadata and scene data for the active drawing.",
    },
    async () => jsonResult(store.getActiveDrawing()),
  );

  server.registerTool(
    "get_scene",
    {
      description:
        "Get a persistent drawing scene, including elements, appState, files, and revision. Works without an open browser.",
      inputSchema: { drawingId: z.string().optional() },
    },
    async ({ drawingId }) => jsonResult(store.getDrawing(drawingId)),
  );

  server.registerTool(
    "update_scene",
    {
      description:
        "Replace a drawing's elements and optionally its appState and files. Pass expectedRevision to reject concurrent stale updates.",
      inputSchema: {
        ...drawingTarget,
        elements: z.array(elementSchema),
        appState: appStateSchema.optional(),
        files: filesSchema.optional(),
      },
    },
    async ({ drawingId, expectedRevision, elements, appState, files }) => {
      assertUniqueElements(elements);
      const drawing = await store.mutateDrawing(
        drawingId,
        (current) => ({
          elements: withBumpedVersions(elements, current.elements),
          appState: appState ?? current.appState,
          files: files ?? current.files,
        }),
        expectedRevision,
      );
      return jsonResult(
        mutationResult(drawing, { elementCount: drawing.elements.length }),
      );
    },
  );

  server.registerTool(
    "add_elements",
    {
      description:
        "Atomically append elements to a drawing. Build elements with draw_shape, then commit them in one call.",
      inputSchema: { ...drawingTarget, elements: z.array(elementSchema) },
    },
    async ({ drawingId, expectedRevision, elements }) => {
      assertUniqueElements(elements);
      const drawing = await store.mutateDrawing(
        drawingId,
        (current) => {
          const existingIds = new Set(
            current.elements.map((element) => element.id),
          );
          const duplicate = elements.find((element) =>
            existingIds.has(element.id),
          );
          if (duplicate) {
            throw new Error(`Element already exists: ${duplicate.id}`);
          }
          return {
            elements: [
              ...current.elements,
              ...withBumpedVersions(elements, current.elements),
            ],
          };
        },
        expectedRevision,
      );
      return jsonResult(
        mutationResult(drawing, { elementCount: drawing.elements.length }),
      );
    },
  );

  server.registerTool(
    "update_elements",
    {
      description:
        "Atomically patch fields of existing elements by id. Element ids and types cannot be changed.",
      inputSchema: {
        ...drawingTarget,
        updates: z.array(
          z.object({
            id: z.string(),
            changes: elementChangesSchema,
          }),
        ),
      },
    },
    async ({ drawingId, expectedRevision, updates }) => {
      const updateIds = new Set(updates.map((update) => update.id));
      if (updateIds.size !== updates.length) {
        throw new Error("Each element may only appear once in updates");
      }
      for (const update of updates) {
        if ("id" in update.changes || "type" in update.changes) {
          throw new Error("Element id and type are immutable");
        }
      }
      const touched = [];
      const drawing = await store.mutateDrawing(
        drawingId,
        (current) => {
          const updatesById = new Map(
            updates.map((update) => [update.id, update]),
          );
          const elements = current.elements.map((element) => {
            const update = updatesById.get(element.id);
            if (!update) {
              return element;
            }
            touched.push(element.id);
            return bumpVersion({ ...element, ...update.changes }, element);
          });
          return { elements };
        },
        expectedRevision,
      );
      return jsonResult(
        mutationResult(drawing, {
          updated: touched,
          notFound: updates
            .map((update) => update.id)
            .filter((id) => !touched.includes(id)),
        }),
      );
    },
  );

  server.registerTool(
    "delete_elements",
    {
      description: "Atomically remove elements from a drawing by id.",
      inputSchema: { ...drawingTarget, ids: z.array(z.string()) },
    },
    async ({ drawingId, expectedRevision, ids }) => {
      let deleted = 0;
      const drawing = await store.mutateDrawing(
        drawingId,
        (current) => {
          const idsToDelete = new Set(ids);
          const elements = current.elements.filter((element) => {
            if (idsToDelete.has(element.id)) {
              deleted += 1;
              return false;
            }
            return true;
          });
          return { elements };
        },
        expectedRevision,
      );
      return jsonResult(mutationResult(drawing, { deleted }));
    },
  );

  server.registerTool(
    "draw_shape",
    {
      description:
        "Build one Excalidraw element with correct defaults without changing a scene. Collect results, then commit with add_elements.",
      inputSchema: {
        type: z.enum(SHAPES),
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().nonnegative().optional(),
        height: z.number().nonnegative().optional(),
        text: z.string().optional(),
        points: z.array(pointSchema).optional(),
        angle: z.number().finite().optional(),
        strokeColor: z.string().optional(),
        backgroundColor: z.string().optional(),
        fillStyle: z.string().optional(),
        strokeWidth: z.number().nonnegative().optional(),
        strokeStyle: z.string().optional(),
        roughness: z.number().nonnegative().optional(),
        opacity: z.number().min(0).max(100).optional(),
        roundness: roundnessSchema,
        fontSize: z.number().positive().optional(),
        fontFamily: z.number().int().optional(),
        textAlign: z.enum(["left", "center", "right"]).optional(),
        verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
        lineHeight: z.number().positive().optional(),
        startArrowhead: z.string().nullable().optional(),
        endArrowhead: z.string().nullable().optional(),
        link: z.string().nullable().optional(),
        locked: z.boolean().optional(),
        frameId: z.string().nullable().optional(),
      },
    },
    async (spec) => jsonResult(makeShape(spec)),
  );

  server.registerTool(
    "set_viewport",
    {
      description:
        "Persist and display pan/zoom for a drawing. Zoom 1 equals 100%.",
      inputSchema: {
        drawingId: z.string().optional(),
        scrollX: z.number().finite().optional(),
        scrollY: z.number().finite().optional(),
        zoom: z.number().positive().finite().optional(),
      },
    },
    async ({ drawingId, scrollX, scrollY, zoom }) => {
      const drawing = await store.mutateDrawing(drawingId, (current) => ({
        appState: {
          ...(current.appState ?? {}),
          ...(scrollX !== undefined ? { scrollX } : {}),
          ...(scrollY !== undefined ? { scrollY } : {}),
          ...(zoom !== undefined
            ? { zoom: { ...(current.appState?.zoom ?? {}), value: zoom } }
            : {}),
        },
      }));
      return jsonResult(mutationResult(drawing));
    },
  );

  server.registerTool(
    "clear_scene",
    {
      description:
        "Remove all elements from a drawing without deleting the drawing.",
      inputSchema: {
        drawingId: z.string().optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
    },
    async ({ drawingId, expectedRevision }) => {
      const drawing = await store.mutateDrawing(
        drawingId,
        () => ({ elements: [] }),
        expectedRevision,
      );
      return jsonResult(mutationResult(drawing));
    },
  );
};

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  SHAPES,
  assertUniqueElements,
  makeShape,
  normalizeElementPatch,
  normalizeNewElement,
  withBumpedVersions,
} from "./elements.js";
import { renderDrawing } from "./render.js";
import { drawingMetadata, getSceneView, validateScene } from "./scene.js";

const jsonResult = (value, text = "Excalidraw MCP call succeeded") => ({
  content: [{ type: "text", text }],
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

const agentChangesSchema = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: optionalElementFields.width,
    height: optionalElementFields.height,
    angle: optionalElementFields.angle,
    text: optionalElementFields.text,
    points: optionalElementFields.points,
    strokeColor: optionalElementFields.strokeColor,
    backgroundColor: optionalElementFields.backgroundColor,
    fillStyle: optionalElementFields.fillStyle,
    strokeWidth: optionalElementFields.strokeWidth,
    strokeStyle: optionalElementFields.strokeStyle,
    roughness: optionalElementFields.roughness,
    opacity: optionalElementFields.opacity,
    fontSize: optionalElementFields.fontSize,
    fontFamily: optionalElementFields.fontFamily,
    textAlign: optionalElementFields.textAlign,
    verticalAlign: optionalElementFields.verticalAlign,
    lineHeight: optionalElementFields.lineHeight,
    startArrowhead: optionalElementFields.startArrowhead,
    endArrowhead: optionalElementFields.endArrowhead,
    startBinding: bindingSchema,
    endBinding: bindingSchema,
    containerId: optionalElementFields.containerId,
    frameId: optionalElementFields.frameId,
    groupIds: optionalElementFields.groupIds,
    link: optionalElementFields.link,
    locked: optionalElementFields.locked,
  })
  .strict();

const shapeSchema = z
  .object({
    ref: z.string().min(1).max(100).optional(),
    type: z.enum(SHAPES),
    x: z.number().finite(),
    y: z.number().finite(),
    width: optionalElementFields.width,
    height: optionalElementFields.height,
    text: z.string().optional(),
    points: z.array(pointSchema).min(1).optional(),
    angle: optionalElementFields.angle,
    strokeColor: optionalElementFields.strokeColor,
    backgroundColor: optionalElementFields.backgroundColor,
    fillStyle: optionalElementFields.fillStyle,
    strokeWidth: optionalElementFields.strokeWidth,
    strokeStyle: optionalElementFields.strokeStyle,
    roughness: optionalElementFields.roughness,
    opacity: optionalElementFields.opacity,
    roundness: roundnessSchema,
    fontSize: optionalElementFields.fontSize,
    fontFamily: optionalElementFields.fontFamily,
    textAlign: optionalElementFields.textAlign,
    verticalAlign: optionalElementFields.verticalAlign,
    lineHeight: optionalElementFields.lineHeight,
    startArrowhead: optionalElementFields.startArrowhead,
    endArrowhead: optionalElementFields.endArrowhead,
    startBinding: z.union([z.string(), bindingSchema]).optional(),
    endBinding: z.union([z.string(), bindingSchema]).optional(),
    focus: optionalElementFields.focus,
    gap: optionalElementFields.gap,
    link: optionalElementFields.link,
    locked: optionalElementFields.locked,
    container: z.string().optional(),
    frame: z.string().optional(),
    group: z.string().optional(),
  })
  .strict();

const drawingTarget = {
  drawingId: z.string().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
};

const nameSchema = z.string().trim().min(1).max(200);
const appStateSchema = z.record(z.string(), z.unknown());
const filesSchema = z.record(z.string(), z.unknown());
const regionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().nonnegative().finite(),
  height: z.number().nonnegative().finite(),
});

const mutationResult = (drawing, extra = {}) => ({
  ok: true,
  projectId: drawing.projectId,
  drawingId: drawing.id,
  revision: drawing.revision,
  ...extra,
});

const mutationOutputSchema = {
  ok: z.boolean(),
  projectId: z.string(),
  drawingId: z.string(),
  revision: z.number().int().nonnegative(),
};

const addBoundElement = (element, id, type) => {
  element.boundElements = element.boundElements ?? [];
  if (
    !element.boundElements.some(
      (bound) => bound.id === id && bound.type === type,
    )
  ) {
    element.boundElements.push({ id, type });
  }
};

const resolveReferences = (specs, currentElements) => {
  const elements = specs.map((spec) => normalizeNewElement(spec));
  assertUniqueElements(elements);
  const existingIds = new Set(currentElements.map((element) => element.id));
  const duplicate = elements.find((element) => existingIds.has(element.id));
  if (duplicate) {
    throw new Error(`Element already exists: ${duplicate.id}`);
  }
  const refs = new Map();
  for (let index = 0; index < specs.length; index += 1) {
    const ref = specs[index].ref;
    if (ref) {
      if (refs.has(ref)) {
        throw new Error(`Duplicate element ref: ${ref}`);
      }
      refs.set(ref, elements[index].id);
    }
  }
  const byId = new Map(
    [...currentElements, ...elements].map((element) => [element.id, element]),
  );
  const resolve = (reference) => {
    const id = refs.get(reference) ?? reference;
    if (!byId.has(id)) {
      throw new Error(`Element reference not found: ${reference}`);
    }
    return id;
  };
  const groups = new Map();
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const element = elements[index];
    if (spec.container) {
      if (element.type !== "text") {
        throw new Error(
          `Only text elements can use container: ${spec.ref ?? element.id}`,
        );
      }
      element.containerId = resolve(spec.container);
      element.textAlign = spec.textAlign ?? "center";
      element.verticalAlign = spec.verticalAlign ?? "middle";
      addBoundElement(byId.get(element.containerId), element.id, "text");
    }
    if (spec.frame) {
      element.frameId = resolve(spec.frame);
    }
    if (spec.group) {
      if (!groups.has(spec.group)) {
        groups.set(spec.group, `mcp-group-${randomUUID()}`);
      }
      element.groupIds = [...(element.groupIds ?? []), groups.get(spec.group)];
    }
    for (const side of ["startBinding", "endBinding"]) {
      const binding = spec[side];
      if (typeof binding === "string") {
        element[side] = {
          elementId: resolve(binding),
          focus: spec.focus ?? 0,
          gap: spec.gap ?? 4,
        };
      } else if (binding) {
        element[side] = { ...binding, elementId: resolve(binding.elementId) };
      }
      if (element[side]) {
        addBoundElement(byId.get(element[side].elementId), element.id, "arrow");
      }
    }
  }
  return elements;
};

const appendElements = async (
  store,
  { drawingId, expectedRevision, elements },
) => {
  assertUniqueElements(elements);
  return store.mutateDrawing(
    drawingId,
    (current) => {
      const existingIds = new Set(
        current.elements.map((element) => element.id),
      );
      const duplicate = elements.find((element) => existingIds.has(element.id));
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
};

const validateShape = (spec) => {
  const linear = ["line", "arrow", "freedraw"].includes(spec.type);
  const arrowLike = ["line", "arrow"].includes(spec.type);
  if (!linear && spec.points) {
    throw new Error(`points are only valid for linear elements: ${spec.type}`);
  }
  if (
    !arrowLike &&
    (spec.startBinding ||
      spec.endBinding ||
      spec.startArrowhead ||
      spec.endArrowhead)
  ) {
    throw new Error(
      `Arrow bindings and arrowheads are only valid for line or arrow: ${spec.type}`,
    );
  }
  if (
    spec.type !== "text" &&
    [
      "fontSize",
      "fontFamily",
      "textAlign",
      "verticalAlign",
      "lineHeight",
      "text",
      "container",
    ].some((field) => spec[field] !== undefined)
  ) {
    throw new Error(
      `Text fields are only valid for text elements: ${spec.type}`,
    );
  }
};

export const registerTools = (server, store, { profile = "agent" } = {}) => {
  server.registerTool(
    "list_projects",
    { description: "List all projects in the persistent Excalidraw store." },
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
      return jsonResult({ drawing: drawingMetadata(drawing) });
    },
  );

  server.registerTool(
    "open_drawing",
    {
      description:
        "Make a drawing active and display it in connected browsers.",
      inputSchema: { drawingId: z.string() },
    },
    async ({ drawingId }) => {
      const drawing = await store.openDrawing(drawingId);
      return jsonResult({ drawing: drawingMetadata(drawing) });
    },
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
      description:
        "Get active drawing metadata. Use detail=full only when the complete scene is required.",
      inputSchema: { detail: z.enum(["metadata", "full"]).optional() },
    },
    async ({ detail }) => {
      const drawing = store.getActiveDrawing();
      return jsonResult(detail === "full" ? drawing : drawingMetadata(drawing));
    },
  );

  server.registerTool(
    "get_scene",
    {
      description:
        "Inspect a drawing. Defaults to a compact summary; detail=elements supports filters and pagination, and detail=full returns raw scene data.",
      inputSchema: {
        drawingId: z.string().optional(),
        detail: z.enum(["summary", "elements", "full"]).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        fields: z.array(z.string().min(1)).max(50).optional(),
        ids: z.array(z.string()).max(500).optional(),
        type: z.string().optional(),
        search: z.string().max(500).optional(),
        region: regionSchema.optional(),
        includeAppState: z.boolean().optional(),
        includeFiles: z.boolean().optional(),
      },
    },
    async ({ drawingId, ...options }) =>
      jsonResult(getSceneView(store.getDrawing(drawingId), options)),
  );

  server.registerTool(
    "create_elements",
    {
      description:
        "Atomically create normalized elements from concise specs. Use ref with container, frame, group, and arrow bindings for local references; no draw_shape round trip is needed.",
      inputSchema: {
        ...drawingTarget,
        elements: z.array(shapeSchema).min(1).max(1000),
      },
      outputSchema: {
        ...mutationOutputSchema,
        created: z.array(
          z.object({ id: z.string(), ref: z.string().optional() }),
        ),
        elementCount: z.number().int().nonnegative(),
      },
    },
    async ({ drawingId, expectedRevision, elements: specs }) => {
      specs.forEach(validateShape);
      let created;
      const drawing = await store.mutateDrawing(
        drawingId,
        (current) => {
          const elements = resolveReferences(specs, current.elements);
          created = elements.map((element, index) => ({
            id: element.id,
            ...(specs[index].ref ? { ref: specs[index].ref } : {}),
          }));
          return { elements: [...current.elements, ...elements] };
        },
        expectedRevision,
      );
      return jsonResult(
        mutationResult(drawing, {
          created,
          elementCount: drawing.elements.length,
        }),
        `Created ${created.length} elements at revision ${drawing.revision}`,
      );
    },
  );

  server.registerTool(
    "update_elements",
    {
      description:
        "Atomically patch elements by id. Unknown ids fail the whole update; text and linear geometry are renormalized.",
      inputSchema: {
        ...drawingTarget,
        updates: z
          .array(
            z.object({
              id: z.string(),
              changes:
                profile === "advanced"
                  ? elementChangesSchema
                  : agentChangesSchema,
            }),
          )
          .min(1)
          .max(1000),
      },
      outputSchema: { ...mutationOutputSchema, updated: z.array(z.string()) },
    },
    async ({ drawingId, expectedRevision, updates }) => {
      const updateIds = new Set(updates.map((update) => update.id));
      if (updateIds.size !== updates.length) {
        throw new Error("Each element may only appear once in updates");
      }
      const updated = [];
      const drawing = await store.mutateDrawing(
        drawingId,
        (current) => {
          const byId = new Map(
            current.elements.map((element) => [element.id, element]),
          );
          const missing = updates
            .filter((update) => !byId.has(update.id))
            .map((update) => update.id);
          if (missing.length) {
            throw new Error(`Elements not found: ${missing.join(", ")}`);
          }
          const updatesById = new Map(
            updates.map((update) => [update.id, update]),
          );
          const elements = current.elements.map((element) => {
            const update = updatesById.get(element.id);
            if (!update) {
              return element;
            }
            const next = normalizeElementPatch(element, update.changes);
            if (next !== element) {
              updated.push(element.id);
            }
            return next;
          });
          return { elements };
        },
        expectedRevision,
      );
      return jsonResult(mutationResult(drawing, { updated }));
    },
  );

  server.registerTool(
    "delete_elements",
    {
      description:
        "Atomically remove elements by id. Unknown ids fail the whole deletion.",
      inputSchema: {
        ...drawingTarget,
        ids: z.array(z.string()).min(1).max(1000),
      },
      outputSchema: {
        ...mutationOutputSchema,
        deleted: z.number().int().nonnegative(),
      },
    },
    async ({ drawingId, expectedRevision, ids }) => {
      let deleted = 0;
      const drawing = await store.mutateDrawing(
        drawingId,
        (current) => {
          const idsToDelete = new Set(ids);
          const missing = [...idsToDelete].filter(
            (id) => !current.elements.some((element) => element.id === id),
          );
          if (missing.length) {
            throw new Error(`Elements not found: ${missing.join(", ")}`);
          }
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
    "validate_scene",
    {
      description:
        "Return compact geometry, reference, text-overlap, empty-text, and bounds diagnostics without returning the scene.",
      inputSchema: {
        drawingId: z.string().optional(),
        bounds: regionSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ drawingId, ...options }) =>
      jsonResult(validateScene(store.getDrawing(drawingId), options)),
  );

  server.registerTool(
    "render_drawing",
    {
      description:
        "Render a drawing revision to SVG or PNG. Returns an artifact path; PNG preview image content is optional.",
      inputSchema: {
        drawingId: z.string().optional(),
        format: z.enum(["svg", "png"]).optional(),
        scale: z.number().positive().max(4).optional(),
        padding: z.number().nonnegative().max(1000).optional(),
        background: z.string().optional(),
        ids: z.array(z.string()).min(1).max(1000).optional(),
        preview: z.boolean().optional(),
      },
    },
    async ({ drawingId, ...options }) => {
      const result = await renderDrawing(
        store.getDrawing(drawingId),
        store.dataDir,
        options,
      );
      const content = [
        {
          type: "text",
          text: `Rendered ${result.format} at revision ${result.revision}: ${result.path}`,
        },
      ];
      if (result.preview) {
        content.push({
          type: "image",
          data: result.preview,
          mimeType: "image/png",
        });
      }
      const structuredContent = { ...result };
      delete structuredContent.preview;
      return { content, structuredContent };
    },
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

  if (profile === "advanced") {
    server.registerTool(
      "update_scene",
      {
        description:
          "Advanced: replace normalized raw elements and optionally appState/files. Pass expectedRevision to reject stale updates.",
        inputSchema: {
          ...drawingTarget,
          elements: z.array(elementSchema),
          appState: appStateSchema.optional(),
          files: filesSchema.optional(),
        },
      },
      async ({ drawingId, expectedRevision, elements, appState, files }) => {
        const normalized = elements.map(normalizeNewElement);
        assertUniqueElements(normalized);
        const drawing = await store.mutateDrawing(
          drawingId,
          (current) => ({
            elements: withBumpedVersions(normalized, current.elements),
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
          "Advanced: atomically append normalized raw elements. Prefer create_elements for concise agent-authored specs.",
        inputSchema: {
          ...drawingTarget,
          elements: z.array(elementSchema).min(1),
        },
      },
      async (args) => {
        const normalized = args.elements.map(normalizeNewElement);
        const drawing = await appendElements(store, {
          ...args,
          elements: normalized,
        });
        return jsonResult(
          mutationResult(drawing, { elementCount: drawing.elements.length }),
        );
      },
    );

    server.registerTool(
      "draw_shape",
      {
        description:
          "Advanced: build one normalized Excalidraw element without changing a scene.",
        inputSchema: {
          type: z.enum(SHAPES),
          x: z.number().finite(),
          y: z.number().finite(),
          width: optionalElementFields.width,
          height: optionalElementFields.height,
          text: z.string().optional(),
          points: z.array(pointSchema).optional(),
          angle: optionalElementFields.angle,
          strokeColor: optionalElementFields.strokeColor,
          backgroundColor: optionalElementFields.backgroundColor,
          fillStyle: optionalElementFields.fillStyle,
          strokeWidth: optionalElementFields.strokeWidth,
          strokeStyle: optionalElementFields.strokeStyle,
          roughness: optionalElementFields.roughness,
          opacity: optionalElementFields.opacity,
          roundness: roundnessSchema,
          fontSize: optionalElementFields.fontSize,
          fontFamily: optionalElementFields.fontFamily,
          textAlign: optionalElementFields.textAlign,
          verticalAlign: optionalElementFields.verticalAlign,
          lineHeight: optionalElementFields.lineHeight,
          startArrowhead: optionalElementFields.startArrowhead,
          endArrowhead: optionalElementFields.endArrowhead,
          link: optionalElementFields.link,
          locked: optionalElementFields.locked,
          frameId: optionalElementFields.frameId,
        },
      },
      async (spec) => jsonResult(makeShape(spec)),
    );
  }
};

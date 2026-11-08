const activeElements = (drawing) =>
  drawing.elements.filter((element) => !element.isDeleted);

const getBounds = (elements) => {
  if (elements.length === 0) {
    return null;
  }
  const left = Math.min(...elements.map((element) => element.x));
  const top = Math.min(...elements.map((element) => element.y));
  const right = Math.max(
    ...elements.map((element) => element.x + element.width),
  );
  const bottom = Math.max(
    ...elements.map((element) => element.y + element.height),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
};

export const drawingMetadata = (drawing) => ({
  id: drawing.id,
  projectId: drawing.projectId,
  name: drawing.name,
  revision: drawing.revision,
  createdAt: drawing.createdAt,
  updatedAt: drawing.updatedAt,
  elementCount: activeElements(drawing).length,
});

const sceneSummary = (drawing) => {
  const elements = activeElements(drawing);
  const byType = {};
  for (const element of elements) {
    byType[element.type] = (byType[element.type] ?? 0) + 1;
  }
  return {
    ...drawingMetadata(drawing),
    drawingId: drawing.id,
    byType,
    bounds: getBounds(elements),
  };
};

const encodeCursor = (offset) =>
  Buffer.from(String(offset)).toString("base64url");
const decodeCursor = (cursor) => {
  if (cursor === undefined) {
    return 0;
  }
  const offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Invalid cursor");
  }
  return offset;
};

const intersects = (element, region) =>
  element.x < region.x + region.width &&
  element.x + element.width > region.x &&
  element.y < region.y + region.height &&
  element.y + element.height > region.y;

const projectElement = (element, fields) => {
  if (!fields) {
    const projected = {};
    for (const field of ["id", "type", "x", "y", "width", "height", "text"]) {
      if (element[field] !== undefined) {
        projected[field] = element[field];
      }
    }
    return projected;
  }
  return Object.fromEntries(
    fields
      .filter((field) => element[field] !== undefined)
      .map((field) => [field, element[field]]),
  );
};

export const getSceneView = (drawing, options = {}) => {
  const detail = options.detail ?? "summary";
  if (detail === "full") {
    return drawing;
  }
  const result = sceneSummary(drawing);
  if (options.includeAppState) {
    result.appState = drawing.appState;
  }
  if (options.includeFiles) {
    result.files = drawing.files;
  }
  if (detail === "summary") {
    return result;
  }

  const ids = options.ids ? new Set(options.ids) : null;
  const search = options.search?.toLocaleLowerCase();
  const elements = activeElements(drawing).filter(
    (element) =>
      (!ids || ids.has(element.id)) &&
      (!options.type || element.type === options.type) &&
      (!search || element.text?.toLocaleLowerCase().includes(search)) &&
      (!options.region || intersects(element, options.region)),
  );
  const offset = decodeCursor(options.cursor);
  const limit = options.limit ?? 50;
  const page = elements.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    ...result,
    elements: page.map((element) => projectElement(element, options.fields)),
    matchedCount: elements.length,
    nextCursor: nextOffset < elements.length ? encodeCursor(nextOffset) : null,
  };
};

const linearDimensions = (element) => {
  const xs = element.points.map(([x]) => x);
  const ys = element.points.map(([, y]) => y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

export const validateScene = (drawing, { bounds, limit = 100 } = {}) => {
  const elements = activeElements(drawing);
  const byId = new Map();
  const errors = [];
  const warnings = [];
  const add = (target, code, elementIds, message) => {
    if (target.length < limit) {
      target.push({ code, elementIds, message });
    }
  };

  for (const element of elements) {
    if (byId.has(element.id)) {
      add(errors, "duplicate-id", [element.id], "Element id is duplicated");
    }
    byId.set(element.id, element);
  }

  for (const element of elements) {
    if (
      ![element.x, element.y, element.width, element.height].every(
        Number.isFinite,
      )
    ) {
      add(
        errors,
        "invalid-geometry",
        [element.id],
        "Element geometry is not finite",
      );
    }
    if (
      ["line", "arrow", "freedraw"].includes(element.type) &&
      Array.isArray(element.points) &&
      element.points.length > 0
    ) {
      const expected = linearDimensions(element);
      if (
        expected.width !== element.width ||
        expected.height !== element.height
      ) {
        add(
          errors,
          "point-bounds-mismatch",
          [element.id],
          "Linear element dimensions do not match its points",
        );
      }
    }
    if (element.type === "text" && !element.text?.trim()) {
      add(warnings, "empty-text", [element.id], "Text element is empty");
    }
    if (element.containerId && !byId.has(element.containerId)) {
      add(
        errors,
        "missing-container",
        [element.id, element.containerId],
        "Text container does not exist",
      );
    }
    if (element.frameId && !byId.has(element.frameId)) {
      add(
        errors,
        "missing-frame",
        [element.id, element.frameId],
        "Frame does not exist",
      );
    }
    for (const binding of [element.startBinding, element.endBinding]) {
      if (binding?.elementId && !byId.has(binding.elementId)) {
        add(
          errors,
          "invalid-binding",
          [element.id, binding.elementId],
          "Arrow binding target does not exist",
        );
      }
    }
    for (const bound of element.boundElements ?? []) {
      if (!byId.has(bound.id)) {
        add(
          errors,
          "invalid-bound-element",
          [element.id, bound.id],
          "Bound element does not exist",
        );
      }
    }
    if (
      bounds &&
      (element.x < bounds.x ||
        element.y < bounds.y ||
        element.x + element.width > bounds.x + bounds.width ||
        element.y + element.height > bounds.y + bounds.height)
    ) {
      add(
        warnings,
        "outside-bounds",
        [element.id],
        "Element extends outside the requested bounds",
      );
    }
  }

  const texts = elements.filter(
    (element) => element.type === "text" && element.text?.trim(),
  );
  for (let left = 0; left < texts.length; left += 1) {
    for (let right = left + 1; right < texts.length; right += 1) {
      if (intersects(texts[left], texts[right])) {
        add(
          warnings,
          "text-overlap",
          [texts[left].id, texts[right].id],
          "Text elements overlap",
        );
      }
    }
  }

  return {
    drawingId: drawing.id,
    revision: drawing.revision,
    valid: errors.length === 0,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    truncated: errors.length >= limit || warnings.length >= limit,
  };
};

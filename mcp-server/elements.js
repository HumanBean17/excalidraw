import { randomInt, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const SHAPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "text",
  "freedraw",
];

const nonce = () => randomInt(0, 2 ** 31);
const isLinear = (type) =>
  type === "line" || type === "arrow" || type === "freedraw";

const measureText = (text, fontSize, lineHeight) => {
  const lines = text.split("\n");
  return {
    width:
      Math.ceil(
        Math.max(0, ...lines.map((line) => Array.from(line).length)) *
          fontSize *
          0.6,
      ) + 10,
    height: Math.ceil(lines.length * fontSize * lineHeight),
  };
};

const normalizeLinear = (element, suppliedPoints) => {
  const points = suppliedPoints ?? [
    [0, 0],
    [element.width, element.height],
  ];
  if (points.length === 0) {
    throw new Error("Linear elements require at least one point");
  }
  const [firstX, firstY] = points[0];
  const normalizedPoints = points.map(([pointX, pointY]) => [
    pointX - firstX,
    pointY - firstY,
  ]);
  const xs = normalizedPoints.map(([pointX]) => pointX);
  const ys = normalizedPoints.map(([, pointY]) => pointY);
  return {
    x: element.x + firstX,
    y: element.y + firstY,
    points: normalizedPoints,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

const normalizeTextElement = (element, changes = null, existing = null) => {
  const text = element.text ?? "";
  const fontSize = element.fontSize ?? 20;
  const lineHeight = element.lineHeight ?? 1.25;
  const textChanged =
    changes && existing && "text" in changes && changes.text !== existing.text;
  const metricsChanged =
    !existing ||
    textChanged ||
    (changes &&
      ("fontSize" in changes ||
        "fontFamily" in changes ||
        "lineHeight" in changes));
  const measured = measureText(text, fontSize, lineHeight);
  return {
    text,
    originalText: textChanged
      ? changes.originalText ?? text
      : element.originalText ?? text,
    fontSize,
    fontFamily: element.fontFamily ?? 1,
    textAlign: element.textAlign ?? "left",
    verticalAlign: element.verticalAlign ?? "top",
    containerId: element.containerId ?? null,
    lineHeight,
    baseline:
      changes && "fontSize" in changes && !("baseline" in changes)
        ? Math.round(fontSize * 0.95)
        : element.baseline ?? Math.round(fontSize * 0.95),
    width:
      metricsChanged && !(changes && "width" in changes)
        ? measured.width
        : element.width,
    height:
      metricsChanged && !(changes && "height" in changes)
        ? measured.height
        : element.height,
  };
};

export const normalizeNewElement = (spec) => {
  const { type, x, y, width, height, text, points, angle = 0, ...style } = spec;
  delete style.ref;
  delete style.container;
  delete style.frame;
  delete style.group;
  const element = {
    ...style,
    id: spec.id ?? `mcp-${randomUUID()}`,
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
    groupIds: style.groupIds ?? [],
    frameId: style.frameId ?? null,
    roundness: style.roundness ?? null,
    seed: style.seed ?? nonce(),
    version: style.version ?? 1,
    versionNonce: style.versionNonce ?? nonce(),
    isDeleted: style.isDeleted ?? false,
    boundElements: style.boundElements ?? [],
    updated: style.updated ?? Date.now(),
    link: style.link ?? null,
    locked: style.locked ?? false,
  };

  if (type === "rectangle") {
    element.roundness = style.roundness ?? { type: 3 };
  }

  if (isLinear(type)) {
    Object.assign(element, normalizeLinear(element, points));
  }

  if (type === "line" || type === "arrow") {
    element.startBinding = style.startBinding ?? null;
    element.endBinding = style.endBinding ?? null;
    element.startArrowhead = style.startArrowhead ?? null;
    element.endArrowhead =
      style.endArrowhead ?? (type === "arrow" ? "arrow" : null);
  }

  if (type === "arrow") {
    element.focus = style.focus ?? 0;
    element.gap = style.gap ?? 4;
  }

  if (type === "freedraw") {
    element.simulatePressure = style.simulatePressure ?? true;
    element.pressures = style.pressures ?? element.points.map(() => 0.5);
  }

  if (type === "text") {
    Object.assign(element, normalizeTextElement({ ...element, text }));
    element.strokeWidth = style.strokeWidth ?? 1;
  }

  return element;
};

export const makeShape = (spec) => normalizeNewElement(spec);

export const normalizeElementPatch = (existing, changes) => {
  const element = { ...existing, ...changes };
  if (isLinear(element.type) && changes.points) {
    Object.assign(element, normalizeLinear(element, changes.points));
  } else if (
    isLinear(element.type) &&
    ("width" in changes || "height" in changes)
  ) {
    const last = existing.points.length - 1;
    const scaleX = existing.width === 0 ? 1 : element.width / existing.width;
    const scaleY = existing.height === 0 ? 1 : element.height / existing.height;
    const points = existing.points.map(([x, y], index) => [
      existing.width === 0 && index === last ? element.width : x * scaleX,
      existing.height === 0 && index === last ? element.height : y * scaleY,
    ]);
    Object.assign(element, normalizeLinear(element, points));
  }
  if (element.type === "text") {
    Object.assign(element, normalizeTextElement(element, changes, existing));
  }
  return isDeepStrictEqual(element, existing)
    ? existing
    : bumpVersion(element, existing);
};

export const bumpVersion = (element, cached) => ({
  ...element,
  version: Math.max(element.version || 1, cached?.version || 1) + 1,
  versionNonce: nonce(),
  updated: Date.now(),
});

export const withBumpedVersions = (incoming, existing) => {
  const existingById = new Map(
    existing.map((element) => [element.id, element]),
  );
  return incoming.map((element) => {
    const cached = existingById.get(element.id);
    if (!cached) {
      return element;
    }
    return isDeepStrictEqual(element, cached)
      ? cached
      : bumpVersion(element, cached);
  });
};

export const assertUniqueElements = (elements) => {
  const ids = new Set();
  for (const element of elements) {
    if (ids.has(element.id)) {
      throw new Error(`Duplicate element id: ${element.id}`);
    }
    ids.add(element.id);
  }
};

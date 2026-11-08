import { randomInt, randomUUID } from "node:crypto";

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

export const makeShape = (spec) => {
  const { type, x, y, width, height, text, points, angle = 0, ...style } = spec;
  const element = {
    id: `mcp-${randomUUID()}`,
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
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: style.link ?? null,
    locked: style.locked ?? false,
  };

  if (type === "rectangle") {
    element.roundness = style.roundness ?? { type: 3 };
  }

  if (type === "line" || type === "arrow" || type === "freedraw") {
    element.points = points ?? [
      [0, 0],
      [width ?? 100, height ?? 100],
    ];
  }

  if (type === "line" || type === "arrow") {
    element.startBinding = null;
    element.endBinding = null;
    element.startArrowhead = style.startArrowhead ?? null;
    element.endArrowhead =
      style.endArrowhead ?? (type === "arrow" ? "arrow" : null);
  }

  if (type === "arrow") {
    element.focus = style.focus ?? 0;
    element.gap = style.gap ?? 4;
  }

  if (type === "freedraw") {
    element.simulatePressure = true;
    element.pressures = element.points.map(() => 0.5);
  }

  if (type === "text") {
    const fontSize = style.fontSize ?? 20;
    const lines = (text ?? "").split("\n");
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
    element.width =
      width ??
      Math.ceil(
        Math.max(0, ...lines.map((line) => line.length)) * fontSize * 0.6,
      ) + 10;
    element.height =
      height ?? Math.ceil(lines.length * fontSize * element.lineHeight);
  }

  return element;
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
  return incoming.map((element) =>
    existingById.has(element.id)
      ? bumpVersion(element, existingById.get(element.id))
      : element,
  );
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

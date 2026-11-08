import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const importDependency = async (name) => {
  try {
    return await import(name);
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes(name)) {
      throw new Error(
        `Rendering requires the optional dependency ${name}. Reinstall excalidraw-mcp with optional dependencies enabled.`,
      );
    }
    throw error;
  }
};

let exportScenePromise;

const loadExportScene = (dataDir) => {
  exportScenePromise ??= (async () => {
    const { build } = await importDependency("esbuild");
    const directory = join(dataDir, "cache");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const outfile = join(directory, "excalidraw-render.mjs");
    await build({
      entryPoints: [
        fileURLToPath(new URL("./render-entry.js", import.meta.url)),
      ],
      outfile,
      bundle: true,
      plugins: [
        {
          name: "external-jsdom",
          setup: ({ onResolve }) => {
            onResolve({ filter: /^jsdom$/ }, () => ({
              path: fileURLToPath(import.meta.resolve("jsdom")),
              external: true,
            }));
          },
        },
      ],
      inject: [fileURLToPath(new URL("./host-shims.js", import.meta.url))],
      platform: "node",
      format: "esm",
      define: {
        "import.meta.env": JSON.stringify({
          PROD: true,
          DEV: false,
          MODE: "production",
        }),
        "process.env.NODE_ENV": '"production"',
        __dirname: '""',
      },
      loader: {
        ".css": "empty",
        ".scss": "empty",
        ".woff2": "dataurl",
        ".png": "dataurl",
      },
      logLevel: "silent",
    });
    const { exportScene } = await import(pathToFileURL(outfile).href);
    return exportScene;
  })().catch((error) => {
    exportScenePromise = null;
    throw error;
  });
  return exportScenePromise;
};

const textMetrics = {
  getLineWidth(text, fontString) {
    const fontSize = Number.parseFloat(fontString) || 20;
    return Array.from(text).length * fontSize * 0.6;
  },
};

const renderSvg = async (
  drawing,
  elements,
  dataDir,
  { scale, padding, background },
) => {
  const { JSDOM } = await importDependency("jsdom");
  const window = new JSDOM("<!doctype html>").window;
  const exportScene = await loadExportScene(dataDir);
  const svg = await exportScene({
    type: "svg",
    data: {
      elements,
      appState: drawing.appState ?? {},
      files: drawing.files,
    },
    config: {
      canvasBackgroundColor: background ?? false,
      padding,
      scale,
      environment: {
        document: window.document,
        loadFonts: async () => {},
        textMetrics,
      },
    },
  });
  return svg.outerHTML;
};

const svgSize = (svg) => ({
  width: Math.max(
    1,
    Math.ceil(Number.parseFloat(svg.match(/width="([^"]+)"/)?.[1] ?? "1")),
  ),
  height: Math.max(
    1,
    Math.ceil(Number.parseFloat(svg.match(/height="([^"]+)"/)?.[1] ?? "1")),
  ),
});

const rasterize = async (svg, path, transparent) => {
  const { chromium } = await importDependency("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const { width, height } = svgSize(svg);
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
    );
    await page.locator("svg").screenshot({ path, omitBackground: transparent });
  } finally {
    await browser.close();
  }
};

export const renderDrawing = async (drawing, dataDir, options = {}) => {
  const format = options.format ?? "svg";
  const scale = options.scale ?? 1;
  const padding = options.padding ?? 10;
  const selected = options.ids ? new Set(options.ids) : null;
  const elements = drawing.elements.filter(
    (element) => !element.isDeleted && (!selected || selected.has(element.id)),
  );
  if (selected && elements.length !== selected.size) {
    const found = new Set(elements.map((element) => element.id));
    const missing = [...selected].filter((id) => !found.has(id));
    throw new Error(`Elements not found: ${missing.join(", ")}`);
  }
  const svg = await renderSvg(drawing, elements, dataDir, {
    scale,
    padding,
    background: options.background,
  });
  const { width, height } = svgSize(svg);
  if (width > 16384 || height > 16384 || width * height > 16777216) {
    throw new Error(
      `Rendered image is too large: ${width}x${height}. Reduce scale or selected elements.`,
    );
  }

  const directory = join(dataDir, "exports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `${drawing.id}-r${drawing.revision}-${randomUUID()}.${format}`,
  );
  if (format === "svg") {
    await writeFile(path, `${svg}\n`, { mode: 0o600 });
  } else {
    await rasterize(svg, path, options.background === undefined);
  }
  return {
    drawingId: drawing.id,
    revision: drawing.revision,
    format,
    path,
    width,
    height,
    elementCount: elements.length,
    ...(options.preview && format === "png"
      ? { preview: (await readFile(path)).toString("base64") }
      : {}),
  };
};

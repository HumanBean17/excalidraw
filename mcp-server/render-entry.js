import * as excalidraw from "@excalidraw/excalidraw";

export const exportScene = (options) => {
  if (typeof excalidraw.exportScene === "function") {
    return excalidraw.exportScene(options);
  }

  const { data, config = {} } = options;
  const hasBackground =
    config.canvasBackgroundColor !== undefined &&
    config.canvasBackgroundColor !== false;
  return excalidraw.exportToSvg({
    elements: data.elements,
    files: data.files,
    appState: {
      ...(data.appState ?? {}),
      exportBackground: hasBackground,
      viewBackgroundColor: hasBackground
        ? config.canvasBackgroundColor
        : data.appState?.viewBackgroundColor ?? "#ffffff",
      exportPadding: config.padding,
      exportScale: config.scale ?? 1,
      exportWithDarkMode: config.theme === "dark",
    },
    exportPadding: config.padding,
    skipInliningFonts: config.skipInliningFonts,
  });
};

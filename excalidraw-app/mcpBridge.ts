import { CaptureUpdateAction, restoreElements } from "@excalidraw/excalidraw";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

type DrawingMessage = {
  type?: string;
  projectId?: string;
  drawingId?: string;
  name?: string;
  revision?: number;
  elements?: ExcalidrawElement[];
  appState?: Partial<AppState> | null;
  files?: BinaryFiles;
};

export class McpBridge {
  private excalidrawAPI: ExcalidrawImperativeAPI;
  private ownerWindow: Window;
  private bridgeOrigin: string;
  private events: EventSource | null = null;
  private drawingId: string | null = null;
  private revision: number | null = null;
  private dirty = false;
  private reporting = false;
  private applying = false;
  private disposed = false;
  private timer: number | null = null;
  private reportPromise: Promise<boolean> | null = null;
  private lastPersistedSignature: string | null = null;
  private clientId: string;

  constructor(
    excalidrawAPI: ExcalidrawImperativeAPI,
    ownerWindow: Window,
    bridgeOrigin: string,
  ) {
    this.excalidrawAPI = excalidrawAPI;
    this.ownerWindow = ownerWindow;
    this.bridgeOrigin = bridgeOrigin.replace(/\/$/, "");
    this.clientId =
      ownerWindow.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  getOwnerWindow = () => this.ownerWindow;

  connect = () => {
    const EventSourceConstructor = (
      this.ownerWindow as unknown as { EventSource?: typeof EventSource }
    ).EventSource;
    if (typeof EventSourceConstructor !== "function") {
      return;
    }
    const events = new EventSourceConstructor(
      `${this.bridgeOrigin}/events?clientId=${encodeURIComponent(
        this.clientId,
      )}`,
    );
    this.events = events;
    events.addEventListener("message", (event) => {
      let message: DrawingMessage;
      try {
        message = JSON.parse((event as MessageEvent).data);
      } catch {
        return;
      }
      if (message.type === "scene") {
        this.applyRemoteDrawing(message);
      }
    });
  };

  private getChangeSignature = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) =>
    JSON.stringify({
      elements: elements.map(
        (element) =>
          `${element.id}:${element.version}:${element.isDeleted ? 1 : 0}`,
      ),
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom.value,
      viewBackgroundColor: appState.viewBackgroundColor,
      gridModeEnabled: appState.gridModeEnabled,
      gridSize: appState.gridSize,
      gridStep: appState.gridStep,
      objectsSnapModeEnabled: appState.objectsSnapModeEnabled,
      files: Object.values(files)
        .map((file) => `${file.id}:${file.lastRetrieved}`)
        .sort(),
    });

  notifyChange = (
    elements = this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    appState = this.excalidrawAPI.getAppState(),
    files = this.excalidrawAPI.getFiles(),
  ) => {
    if (this.disposed || this.applying || !this.drawingId) {
      return;
    }
    if (
      this.getChangeSignature(elements, appState, files) ===
      this.lastPersistedSignature
    ) {
      if (this.reporting) {
        this.dirty = true;
      } else {
        this.dirty = false;
        this.clearTimer();
      }
      return;
    }
    this.dirty = true;
    this.scheduleReport(300);
  };

  private applyRemoteDrawing = (message: DrawingMessage) => {
    if (
      !message.drawingId ||
      !Number.isInteger(message.revision) ||
      !Array.isArray(message.elements)
    ) {
      return;
    }
    if (
      message.drawingId === this.drawingId &&
      message.revision! <= (this.revision ?? -1)
    ) {
      return;
    }

    this.clearTimer();
    this.applying = true;
    this.drawingId = message.drawingId;
    this.revision = message.revision!;
    this.dirty = false;
    const current = this.excalidrawAPI.getAppState();
    const appState = message.appState;
    this.excalidrawAPI.updateScene({
      elements: restoreElements(message.elements, null),
      ...(appState
        ? {
            appState: {
              scrollX: appState.scrollX ?? current.scrollX,
              scrollY: appState.scrollY ?? current.scrollY,
              zoom: {
                value: appState.zoom?.value ?? current.zoom.value,
              } as typeof current.zoom,
            },
          }
        : {}),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    if (message.files && Object.keys(message.files).length > 0) {
      this.excalidrawAPI.addFiles(Object.values(message.files));
    }
    this.lastPersistedSignature = this.getChangeSignature(
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      this.excalidrawAPI.getAppState(),
      this.excalidrawAPI.getFiles(),
    );
    this.ownerWindow.setTimeout(() => {
      this.applying = false;
    }, 0);
  };

  flush = async () => {
    this.clearTimer();
    if (this.reportPromise) {
      await this.reportPromise;
    }
    let saved = true;
    for (let attempt = 0; this.dirty && attempt < 3; attempt += 1) {
      this.clearTimer();
      this.startReport();
      const pending = this.reportPromise;
      if (pending) {
        saved = (await pending) && saved;
      }
    }
    this.clearTimer();
    return !this.disposed && saved && !this.dirty;
  };

  private scheduleReport = (delay: number) => {
    if (this.disposed || this.reporting) {
      return;
    }
    this.clearTimer();
    this.timer = this.ownerWindow.setTimeout(() => {
      this.timer = null;
      this.startReport();
    }, delay);
  };

  private startReport = () => {
    const pending = this.report();
    this.reportPromise = pending;
    void pending.then(() => {
      if (this.reportPromise === pending) {
        this.reportPromise = null;
      }
    });
  };

  private report = async (): Promise<boolean> => {
    if (
      this.disposed ||
      this.reporting ||
      !this.dirty ||
      !this.drawingId ||
      this.revision === null
    ) {
      return !this.dirty;
    }
    const drawingId = this.drawingId;
    const baseRevision = this.revision;
    const elements = this.excalidrawAPI.getSceneElementsIncludingDeleted();
    const appState = this.excalidrawAPI.getAppState();
    const files = this.excalidrawAPI.getFiles();
    const reportedSignature = this.getChangeSignature(
      elements,
      appState,
      files,
    );
    this.reporting = true;
    this.dirty = false;
    let retryDelay = 0;
    let saved = false;
    try {
      const response = await this.ownerWindow.fetch(
        `${this.bridgeOrigin}/report`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: this.clientId,
            drawingId,
            baseRevision,
            elements,
            appState,
            files,
          }),
        },
      );
      const result = await response.json();
      if (this.disposed) {
        return false;
      }
      if (response.status === 409 && result.drawing) {
        this.applyRemoteDrawing({ type: "scene", ...result.drawing });
        saved = true;
      } else if (response.ok && result.drawing) {
        if (this.drawingId === drawingId && this.revision === baseRevision) {
          this.revision = result.drawing.revision;
          this.lastPersistedSignature = reportedSignature;
        }
        saved = true;
      } else {
        throw new Error(result.error || `Report failed (${response.status})`);
      }
    } catch {
      if (!this.disposed && this.drawingId === drawingId) {
        this.dirty = true;
        retryDelay = 2000;
      }
    } finally {
      this.reporting = false;
      if (this.dirty) {
        this.scheduleReport(retryDelay);
      }
    }
    return saved;
  };

  private clearTimer = () => {
    if (this.timer !== null) {
      this.ownerWindow.clearTimeout(this.timer);
      this.timer = null;
    }
  };

  dispose = () => {
    this.disposed = true;
    this.clearTimer();
    this.events?.close();
    this.events = null;
  };
}

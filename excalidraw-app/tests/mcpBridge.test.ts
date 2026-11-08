import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpBridge } from "../mcpBridge";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "immediately" },
  hashElementsVersion: (elements: Array<{ versionNonce?: number }>) =>
    elements.reduce((hash, element) => hash + (element.versionNonce ?? 0), 0),
  restoreElements: (elements: unknown) => elements,
}));

class FakeEventSource {
  static latest: FakeEventSource;
  url: string;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }

  emit(value: unknown) {
    this.listeners.get("message")?.(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }

  close() {
    this.closed = true;
  }
}

const scene = (revision = 0, id = "local") => ({
  type: "scene",
  projectId: "project",
  drawingId: "drawing",
  revision,
  elements: [{ id, type: "rectangle", x: 0, y: 0 }],
  appState: { scrollX: 10, scrollY: 20, zoom: { value: 1.2 } },
  files: {},
});

const setup = () => {
  let localVersionNonce = 0;
  const api = {
    getAppState: vi.fn(() => ({
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
    })),
    getSceneElementsIncludingDeleted: vi.fn(() => [
      { id: "local", type: "rectangle", x: 0, y: 0, versionNonce: 0 },
    ]),
    getFiles: vi.fn(() => ({})),
    updateScene: vi.fn(),
    addFiles: vi.fn(),
  };
  api.getSceneElementsIncludingDeleted.mockImplementation(() => [
    {
      id: "local",
      type: "rectangle",
      x: 0,
      y: 0,
      version: localVersionNonce,
      versionNonce: localVersionNonce,
    },
  ]);
  const fetch = vi.fn();
  const ownerWindow = {
    EventSource: FakeEventSource,
    fetch,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as unknown as Window;
  const bridge = new McpBridge(
    api as any,
    ownerWindow,
    "http://127.0.0.1:3845",
  );
  bridge.connect();
  return {
    bridge,
    api,
    fetch,
    events: FakeEventSource.latest,
    localChange: () => {
      localVersionNonce += 1;
    },
  };
};

describe("McpBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies persisted scenes without reporting them back", async () => {
    const { bridge, api, fetch, events } = setup();
    api.updateScene.mockImplementation(() => bridge.notifyChange());
    events.emit(scene(4));

    expect(api.updateScene).toHaveBeenCalledOnce();
    expect(api.updateScene.mock.calls[0][0].appState.scrollX).toBe(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("debounces manual changes and reports the current revision and files", async () => {
    const { bridge, fetch, events, localChange } = setup();
    events.emit(scene(0));
    await vi.advanceTimersByTimeAsync(0);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ drawing: scene(1) }),
    });

    localChange();
    bridge.notifyChange();
    localChange();
    bridge.notifyChange();
    await vi.advanceTimersByTimeAsync(299);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.drawingId).toBe("drawing");
    expect(body.baseRevision).toBe(0);
    expect(body.files).toEqual({});
    bridge.dispose();
  });

  it("uses the server drawing when a report has a revision conflict", async () => {
    const { bridge, api, fetch, events, localChange } = setup();
    events.emit(scene(0));
    await vi.advanceTimersByTimeAsync(0);
    fetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ drawing: scene(3, "server") }),
    });

    localChange();
    bridge.notifyChange();
    await vi.advanceTimersByTimeAsync(300);

    expect(api.updateScene).toHaveBeenCalledTimes(2);
    expect(api.updateScene.mock.calls[1][0].elements[0].id).toBe("server");
    bridge.dispose();
  });

  it("ignores duplicate events and stops timers on dispose", async () => {
    const { bridge, api, fetch, events, localChange } = setup();
    events.emit(scene(2));
    events.emit(scene(2));
    expect(api.updateScene).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    localChange();
    bridge.notifyChange();
    bridge.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
    expect(events.closed).toBe(true);
  });
});

describe("McpBridge flushing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists debounced changes before switching drawings", async () => {
    const { bridge, fetch, events, localChange } = setup();
    events.emit(scene(0));
    await vi.advanceTimersByTimeAsync(0);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ drawing: scene(1) }),
    });

    localChange();
    bridge.notifyChange();
    await expect(bridge.flush()).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body).baseRevision).toBe(0);
    bridge.dispose();
  });

  it("reports a failed flush without scheduling another immediate retry", async () => {
    const { bridge, fetch, events, localChange } = setup();
    events.emit(scene(0));
    await vi.advanceTimersByTimeAsync(0);
    fetch.mockRejectedValue(new Error("offline"));

    localChange();
    bridge.notifyChange();
    await expect(bridge.flush()).resolves.toBe(false);

    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(3);
    bridge.dispose();
  });
});

describe("McpBridge programmatic updates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a delayed onChange for the exact applied scene", async () => {
    const { bridge, api, fetch, events } = setup();
    const elements = [
      { id: "server", type: "rectangle", x: 0, y: 0, versionNonce: 0 },
    ];
    const appState = { scrollX: 10, scrollY: 20, zoom: { value: 1 } };
    const files = {};
    api.getSceneElementsIncludingDeleted.mockReturnValue(elements);
    api.getAppState.mockReturnValue(appState);
    api.getFiles.mockReturnValue(files);

    events.emit(scene(1));
    await vi.advanceTimersByTimeAsync(0);
    bridge.notifyChange(
      elements as any,
      { ...appState, showWelcomeScreen: true } as any,
      files,
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetch).not.toHaveBeenCalled();
    bridge.dispose();
  });
});

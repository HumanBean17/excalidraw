export const MCP_SERVER_ORIGIN = (
  import.meta.env.VITE_APP_MCP_URL || "http://127.0.0.1:3845"
).replace(/\/$/, "");

export type McpProject = {
  id: string;
  name: string;
  drawingCount: number;
  active: boolean;
};

export type McpDrawing = {
  id: string;
  projectId: string;
  name: string;
  revision: number;
  elementCount: number;
  updatedAt: string;
  active: boolean;
};

export class McpClient {
  private ownerWindow: Window;
  private origin: string;

  constructor(ownerWindow: Window, origin = MCP_SERVER_ORIGIN) {
    this.ownerWindow = ownerWindow;
    this.origin = origin.replace(/\/$/, "");
  }

  private request = async <T>(
    path: string,
    options: { method?: string; body?: object } = {},
  ): Promise<T> => {
    const response = await this.ownerWindow.fetch(`${this.origin}${path}`, {
      method: options.method ?? "GET",
      ...(options.body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options.body),
          }
        : {}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(result?.error || `Request failed (${response.status})`);
    }
    return result as T;
  };

  listProjects = async () => {
    const result = await this.request<{ projects: McpProject[] }>("/projects");
    return result.projects;
  };

  createProject = async (name: string) => {
    const result = await this.request<{ project: McpProject }>("/projects", {
      method: "POST",
      body: { name },
    });
    return result.project;
  };

  deleteProject = (projectId: string) =>
    this.request<{ ok: true }>(`/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
    });

  listDrawings = async (projectId: string) => {
    const result = await this.request<{ drawings: McpDrawing[] }>(
      `/projects/${encodeURIComponent(projectId)}/drawings`,
    );
    return result.drawings;
  };

  createDrawing = async (projectId: string, name: string) => {
    const result = await this.request<{ drawing: McpDrawing }>(
      `/projects/${encodeURIComponent(projectId)}/drawings`,
      { method: "POST", body: { name, open: true } },
    );
    return result.drawing;
  };

  openDrawing = (drawingId: string) =>
    this.request<{ drawing: McpDrawing }>(
      `/drawings/${encodeURIComponent(drawingId)}/open`,
      { method: "POST" },
    );

  deleteDrawing = (drawingId: string) =>
    this.request<{ ok: true }>(`/drawings/${encodeURIComponent(drawingId)}`, {
      method: "DELETE",
    });

  subscribe = (onChange: () => void) => {
    const EventSourceConstructor = (
      this.ownerWindow as unknown as { EventSource?: typeof EventSource }
    ).EventSource;
    if (typeof EventSourceConstructor !== "function") {
      return () => {};
    }
    const events = new EventSourceConstructor(`${this.origin}/events`);
    events.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse((event as MessageEvent).data);
      } catch {
        message = null;
      }
      if (message?.type === "scene" || message?.type === "store-changed") {
        onChange();
      }
    });
    return () => events.close();
  };
}

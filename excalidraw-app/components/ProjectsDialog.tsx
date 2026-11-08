import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { McpClient } from "../mcpClient";

import "./ProjectsDialog.scss";

import type { McpDrawing, McpProject } from "../mcpClient";

export const ProjectsDialog = ({
  ownerWindow,
  onCloseRequest,
  onFlush,
}: {
  ownerWindow: Window;
  onCloseRequest: () => void;
  onFlush: () => Promise<boolean>;
}) => {
  const client = useMemo(() => new McpClient(ownerWindow), [ownerWindow]);
  const [projects, setProjects] = useState<McpProject[]>([]);
  const [drawings, setDrawings] = useState<McpDrawing[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const selectedProjectRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const [projectName, setProjectName] = useState("");
  const [drawingName, setDrawingName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const nextProjects = await client.listProjects();
      if (disposedRef.current) {
        return;
      }
      const selected =
        nextProjects.find(
          (project) => project.id === selectedProjectRef.current,
        ) ??
        nextProjects.find((project) => project.active) ??
        nextProjects[0] ??
        null;
      selectedProjectRef.current = selected?.id ?? null;
      setProjects(nextProjects);
      setSelectedProjectId(selected?.id ?? null);
      const nextDrawings = selected
        ? await client.listDrawings(selected.id)
        : [];
      if (disposedRef.current) {
        return;
      }
      setDrawings(nextDrawings);
      setError(null);
    } catch (cause) {
      if (!disposedRef.current) {
        setError(
          `Cannot connect to the MCP server. Start it with “yarn start:mcp”, then reload this dialog.\n${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    } finally {
      if (!disposedRef.current) {
        setLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    disposedRef.current = false;
    let timer: number | null = null;
    const unsubscribe = client.subscribe(() => {
      if (timer !== null) {
        ownerWindow.clearTimeout(timer);
      }
      timer = ownerWindow.setTimeout(() => {
        timer = null;
        void refresh();
      }, 50);
    });
    void refresh();
    return () => {
      disposedRef.current = true;
      if (timer !== null) {
        ownerWindow.clearTimeout(timer);
      }
      unsubscribe();
    };
  }, [client, ownerWindow, refresh]);

  const run = async (
    action: () => Promise<unknown>,
    options: { flush?: boolean; close?: boolean } = {},
  ) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (options.flush && !(await onFlush())) {
        throw new Error(
          "The current drawing could not be saved. Check the MCP server and try again.",
        );
      }
      await action();
      if (options.close) {
        onCloseRequest();
      } else {
        await refresh();
      }
    } catch (cause) {
      if (!disposedRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!disposedRef.current) {
        setBusy(false);
      }
    }
  };

  const selectProject = (projectId: string) => {
    selectedProjectRef.current = projectId;
    setSelectedProjectId(projectId);
    void refresh();
  };

  const selectedProject = projects.find(
    (project) => project.id === selectedProjectId,
  );

  return (
    <Dialog
      className="ProjectsDialog__modal"
      size="wide"
      onCloseRequest={onCloseRequest}
      title="Projects"
    >
      <div className="ProjectsDialog">
        {error && (
          <p className="ProjectsDialog__error" role="alert">
            {error}
          </p>
        )}
        <section className="ProjectsDialog__panel">
          <div className="ProjectsDialog__heading">
            <h3>Projects</h3>
            <button
              type="button"
              className="ProjectsDialog__action"
              onClick={() => void refresh()}
              disabled={busy}
            >
              Refresh
            </button>
          </div>
          <ul className="ProjectsDialog__list" aria-label="Projects">
            {projects.map((project) => (
              <li
                key={project.id}
                className={`ProjectsDialog__row${
                  project.id === selectedProjectId
                    ? " ProjectsDialog__row--selected"
                    : ""
                }`}
              >
                <button
                  type="button"
                  className="ProjectsDialog__select"
                  onClick={() => selectProject(project.id)}
                  disabled={busy}
                >
                  <span className="ProjectsDialog__name">
                    {project.name}
                    {project.active ? " (active)" : ""}
                  </span>
                  <span className="ProjectsDialog__meta">
                    {project.drawingCount}{" "}
                    {project.drawingCount === 1 ? "drawing" : "drawings"}
                  </span>
                </button>
                <button
                  type="button"
                  className="ProjectsDialog__action ProjectsDialog__action--danger"
                  aria-label={`Delete project ${project.name}`}
                  disabled={busy || project.drawingCount > 0 || project.active}
                  title={
                    project.active
                      ? "Open another project before deleting this one"
                      : project.drawingCount > 0
                      ? "Delete all drawings in this project first"
                      : "Delete project"
                  }
                  onClick={() => {
                    if (
                      ownerWindow.confirm(
                        `Permanently delete project “${project.name}”?`,
                      )
                    ) {
                      void run(() => client.deleteProject(project.id));
                    }
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <form
            className="ProjectsDialog__create"
            onSubmit={(event) => {
              event.preventDefault();
              const name = projectName.trim();
              if (!name) {
                return;
              }
              void run(async () => {
                const project = await client.createProject(name);
                selectedProjectRef.current = project.id;
                setProjectName("");
              });
            }}
          >
            <TextField
              label="New project"
              value={projectName}
              onChange={setProjectName}
              placeholder="Project name"
              fullWidth
            />
            <button
              type="submit"
              className="ProjectsDialog__createButton"
              disabled={busy || !projectName.trim()}
            >
              Create
            </button>
          </form>
        </section>

        <section className="ProjectsDialog__panel">
          <div className="ProjectsDialog__heading">
            <h3>{selectedProject?.name ?? "Drawings"}</h3>
          </div>
          {loading ? (
            <p className="ProjectsDialog__status">Loading…</p>
          ) : drawings.length === 0 ? (
            <p className="ProjectsDialog__empty">
              No drawings in this project yet.
            </p>
          ) : (
            <ul className="ProjectsDialog__list" aria-label="Drawings">
              {drawings.map((drawing) => (
                <li key={drawing.id} className="ProjectsDialog__row">
                  <button
                    type="button"
                    className="ProjectsDialog__select"
                    onClick={() =>
                      void run(() => client.openDrawing(drawing.id), {
                        flush: true,
                        close: true,
                      })
                    }
                    disabled={busy}
                  >
                    <span className="ProjectsDialog__name">
                      {drawing.name}
                      {drawing.active ? " (open)" : ""}
                    </span>
                    <span className="ProjectsDialog__meta">
                      {drawing.elementCount} elements · revision{" "}
                      {drawing.revision}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ProjectsDialog__action ProjectsDialog__action--danger"
                    aria-label={`Delete drawing ${drawing.name}`}
                    disabled={busy}
                    onClick={() => {
                      if (
                        ownerWindow.confirm(
                          `Permanently delete drawing “${drawing.name}”?`,
                        )
                      ) {
                        void run(() => client.deleteDrawing(drawing.id), {
                          flush: drawing.active,
                        });
                      }
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="ProjectsDialog__create"
            onSubmit={(event) => {
              event.preventDefault();
              const name = drawingName.trim();
              if (!selectedProjectId || !name) {
                return;
              }
              void run(
                async () => {
                  await client.createDrawing(selectedProjectId, name);
                  setDrawingName("");
                },
                { flush: true, close: true },
              );
            }}
          >
            <TextField
              label="New drawing"
              value={drawingName}
              onChange={setDrawingName}
              placeholder="Drawing name"
              fullWidth
            />
            <button
              type="submit"
              className="ProjectsDialog__createButton"
              disabled={busy || !selectedProjectId || !drawingName.trim()}
            >
              Create & open
            </button>
          </form>
        </section>
        <p className="ProjectsDialog__hint">
          Saved locally in <code>~/.excalidraw</code>. Agents access the same
          projects and drawings through MCP.
        </p>
      </div>
    </Dialog>
  );
};

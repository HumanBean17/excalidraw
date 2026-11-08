import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const clone = (value) => structuredClone(value);
const timestamp = () => new Date().toISOString();

export class StoreError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "StoreError";
    this.statusCode = statusCode;
  }
}

const requireName = (name) => {
  if (typeof name !== "string" || !name.trim()) {
    throw new StoreError("A non-empty name is required");
  }
  if (name.length > 200) {
    throw new StoreError("Names must be at most 200 characters");
  }
  return name.trim();
};

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${error.message}`);
    }
    throw error;
  }
};

const writeJsonAtomic = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
};

const pathExists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export const migrateLegacyDataDir = async (legacyDataDir, dataDir) => {
  if (!(await pathExists(legacyDataDir))) {
    return false;
  }
  if (await pathExists(dataDir)) {
    throw new Error(
      `Cannot migrate ${legacyDataDir} because ${dataDir} already exists. Move or merge the directories manually, or select one with --data-dir.`,
    );
  }
  await rename(legacyDataDir, dataDir);
  return true;
};

const validateProject = (project, path) => {
  if (
    !project ||
    typeof project.id !== "string" ||
    typeof project.name !== "string"
  ) {
    throw new Error(`Invalid project record in ${path}`);
  }
  return project;
};

const validateDrawing = (drawing, path) => {
  if (
    !drawing ||
    typeof drawing.id !== "string" ||
    typeof drawing.projectId !== "string" ||
    typeof drawing.name !== "string" ||
    !Number.isInteger(drawing.revision) ||
    !Array.isArray(drawing.elements) ||
    typeof drawing.files !== "object" ||
    drawing.files === null
  ) {
    throw new Error(`Invalid drawing record in ${path}`);
  }
  return drawing;
};

export class DrawingStore extends EventEmitter {
  #dataDir;
  #projects = new Map();
  #drawings = new Map();
  #active = null;
  #queues = new Map();

  constructor(dataDir) {
    super();
    this.#dataDir = dataDir;
  }

  get dataDir() {
    return this.#dataDir;
  }

  async initialize() {
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
    const projectDirectory = join(this.#dataDir, "projects");
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });

    const projectEntries = await readdir(projectDirectory, {
      withFileTypes: true,
    });
    for (const entry of projectEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const projectPath = join(projectDirectory, entry.name, "project.json");
      const project = validateProject(await readJson(projectPath), projectPath);
      this.#projects.set(project.id, project);

      const drawingDirectory = join(projectDirectory, entry.name, "drawings");
      const drawingEntries = await readdir(drawingDirectory, {
        withFileTypes: true,
      }).catch((error) => {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      });
      for (const drawingEntry of drawingEntries) {
        if (!drawingEntry.isFile() || !drawingEntry.name.endsWith(".json")) {
          continue;
        }
        const drawingPath = join(drawingDirectory, drawingEntry.name);
        const drawing = validateDrawing(
          await readJson(drawingPath),
          drawingPath,
        );
        if (drawing.projectId !== project.id) {
          throw new Error(
            `Drawing ${drawing.id} is stored under the wrong project`,
          );
        }
        this.#drawings.set(drawing.id, drawing);
      }
    }

    if (this.#projects.size === 0) {
      const project = await this.#createProject("Default");
      await this.#createDrawing("Untitled drawing", project.id);
    }

    const activePath = join(this.#dataDir, "active.json");
    const active = await readJson(activePath);
    if (active && this.#drawings.has(active.drawingId)) {
      this.#active = {
        projectId: this.#drawings.get(active.drawingId).projectId,
        drawingId: active.drawingId,
      };
    } else {
      const firstDrawing = this.#drawings.values().next().value;
      this.#active = {
        projectId: firstDrawing.projectId,
        drawingId: firstDrawing.id,
      };
      await writeJsonAtomic(activePath, this.#active);
    }
    return this;
  }

  async #enqueue(key, operation) {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const cleanup = () => {
      if (this.#queues.get(key) === pending) {
        this.#queues.delete(key);
      }
    };
    const pending = result.then(cleanup, cleanup);
    this.#queues.set(key, pending);
    return result;
  }

  #projectPath(projectId) {
    return join(this.#dataDir, "projects", projectId, "project.json");
  }

  #drawingPath(projectId, drawingId) {
    return join(
      this.#dataDir,
      "projects",
      projectId,
      "drawings",
      `${drawingId}.json`,
    );
  }

  async #createProject(name) {
    const now = timestamp();
    const project = {
      id: randomUUID(),
      name: requireName(name),
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(this.#projectPath(project.id), project);
    this.#projects.set(project.id, project);
    return clone(project);
  }

  async #createDrawing(name, projectId) {
    const project = this.#projects.get(projectId);
    if (!project) {
      throw new StoreError(`Project not found: ${projectId}`, 404);
    }
    const now = timestamp();
    const drawing = {
      id: randomUUID(),
      projectId,
      name: requireName(name),
      revision: 0,
      createdAt: now,
      updatedAt: now,
      elements: [],
      appState: null,
      files: {},
    };
    await writeJsonAtomic(this.#drawingPath(projectId, drawing.id), drawing);
    this.#drawings.set(drawing.id, drawing);
    return clone(drawing);
  }

  listProjects() {
    return [...this.#projects.values()]
      .map((project) => ({
        ...clone(project),
        drawingCount: [...this.#drawings.values()].filter(
          (drawing) => drawing.projectId === project.id,
        ).length,
        active: project.id === this.#active.projectId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProject(name) {
    const project = await this.#enqueue("projects", () =>
      this.#createProject(name),
    );
    this.emit("store-changed");
    return project;
  }

  async deleteProject(projectId) {
    return this.#enqueue("projects", async () => {
      if (projectId === this.#active.projectId) {
        throw new StoreError("Open another project before deleting this one");
      }
      if (!this.#projects.has(projectId)) {
        throw new StoreError(`Project not found: ${projectId}`, 404);
      }
      if (
        [...this.#drawings.values()].some(
          (drawing) => drawing.projectId === projectId,
        )
      ) {
        throw new StoreError("Delete all drawings in the project first");
      }
      await rm(dirname(this.#projectPath(projectId)), {
        recursive: true,
        force: true,
      });
      this.#projects.delete(projectId);
      this.emit("store-changed");
      return { ok: true, deleted: projectId };
    });
  }

  #getProject(projectId) {
    const id = projectId ?? this.#active.projectId;
    const project = this.#projects.get(id);
    if (!project) {
      throw new StoreError(`Project not found: ${id}`, 404);
    }
    return project;
  }

  #getDrawing(drawingId) {
    const id = drawingId ?? this.#active.drawingId;
    const drawing = this.#drawings.get(id);
    if (!drawing) {
      throw new StoreError(`Drawing not found: ${id}`, 404);
    }
    return drawing;
  }

  listDrawings(projectId) {
    const project = this.#getProject(projectId);
    return [...this.#drawings.values()]
      .filter((drawing) => drawing.projectId === project.id)
      .map((drawing) => ({
        id: drawing.id,
        projectId: drawing.projectId,
        name: drawing.name,
        revision: drawing.revision,
        createdAt: drawing.createdAt,
        updatedAt: drawing.updatedAt,
        elementCount: drawing.elements.filter((element) => !element.isDeleted)
          .length,
        active: drawing.id === this.#active.drawingId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createDrawing(name, projectId, shouldOpen = false) {
    const project = this.#getProject(projectId);
    const drawing = await this.#enqueue(`project:${project.id}`, () =>
      this.#createDrawing(name, project.id),
    );
    this.emit("store-changed");
    return shouldOpen ? this.openDrawing(drawing.id) : drawing;
  }

  getDrawing(drawingId) {
    return clone(this.#getDrawing(drawingId));
  }

  getActiveDrawing() {
    return clone(this.#getDrawing());
  }

  async openDrawing(drawingId) {
    return this.#enqueue("active", async () => {
      const drawing = this.#getDrawing(drawingId);
      this.#active = { projectId: drawing.projectId, drawingId: drawing.id };
      await writeJsonAtomic(join(this.#dataDir, "active.json"), this.#active);
      this.emit("store-changed");
      this.emit("drawing-opened", clone(drawing));
      return clone(drawing);
    });
  }

  async deleteDrawing(drawingId) {
    const drawing = this.#getDrawing(drawingId);
    if (
      this.listDrawings(drawing.projectId).length === 1 &&
      this.#active.drawingId === drawingId
    ) {
      throw new StoreError(
        "Open a drawing in another project before deleting the last drawing",
      );
    }
    await this.#enqueue(`drawing:${drawingId}`, async () => {
      await unlink(this.#drawingPath(drawing.projectId, drawingId));
      this.#drawings.delete(drawingId);
    });
    this.emit("store-changed");
    if (this.#active.drawingId === drawingId) {
      const replacement = this.listDrawings(drawing.projectId)[0];
      await this.openDrawing(replacement.id);
    }
    return { ok: true, deleted: drawingId };
  }

  async mutateDrawing(
    drawingId,
    mutation,
    expectedRevision,
    { sourceClientId } = {},
  ) {
    const current = this.#getDrawing(drawingId);
    return this.#enqueue(`drawing:${current.id}`, async () => {
      const drawing = this.#getDrawing(current.id);
      if (
        expectedRevision !== undefined &&
        drawing.revision !== expectedRevision
      ) {
        throw new StoreError(
          `Revision conflict: expected ${expectedRevision}, current ${drawing.revision}`,
          409,
        );
      }
      const changes = await mutation(clone(drawing));
      if (
        Object.entries(changes).every(([key, value]) =>
          isDeepStrictEqual(value, drawing[key]),
        )
      ) {
        return clone(drawing);
      }
      const next = {
        ...drawing,
        ...changes,
        id: drawing.id,
        projectId: drawing.projectId,
        revision: drawing.revision + 1,
        createdAt: drawing.createdAt,
        updatedAt: timestamp(),
      };
      validateDrawing(next, this.#drawingPath(drawing.projectId, drawing.id));
      await writeJsonAtomic(
        this.#drawingPath(drawing.projectId, drawing.id),
        next,
      );
      this.#drawings.set(next.id, next);
      this.emit("drawing-updated", clone(next), { sourceClientId });
      return clone(next);
    });
  }
}

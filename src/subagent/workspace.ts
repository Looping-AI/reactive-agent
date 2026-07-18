import { Workspace } from "@cloudflare/shell";

/**
 * The narrow file-store surface the resumable runner and its tool families use.
 *
 * This is the **only** import surface for `@cloudflare/shell` in the codebase:
 * shell is experimental ("expect breaking changes"), so tools and the runner code
 * against this stable wrapper, never shell's full (large, churning) API. Backed by
 * the facet's own SQLite via a shell {@link Workspace}, so per-Subtask isolation is
 * free and `deleteSubAgent` wipes it with the rest of the facet's storage.
 */
export interface WorkspaceHandle {
  /** File content, or null if the file does not exist. */
  read(path: string): Promise<string | null>;
  /** Write (create or overwrite) a text file. Parent directories are created. */
  write(path: string, content: string): Promise<void>;
  /** Whether a file or directory exists at the path. */
  exists(path: string): Promise<boolean>;
  /** Delete a file. Returns whether a file was removed. */
  remove(path: string): Promise<boolean>;
  /** Immediate entries under `dir` (default root): their path and byte size. */
  list(dir?: string): Promise<WorkspaceEntry[]>;
  /** Parse a JSON file, or null if it does not exist. Throws on malformed JSON. */
  readJson<T>(path: string): Promise<T | null>;
  /** Serialize a value to a JSON file (pretty-printed). */
  writeJson(path: string, value: unknown): Promise<void>;
}

export interface WorkspaceEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
}

/**
 * The subset of a shell {@link Workspace} the handle needs. Declared structurally
 * so tests can supply a lightweight fake without a real SQLite backend, and so the
 * handle never depends on the full Workspace class.
 */
export type WorkspaceBacking = Pick<
  Workspace,
  | "readFile"
  | "writeFile"
  | "exists"
  | "deleteFile"
  | "readDir"
  | "getWorkspaceInfo"
>;

/** Per-file byte ceiling — safely under the 2 MB Durable Object SQLite row limit. */
export const WORKSPACE_MAX_FILE_BYTES = 512 * 1024;
/** Max number of files in one workspace — a cheap guard against runaway writes. */
export const WORKSPACE_MAX_FILES = 200;

export class WorkspaceLimitError extends Error {}

/**
 * Build a {@link WorkspaceHandle} over a shell workspace (or a test fake),
 * enforcing the per-file and file-count caps. The caps degrade a misbehaving
 * recipe to an explicit error rather than letting it exceed the DO row limit or
 * fill storage.
 */
export function makeWorkspaceHandle(ws: WorkspaceBacking): WorkspaceHandle {
  const byteLength = (s: string): number => new TextEncoder().encode(s).length;

  return {
    read: (path) => ws.readFile(path),

    async write(path, content) {
      const bytes = byteLength(content);
      if (bytes > WORKSPACE_MAX_FILE_BYTES) {
        throw new WorkspaceLimitError(
          `file "${path}" is ${bytes} bytes, over the ${WORKSPACE_MAX_FILE_BYTES}-byte limit`
        );
      }
      if (!(await ws.exists(path))) {
        const { fileCount } = await ws.getWorkspaceInfo();
        if (fileCount >= WORKSPACE_MAX_FILES) {
          throw new WorkspaceLimitError(
            `workspace already holds ${fileCount} files (max ${WORKSPACE_MAX_FILES})`
          );
        }
      }
      await ws.writeFile(path, content);
    },

    exists: (path) => ws.exists(path),

    remove: (path) => ws.deleteFile(path),

    async list(dir) {
      const entries = await ws.readDir(dir);
      return entries.map((e) => ({
        path: e.path,
        type: e.type,
        size: e.size
      }));
    },

    async readJson<T>(path: string): Promise<T | null> {
      const raw = await ws.readFile(path);
      return raw === null ? null : (JSON.parse(raw) as T);
    },

    async writeJson(path, value) {
      await this.write(path, JSON.stringify(value, null, 2));
    }
  };
}

/**
 * Construct a shell {@link Workspace} over a Durable Object's SQLite storage. The
 * facet calls this with its own `ctx.storage.sql`; `name` is lazy because a
 * facet's `name` is set after construction.
 */
export function createDurableWorkspace(
  sql: SqlStorage,
  name: () => string | undefined
): Workspace {
  return new Workspace({ sql, name });
}

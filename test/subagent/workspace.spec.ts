import { describe, it, expect } from "vitest";
import {
  makeWorkspaceHandle,
  WorkspaceLimitError,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_FILES,
  type WorkspaceBacking
} from "@/subagent/workspace";

/** An in-memory backing that satisfies the WorkspaceBacking subset of Workspace. */
function memoryBacking(): WorkspaceBacking {
  const files = new Map<string, string>();
  return {
    readFile: async (path) => files.get(path) ?? null,
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    exists: async (path) => files.has(path),
    deleteFile: async (path) => files.delete(path),
    readDir: async () =>
      [...files.entries()].map(([path, content]) => ({
        path,
        name: path,
        type: "file" as const,
        mimeType: "text/plain",
        size: content.length,
        createdAt: 0,
        updatedAt: 0
      })),
    getWorkspaceInfo: async () => ({
      fileCount: files.size,
      directoryCount: 0,
      totalBytes: 0,
      r2FileCount: 0
    })
  };
}

describe("makeWorkspaceHandle", () => {
  it("reads back what it writes, and returns null for a missing file", async () => {
    const ws = makeWorkspaceHandle(memoryBacking());
    expect(await ws.read("notes.md")).toBeNull();
    await ws.write("notes.md", "hello");
    expect(await ws.read("notes.md")).toBe("hello");
    expect(await ws.exists("notes.md")).toBe(true);
  });

  it("round-trips JSON via readJson/writeJson", async () => {
    const ws = makeWorkspaceHandle(memoryBacking());
    await ws.writeJson("state.json", { a: 1, b: ["x"] });
    expect(await ws.readJson("state.json")).toEqual({ a: 1, b: ["x"] });
    expect(await ws.readJson("missing.json")).toBeNull();
  });

  it("lists files with sizes", async () => {
    const ws = makeWorkspaceHandle(memoryBacking());
    await ws.write("a.txt", "12345");
    const entries = await ws.list();
    expect(entries).toEqual([{ path: "a.txt", type: "file", size: 5 }]);
  });

  it("removes files", async () => {
    const ws = makeWorkspaceHandle(memoryBacking());
    await ws.write("a.txt", "x");
    expect(await ws.remove("a.txt")).toBe(true);
    expect(await ws.exists("a.txt")).toBe(false);
  });

  it("rejects a file over the per-file byte cap", async () => {
    const ws = makeWorkspaceHandle(memoryBacking());
    const tooBig = "a".repeat(WORKSPACE_MAX_FILE_BYTES + 1);
    await expect(ws.write("big.txt", tooBig)).rejects.toThrow(
      WorkspaceLimitError
    );
  });

  it("rejects a new file once the file-count cap is reached", async () => {
    const backing = memoryBacking();
    const ws = makeWorkspaceHandle(backing);
    for (let i = 0; i < WORKSPACE_MAX_FILES; i++) {
      await ws.write(`f${i}.txt`, "x");
    }
    await expect(ws.write("one-too-many.txt", "x")).rejects.toThrow(
      WorkspaceLimitError
    );
    // Overwriting an existing file is still allowed at the cap.
    await expect(ws.write("f0.txt", "y")).resolves.toBeUndefined();
  });
});

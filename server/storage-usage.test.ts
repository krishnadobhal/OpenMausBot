import { linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { storageLow } from "../shared/storage.ts";
import { scanStorage, storageDisks, type StorageSources } from "./storage-usage.ts";

const GIB = 1024 ** 3;

function put(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
}

/** Every entry under `dir` with its size and modified time: equal before and after means nothing was touched. */
function snapshot(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort().map((name) => {
    const info = statSync(join(dir, name));
    return `${name}:${info.isFile() ? info.size : "dir"}:${info.mtimeMs}`;
  });
}

function world() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omb-storage-")));
  const dataDir = join(base, "data"), project = join(base, "project"), shared = join(base, "shared");
  put(join(dataDir, "workspaces", "ada", "MEMORY.md"), 10);
  put(join(dataDir, "workspaces", "gone", "old.txt"), 7);
  put(join(dataDir, "task-workspaces", "ada", "t1", ".hidden"), 100);
  put(join(dataDir, "task-workspaces", "ada", "deleted", "left.bin"), 5);
  put(join(project, "package.json"), 2);
  put(join(project, "node_modules", "dep", "index.js"), 1000);
  put(join(project, "node_modules", "dep", "node_modules", "inner", "a.js"), 500);
  put(join(project, "tsconfig.json"), 0);
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "./dist" } }));
  put(join(project, "dist", "out.js"), 300);
  put(join(project, "build", "unproven.js"), 40);
  put(join(project, "logs", "run.log"), 60);
  put(join(project, "nested", "thread.txt"), 20);
  put(join(shared, "both.txt"), 30);
  linkSync(join(shared, "both.txt"), join(project, "same-file.txt"));
  try {
    symlinkSync(shared, join(project, "link-to-shared"), "junction");
  } catch {
  }
  const sources: StorageSources = {
    dataDir,
    bots: [
      { id: "ada", name: "Ada", cwd: project, tasks: [
        { threadId: "t1", title: "First", cwd: join(dataDir, "task-workspaces", "ada", "t1") },
        { threadId: "t2", title: "Nested", cwd: join(project, "nested") },
        { threadId: "t3", title: "Follows the bot" },
        { threadId: "t4", title: "No folder", cwd: null },
        { threadId: "t5", title: "Shared", cwd: shared },
      ] },
      { id: "bo", name: "Bo", cwd: shared },
      { id: "cy", name: "Cy", cwd: join(base, "never-made") },
      { id: "di", name: "Di", cwd: base },
    ],
    groups: [{ id: "room", name: "Room", threadId: "r1", cwd: shared }],
  };
  return { base, dataDir, project, shared, sources };
}

describe("storage usage", () => {
  it("counts each file once, in its most specific folder, and changes nothing", async () => {
    const { base, project, shared, sources } = world();
    const before = snapshot(base);

    const usage = await scanStorage(sources, { home: base });

    expect(snapshot(base)).toEqual(before);
    const at = (location: string) => usage.roots.find((root) => root.location === location);
    const projectFiles = 2 + 1000 + 500 + statSync(join(project, "tsconfig.json")).size + 300 + 40 + 60;
    const sharedRow = at(shared)!, projectRow = at(project)!;
    expect(sharedRow.kind).toBe("shared");
    expect(sharedRow.owners.map((owner) => owner.name).sort()).toEqual(["Ada", "Bo", "Room"]);
    // The hard-linked file is counted in whichever of its two folders was walked first.
    expect(projectRow.bytes + sharedRow.bytes).toBe(projectFiles + 30);
    expect(projectRow).toMatchObject({ kind: "owner", managed: false });
    expect(at(join(project, "nested"))).toMatchObject({ kind: "thread", bytes: 20, files: 1 });
    expect(usage.roots.find((root) => root.owners[0]?.threadId === "t1")).toMatchObject({ kind: "thread", managed: true, bytes: 100 });
    expect(usage.roots.filter((root) => root.kind === "unassigned").map((root) => root.bytes).sort()).toEqual([5, 7]);
    expect(usage.roots.find((root) => root.owners[0]?.name === "Cy")).toMatchObject({ gap: "missing", bytes: 0 });
    expect(usage.roots.find((root) => root.owners[0]?.name === "Di")).toMatchObject({ gap: "broad", bytes: 0 });
    expect(usage.bytes).toBe(projectFiles + 30 + 20 + 10 + 7 + 100 + 5);
    expect(usage.bytes).toBe(usage.roots.reduce((sum, root) => sum + root.bytes, 0));
    expect(usage.complete).toBe(true);
  });

  it("suggests only folders a manifest, a known cache name or a project's own settings vouch for", async () => {
    const { sources } = world();
    const usage = await scanStorage(sources, { home: sources.dataDir });
    expect(usage.candidates.map(({ location, bytes, category, evidence }) => ({ location, bytes, category, evidence }))).toEqual([
      { location: "node_modules", bytes: 1500, category: "dependencies", evidence: "package.json" },
      { location: "dist", bytes: 300, category: "build", evidence: "tsconfig.json" },
    ]);
  });

  it("says so when a limit stopped it, instead of giving a low number as the total", async () => {
    const { sources } = world();
    const usage = await scanStorage(sources, { entries: 1, home: sources.dataDir });
    expect(usage.complete).toBe(false);
    expect(usage.roots.some((root) => root.gap === "limit")).toBe(true);
  });

  it("warns below 10 GiB free or below a tenth of the volume", () => {
    expect(storageLow(1000 * GIB, 10 * GIB - 1)).toBe(true);
    expect(storageLow(50 * GIB, 10 * GIB)).toBe(false);
    expect(storageLow(1000 * GIB, 99 * GIB)).toBe(true);
    expect(storageLow(1000 * GIB, 100 * GIB)).toBe(false);
  });

  it("reads each volume once, and a folder that is gone as unavailable rather than healthy or full", async () => {
    const { sources } = world();
    const disks = await storageDisks(sources);
    const known = disks.filter((disk) => !disk.unavailable);
    expect(known).toHaveLength(1);
    expect(known[0]).toMatchObject({ appData: true });
    expect(known[0]!.totalBytes).toBeGreaterThan(0);
    expect(disks.filter((disk) => disk.unavailable)).toMatchObject([{ low: false, totalBytes: 0 }]);
  });
});

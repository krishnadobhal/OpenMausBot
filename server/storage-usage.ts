// Read-only: how much each bot's, room's and conversation's folder holds, and the free space of the volumes under them.
// Security invariant: nothing here creates, changes or deletes a file, and the only contents read are the small
// declarative project files in provenBuildFolders.
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { storageLow, type StorageCandidate, type StorageDisk, type StorageOwner, type StorageRoot, type StorageUsage } from "../shared/storage.ts";

export interface StorageSources {
  dataDir: string;
  bots: ReadonlyArray<{ id: string; name: string; cwd?: string; tasks?: ReadonlyArray<{ threadId: string; title: string; cwd?: string | null }> }>;
  groups: ReadonlyArray<{ id: string; name: string; threadId: string; cwd?: string; pinnedCwd?: string | null;
    tasks?: ReadonlyArray<{ threadId: string; title: string; pinnedCwd?: string | null }> }>;
}

export interface ScanLimits { entries: number; ms: number; home: string }
const LIMITS: ScanLimits = { entries: 200_000, ms: 30_000, home: homedir() };
const EVIDENCE_MAX_BYTES = 256 * 1024;
const CANDIDATES_SHOWN = 100;
const TOOL_CACHES = new Set(["__pycache__", ".pytest_cache", ".mypy_cache"]);
const NODE_MANIFESTS = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

interface Claim { path: string; managed: boolean; owner?: StorageOwner }

const idOf = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 16);
const names = (dir: string) => readdir(dir).catch(() => [] as string[]);

/** The folders people chose: a bot's or room's working folder, and a conversation's own. */
function chosenFolders({ bots, groups }: StorageSources): Claim[] {
  const out: Claim[] = [];
  for (const bot of bots) {
    const owner = { kind: "bot" as const, id: bot.id, name: bot.name };
    if (bot.cwd) out.push({ path: bot.cwd, managed: false, owner });
    for (const task of bot.tasks ?? []) {
      if (typeof task.cwd === "string") out.push({ path: task.cwd, managed: false, owner: { ...owner, threadId: task.threadId, threadTitle: task.title } });
    }
  }
  for (const group of groups) {
    const owner = { kind: "room" as const, id: group.id, name: group.name };
    if (group.cwd) out.push({ path: group.cwd, managed: false, owner });
    for (const task of group.tasks ?? []) {
      if (typeof task.pinnedCwd === "string") out.push({ path: task.pinnedCwd, managed: false, owner: { ...owner, threadId: task.threadId, threadTitle: task.title } });
    }
    if (!group.tasks?.length && typeof group.pinnedCwd === "string") out.push({ path: group.pinnedCwd, managed: false, owner: { ...owner, threadId: group.threadId } });
  }
  return out;
}

/** The app's own folders, as they are on disk: one whose bot or conversation is gone has no owner. */
async function managedFolders({ dataDir, bots }: StorageSources): Promise<Claim[]> {
  const out: Claim[] = [];
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  for (const id of await names(join(dataDir, "workspaces"))) {
    const bot = byId.get(id);
    out.push({ path: join(dataDir, "workspaces", id), managed: true, owner: bot && { kind: "bot", id, name: bot.name } });
  }
  for (const id of await names(join(dataDir, "task-workspaces"))) {
    const bot = byId.get(id);
    for (const threadId of await names(join(dataDir, "task-workspaces", id))) {
      const task = bot?.tasks?.find((candidate) => candidate.threadId === threadId);
      out.push({ path: join(dataDir, "task-workspaces", id, threadId), managed: true,
        owner: bot && task && { kind: "bot", id, name: bot.name, threadId, threadTitle: task.title } });
    }
  }
  return out;
}

function kindOf(owners: readonly StorageOwner[]): StorageRoot["kind"] {
  if (!owners.length) return "unassigned";
  if (new Set(owners.map((owner) => `${owner.kind}:${owner.id}`)).size > 1) return "shared";
  return owners.length === 1 && owners[0]!.threadId ? "thread" : "owner";
}

/** A person's whole home folder or a drive: too much to walk, and mostly not a bot's work. */
function tooBroad(path: string, home: string): boolean {
  return dirname(path) === path || path === home || home.startsWith(path.endsWith(sep) ? path : path + sep);
}

async function rootsOf(claims: readonly Claim[], home: string): Promise<StorageRoot[]> {
  const roots = new Map<string, StorageRoot>();
  for (const claim of claims) {
    let path = resolve(claim.path), gap: StorageRoot["gap"];
    try {
      path = await realpath(path);
    } catch (error) {
      gap = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "denied";
    }
    if (!gap && !claim.managed && tooBroad(path, home)) gap = "broad";
    const root = roots.get(path) ?? { id: idOf(path), kind: "unassigned" as const, owners: [], location: path, managed: false, bytes: 0, files: 0, ...(gap ? { gap } : {}) };
    root.managed ||= claim.managed;
    const owner = claim.owner;
    if (owner && !root.owners.some((known) => known.kind === owner.kind && known.id === owner.id && known.threadId === owner.threadId)) root.owners.push(owner);
    roots.set(path, root);
  }
  for (const root of roots.values()) root.kind = kindOf(root.owners);
  return [...roots.values()];
}

/** Build folders a project's own declarative file names; nothing is run to find them. */
async function provenBuildFolders(dir: string, present: ReadonlySet<string>): Promise<Map<string, string>> {
  const proven = new Map<string, string>();
  if (present.has("tsconfig.json")) {
    try {
      const file = join(dir, "tsconfig.json"), info = await lstat(file);
      if (info.isFile() && info.size <= EVIDENCE_MAX_BYTES) {
        const outDir: unknown = JSON.parse(await readFile(file, "utf8"))?.compilerOptions?.outDir;
        const name = typeof outDir === "string" ? outDir.replace(/^\.\//, "").replace(/\/$/, "") : "";
        if (/^[^\\/]+$/.test(name) && name !== "." && name !== "..") proven.set(name, "tsconfig.json");
      }
    } catch {
    }
  }
  // Cargo marks its own target folder with CACHEDIR.TAG (cargo 1.38+).
  if (present.has("Cargo.toml") && present.has("target") && await lstat(join(dir, "target", "CACHEDIR.TAG")).then((info) => info.isFile(), () => false)) {
    proven.set("target", "Cargo.toml");
  }
  return proven;
}

function candidateFor(name: string, present: ReadonlySet<string>, proven: ReadonlyMap<string, string>): Pick<StorageCandidate, "category" | "evidence"> | null {
  if (name === "node_modules") {
    const manifest = NODE_MANIFESTS.find((file) => present.has(file));
    return manifest ? { category: "dependencies", evidence: manifest } : null;
  }
  if (TOOL_CACHES.has(name)) return { category: "tool-cache", evidence: name };
  const evidence = proven.get(name);
  return evidence ? { category: "build", evidence } : null;
}

export async function scanStorage(sources: StorageSources, limits: Partial<ScanLimits> = {}): Promise<StorageUsage> {
  const { entries, ms, home } = { ...LIMITS, ...limits };
  const roots = await rootsOf([...await managedFolders(sources), ...chosenFolders(sources)], home);
  const measuredElsewhere = new Set(roots.map((root) => root.location));
  const linked = new Set<string>();
  const candidates: StorageCandidate[] = [];
  const deadline = Date.now() + ms;
  let visited = 0, skipped = 0, errors = 0, linksApproximate = false, stopped = false;

  const walk = async (root: StorageRoot): Promise<void> => {
    const failed = (error: unknown) => {
      // A file that went away mid-scan is churn, not a failure.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      errors += 1;
      root.gap ??= "denied";
    };
    let volume: bigint;
    try {
      const top = await lstat(root.location, { bigint: true });
      volume = top.dev;
      if (top.isFile()) {
        root.bytes = Number(top.size);
        root.files = 1;
      }
      if (!top.isDirectory()) return;
    } catch (error) {
      return failed(error);
    }
    const queue: Array<{ dir: string; candidate?: StorageCandidate }> = [{ dir: root.location }];
    while (queue.length) {
      const { dir, candidate } = queue.pop()!;
      let listed: string[];
      try {
        listed = await readdir(dir);
      } catch (error) {
        failed(error);
        continue;
      }
      const present = new Set(listed);
      const proven = candidate ? new Map<string, string>() : await provenBuildFolders(dir, present);
      for (let at = 0; at < listed.length; at += 64) {
        if (visited >= entries || Date.now() > deadline) {
          stopped = true;
          root.gap = "limit";
          return;
        }
        const batch = listed.slice(at, at + 64);
        const infos = await Promise.all(batch.map((name) => lstat(join(dir, name), { bigint: true }).catch((error: unknown) => error as Error)));
        visited += batch.length;
        for (const [index, info] of infos.entries()) {
          const name = batch[index]!, path = join(dir, name);
          if (info instanceof Error) {
            failed(info);
          } else if (info.isDirectory()) {
            if (measuredElsewhere.has(path)) continue;
            if (info.dev !== volume) { skipped += 1; continue; }
            const found = candidate ? null : candidateFor(name, present, proven);
            const inside = found ? { id: idOf(path), rootId: root.id, location: relative(root.location, path), bytes: 0, ...found } : candidate;
            if (found) candidates.push(inside!);
            queue.push({ dir: path, candidate: inside });
          } else if (info.isFile()) {
            if (info.nlink > 1n) {
              const identity = `${info.dev}:${info.ino}`;
              if (info.ino === 0n) linksApproximate = true;
              else if (linked.has(identity)) continue;
              else linked.add(identity);
            }
            const size = Number(info.size);
            root.bytes += size;
            root.files += 1;
            if (candidate) candidate.bytes += size;
          } else {
            skipped += 1;
          }
        }
      }
    }
  };

  for (const root of roots) {
    if (root.gap) continue;
    if (stopped) root.gap = "limit";
    else await walk(root);
  }
  return {
    scanId: randomUUID(), scannedAt: Date.now(), complete: !roots.some((root) => root.gap === "limit" || root.gap === "denied"),
    bytes: roots.reduce((sum, root) => sum + root.bytes, 0), files: roots.reduce((sum, root) => sum + root.files, 0),
    skipped, errors, linksApproximate,
    roots: roots.sort((a, b) => b.bytes - a.bytes),
    candidates: candidates.filter((candidate) => candidate.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, CANDIDATES_SHOWN),
  };
}

/** Free space of each volume under the data folder and the chosen folders. Reads volume metadata only. */
export async function storageDisks(sources: StorageSources): Promise<StorageDisk[]> {
  const disks = new Map<string, StorageDisk>();
  for (const claim of [{ path: sources.dataDir, managed: true }, ...chosenFolders(sources)]) {
    let path = resolve(claim.path), id: string, space = { totalBytes: 0, availableBytes: 0 }, unavailable = false;
    try {
      path = await realpath(path);
      id = String((await lstat(path, { bigint: true })).dev);
      const volume = await statfs(path, { bigint: true });
      space = { totalBytes: Number(volume.blocks * volume.bsize), availableBytes: Number(volume.bavail * volume.bsize) };
    } catch {
      id = `unavailable:${idOf(path)}`;
      unavailable = true;
    }
    const disk = disks.get(id) ?? { id, appData: false, rootIds: [], ...space, low: !unavailable && storageLow(space.totalBytes, space.availableBytes), ...(unavailable ? { unavailable: true as const } : {}) };
    if (claim.managed) disk.appData = true;
    else if (!disk.rootIds.includes(idOf(path))) disk.rootIds.push(idOf(path));
    disks.set(id, disk);
  }
  return [...disks.values()];
}

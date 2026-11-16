// Everything under /api/storage/, for the owner or an admin only. No route takes a filesystem path or a bucket key: the
// folders measured are the server's own and the ones its bots and rooms are set to work in, and archive operations take
// ids this server made.
import type { StorageOwner, StorageUsage } from "../../shared/storage.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { StorageArchiver } from "../storage-archive.ts";
import { scanStorage, storageDisks, type StorageSources } from "../storage-usage.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const FRESH_MS = 60_000;

export interface StorageRouteDeps {
  sources(): StorageSources;
  visible(auth: RequestAuth): { bot(id: string): boolean; group(id: string): boolean; thread(id: string): boolean };
  archive?: StorageArchiver;
  scan?: typeof scanStorage;
  disks?: typeof storageDisks;
}

/** Security invariant: a folder any of whose owners the viewer may not see keeps its size and loses its name and path. */
function shownTo(usage: StorageUsage, visible: ReturnType<StorageRouteDeps["visible"]>): StorageUsage {
  const sees = (owner: StorageOwner) => owner.threadId ? visible.thread(owner.threadId) : owner.kind === "bot" ? visible.bot(owner.id) : visible.group(owner.id);
  const withheld = new Set(usage.roots.filter((root) => !root.owners.every(sees)).map((root) => root.id));
  if (!withheld.size) return usage;
  return {
    ...usage,
    roots: usage.roots.map((root) => withheld.has(root.id) ? { ...root, owners: [], location: "", private: true as const } : root),
    candidates: usage.candidates.filter((candidate) => !withheld.has(candidate.rootId)),
  };
}

export function createStorageRoutes(deps: StorageRouteDeps): RouteHandler {
  const scan = deps.scan ?? scanStorage, disks = deps.disks ?? storageDisks;
  let latest: StorageUsage | null = null;
  let running: Promise<StorageUsage> | null = null;
  const usage = (refresh: boolean): Promise<StorageUsage> => {
    if (running) return running;
    if (latest && !refresh && Date.now() - latest.scannedAt < FRESH_MS) return Promise.resolve(latest);
    running = scan(deps.sources()).then((next) => latest = next).finally(() => { running = null; });
    return running;
  };
  /** Security invariant: an archive of a conversation the viewer may not read is neither listed nor acted on. */
  async function archiveRoute({ req, res, method, path, url, auth, json, readBody }: RouteContext, archive: StorageArchiver): Promise<void> {
    const sees = deps.visible(auth), actor = auth.kind;
    const gone = () => Object.assign(new Error("No such archive."), { status: 404 });
    const mine = (archiveId: unknown) => { if (!sees.thread(archive.owner(archiveId).threadId)) throw gone(); };
    const body: Record<string, unknown> = method === "GET" ? {} : await readBody(req);
    if (!body || typeof body !== "object") return json(res, 400, { error: "Send a JSON object." });
    const name = path.slice("/api/storage/".length);
    switch (`${method} ${name}`) {
      case "GET destination": return json(res, 200, { destination: archive.destination() });
      case "PUT destination": return json(res, 200, { destination: archive.saveDestination(body as never, actor) });
      case "DELETE destination": archive.disconnect(actor); return json(res, 200, { destination: null });
      case "POST destination/test": return json(res, 200, await archive.test());
      case "POST recovery": res.setHeader("cache-control", "no-store"); return json(res, 200, archive.recovery());
      case "POST archive-preview":
        if (typeof body.botId !== "string" || typeof body.threadId !== "string" || !sees.thread(body.threadId)) throw gone();
        return json(res, 200, await archive.previewArchive(body.botId, body.threadId));
      case "POST archive": return json(res, 202, archive.archive(body.previewId, body.idempotencyKey, actor));
      case "POST cleanup-preview": mine(body.archiveId); return json(res, 200, await archive.previewCleanup(body.archiveId));
      case "POST cleanup": return json(res, 202, archive.cleanup(body.previewId, body.confirm, body.idempotencyKey, actor));
      case "POST restore": mine(body.archiveId); return json(res, 202, await archive.restore(body.archiveId, body.fileIds, body.idempotencyKey, actor));
      case "GET archives": return json(res, 200, { archives: archive.archives().filter((one) => sees.thread(one.threadId)) });
      case "GET events": {
        const shown = new Set(archive.archives().filter((one) => sees.thread(one.threadId)).map((one) => one.id));
        const before = Number(url.searchParams.get("before")) || undefined;
        return json(res, 200, { events: archive.events(100, before).filter((event) => !event.archiveId || shown.has(event.archiveId)) });
      }
    }
    const job = method === "GET" && name.startsWith("jobs/") ? archive.job(name.slice("jobs/".length)) : null;
    if (job?.archiveId) mine(job.archiveId);
    return job ? json(res, 200, job) : json(res, 404, { error: "No such storage route." });
  }

  return async (ctx) => {
    const { res, method, path, url, auth, json } = ctx;
    if (!path.startsWith("/api/storage/")) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only this server's owner or an admin can see its storage." });
    if (path === "/api/storage/usage" || path === "/api/storage/disk") {
      if (method !== "GET") return json(res, 405, { error: "Use GET." });
      if (path === "/api/storage/disk") return json(res, 200, { disks: await disks(deps.sources()) });
      return json(res, 200, shownTo(await usage(url.searchParams.get("refresh") === "1"), deps.visible(auth)));
    }
    if (!deps.archive) return json(res, 404, { error: "No such storage route." });
    try {
      return await archiveRoute(ctx, deps.archive);
    } catch (error) {
      const known = error as { status?: unknown; code?: unknown; message?: string };
      if (typeof known.status !== "number") throw error;
      return json(res, known.status, { error: known.message, ...(typeof known.code === "string" ? { code: known.code } : {}) });
    }
  };
}

import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import type { StorageUsage } from "../../shared/storage.ts";
import { requiredScope, serviceAllowed, type RequestAuth } from "../request-auth.ts";
import type { StorageArchiver } from "../storage-archive.ts";
import { createStorageRoutes } from "./storage.ts";
import { PASS } from "./table.ts";

const OWNER = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const SERVICE = { kind: "loopback", scopes: ["client"], trust: "service" } as RequestAuth;
const MEMBER = { kind: "session", scopes: ["client"] } as unknown as RequestAuth;

const usage = (scanId: string): StorageUsage => ({
  scanId, scannedAt: Date.now(), complete: true, bytes: 30, files: 2, skipped: 0, errors: 0, linksApproximate: false,
  roots: [
    { id: "a", kind: "thread", owners: [{ kind: "bot", id: "ada", name: "Ada", threadId: "mine", threadTitle: "Mine" }], location: "/work/mine", managed: false, bytes: 10, files: 1 },
    { id: "b", kind: "thread", owners: [{ kind: "bot", id: "ada", name: "Ada", threadId: "theirs", threadTitle: "Theirs" }], location: "/work/theirs", managed: false, bytes: 20, files: 1 },
  ],
  candidates: [{ id: "c", rootId: "b", location: "node_modules", bytes: 5, category: "dependencies", evidence: "package.json" }],
});

function world(archive?: Partial<StorageArchiver>) {
  let scans = 0, release = () => {};
  const held = new Promise<void>((done) => { release = done; });
  const routes = createStorageRoutes({
    sources: () => ({ dataDir: "/data", bots: [], groups: [] }),
    visible: () => ({ bot: () => true, group: () => true, thread: (id) => id !== "theirs" }),
    scan: async () => { scans += 1; if (scans === 1) await held; return usage(`scan-${scans}`); },
    disks: async () => [],
    ...(archive ? { archive: archive as StorageArchiver } : {}),
  });
  const call = async (path: string, auth = OWNER, method = "GET", body: unknown = {}) => {
    let status = 0, answer: any;
    const json = (_res: unknown, code: number, value: unknown) => { status = code; answer = value; };
    const out = await routes({ req: {} as never, res: {} as ServerResponse, url: new URL(`http://x${path}`), path: path.split("?")[0]!, method, auth, json: json as never, readBody: (async () => body) as never });
    return { out, status, answer };
  };
  return { call, release, scans: () => scans };
}

describe("storage over HTTP", () => {
  it("is the owner's or an admin's: a member's session, a bot's shell and any change are refused", async () => {
    for (const path of ["/api/storage/usage", "/api/storage/disk"]) {
      expect(requiredScope("GET", path)).toBe("admin");
      expect(serviceAllowed("GET", path)).toBe(false);
    }
    const { call, scans } = world();
    expect((await call("/api/storage/usage", SERVICE)).status).toBe(403);
    expect((await call("/api/storage/disk", MEMBER)).status).toBe(403);
    expect((await call("/api/storage/usage", OWNER, "DELETE")).status).toBe(405);
    expect(scans()).toBe(0);
    expect((await call("/api/storage")).out).toBe(PASS);
  });

  it("shares one scan between requests, keeps it a minute, and scans again on refresh", async () => {
    const { call, release, scans } = world();
    const both = Promise.all([call("/api/storage/usage"), call("/api/storage/usage?refresh=1")]);
    release();
    expect((await both).map((one) => one.answer.scanId)).toEqual(["scan-1", "scan-1"]);
    expect((await call("/api/storage/usage?path=/etc")).answer.scanId).toBe("scan-1");
    expect((await call("/api/storage/usage?refresh=1")).answer.scanId).toBe("scan-2");
    expect(scans()).toBe(2);
  });

  it("keeps the size of a conversation the viewer may not read, without its name, path or suggestions", async () => {
    const { call, release } = world();
    release();
    const { answer } = await call("/api/storage/usage");
    expect(answer.bytes).toBe(30);
    expect(answer.roots[0]).toMatchObject({ location: "/work/mine", owners: [{ threadTitle: "Mine" }] });
    expect(answer.roots[1]).toEqual({ id: "b", kind: "thread", owners: [], location: "", managed: false, bytes: 20, files: 1, private: true });
    expect(answer.candidates).toEqual([]);
  });

  it("keeps archive routes to the owner or an admin, and to conversations the viewer may read", async () => {
    const paths = ["destination", "destination/test", "recovery", "archive-preview", "archive", "cleanup-preview", "cleanup", "restore", "archives", "events", "jobs/j1"];
    for (const name of paths) for (const method of ["GET", "PUT", "POST", "DELETE"]) {
      expect(requiredScope(method, `/api/storage/${name}`)).toBe("admin");
      expect(serviceAllowed(method, `/api/storage/${name}`)).toBe(false);
    }
    const asked: string[] = [];
    const { call } = world({
      owner: (id) => ({ botId: "ada", threadId: id === "a-theirs" ? "theirs" : "mine" }),
      previewArchive: async (_bot, threadId) => { asked.push(threadId); return { id: "p1" } as never; },
      previewCleanup: async (id) => { asked.push(String(id)); return { id: "p2" } as never; },
      archives: () => [{ id: "a-mine", threadId: "mine" }, { id: "a-theirs", threadId: "theirs" }] as never,
      events: () => [{ seq: 2, archiveId: "a-theirs", path: "secret.txt" }, { seq: 1, archiveId: "a-mine" }] as never,
      job: () => ({ id: "j1", archiveId: "a-theirs" }) as never,
      cleanup: () => { throw Object.assign(new Error("needs confirmation"), { status: 400, code: "unconfirmed" }); },
    });
    for (const [method, name] of [["POST", "archive"], ["PUT", "destination"], ["POST", "recovery"], ["GET", "archives"]] as const) {
      expect((await call(`/api/storage/${name}`, MEMBER, method)).status).toBe(403);
      expect((await call(`/api/storage/${name}`, SERVICE, method)).status).toBe(403);
    }
    expect((await call("/api/storage/archive-preview", OWNER, "POST", { botId: "ada", threadId: "theirs", path: "/etc" })).status).toBe(404);
    expect((await call("/api/storage/archive-preview", OWNER, "POST", { botId: "ada", threadId: "mine" })).answer).toEqual({ id: "p1" });
    expect((await call("/api/storage/cleanup-preview", OWNER, "POST", { archiveId: "a-theirs" })).status).toBe(404);
    expect((await call("/api/storage/restore", OWNER, "POST", { archiveId: "a-theirs", idempotencyKey: "restore-0001" })).status).toBe(404);
    expect((await call("/api/storage/jobs/j1")).status).toBe(404);
    expect(asked).toEqual(["mine"]);
    expect((await call("/api/storage/archives")).answer.archives).toEqual([{ id: "a-mine", threadId: "mine" }]);
    expect((await call("/api/storage/events")).answer.events).toEqual([{ seq: 1, archiveId: "a-mine" }]);
    expect(await call("/api/storage/cleanup", OWNER, "POST", { previewId: "p2" })).toMatchObject({ status: 400, answer: { code: "unconfirmed" } });
    expect((await call("/api/storage/bucket-objects")).status).toBe(404);
  });
});

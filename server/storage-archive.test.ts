import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { StorageJob } from "../shared/storage.ts";
import { createStorageArchive, destinationProblem, type StorageArchiver } from "./storage-archive.ts";

const SECRET = "wJalrSYNTHETICsecretKEY";

/** Just enough of the S3 wire protocol for the SDK: objects and multipart uploads, kept in memory. */
function fakeBucket() {
  const objects = new Map<string, Buffer>(), parts = new Map<string, Map<number, Buffer>>();
  const seen = { multipart: 0, corruptUploads: false };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x"), key = decodeURIComponent(url.pathname), chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => {
      const body = Buffer.concat(chunks), uploadId = url.searchParams.get("uploadId");
      const xml = (text: string) => { res.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?>${text}`); };
      const stored = (data: Buffer) => { if (seen.corruptUploads && data.length) data[data.length - 1]! ^= 1; objects.set(key, data); };
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        seen.multipart += 1;
        parts.set("u1", new Map());
        return xml("<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>");
      }
      if (req.method === "PUT" && uploadId) { parts.get(uploadId)!.set(Number(url.searchParams.get("partNumber")), body); return res.writeHead(200, { etag: '"part"' }).end(); }
      if (req.method === "POST" && uploadId) {
        stored(Buffer.concat([...parts.get(uploadId)!].sort((a, b) => a[0] - b[0]).map((part) => part[1])));
        return xml("<CompleteMultipartUploadResult><ETag>\"whole\"</ETag></CompleteMultipartUploadResult>");
      }
      if (req.method === "PUT") { stored(body); return res.writeHead(200, { etag: '"one"' }).end(); }
      const found = objects.get(key);
      if (req.method === "DELETE") { objects.delete(key); return res.writeHead(204).end(); }
      if (!found) return res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
      res.writeHead(200, { "content-length": String(found.length) }).end(req.method === "HEAD" ? undefined : found);
    });
  });
  return new Promise<{ endpoint: string; objects: Map<string, Buffer>; seen: typeof seen; close(): void }>((ready) => {
    server.listen(0, "127.0.0.1", () => ready({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, objects, seen, close: () => { server.closeAllConnections(); server.close(); } }));
  });
}

const open: Array<() => void> = [];
afterEach(() => { for (const close of open.splice(0)) close(); });

async function world() {
  const bucket = await fakeBucket();
  const dataDir = join(realpathSync.native(mkdtempSync(join(tmpdir(), "omb-archive-"))), "data");
  const root = join(dataDir, "task-workspaces", "ada", "t1");
  const put = (name: string, data: string | Buffer) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), data); };
  const big = randomBytes(9 * 1024 ** 2);
  put("report.txt", "the quarterly report");
  put("out/video.bin", big);
  put(".env", `TOKEN=${SECRET}`);
  let busy = false;
  const archiver = createStorageArchive({ dataDir, thread: (bot, thread) => bot === "ada" && thread === "t1" ? { botName: "Ada", title: "Report" } : null, busy: () => busy });
  open.push(() => archiver.close(), bucket.close);
  archiver.saveDestination({ endpoint: bucket.endpoint, region: "us-east-1", bucket: "archive", prefix: "omb", pathStyle: true, accessKeyId: "AKIASYNTHETIC", secretAccessKey: SECRET, allowLoopbackHttp: true }, "owner");
  const settled = async (job: StorageJob | Promise<StorageJob>): Promise<StorageJob> => {
    const { id } = await job;
    for (;;) {
      const now = archiver.job(id)!;
      if (now.state !== "running") return now;
      await new Promise((tick) => setTimeout(tick, 10));
    }
  };
  const archived = async () => settled(archiver.archive((await archiver.previewArchive("ada", "t1")).id, `archive-${Math.random().toString(36).slice(2)}aaaa`, "owner"));
  return { archiver, bucket, dataDir, root, put, big, settled, archived, setBusy: (value: boolean) => { busy = value; } };
}

const removeLocal = async (w: Awaited<ReturnType<typeof world>>, archiveId: string) =>
  w.settled(w.archiver.cleanup((await w.archiver.previewCleanup(archiveId)).id, true, `cleanup-${Math.random().toString(36).slice(2)}aaaa`, "owner"));
const idOf = (archiver: StorageArchiver) => archiver.archives()[0]!.id;

describe("moving a conversation's folder to cloud storage", () => {
  it("uploads sealed copies, proves them by reading them back, and removes local files only once that is confirmed", async () => {
    const w = await world();
    expect(await w.archiver.test()).toEqual({ ok: true });
    expect(w.bucket.objects.size).toBe(0);

    const preview = await w.archiver.previewArchive("ada", "t1");
    expect(preview.files.map((file) => file.path).sort()).toEqual(["out/video.bin", "report.txt"]);
    expect(preview.skipped).toEqual([{ path: ".env", reason: "secret" }]);
    const first = w.archiver.archive(preview.id, "archive-key-0001", "owner");
    expect(w.archiver.archive(preview.id, "archive-key-0001", "owner").id).toBe(first.id);
    expect(await w.settled(first)).toMatchObject({ state: "done", done: 2, total: 2 });

    expect(w.bucket.seen.multipart).toBe(1);
    const uploaded = Buffer.concat([Buffer.from([...w.bucket.objects.keys()].join(" ")), ...w.bucket.objects.values()]);
    for (const plain of ["report", "video", "quarterly", SECRET]) expect(uploaded.includes(plain)).toBe(false);
    expect(w.archiver.archives()[0]).toMatchObject({ state: "verified", files: 2, removedBytes: 0, botName: "Ada", threadTitle: "Report" });
    expect(readdirSync(w.root).sort()).toEqual([".env", "out", "report.txt"]);

    const review = await w.archiver.previewCleanup(idOf(w.archiver));
    expect(() => w.archiver.cleanup(review.id, undefined, "cleanup-key-0001", "owner")).toThrow(/confirmation/);
    expect(await w.settled(w.archiver.cleanup(review.id, true, "cleanup-key-0002", "owner"))).toMatchObject({ state: "done", done: 2 });
    expect(() => w.archiver.cleanup(review.id, true, "cleanup-key-0003", "owner")).toThrow(/out of date/);
    expect(readdirSync(w.root).sort()).toEqual([".env", "out"]);
    expect(readdirSync(join(w.root, "out"))).toEqual([]);
    expect(w.archiver.archives()[0]!.removedBytes).toBe(w.big.length + 20);

    expect(await w.archiver.hydrate("ada", [w.root], join(w.root, "report.txt"), 1024)).toBe(true);
    expect(readFileSync(join(w.root, "report.txt"), "utf8")).toBe("the quarterly report");
    expect(await w.archiver.hydrate("ada", [w.root], join(w.root, "never-archived.txt"), 1024)).toBe(false);
    expect(await w.archiver.hydrate("ada", [dirname(w.root)], join(w.root, "out", "video.bin"), 1024 ** 3)).toBe(false);

    (await w.archiver.admit("ada", "t1"))();
    expect(readFileSync(join(w.root, "out", "video.bin")).equals(w.big)).toBe(true);
    expect(w.archiver.archives()[0]!.removedBytes).toBe(0);
    expect(w.archiver.events(50).map((event) => `${event.action}:${event.outcome}`)).toEqual(expect.arrayContaining(["file.remove:intent", "file.remove:removed", "file.restore:ok", "archive.verified:ok"]));
    expect(JSON.stringify(w.archiver.destination()) + JSON.stringify(w.archiver.events(50))).not.toContain(SECRET);
  });

  it("keeps every local file when the cloud copy does not read back the same", async () => {
    const w = await world();
    w.bucket.seen.corruptUploads = true;
    expect(await w.archiver.test()).toMatchObject({ ok: false, step: "read" });
    expect(await w.archived()).toMatchObject({ state: "failed", error: "nothing_archived", done: 0 });
    await expect(w.archiver.previewCleanup(idOf(w.archiver))).rejects.toMatchObject({ status: 409, code: "unverified" });
    expect(readFileSync(join(w.root, "report.txt"), "utf8")).toBe("the quarterly report");
  });

  it("leaves alone a file edited after its upload, and never overwrites one on restore", async () => {
    const w = await world();
    await w.archived();
    const id = idOf(w.archiver);
    const review = await w.archiver.previewCleanup(id);
    w.put("report.txt", "the quarterly report, edited!");
    expect(await w.settled(w.archiver.cleanup(review.id, true, "cleanup-key-0004", "owner"))).toMatchObject({ done: 1, notes: [{ path: "report.txt", reason: "changed" }] });
    expect(readFileSync(join(w.root, "report.txt"), "utf8")).toBe("the quarterly report, edited!");

    w.put("out/video.bin", "something new written where the video was");
    const restored = await w.settled(w.archiver.restore(id, undefined, "restore-key-0001", "owner"));
    expect(restored).toMatchObject({ state: "done", notes: [{ path: "out/video.bin", reason: "restored-as:video (restored).bin" }] });
    expect(readFileSync(join(w.root, "out", "video.bin"), "utf8")).toBe("something new written where the video was");
    expect(readFileSync(join(w.root, "out", "video (restored).bin")).equals(w.big)).toBe(true);
  });

  it("does not touch a conversation that is working, and holds a turn back while its files are being removed", async () => {
    const w = await world();
    w.setBusy(true);
    expect(await w.archived()).toMatchObject({ state: "failed", error: "thread_busy" });
    w.setBusy(false);
    await w.archived();
    const release = await w.archiver.admit("ada", "t1");
    expect(await removeLocal(w, idOf(w.archiver))).toMatchObject({ state: "failed", error: "thread_busy", done: 0 });
    release();
    const review = await w.archiver.previewCleanup(idOf(w.archiver));
    const removing = w.settled(w.archiver.cleanup(review.id, true, "cleanup-key-0005", "owner"));
    await w.archiver.ready;
    await Promise.resolve();
    await expect(w.archiver.admit("ada", "t1")).rejects.toMatchObject({ code: "storage_busy" });
    expect(await removing).toMatchObject({ state: "done", done: 2 });
  });

  it("puts back a file that was moved aside for removal when the server stopped", async () => {
    const w = await world();
    await w.archived();
    const { DatabaseSync } = await import("node:sqlite");
    w.archiver.close();
    open.shift();
    const db = new DatabaseSync(join(w.dataDir, "storage", "archive.db"));
    const file = db.prepare("SELECT id FROM file WHERE path = 'report.txt'").get() as { id: string };
    db.close();
    const { renameSync } = await import("node:fs");
    renameSync(join(w.root, "report.txt"), join(w.dataDir, "storage", "quarantine", file.id));
    const again = createStorageArchive({ dataDir: w.dataDir, thread: () => ({ botName: "Ada", title: "Report" }), busy: () => false });
    open.push(() => again.close());
    await again.ready;
    expect(readFileSync(join(w.root, "report.txt"), "utf8")).toBe("the quarterly report");
    expect(existsSync(join(w.dataDir, "storage", "quarantine", file.id))).toBe(false);
  });

  it("accepts only an https endpoint, or plain http on this machine when confirmed", () => {
    const base = { region: "auto", bucket: "my-bucket", accessKeyId: "id", secretAccessKey: "secret" };
    expect(destinationProblem({ ...base, endpoint: "https://account.r2.cloudflarestorage.com" })).toBeNull();
    expect(destinationProblem({ ...base, endpoint: "http://127.0.0.1:9000", allowLoopbackHttp: true })).toBeNull();
    for (const endpoint of ["http://127.0.0.1:9000", "http://minio.lan:9000", "https://user:pass@s3.example.com", "https://s3.example.com/?X-Amz-Credential=a", "https://169.254.169.254", "https://[fe80::1]", "ftp://s3.example.com", "s3.example.com"]) {
      expect(destinationProblem({ ...base, endpoint }), endpoint).not.toBeNull();
    }
    expect(destinationProblem({ ...base, endpoint: "http://minio.lan:9000", allowLoopbackHttp: true })).not.toBeNull();
    expect(destinationProblem({ ...base, endpoint: "https://s3.example.com", prefix: "../other" })).not.toBeNull();
  });
});

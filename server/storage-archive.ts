// Moves a conversation's own folder to the person's S3-compatible bucket and back.
// Security invariants:
// - A local file is removed only after its sealed copy was fetched back and matched byte for byte, the person confirmed
//   that exact reviewed set, and the file is still what was uploaded. Any doubt keeps the local file.
// - Every operation takes ids the server made. No path, bucket key or URL comes from a client or from a bot.
// - Files are sealed (AES-256-GCM, a fresh nonce each, bound to their object key) before they leave; names and hashes
//   travel only inside the sealed manifest.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, type DecipherGCM } from "node:crypto";
import { lookup } from "node:dns";
import { constants, createReadStream, createWriteStream, type Stats } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, realpath, rename, statfs, unlink } from "node:fs/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { LookupFunction } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import type { StorageArchive, StorageDestination, StorageDestinationInput, StorageEvent, StorageJob, StoragePreview, StorageSkipReason } from "../shared/storage.ts";
import { inSecretFolder } from "./secret-folder.ts";
import { ArchiveStore, type ArchiveRow, type DestinationRow, type FileRow, type JobRow } from "./storage-archive-store.ts";

export interface ArchiveDeps {
  dataDir: string;
  /** The conversation, while its bot still has it. */
  thread(botId: string, threadId: string): { botName: string; title: string } | null;
  busy(botId: string, threadId: string): boolean;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PREVIEW_MS = 15 * 60_000;
const MAX_FILES = 50_000;
// AES-GCM seals at most 2^39 - 256 bits under one nonce (NIST SP 800-38D): about 64 GiB.
const MAX_FILE_BYTES = 32 * 1024 ** 3;
const PART_BYTES = 8 * 1024 ** 2;
const DISK_RESERVE_BYTES = 256 * 1024 ** 2;
const MAGIC = Buffer.from("OMBA\u0001", "latin1");
const SEAL_BYTES = MAGIC.length + 12 + 16;
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const RESTORE_TEMP = /^\.omb-restore-.*\.tmp$/;

type Failure = Error & { status: number; code?: string };
const failure = (status: number, message: string, code?: string): Failure => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

/** A provider's error as a short code: its message can carry request details, so it is never passed on. */
function reason(error: unknown): string {
  const known = error as { code?: unknown; name?: unknown } | null;
  return String(known?.code ?? known?.name ?? "error").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) || "error";
}

const plainHost = (hostname: string) => hostname.replace(/^\[|\]$/g, "").toLowerCase();
const loopbackHost = (hostname: string) => { const host = plainHost(hostname); return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host); };

/** Link-local and unspecified addresses: where cloud metadata services answer. */
function blockedAddress(address: string): boolean {
  const plain = address.toLowerCase().replace(/^::ffff:/, "");
  return plain.startsWith("169.254.") || /^fe[89ab][0-9a-f]:/.test(plain) || plain === "0.0.0.0" || plain === "::";
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, options, (error, address, family) => {
    const found = Array.isArray(address) ? address.map((one) => one.address) : [address];
    if (!error && found.some(blockedAddress)) return callback(Object.assign(new Error("address not allowed"), { code: "EBLOCKED" }), address as never, family);
    callback(error, address as never, family);
  });
};

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Why these settings cannot be saved, or null. */
export function destinationProblem(input: StorageDestinationInput): string | null {
  let url: URL;
  if (typeof input.endpoint !== "string") return "Enter the storage endpoint.";
  try { url = new URL(input.endpoint); } catch { return "The endpoint must be a full address, such as https://s3.eu-west-1.amazonaws.com."; }
  if (url.username || url.password || url.search || url.hash) return "The endpoint must not carry a sign-in, a query or a fragment.";
  if (blockedAddress(plainHost(url.hostname)) || plainHost(url.hostname) === "metadata.google.internal") return "That address is not allowed for cloud storage.";
  if (url.protocol === "http:" ? !(loopbackHost(url.hostname) && input.allowLoopbackHttp === true) : url.protocol !== "https:") {
    return "The endpoint must use https. Plain http is accepted only for a storage server on this same machine, when you confirm it.";
  }
  if (!text(input.region, 64) || !/^[a-z0-9-]+$/i.test(input.region)) return "Enter the bucket's region (for Cloudflare R2, auto).";
  if (!text(input.bucket, 63) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) return "Enter the bucket's name.";
  if (input.prefix !== undefined && typeof input.prefix !== "string") return "The folder inside the bucket is not valid.";
  const prefix = input.prefix ?? "";
  if (prefix && (!/^[A-Za-z0-9._/-]{1,200}$/.test(prefix) || prefix.split("/").some((part) => !part || part === "." || part === ".."))) return "The folder inside the bucket may use letters, numbers, dots, dashes and single slashes.";
  if (!text(input.accessKeyId, 256) || !text(input.secretAccessKey, 512)) return "Enter the access key and the secret key.";
  if (input.sessionToken !== undefined && input.sessionToken !== "" && !text(input.sessionToken, 4096)) return "The session token is not valid.";
  return null;
}

async function* sealed(source: AsyncIterable<Buffer>, key: Buffer, objectKey: string): AsyncGenerator<Buffer> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(objectKey));
  yield Buffer.concat([MAGIC, nonce]);
  for await (const chunk of source) {
    const out = cipher.update(chunk);
    if (out.length) yield out;
  }
  const last = cipher.final();
  if (last.length) yield last;
  yield cipher.getAuthTag();
}

/** Throws on a truncated, altered or misplaced object. What it yields before it finishes is not yet authenticated: a
 * caller keeps it private until the stream ends cleanly. */
async function* unsealed(source: AsyncIterable<Uint8Array>, key: Buffer, objectKey: string): AsyncGenerator<Buffer> {
  let head = Buffer.alloc(0), tail = Buffer.alloc(0);
  let decipher: DecipherGCM | undefined;
  for await (const chunk of source) {
    let data = Buffer.from(chunk);
    if (!decipher) {
      head = Buffer.concat([head, data]);
      if (head.length < MAGIC.length + 12) continue;
      if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a sealed archive object");
      decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length, MAGIC.length + 12));
      decipher.setAAD(Buffer.from(objectKey));
      data = head.subarray(MAGIC.length + 12);
    }
    tail = Buffer.concat([tail, data]);
    if (tail.length > 16) {
      const out = decipher.update(tail.subarray(0, tail.length - 16));
      tail = Buffer.from(tail.subarray(tail.length - 16));
      if (out.length) yield out;
    }
  }
  if (!decipher || tail.length !== 16) throw new Error("sealed archive object is cut short");
  decipher.setAuthTag(tail);
  const last = decipher.final();
  if (last.length) yield last;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const restoredName = (path: string, attempt: number) => join(dirname(path), `${basename(path, extname(path))} (restored${attempt > 1 ? ` ${attempt}` : ""})${extname(path)}`);

/** Moves `from` to `to` without ever replacing a file: when `to` is taken, the file lands beside it under another name. */
async function publish(from: string, to: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = attempt === 0 ? to : restoredName(to, attempt);
    try {
      await link(from, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      try {
        await copyFile(from, target, constants.COPYFILE_EXCL);
      } catch (again) {
        if ((again as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw again;
      }
    }
    await unlink(from);
    return target;
  }
  throw new Error("no free name beside the existing file");
}

interface Entry { path: string; size: number; mtime: number }
interface Held { preview: StoragePreview; botId: string; threadId: string; root: string; entries: Entry[]; archiveId?: string; fileIds?: string[] }

const unchanged = (info: Stats | null, entry: Entry) => Boolean(info?.isFile() && info.nlink === 1 && info.size === entry.size && info.mtimeMs === entry.mtime);
const stat = (path: string) => lstat(path).catch(() => null);
const hostPath = (root: string, path: string) => join(root, ...path.split("/"));

/** The folder that will hold `path`, with every link resolved, is still inside `root`. */
async function inside(root: string, path: string): Promise<boolean> {
  const parent = await realpath(dirname(path)).catch(() => null);
  return parent === root || Boolean(parent?.startsWith(root + sep));
}

async function eligible(root: string): Promise<{ entries: Entry[]; skipped: StoragePreview["skipped"] }> {
  const entries: Entry[] = [], skipped: StoragePreview["skipped"] = [];
  const queue = [""];
  while (queue.length) {
    const dir = queue.pop()!;
    for (const name of (await readdir(hostPath(root, dir))).sort()) {
      const path = dir ? `${dir}/${name}` : name;
      const info = await stat(hostPath(root, path));
      if (!info || RESTORE_TEMP.test(name)) continue;
      const skip = (why: StorageSkipReason) => { skipped.push({ path, reason: why }); };
      if (inSecretFolder(path) || (info.isFile() && SECRET_NAME.test(name))) skip("secret");
      else if (info.isSymbolicLink()) skip("link");
      else if (info.isDirectory()) queue.push(path);
      else if (!info.isFile()) skip("not-a-file");
      else if (info.nlink > 1) skip("link");
      else if (info.size > MAX_FILE_BYTES) skip("too-large");
      else entries.push({ path, size: info.size, mtime: info.mtimeMs });
      if (entries.length > MAX_FILES) throw failure(413, `This conversation holds more than ${MAX_FILES} files. Remove what can be rebuilt first.`, "too_many_files");
    }
  }
  return { entries, skipped };
}

export function createStorageArchive(deps: ArchiveDeps) {
  const store = new ArchiveStore(deps.dataDir);
  const previews = new Map<string, Held>();
  const live = new Map<string, StorageJob>();
  const leases = new Set<string>();
  const entering = new Map<string, number>();
  const pathMatch = process.platform === "win32" ? "path = ? COLLATE NOCASE" : "path = ?";

  const wireDestination = (row: DestinationRow): StorageDestination => ({
    id: row.id, endpoint: row.endpoint, region: row.region, bucket: row.bucket, prefix: row.prefix, pathStyle: row.path_style === 1,
    hasCredentials: Boolean(store.credentials(row.id)), createdAt: row.created_at, ...(row.tested_at ? { testedAt: row.tested_at } : {}),
  });
  const activeRow = () => store.one<DestinationRow>("SELECT * FROM destination WHERE active = 1");

  function bucketOf(row: DestinationRow | undefined) {
    const credentials = row && store.credentials(row.id);
    if (!row || !credentials) throw failure(409, "Cloud storage is not connected. Connect a bucket in Settings first.", "not_connected");
    const client = new S3Client({
      endpoint: row.endpoint, region: row.region, forcePathStyle: row.path_style === 1, maxAttempts: 3,
      credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) },
      // R2 and Backblaze B2 do not accept every optional checksum the SDK would add; integrity here is the sealed read-back.
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { httpAgent: new HttpAgent({ lookup: guardedLookup }), httpsAgent: new HttpsAgent({ lookup: guardedLookup }) },
    });
    const base = `${row.prefix ? `${row.prefix}/` : ""}${store.installation()}`;
    const put = (objectKey: string, source: AsyncIterable<Buffer>, key: Buffer) => new Upload({
      client, queueSize: 1, partSize: PART_BYTES, leavePartsOnError: false,
      params: { Bucket: row.bucket, Key: objectKey, Body: Readable.from(sealed(source, key, objectKey), { objectMode: false }), ContentType: "application/octet-stream" },
    }).done();
    async function* get(objectKey: string, key: Buffer): AsyncGenerator<Buffer> {
      const got = await client.send(new GetObjectCommand({ Bucket: row!.bucket, Key: objectKey }));
      yield* unsealed(got.Body as Readable, key, objectKey);
    }
    const sealedBytes = async (objectKey: string) => (await client.send(new HeadObjectCommand({ Bucket: row.bucket, Key: objectKey }))).ContentLength;
    const remove = (objectKey: string) => client.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: objectKey }));
    return { base, put, get, sealedBytes, remove, close: () => client.destroy() };
  }
  type Bucket = ReturnType<typeof bucketOf>;

  async function digest(source: AsyncIterable<Buffer>): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of source) { hash.update(chunk); bytes += chunk.length; }
    return { sha256: hash.digest("hex"), bytes };
  }

  /** Uploads sealed, then fetches the object back and compares what it opens to with what was read from disk. */
  async function uploadVerified(bucket: Bucket, objectKey: string, source: AsyncIterable<Buffer>, key: Buffer): Promise<{ sha256: string; bytes: number } | null> {
    const hash = createHash("sha256");
    let bytes = 0;
    await bucket.put(objectKey, (async function* () {
      for await (const chunk of source) { hash.update(chunk); bytes += chunk.length; yield chunk; }
    })(), key);
    const sent = { sha256: hash.digest("hex"), bytes };
    const back = await digest(bucket.get(objectKey, key)).catch(() => null);
    return back && back.sha256 === sent.sha256 && back.bytes === sent.bytes ? sent : null;
  }

  async function threadRoot(botId: string, threadId: string): Promise<string> {
    const missing = () => failure(404, "That conversation has no folder of its own on this server.", "no_folder");
    if (!ID.test(botId) || !ID.test(threadId) || !deps.thread(botId, threadId)) throw missing();
    const base = await realpath(join(deps.dataDir, "task-workspaces")).catch(() => null);
    const root = base && await realpath(join(base, botId, threadId)).catch(() => null);
    if (!root || dirname(dirname(root)) !== base || !(await lstat(root)).isDirectory()) throw missing();
    return root;
  }

  function lease(botId: string, threadId: string): () => void {
    if (leases.has(threadId) || entering.has(threadId) || deps.busy(botId, threadId)) {
      throw failure(409, "This conversation is working. Try again when it is idle.", "thread_busy");
    }
    leases.add(threadId);
    return () => { leases.delete(threadId); };
  }

  /** Called as a turn is admitted. Refuses while this conversation's files are being moved, and until the returned
   * release is called keeps a removal from starting under the turn. */
  function enter(threadId: string): () => void {
    if (leases.has(threadId)) throw failure(409, "This conversation's files are being moved to or from cloud storage. Try again shortly.", "storage_busy");
    entering.set(threadId, (entering.get(threadId) ?? 0) + 1);
    return () => {
      const left = (entering.get(threadId) ?? 1) - 1;
      if (left > 0) entering.set(threadId, left); else entering.delete(threadId);
    };
  }

  const wireJob = (row: JobRow): StorageJob => ({
    id: row.id, operation: row.operation, state: row.state, done: row.done, total: row.total,
    ...(row.archive ? { archiveId: row.archive } : {}), ...(row.error ? { error: row.error } : {}), notes: JSON.parse(row.notes) as StorageJob["notes"],
  });

  /** The same key always answers with the same job, so a repeated click or a retried request starts nothing twice. */
  function start(operation: StorageJob["operation"], idem: unknown, total: number, archiveId: string, actor: string, work: (job: StorageJob) => Promise<void>): StorageJob {
    if (typeof idem !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(idem)) throw failure(400, "idempotencyKey is required");
    const earlier = store.one<JobRow>("SELECT * FROM job WHERE idem = ?", idem);
    if (earlier) return live.get(earlier.id) ?? wireJob(earlier);
    const job: StorageJob = { id: randomUUID(), operation, state: "running", done: 0, total, archiveId, notes: [] };
    store.run("INSERT INTO job(id, operation, idem, done, total, state, error, archive, notes, created_at) VALUES(?, ?, ?, 0, ?, 'running', NULL, ?, '[]', ?)", job.id, operation, idem, total, archiveId, Date.now());
    store.record({ job: job.id, archive: archiveId, actor, action: `${operation}.start`, outcome: "started" });
    live.set(job.id, job);
    void ready.then(() => work(job)).then(() => { job.state = "done"; }, (error: unknown) => { job.state = "failed"; job.error = reason(error); }).then(() => {
      if (operation === "archive") store.run("UPDATE archive SET state = 'failed' WHERE id = ? AND state = 'uploading'", archiveId);
      store.run("UPDATE job SET state = ?, done = ?, error = ?, notes = ? WHERE id = ?", job.state, job.done, job.error ?? null, JSON.stringify(job.notes.slice(0, 500)), job.id);
      store.record({ job: job.id, archive: archiveId, actor, action: `${operation}.end`, outcome: job.state, ...(job.error ? { reason: job.error } : {}) });
      live.delete(job.id);
    });
    return job;
  }

  function held(previewId: unknown, operation: StoragePreview["operation"]): Held {
    const found = typeof previewId === "string" ? previews.get(previewId) : undefined;
    if (!found || found.preview.operation !== operation || found.preview.expiresAt < Date.now()) {
      throw failure(409, "That review is out of date. Review the files again.", "stale_preview");
    }
    previews.delete(found.preview.id);
    return found;
  }

  function keep(operation: StoragePreview["operation"], rest: Omit<Held, "preview">, skipped: StoragePreview["skipped"]): StoragePreview {
    for (const [id, old] of previews) if (old.preview.expiresAt < Date.now()) previews.delete(id);
    const preview: StoragePreview = {
      id: randomUUID(), operation, expiresAt: Date.now() + PREVIEW_MS, bytes: rest.entries.reduce((sum, entry) => sum + entry.size, 0),
      files: rest.entries.map((entry) => ({ path: entry.path, bytes: entry.size })), skipped,
    };
    previews.set(preview.id, { ...rest, preview });
    return preview;
  }

  const archiveRow = (id: unknown): ArchiveRow => {
    const row = typeof id === "string" ? store.one<ArchiveRow>("SELECT * FROM archive WHERE id = ?", id) : undefined;
    if (!row) throw failure(404, "No such archive.");
    return row;
  };
  const destinationOf = (archive: ArchiveRow) => store.one<DestinationRow>("SELECT * FROM destination WHERE id = ?", archive.destination);
  const keyFor = (archive: ArchiveRow): Buffer => {
    const { id, key } = store.archiveKey();
    if (id !== archive.key_id) throw failure(409, "This archive was sealed under a key this server does not hold.", "wrong_key");
    return key;
  };

  async function runArchive(job: StorageJob, from: Held, actor: string): Promise<void> {
    const release = lease(from.botId, from.threadId);
    let bucket: Bucket | undefined;
    try {
      bucket = bucketOf(activeRow());
      const { key } = store.archiveKey(), prefix = `${bucket.base}/${job.archiveId}`;
      const listed: Array<Entry & { id: string; sha256: string; objectKey: string }> = [];
      for (const entry of from.entries) {
        const path = hostPath(from.root, entry.path), objectKey = `${prefix}/${randomUUID()}`;
        const skip = (why: StorageSkipReason) => { job.notes.push({ path: entry.path, reason: why }); };
        if (!unchanged(await stat(path), entry)) { skip("changed"); continue; }
        const sent = await uploadVerified(bucket, objectKey, createReadStream(path), key);
        if (!sent || sent.bytes !== entry.size || !unchanged(await stat(path), entry)) {
          await bucket.remove(objectKey).catch(() => undefined);
          skip(sent ? "changed" : "unverified");
          continue;
        }
        const id = randomUUID();
        store.run("INSERT INTO file(id, archive, path, size, mtime, sha256, object_key, verified_at, local) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'present')",
          id, job.archiveId!, entry.path, entry.size, entry.mtime, sent.sha256, objectKey, Date.now());
        listed.push({ ...entry, id, sha256: sent.sha256, objectKey });
        job.done += 1;
      }
      if (!listed.length) throw Object.assign(new Error("nothing archived"), { code: "nothing_archived" });
      const manifest = Buffer.from(JSON.stringify({ version: 1, archiveId: job.archiveId, botId: from.botId, threadId: from.threadId, createdAt: Date.now(), files: listed }));
      if (!await uploadVerified(bucket, `${prefix}/manifest`, Readable.from([manifest]), key)) throw Object.assign(new Error("manifest unverified"), { code: "manifest_unverified" });
      store.run("UPDATE archive SET state = 'verified' WHERE id = ?", job.archiveId!);
      store.record({ job: job.id, archive: job.archiveId, actor, action: "archive.verified", outcome: "ok", bytes: listed.reduce((sum, entry) => sum + entry.size, 0) });
    } finally {
      bucket?.close();
      release();
    }
  }

  /** Brings one file back beside nothing: an existing different file is kept, and the restored one takes another name. */
  async function restoreFile(file: FileRow, archive: ArchiveRow, bucket: Bucket, actor: string, job?: StorageJob): Promise<void> {
    const target = hostPath(archive.root, file.path);
    await mkdir(dirname(target), { recursive: true });
    if (!await inside(archive.root, target)) throw Object.assign(new Error("folder moved"), { code: "outside_folder" });
    const present = await stat(target);
    if (!(present?.isFile() && present.size === file.size && await sha256Of(target) === file.sha256)) {
      const space = await statfs(dirname(target), { bigint: true });
      if (space.bavail * space.bsize < BigInt(file.size + DISK_RESERVE_BYTES)) throw Object.assign(new Error("low disk space"), { code: "low_space" });
      const temp = join(dirname(target), `.omb-restore-${randomUUID()}.tmp`);
      try {
        const hash = createHash("sha256");
        let bytes = 0;
        const source = bucket.get(file.object_key, keyFor(archive));
        await pipeline(async function* () {
          for await (const chunk of source) { hash.update(chunk); bytes += chunk.length; yield chunk; }
        }, createWriteStream(temp, { flags: "wx", mode: 0o600 }));
        if (bytes !== file.size || hash.digest("hex") !== file.sha256) throw Object.assign(new Error("restored copy does not match"), { code: "mismatch" });
        const landed = await publish(temp, target);
        if (landed !== target) job?.notes.push({ path: file.path, reason: `restored-as:${basename(landed)}` });
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    }
    store.run("UPDATE file SET local = 'present' WHERE id = ?", file.id);
    store.record({ job: job?.id, archive: archive.id, path: file.path, actor, action: "file.restore", outcome: "ok", bytes: file.size });
  }

  async function missingLocally(archive: ArchiveRow, only?: readonly string[]): Promise<FileRow[]> {
    const rows = store.all<FileRow>("SELECT * FROM file WHERE archive = ?", archive.id).filter((row) => !only || only.includes(row.id));
    const out: FileRow[] = [];
    for (const row of rows) if (row.local === "removed" || !await stat(hostPath(archive.root, row.path))) out.push(row);
    return out;
  }

  async function runCleanup(job: StorageJob, from: Held, actor: string): Promise<void> {
    const archive = archiveRow(from.archiveId);
    const release = lease(archive.bot, archive.thread);
    let bucket: Bucket | undefined;
    try {
      bucket = bucketOf(destinationOf(archive));
      for (const [index, entry] of from.entries.entries()) {
        const file = store.one<FileRow>("SELECT * FROM file WHERE id = ?", from.fileIds![index]!)!;
        const path = hostPath(archive.root, file.path), quarantine = join(store.dir, "quarantine", file.id);
        const keepIt = (why: StorageSkipReason | string) => {
          job.notes.push({ path: file.path, reason: why });
          store.record({ job: job.id, archive: archive.id, path: file.path, actor, action: "file.remove", outcome: "kept", reason: why });
        };
        if (deps.busy(archive.bot, archive.thread)) throw failure(409, "conversation started working", "thread_busy");
        if (!await inside(archive.root, path) || !unchanged(await stat(path), entry)) { keepIt("changed"); continue; }
        if (await bucket.sealedBytes(file.object_key).catch(() => undefined) !== file.size + SEAL_BYTES) { keepIt("cloud-copy-missing"); continue; }
        store.record({ job: job.id, archive: archive.id, path: file.path, actor, action: "file.remove", outcome: "intent", bytes: file.size });
        try {
          await rename(path, quarantine);
        } catch (error) {
          keepIt(reason(error));
          continue;
        }
        if (await sha256Of(quarantine).catch(() => "") !== file.sha256) {
          await publish(quarantine, path);
          keepIt("changed");
          continue;
        }
        await unlink(quarantine);
        store.run("UPDATE file SET local = 'removed' WHERE id = ?", file.id);
        store.record({ job: job.id, archive: archive.id, path: file.path, actor, action: "file.remove", outcome: "removed", bytes: file.size });
        job.done += 1;
      }
    } finally {
      bucket?.close();
      release();
    }
  }

  async function runRestore(job: StorageJob, archive: ArchiveRow, files: FileRow[], actor: string): Promise<void> {
    const release = lease(archive.bot, archive.thread);
    let bucket: Bucket | undefined;
    try {
      bucket = bucketOf(destinationOf(archive));
      for (const file of files) {
        await restoreFile(file, archive, bucket, actor, job);
        job.done += 1;
      }
    } finally {
      bucket?.close();
      release();
    }
  }

  /** A file moved aside for removal when the server stopped goes back where it was: its removal was never completed. */
  async function reconcile(): Promise<void> {
    store.run("UPDATE job SET state = 'failed', error = 'interrupted' WHERE state = 'running'");
    store.run("UPDATE archive SET state = 'failed' WHERE state = 'uploading'");
    for (const id of await readdir(join(store.dir, "quarantine"))) {
      const file = store.one<FileRow>("SELECT * FROM file WHERE id = ?", id);
      const archive = file && store.one<ArchiveRow>("SELECT * FROM archive WHERE id = ?", file.archive);
      if (!file || !archive) continue;
      try {
        const target = hostPath(archive.root, file.path);
        await mkdir(dirname(target), { recursive: true });
        await publish(join(store.dir, "quarantine", id), target);
        store.run("UPDATE file SET local = 'present' WHERE id = ?", id);
        store.record({ archive: archive.id, path: file.path, actor: "server", action: "file.remove", outcome: "kept", reason: "interrupted" });
      } catch (error) {
        store.record({ archive: archive.id, path: file.path, actor: "server", action: "file.remove", outcome: "quarantined", reason: reason(error) });
      }
    }
  }
  const ready = reconcile();

  return {
    ready,
    close: () => store.close(),

    destination: (): StorageDestination | null => { const row = activeRow(); return row ? wireDestination(row) : null; },

    /** Settings are never edited in place: archives made under the old ones keep reading from where they were written. */
    saveDestination(input: StorageDestinationInput, actor: string): StorageDestination {
      const problem = destinationProblem(input);
      if (problem) throw failure(400, problem);
      const row: DestinationRow = {
        id: randomUUID(), endpoint: new URL(input.endpoint).origin, region: input.region, bucket: input.bucket, prefix: input.prefix ?? "",
        path_style: input.pathStyle ? 1 : 0, created_at: Date.now(), tested_at: null, active: 1,
      };
      store.saveCredentials(row.id, { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey, ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}) });
      store.run("UPDATE destination SET active = 0");
      store.run("INSERT INTO destination(id, endpoint, region, bucket, prefix, path_style, created_at, tested_at, active) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, 1)",
        row.id, row.endpoint, row.region, row.bucket, row.prefix, row.path_style, row.created_at);
      store.record({ actor, action: "destination.save", outcome: "ok" });
      return wireDestination(row);
    },

    /** Stops new archives. Nothing in the bucket, the catalog or the key is touched, and existing archives still restore. */
    disconnect(actor: string): void {
      store.run("UPDATE destination SET active = 0");
      store.record({ actor, action: "destination.disconnect", outcome: "ok" });
    },

    /** One small random object: uploaded, read back, deleted. Names the step that was refused. */
    async test(): Promise<{ ok: true } | { ok: false; step: "upload" | "read" | "delete"; error: string }> {
      const row = activeRow(), bucket = bucketOf(row);
      const objectKey = `${bucket.base}/connection-test-${randomUUID()}`, body = randomBytes(64), { key } = store.archiveKey();
      let step: "upload" | "read" | "delete" = "upload";
      try {
        await bucket.put(objectKey, Readable.from([body]), key);
        step = "read";
        const back = await digest(bucket.get(objectKey, key));
        if (back.sha256 !== createHash("sha256").update(body).digest("hex")) throw Object.assign(new Error("mismatch"), { code: "mismatch" });
        step = "delete";
        await bucket.remove(objectKey);
        store.run("UPDATE destination SET tested_at = ? WHERE id = ?", Date.now(), row!.id);
        return { ok: true };
      } catch (error) {
        return { ok: false, step, error: reason(error) };
      } finally {
        bucket.close();
      }
    },

    /** Everything needed to read this server's archives from another machine, apart from the bucket's own credentials. */
    recovery() {
      const { id, key } = store.archiveKey();
      return {
        version: 1, installationId: store.installation(), keyId: id, key: key.toString("hex"),
        destinations: store.all<DestinationRow>("SELECT * FROM destination").map((row) => ({ id: row.id, endpoint: row.endpoint, region: row.region, bucket: row.bucket, prefix: row.prefix, pathStyle: row.path_style === 1 })),
      };
    },

    async previewArchive(botId: string, threadId: string): Promise<StoragePreview> {
      const root = await threadRoot(botId, threadId);
      const { entries, skipped } = await eligible(root);
      return keep("archive", { botId, threadId, root, entries }, skipped);
    },

    archive(previewId: unknown, idem: unknown, actor: string): StorageJob {
      const earlier = typeof idem === "string" ? store.one<JobRow>("SELECT * FROM job WHERE idem = ?", idem) : undefined;
      if (earlier) return live.get(earlier.id) ?? wireJob(earlier);
      const destination = activeRow();
      if (!destination || !store.credentials(destination.id)) throw failure(409, "Cloud storage is not connected. Connect a bucket in Settings first.", "not_connected");
      const from = held(previewId, "archive");
      const id = randomUUID();
      store.run("INSERT INTO archive(id, destination, key_id, bot, thread, root, manifest_key, created_at, state) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'uploading')",
        id, destination.id, store.archiveKey().id, from.botId, from.threadId, from.root, `${destination.prefix ? `${destination.prefix}/` : ""}${store.installation()}/${id}/manifest`, Date.now());
      return start("archive", idem, from.entries.length, id, actor, (job) => runArchive(job, from, actor));
    },

    /** What removing an archive's local files would take: only files still exactly as they were uploaded. */
    async previewCleanup(archiveId: unknown): Promise<StoragePreview> {
      const archive = archiveRow(archiveId);
      if (archive.state !== "verified") throw failure(409, "This archive was not verified, so its local files stay.", "unverified");
      const entries: Entry[] = [], fileIds: string[] = [], skipped: StoragePreview["skipped"] = [];
      for (const file of store.all<FileRow>("SELECT * FROM file WHERE archive = ? AND local = 'present' ORDER BY path", archive.id)) {
        const entry = { path: file.path, size: file.size, mtime: file.mtime };
        const info = await stat(hostPath(archive.root, file.path));
        if (!info) skipped.push({ path: file.path, reason: "missing" });
        else if (!unchanged(info, entry)) skipped.push({ path: file.path, reason: "changed" });
        else { entries.push(entry); fileIds.push(file.id); }
      }
      return keep("cleanup", { botId: archive.bot, threadId: archive.thread, root: archive.root, entries, archiveId: archive.id, fileIds }, skipped);
    },

    cleanup(previewId: unknown, confirmed: unknown, idem: unknown, actor: string): StorageJob {
      const earlier = typeof idem === "string" ? store.one<JobRow>("SELECT * FROM job WHERE idem = ?", idem) : undefined;
      if (earlier) return live.get(earlier.id) ?? wireJob(earlier);
      if (confirmed !== true) throw failure(400, "Removing local files needs your confirmation of the reviewed list.", "unconfirmed");
      const from = held(previewId, "cleanup");
      return start("cleanup", idem, from.entries.length, from.archiveId!, actor, (job) => runCleanup(job, from, actor));
    },

    async restore(archiveId: unknown, fileIds: unknown, idem: unknown, actor: string): Promise<StorageJob> {
      const archive = archiveRow(archiveId);
      const only = Array.isArray(fileIds) ? fileIds.filter((id): id is string => typeof id === "string") : undefined;
      const files = await missingLocally(archive, only);
      return start("restore", idem, files.length, archive.id, actor, (job) => runRestore(job, archive, files, actor));
    },

    job(id: string): StorageJob | null {
      const row = store.one<JobRow>("SELECT * FROM job WHERE id = ?", id);
      return live.get(id) ?? (row ? wireJob(row) : null);
    },

    owner(archiveId: unknown): { botId: string; threadId: string } {
      const archive = archiveRow(archiveId);
      return { botId: archive.bot, threadId: archive.thread };
    },

    archives(): StorageArchive[] {
      return store.all<ArchiveRow & { files: number; bytes: number | null; removed: number | null }>(
        `SELECT archive.*, COUNT(file.id) AS files, SUM(file.size) AS bytes, SUM(CASE WHEN file.local = 'removed' THEN file.size ELSE 0 END) AS removed
         FROM archive LEFT JOIN file ON file.archive = archive.id GROUP BY archive.id ORDER BY archive.created_at DESC LIMIT 500`).map((row) => {
        const thread = deps.thread(row.bot, row.thread);
        return {
          id: row.id, botId: row.bot, threadId: row.thread, ...(thread ? { botName: thread.botName, threadTitle: thread.title } : {}),
          createdAt: row.created_at, state: row.state, files: row.files, bytes: row.bytes ?? 0, removedBytes: row.removed ?? 0,
        };
      });
    },

    events: (limit: number, before?: number): StorageEvent[] => store.events(Math.min(Math.max(limit, 1), 200), before),

    enter,

    /** Some of this conversation's files are in cloud storage only. */
    evicted: (botId: string, threadId: string): boolean =>
      Boolean(store.one("SELECT 1 FROM file JOIN archive ON archive.id = file.archive WHERE archive.bot = ? AND archive.thread = ? AND file.local = 'removed' LIMIT 1", botId, threadId)),

    /** As `enter`, after bringing back what was removed from the conversation's folder. */
    async admit(botId: string, threadId: string): Promise<() => void> {
      await ready;
      const release = enter(threadId);
      try {
        for (const archive of store.all<ArchiveRow>("SELECT * FROM archive WHERE bot = ? AND thread = ? AND id IN (SELECT archive FROM file WHERE local = 'removed')", botId, threadId)) {
          const bucket = bucketOf(destinationOf(archive));
          try {
            for (const file of store.all<FileRow>("SELECT * FROM file WHERE archive = ? AND local = 'removed'", archive.id)) await restoreFile(file, archive, bucket, "turn");
          } finally {
            bucket.close();
          }
        }
      } catch (error) {
        release();
        throw failure(409, `This conversation's files are in cloud storage and could not be brought back (${reason(error)}). Restore them in Settings, under Data.`, "storage_restore_failed");
      }
      return release;
    },

    /** For a chat link whose file is gone: brings back the archived file that lived at exactly that place under one of
     * the folders the caller already authorized. Never looks a file up by name alone. */
    async hydrate(botId: string, roots: readonly string[], requested: string, maxBytes: number): Promise<boolean> {
      await ready;
      const canonical = new Set((await Promise.all(roots.map((root) => realpath(root).catch(() => null)))).filter((root): root is string => Boolean(root)));
      const candidates = isAbsolute(requested) ? [resolve(requested)] : [...canonical].map((root) => resolve(root, requested));
      for (const candidate of candidates) {
        for (const archive of store.all<ArchiveRow>("SELECT * FROM archive WHERE bot = ? AND state = 'verified' ORDER BY created_at DESC", botId)) {
          const inner = relative(archive.root, candidate);
          if (!canonical.has(archive.root) || !inner || inner.startsWith("..") || isAbsolute(inner)) continue;
          const file = store.one<FileRow>(`SELECT * FROM file WHERE archive = ? AND ${pathMatch}`, archive.id, inner.split(sep).join("/"));
          if (!file || file.size > maxBytes || await stat(candidate)) continue;
          const bucket = bucketOf(destinationOf(archive));
          try {
            await restoreFile(file, archive, bucket, "link");
            return true;
          } finally {
            bucket.close();
          }
        }
      }
      return false;
    },
  };
}

export type StorageArchiver = ReturnType<typeof createStorageArchive>;

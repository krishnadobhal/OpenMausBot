// What cloud archiving keeps on this server, all under <data>/storage: the catalog (archive.db), the key archived files
// are sealed under, and the bucket credentials.
// Security invariant: the key and the credentials are read only by the archiver. Neither is returned by a route, put in a
// bot's environment or prompt, logged, or copied into a backup.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { StorageEvent } from "../shared/storage.ts";
import { writeFileAtomic } from "./atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "./browser-sites.ts";

export interface BucketCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export interface DestinationRow { id: string; endpoint: string; region: string; bucket: string; prefix: string; path_style: number; created_at: number; tested_at: number | null; active: number }
export interface ArchiveRow { id: string; destination: string; key_id: string; bot: string; thread: string; root: string; manifest_key: string; created_at: number; state: "uploading" | "verified" | "failed" }
export interface FileRow { id: string; archive: string; path: string; size: number; mtime: number; sha256: string; object_key: string; verified_at: number; local: "present" | "removed" }
export interface JobRow { id: string; operation: "archive" | "cleanup" | "restore"; idem: string; done: number; total: number; state: "running" | "done" | "failed"; error: string | null; archive: string | null; notes: string; created_at: number }

const SCHEMA = 1;

export class ArchiveStore {
  readonly dir: string;
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "storage");
    mkdirSync(join(this.dir, "quarantine"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.dir, "archive.db"));
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    // Security invariant: a catalog written by a newer release is never rewritten by this one, so its records of removed files survive a downgrade.
    if (version > SCHEMA) throw new Error("The storage archive catalog was written by a newer version of the app.");
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS destination(id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, region TEXT NOT NULL, bucket TEXT NOT NULL, prefix TEXT NOT NULL, path_style INTEGER NOT NULL, created_at INTEGER NOT NULL, tested_at INTEGER, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archive(id TEXT PRIMARY KEY, destination TEXT NOT NULL, key_id TEXT NOT NULL, bot TEXT NOT NULL, thread TEXT NOT NULL, root TEXT NOT NULL, manifest_key TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file(id TEXT PRIMARY KEY, archive TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, sha256 TEXT NOT NULL, object_key TEXT NOT NULL, verified_at INTEGER NOT NULL, local TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS file_archive ON file(archive);
      CREATE TABLE IF NOT EXISTS job(id TEXT PRIMARY KEY, operation TEXT NOT NULL, idem TEXT NOT NULL UNIQUE, done INTEGER NOT NULL, total INTEGER NOT NULL, state TEXT NOT NULL, error TEXT, archive TEXT, notes TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS event(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, job TEXT, archive TEXT, path TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT, bytes INTEGER);
      PRAGMA user_version = ${SCHEMA};`);
  }

  close(): void { this.db.close(); }

  all<Row>(sql: string, ...values: Array<string | number | null>): Row[] { return this.db.prepare(sql).all(...values) as Row[]; }
  one<Row>(sql: string, ...values: Array<string | number | null>): Row | undefined { return this.db.prepare(sql).get(...values) as Row | undefined; }
  run(sql: string, ...values: Array<string | number | null>): void { this.db.prepare(sql).run(...values); }

  /** Names this installation's objects in a bucket it may share with others. */
  installation(): string {
    const known = this.one<{ value: string }>("SELECT value FROM meta WHERE key = 'installation'")?.value;
    if (known) return known;
    const made = randomUUID();
    this.run("INSERT INTO meta(key, value) VALUES('installation', ?)", made);
    return made;
  }

  private secretFile(name: string, create: boolean): string | null {
    const file = join(this.dir, name);
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(existing)) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!create) return null;
    const made = randomBytes(32).toString("hex");
    writeFileAtomic(file, `${made}\n`, { mode: 0o600 });
    return made;
  }

  /** The key archived files are sealed under. It is made once and never replaced: every archive needs it to be read. */
  archiveKey(): { id: string; key: Buffer } {
    const hex = this.secretFile("archive-key", true)!;
    return { id: createHash("sha256").update(hex).digest("hex").slice(0, 16), key: Buffer.from(hex, "hex") };
  }

  private allCredentials(): Record<string, BucketCredentials> {
    const key = this.secretFile("credentials-key", false);
    if (!key) return {};
    try {
      return JSON.parse(decryptBrowserState(readFileSync(join(this.dir, "credentials.json.enc")), key)) as Record<string, BucketCredentials>;
    } catch {
      return {};
    }
  }

  credentials(destination: string): BucketCredentials | null { return this.allCredentials()[destination] ?? null; }

  saveCredentials(destination: string, credentials: BucketCredentials): void {
    const key = this.secretFile("credentials-key", true)!;
    writeFileAtomic(join(this.dir, "credentials.json.enc"), encryptBrowserState(JSON.stringify({ ...this.allCredentials(), [destination]: credentials }), key), { mode: 0o600 });
  }

  record(event: { job?: string; archive?: string; path?: string; actor: string; action: string; outcome: string; reason?: string; bytes?: number }): void {
    this.run("INSERT INTO event(at, job, archive, path, actor, action, outcome, reason, bytes) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      Date.now(), event.job ?? null, event.archive ?? null, event.path ?? null, event.actor, event.action, event.outcome, event.reason ?? null, event.bytes ?? null);
  }

  events(limit: number, before?: number): StorageEvent[] {
    return this.all<{ seq: number; at: number; action: string; outcome: string; archive: string | null; path: string | null; bytes: number | null; reason: string | null }>(
      "SELECT seq, at, action, outcome, archive, path, bytes, reason FROM event WHERE seq < ? ORDER BY seq DESC LIMIT ?", before ?? Number.MAX_SAFE_INTEGER, limit)
      .map((row) => ({ seq: row.seq, at: row.at, action: row.action, outcome: row.outcome, ...(row.archive ? { archiveId: row.archive } : {}),
        ...(row.path ? { path: row.path } : {}), ...(row.bytes === null ? {} : { bytes: row.bytes }), ...(row.reason ? { reason: row.reason } : {}) }));
  }
}

/** Why a folder's numbers are absent (`missing`, `broad`) or lower than what is on disk (`denied`, `limit`). */
export type StorageGap = "missing" | "denied" | "broad" | "limit";

export interface StorageOwner {
  kind: "bot" | "room";
  id: string;
  name: string;
  threadId?: string;
  threadTitle?: string;
}

/** One measured folder. A file under two folders counts in the more specific one, so the rows add up to the total. */
export interface StorageRoot {
  /** Opaque: never a path a request may send back. */
  id: string;
  /** `owner`: one bot's or room's, across its conversations. `shared`: several bots or rooms work in it.
   * `unassigned`: an app-made folder whose bot or conversation is gone. */
  kind: "owner" | "thread" | "shared" | "unassigned";
  owners: StorageOwner[];
  /** The folder's path on the server; empty when `private`. */
  location: string;
  /** Made by the app under its own data folder, not chosen by a person. */
  managed: boolean;
  /** Logical file sizes, not blocks on disk. */
  bytes: number;
  files: number;
  gap?: StorageGap;
  /** Someone else's conversation on a shared server: its size counts, its name and place are withheld. */
  private?: true;
}

/** A folder a tool can probably make again. Informational: rebuilding may need the network and the original toolchain. */
export interface StorageCandidate {
  id: string;
  rootId: string;
  /** Relative to its root's location. */
  location: string;
  bytes: number;
  category: "dependencies" | "tool-cache" | "build";
  /** The file beside it that names the tool which made it, or the cache's own name. */
  evidence: string;
}

export interface StorageUsage {
  scanId: string;
  /** Epoch ms. */
  scannedAt: number;
  /** False when a limit or an unreadable folder left the totals lower than what is on disk. */
  complete: boolean;
  bytes: number;
  files: number;
  /** Links, other volumes and special files that were not followed. */
  skipped: number;
  errors: number;
  /** The filesystem gave no file identity, so a file with several names may be counted once per name. */
  linksApproximate: boolean;
  roots: StorageRoot[];
  candidates: StorageCandidate[];
}

/** One volume that holds measured folders. */
export interface StorageDisk {
  id: string;
  /** This volume holds the app's own data folder. */
  appData: boolean;
  /** The chosen folders on this volume, by StorageRoot id. */
  rootIds: string[];
  totalBytes: number;
  availableBytes: number;
  low: boolean;
  /** The volume's numbers could not be read: neither healthy nor full. */
  unavailable?: true;
}

export function storageLow(totalBytes: number, availableBytes: number): boolean {
  return availableBytes < 10 * 1024 ** 3 || availableBytes < totalBytes / 10;
}

/** Where archived conversation folders go. Credentials never leave the server: `hasCredentials` is all a client learns. */
export interface StorageDestination {
  id: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  hasCredentials: boolean;
  /** When the upload, read-back and delete test last passed. */
  testedAt?: number;
  createdAt: number;
}

export interface StorageDestinationInput {
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  pathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Plain HTTP is accepted only for a loopback address, and only when this is true. */
  allowLoopbackHttp?: boolean;
}

export type StorageSkipReason = "link" | "secret" | "not-a-file" | "too-large" | "changed" | "missing" | "cloud-copy-missing" | "unverified";

/** What an archive or a local removal would cover. It expires, and the operation takes its id, never a path. */
export interface StoragePreview {
  id: string;
  operation: "archive" | "cleanup";
  expiresAt: number;
  bytes: number;
  files: Array<{ path: string; bytes: number }>;
  skipped: Array<{ path: string; reason: StorageSkipReason }>;
}

export interface StorageJob {
  id: string;
  operation: "archive" | "cleanup" | "restore";
  state: "running" | "done" | "failed";
  done: number;
  total: number;
  archiveId?: string;
  /** A short reason code, never a provider's raw response. */
  error?: string;
  /** Files left alone or restored under another name, with why. */
  notes: Array<{ path: string; reason: string }>;
}

export interface StorageArchive {
  id: string;
  botId: string;
  threadId: string;
  botName?: string;
  threadTitle?: string;
  createdAt: number;
  state: "uploading" | "verified" | "failed";
  files: number;
  bytes: number;
  /** Bytes of this archive no longer on this server's disk. */
  removedBytes: number;
}

export interface StorageEvent {
  seq: number;
  at: number;
  action: string;
  outcome: string;
  archiveId?: string;
  path?: string;
  bytes?: number;
  reason?: string;
}

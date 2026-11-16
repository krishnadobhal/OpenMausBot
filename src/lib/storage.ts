import type { StorageDisk, StorageRoot } from "../../shared/storage";
import { activeLocale } from "./i18n";

export function storageSize(bytes: number): string {
  const power = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: power === 3 ? 1 : 0 }).format(bytes / 1024 ** power)} ${["B", "KB", "MB", "GB"][power]}`;
}

export interface StorageSection {
  /** A bot's or room's id, or which of the three shared kinds of folder this is. */
  key: string;
  kind: "owner" | "shared" | "unassigned" | "private";
  name?: string;
  bytes: number;
  roots: StorageRoot[];
}

/** One section per bot or room, then shared, unassigned and withheld folders, each largest first. */
export function storageSections(roots: readonly StorageRoot[]): StorageSection[] {
  const sections = new Map<string, StorageSection>();
  for (const root of roots) {
    const owner = root.kind === "owner" || root.kind === "thread" ? root.owners[0] : undefined;
    const kind = root.private ? "private" : owner ? "owner" : root.kind === "shared" ? "shared" : "unassigned";
    const key = owner ? `${owner.kind}:${owner.id}` : kind;
    const section = sections.get(key) ?? { key, kind, ...(owner ? { name: owner.name } : {}), bytes: 0, roots: [] };
    section.bytes += root.bytes;
    section.roots.push(root);
    sections.set(key, section);
  }
  for (const section of sections.values()) section.roots.sort((a, b) => b.bytes - a.bytes);
  return [...sections.values()].sort((a, b) => b.bytes - a.bytes);
}

/** Which volumes are low: a warning closed for one state shows again when the state changes. */
export function lowDiskKey(disks: readonly StorageDisk[]): string {
  return disks.filter((disk) => disk.low).map((disk) => disk.id).sort().join(",");
}

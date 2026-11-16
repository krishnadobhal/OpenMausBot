import { describe, expect, it } from "vitest";

import type { StorageDisk, StorageRoot } from "../../shared/storage";
import { lowDiskKey, storageSections, storageSize } from "./storage";

const root = (id: string, bytes: number, rest: Partial<StorageRoot>): StorageRoot =>
  ({ id, kind: "thread", owners: [], location: `/work/${id}`, managed: false, bytes, files: 1, ...rest });
const ada = { kind: "bot" as const, id: "ada", name: "Ada" };

describe("the storage report", () => {
  it("lists each bot once with its folders, then shared, unassigned and withheld ones, largest first", () => {
    const sections = storageSections([
      root("small", 1, { owners: [{ ...ada, threadId: "t1" }] }),
      root("big", 5, { kind: "owner", owners: [ada] }),
      root("both", 50, { kind: "shared", owners: [ada, { kind: "room", id: "r", name: "Room" }] }),
      root("left", 3, { kind: "unassigned" }),
      root("theirs", 2, { private: true }),
    ]);
    expect(sections.map((section) => [section.kind, section.name, section.bytes, section.roots.map((one) => one.id)])).toEqual([
      ["shared", undefined, 50, ["both"]],
      ["owner", "Ada", 6, ["big", "small"]],
      ["unassigned", undefined, 3, ["left"]],
      ["private", undefined, 2, ["theirs"]],
    ]);
  });

  it("names the low disks, so a closed warning returns only when they change", () => {
    const disk = (id: string, low: boolean): StorageDisk => ({ id, appData: false, rootIds: [], totalBytes: 1, availableBytes: 0, low });
    expect(lowDiskKey([disk("b", true), disk("a", true), disk("c", false)])).toBe("a,b");
    expect(lowDiskKey([disk("c", false)])).toBe("");
  });

  it("writes sizes from bytes to gigabytes", () => {
    expect([0, 2048, 5 * 1024 ** 2, 1.5 * 1024 ** 3].map(storageSize)).toEqual(["0 B", "2 KB", "5 MB", "1.5 GB"]);
  });
});

import { useEffect, useState } from "react";

import type { StorageArchive, StorageCandidate, StorageDestination, StorageDisk, StorageGap, StorageRoot, StorageUsage } from "../../shared/storage";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/relative-time";
import { storageSections, storageSize, type StorageSection } from "@/lib/storage";
import type { LocaleKey } from "@/locales";
import { api } from "@/state/store";
import { SettingRow, SettingsFoldRow } from "./SettingsPrimitives";
import { StorageArchiveActions, StorageDestinationSettings } from "./StorageArchiveSettings";

const GAP: Record<StorageGap, LocaleKey> = {
  missing: "settings.storage.gap.missing",
  denied: "settings.storage.gap.denied",
  broad: "settings.storage.gap.broad",
  limit: "settings.storage.gap.limit",
};
const CANDIDATE: Record<StorageCandidate["category"], LocaleKey> = {
  dependencies: "settings.storage.candidate.dependencies",
  "tool-cache": "settings.storage.candidate.toolCache",
  build: "settings.storage.candidate.build",
};
const SECTION: Record<Exclude<StorageSection["kind"], "owner">, LocaleKey> = {
  shared: "settings.storage.shared",
  unassigned: "settings.storage.unassigned",
  private: "settings.storage.private",
};

const folderName = (location: string) => location.split(/[\\/]/).filter(Boolean).at(-1) ?? location;

function rootTitle(root: StorageRoot): string {
  if (root.private) return t("settings.storage.privateRow");
  if (root.kind === "thread") return root.owners[0]?.threadTitle || folderName(root.location);
  if (root.kind === "owner") return t(root.managed ? "settings.storage.ownFolder" : "settings.storage.workingFolder");
  return folderName(root.location);
}

function RootRow({ root, candidates, children }: { root: StorageRoot; candidates: StorageCandidate[]; children?: React.ReactNode }) {
  return (
    <div data-storage-root={root.kind} className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[14px] leading-5 text-ink" dir="auto">{rootTitle(root)}</span>
        <span className="shrink-0 text-[13px] leading-5 tabular-nums text-ink-secondary">{storageSize(root.bytes)}</span>
      </div>
      {root.kind === "shared" && <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.storage.usedBy", { names: [...new Set(root.owners.map((owner) => owner.name))].join(", ") })}</p>}
      {root.location && <p className="break-all font-mono text-[12px] leading-4 text-ink-secondary" dir="ltr">{root.location}</p>}
      {root.gap && <p className="text-[12px] leading-4 text-warning">{t(GAP[root.gap])}</p>}
      {candidates.length > 0 && <ul className="mt-1 flex flex-col gap-1">
        {candidates.map((candidate) => (
          <li key={candidate.id} data-storage-candidate={candidate.category} className="text-[12px] leading-4 text-ink-secondary">
            <span className="font-mono text-ink" dir="ltr">{candidate.location}</span>{" · "}<span className="tabular-nums">{storageSize(candidate.bytes)}</span>{" · "}
            {t(CANDIDATE[candidate.category], { evidence: candidate.evidence })}
          </li>
        ))}
      </ul>}
      {children}
    </div>
  );
}

/** Settings → Data: what each bot's, room's and conversation's folder holds on the server this app is showing, and
 * whether its disks are running out. Read-only: nothing here removes a file. */
export function StorageSettings() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [disks, setDisks] = useState<StorageDisk[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [cloud, setCloud] = useState<{ destination: StorageDestination | null; archives: StorageArchive[] }>({ destination: null, archives: [] });
  const loadCloud = () => void Promise.all([api<{ destination: StorageDestination | null }>("/api/storage/destination"), api<{ archives: StorageArchive[] }>("/api/storage/archives")])
    .then(([{ destination }, { archives }]) => setCloud({ destination, archives })).catch(() => {});

  const load = (refresh: boolean) => {
    setLoading(true);
    setError(null);
    void api<{ disks: StorageDisk[] }>("/api/storage/disk").then((body) => setDisks(body.disks)).catch(() => {});
    return api<StorageUsage>(`/api/storage/usage${refresh ? "?refresh=1" : ""}`)
      .then(setUsage, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { void load(false); loadCloud(); }, []);

  const low = disks.filter((disk) => disk.low);
  return <>
    <SettingRow
      title={t("settings.storage.title")}
      subtitle={usage
        ? t("settings.storage.summary", { size: storageSize(usage.bytes), files: new Intl.NumberFormat(activeLocale()).format(usage.files), time: localizedRelativeTime(usage.scannedAt, activeLocale()) })
        : loading ? t("settings.storage.loading") : undefined}
      message={<>
        {error && <p role="alert" className="text-danger">{t("settings.storage.error", { error })}</p>}
        {low.map((disk) => <p key={disk.id} role="status" data-storage-low className="text-warning">{t("settings.storage.diskLow", { free: storageSize(disk.availableBytes), total: storageSize(disk.totalBytes) })}</p>)}
        {disks.some((disk) => disk.unavailable) && <p>{t("settings.storage.diskUnavailable")}</p>}
        {usage && !usage.complete && <p role="status" data-storage-partial className="text-warning">{t("settings.storage.partial")}</p>}
        {usage?.linksApproximate && <p>{t("settings.storage.linksApproximate")}</p>}
      </>}
    >
      <button type="button" onClick={() => void load(true)} disabled={loading} className="ui-button">
        {loading ? t("settings.storage.refreshing") : error ? t("common.tryAgain") : t("settings.storage.refresh")}
      </button>
    </SettingRow>
    <StorageDestinationSettings destination={cloud.destination} onChange={loadCloud} />
    {usage && storageSections(usage.roots).map((section) => (
      <SettingsFoldRow key={section.key} id={`storage-${section.key}`} title={section.kind === "owner" ? section.name! : t(SECTION[section.kind])}
        value={<span className="tabular-nums">{storageSize(section.bytes)}</span>} open={open === section.key} onToggle={() => setOpen(open === section.key ? null : section.key)}>
        {section.roots.map((root) => <RootRow key={root.id} root={root} candidates={usage.candidates.filter((candidate) => candidate.rootId === root.id)}>
          <StorageArchiveActions root={root} archives={cloud.archives} connected={Boolean(cloud.destination?.hasCredentials)} onChange={loadCloud} />
        </RootRow>)}
      </SettingsFoldRow>
    ))}
  </>;
}

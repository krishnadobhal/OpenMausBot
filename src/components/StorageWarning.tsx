import { useEffect, useState } from "react";
import { HardDrive, X } from "lucide-react";

import type { StorageDisk } from "../../shared/storage";
import { t } from "@/lib/i18n";
import { lowDiskKey, storageSize } from "@/lib/storage";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, useStore } from "@/state/store";

const POLL_MS = 60_000;

/** One line for the owner or an admin while a disk under the bots' folders is nearly full. Closing it lasts until which
 * disks are low changes. The poll reads volume numbers only, and waits while the page is hidden. */
export function StorageWarning() {
  const { dispatch } = useStore();
  const allowed = useOwnerOrAdmin() === true;
  const [disks, setDisks] = useState<StorageDisk[]>([]);
  const [closed, setClosed] = useState("");
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    const look = () => void api<{ disks: StorageDisk[] }>("/api/storage/disk", { background: true }).then((body) => { if (live) setDisks(body.disks); }).catch(() => {});
    look();
    const timer = setInterval(look, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [allowed]);

  const key = lowDiskKey(disks);
  if (!allowed || !key || key === closed) return null;
  const free = Math.min(...disks.filter((disk) => disk.low).map((disk) => disk.availableBytes));
  return (
    <div role="status" data-storage-warning className="relative flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/10 px-8 py-1.5 text-[13px] text-warning">
      <HardDrive size={14} aria-hidden="true" />
      <span>{t("storage.warning.text", { free: storageSize(free) })}</span>
      <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "data" })}>{t("storage.warning.open")}</button>
      <button type="button" aria-label={t("common.close")} title={t("common.close")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 hover:text-ink" onClick={() => setClosed(key)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

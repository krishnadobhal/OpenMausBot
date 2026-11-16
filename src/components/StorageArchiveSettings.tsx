import { useEffect, useRef, useState } from "react";

import type { StorageArchive, StorageDestination, StorageJob, StoragePreview, StorageRoot } from "../../shared/storage";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/relative-time";
import { storageSize } from "@/lib/storage";
import { api } from "@/state/store";
import { SETTINGS_INPUT, SettingsField, SettingsFoldRow } from "./SettingsPrimitives";

const send = <T,>(method: string, name: string, body?: unknown) => api<T>(`/api/storage/${name}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const failed = (error: unknown) => error instanceof Error ? error.message : String(error);
const DANGER = "ui-button !bg-danger !text-danger-ink";

const EMPTY = { endpoint: "", region: "", bucket: "", prefix: "", pathStyle: false, accessKeyId: "", secretAccessKey: "", sessionToken: "", allowLoopbackHttp: false };

/** Settings → Data: the person's own bucket. The saved keys are never shown again: the form starts empty every time. */
export function StorageDestinationSettings({ destination, onChange }: { destination: StorageDestination | null; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<typeof EMPTY>) => setForm((now) => ({ ...now, ...patch }));
  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try { setNote({ ok: true, text: await work() }); } catch (error) { setNote({ ok: false, text: failed(error) }); } finally { setBusy(false); onChange(); }
  };
  const field = (key: "endpoint" | "region" | "bucket" | "prefix" | "accessKeyId" | "secretAccessKey" | "sessionToken", placeholder = "", secret = false) => (
    <SettingsField label={t(`settings.storage.cloud.${key}`)}>
      <input type={secret ? "password" : "text"} autoComplete="off" spellCheck={false} dir="ltr" className={SETTINGS_INPUT} placeholder={placeholder} value={form[key]} onChange={(event) => set({ [key]: event.target.value })} />
    </SettingsField>
  );
  const test = async () => {
    const result = await send<{ ok: boolean; step?: string; error?: string }>("POST", "destination/test");
    if (!result.ok) throw new Error(t("settings.storage.cloud.testFailed", { step: result.step ?? "", error: result.error ?? "" }));
    return t("settings.storage.cloud.testPassed");
  };
  const saveKey = async () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(await send("POST", "recovery"), null, 2)], { type: "application/json" }));
    link.download = "openmausbot-archive-recovery.json";
    link.click();
    URL.revokeObjectURL(link.href);
    return t("settings.storage.cloud.recoverySaved");
  };

  return (
    <SettingsFoldRow id="storage-cloud" title={t("settings.storage.cloud.title")} subtitle={t("settings.storage.cloud.subtitle")}
      value={destination ? destination.bucket : t("settings.storage.cloud.notConnected")} open={open} onToggle={() => setOpen(!open)}>
      <form className="flex flex-col gap-3 px-4 py-3" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => { await send("PUT", "destination", form); setForm(EMPTY); return t("settings.storage.cloud.saved"); });
      }}>
        {destination && <p className="text-[13px] leading-[18px] text-ink-secondary" data-storage-destination>
          {t("settings.storage.cloud.connected", { bucket: destination.bucket, endpoint: destination.endpoint })}{" "}
          {destination.testedAt ? t("settings.storage.cloud.tested", { time: localizedRelativeTime(destination.testedAt, activeLocale()) }) : t("settings.storage.cloud.untested")}
        </p>}
        {field("endpoint", "https://s3.eu-west-1.amazonaws.com")}
        {field("region", "eu-west-1")}
        {field("bucket")}
        {field("prefix")}
        {field("accessKeyId")}
        {field("secretAccessKey", "", true)}
        {field("sessionToken", "", true)}
        <label className="flex items-center gap-2 text-[13px] leading-[18px] text-ink">
          <input type="checkbox" checked={form.pathStyle} onChange={(event) => set({ pathStyle: event.target.checked })} />{t("settings.storage.cloud.pathStyle")}
        </label>
        {form.endpoint.trim().toLowerCase().startsWith("http://") && <label className="flex items-center gap-2 text-[13px] leading-[18px] text-warning">
          <input type="checkbox" checked={form.allowLoopbackHttp} onChange={(event) => set({ allowLoopbackHttp: event.target.checked })} />{t("settings.storage.cloud.allowHttp")}
        </label>}
        {note && <p role={note.ok ? "status" : "alert"} className={note.ok ? "text-[13px] text-success" : "text-[13px] text-danger"}>{note.text}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className="ui-button">{t("common.save")}</button>
          {destination && <>
            <button type="button" disabled={busy} className="ui-button" onClick={() => void run(test)}>{t("settings.storage.cloud.test")}</button>
            <button type="button" disabled={busy} className="ui-button" title={t("settings.storage.cloud.recoveryHelp")} onClick={() => void run(saveKey)}>{t("settings.storage.cloud.recovery")}</button>
            <button type="button" disabled={busy} className="ui-button" title={t("settings.storage.cloud.disconnectHelp")}
              onClick={() => void run(async () => { await send("DELETE", "destination"); return t("settings.storage.cloud.disconnected"); })}>{t("settings.storage.cloud.disconnect")}</button>
          </>}
        </div>
        <p className="text-[12px] leading-4 text-ink-secondary">{t("settings.storage.cloud.recoveryHelp")}</p>
      </form>
    </SettingsFoldRow>
  );
}

/** Under one conversation's own folder: copy it to the bucket, then, as a second reviewed step, remove the local files;
 * or bring them back. Removing never follows an upload by itself. */
export function StorageArchiveActions({ root, archives, connected, onChange }: { root: StorageRoot; archives: readonly StorageArchive[]; connected: boolean; onChange: () => void }) {
  const owner = root.owners[0];
  const [review, setReview] = useState<StoragePreview | null>(null);
  const [job, setJob] = useState<StorageJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  if (!root.managed || root.kind !== "thread" || owner?.kind !== "bot" || !owner.threadId) return null;

  const mine = archives.filter((archive) => archive.botId === owner.id && archive.threadId === owner.threadId);
  const verified = mine.find((archive) => archive.state === "verified");
  const away = mine.find((archive) => archive.removedBytes > 0);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await work(); } catch (problem) { if (live.current) setError(failed(problem)); } finally { if (live.current) setBusy(false); }
  };
  const follow = async (started: StorageJob) => {
    let now = started;
    while (live.current) {
      setJob(now);
      if (now.state !== "running") break;
      await new Promise((tick) => setTimeout(tick, 1000));
      now = await send<StorageJob>("GET", `jobs/${now.id}`);
    }
    onChange();
  };
  const begin = (name: "archive" | "cleanup" | "restore", body: Record<string, unknown>) => act(async () => {
    setReview(null);
    await follow(await send<StorageJob>("POST", name, { ...body, idempotencyKey: crypto.randomUUID() }));
  });
  const look = (name: "archive-preview" | "cleanup-preview", body: Record<string, unknown>) => act(async () => { setJob(null); setReview(await send<StoragePreview>("POST", name, body)); });

  return (
    <div data-storage-archive className="mt-1 flex flex-col gap-2 text-[13px] leading-[18px] text-ink-secondary">
      {verified && <p>{t(away ? "settings.storage.cloud.away" : "settings.storage.cloud.copied", { time: localizedRelativeTime(verified.createdAt, activeLocale()), size: storageSize(away?.removedBytes ?? verified.bytes) })}</p>}
      {review && <div role="group" aria-label={t("settings.storage.cloud.review")} className="flex flex-col gap-1">
        <p className="text-ink">{t(review.operation === "archive" ? "settings.storage.cloud.reviewUpload" : "settings.storage.cloud.reviewRemove", { count: review.files.length, size: storageSize(review.bytes) })}</p>
        {review.skipped.length > 0 && <p>{t("settings.storage.cloud.reviewSkipped", { count: review.skipped.length })}</p>}
        <details>
          <summary className="cursor-pointer">{t("settings.storage.cloud.reviewList")}</summary>
          <ul className="mt-1 max-h-40 overflow-y-auto font-mono text-[12px] leading-4" dir="ltr">
            {review.files.slice(0, 500).map((file) => <li key={file.path}>{file.path} · {storageSize(file.bytes)}</li>)}
            {review.skipped.slice(0, 200).map((file) => <li key={file.path} className="text-warning">{file.path} · {file.reason}</li>)}
          </ul>
        </details>
      </div>}
      {job && <p role="status" data-storage-job={job.state} className={job.state === "failed" ? "text-danger" : undefined}>
        {job.state === "failed" ? t("settings.storage.cloud.jobFailed", { error: job.error ?? "" })
          : t(job.state === "running" ? "settings.storage.cloud.jobRunning" : "settings.storage.cloud.jobDone", { done: job.done, total: job.total })}
        {job.notes.length > 0 && ` ${t("settings.storage.cloud.jobNotes", { count: job.notes.length, first: `${job.notes[0]!.path} (${job.notes[0]!.reason})` })}`}
      </p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {review ? <>
          <button type="button" className="ui-button" disabled={busy} onClick={() => setReview(null)}>{t("common.cancel")}</button>
          {review.files.length > 0 && (review.operation === "archive"
            ? <button type="button" className="ui-button" disabled={busy} onClick={() => void begin("archive", { previewId: review.id })}>{t("settings.storage.cloud.upload")}</button>
            : <button type="button" className={DANGER} disabled={busy} onClick={() => void begin("cleanup", { previewId: review.id, confirm: true })}>{t("settings.storage.cloud.remove")}</button>)}
        </> : <>
          {connected && <button type="button" className="ui-button" disabled={busy} onClick={() => void look("archive-preview", { botId: owner.id, threadId: owner.threadId })}>{t("settings.storage.cloud.copy")}</button>}
          {verified && verified.removedBytes < verified.bytes && <button type="button" className="ui-button" disabled={busy} onClick={() => void look("cleanup-preview", { archiveId: verified.id })}>{t("settings.storage.cloud.free")}</button>}
          {away && <button type="button" className="ui-button" disabled={busy} onClick={() => void begin("restore", { archiveId: away.id })}>{t("settings.storage.cloud.restore")}</button>}
        </>}
      </div>
    </div>
  );
}

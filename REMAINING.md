# Remaining work for #5634: phased build order

Continues [implementation.md](implementation.md); section numbers such as 2D refer to it.

This section is the plan for what is left. Nothing in it is built. Each phase ends at a review checkpoint on the same branch and PR; later phases stay unstaged until the earlier one is reviewed.

### Built so far (for orientation)

- Phase 1: storage report, cleanup suggestions and low-disk warning (`server/storage-usage.ts`, `server/routes/storage.ts`, `StorageSettings.tsx`, `StorageWarning.tsx`).
- Phase 2 core (2A–2D, partly): bucket connection and test, encrypted upload with read-back verification, reviewed local removal, restore, chat-link restore, and restore at turn start (`server/storage-archive.ts`, `server/storage-archive-store.ts`, `StorageArchiveSettings.tsx`). Scope is the app's own conversation folders (`task-workspaces/<bot>/<thread>`) only.
- Verified only against an in-memory S3 stand-in and the isolated fixture on Windows. No real provider, no UI seen in a window.

### Phase 3 — Restore and continue in the chat (2D)

**Goal:** a person who opens a conversation whose files were removed locally can read it at once, and gets one in-chat action to bring the files back before the bot works again.

Server:

1. Tell the client which conversations have files in cloud storage only. Add an optional field to the wire task in `shared/` (for example `filesInCloud?: { bytes: number }`), filled from `storageArchive.evicted` when a bot is serialised, and broadcast the bot when a removal or restore job ends. Reading history must not touch the bucket.
2. Add thread-scoped routes beside the existing thread routes, authorised by the same check that lets this person send to the thread (not the owner/admin gate of `/api/storage/*`):
   - `POST /api/threads/:id/restore` starts the conversation's restore job, or returns the one already running (one live restore job per conversation; the server makes the idempotency key).
   - `GET /api/threads/:id/restore` returns that job's progress.
3. Reuse `restore`/`restoreFile` in `server/storage-archive.ts` unchanged for the transfer, verification and no-overwrite rules. Add only: lookup of the running restore job by conversation, and a restore that spans every archive of the conversation with removed files.
4. Turn the job's reason codes into four stable failure kinds for the client: `storage_unavailable` (not connected, DNS, refused, timeout), `credentials` (expired or denied keys), `low_space`, `integrity` (mismatch, wrong key). Each says whether retry makes sense.
5. Keep server-side admission as the enforcement point: `startTurn` already refuses while files are moving and restores removed files before `beginTurn`. Add the same guard to the room-turn path if room folders ever become archivable, and return the failure kind from step 4 in the 409 so a client that bypasses the UI still gets an actionable answer.

Client:

6. In the chat view, when the open conversation has `filesInCloud`, show a strip above the composer: what is in cloud storage, its size, and **Restore and continue**. History and file links stay as they are.
7. While restoring, show progress (`done` of `total`) in the same strip, poll the thread restore route, and join a job another window started.
8. Keep the composer's text. Disable Send while files are in cloud storage or restoring; never send the draft automatically when the restore ends, and never queue it twice. When the restore finishes the strip goes away and Send works.
9. On failure, show the failure kind in plain words with **Try again** where retry makes sense, and a link to Settings → Data for credentials or connection problems (owner/admin only). The cloud copy, history and draft are untouched.
10. Conversations with all files local render exactly as today: no strip, no extra request.

Checks: engine test for join-not-duplicate and for each failure kind; route test for thread authorisation (a person who cannot send cannot restore, a member who can send can); component test for draft kept, Send disabled, no auto-send, retry; fixture run: remove files, open the conversation, restore from the chat, send one message, confirm one turn and intact files.

Review gate: history readable with the bucket offline; no download from opening a conversation; no turn before verified restore, including through a direct API call; one job for simultaneous clicks; draft neither lost nor sent twice.

### Phase 4 — Opt-in daily policy with queued removal reviews (2E)

1. `GET/PUT /api/storage/policy`: off by default; fields for the two quiet periods (7 days for archived or closed conversations, 30 days otherwise) and the 7-day grace after a restore. Stored in the catalog.
2. A daily pass while the server runs, plus one overdue pass at startup. Eligibility is re-read at run time: no messages, turns, routines or file changes within the period, not busy, not inside the restore grace. Skip when any of that is uncertain.
3. One conversation at a time. The pass may upload and verify unattended. It never removes local files: it records a pending removal review, persisted across restarts.
4. Settings shows pending reviews; each needs the same confirmation as a manual removal. Pausing the policy stops new passes and new removals; verified uploads stay listed.
5. Low disk space makes the warning more prominent and nothing else.

Checks: disabled by default; 7/30-day boundaries; missed days produce one pass; busy and uncertain conversations skipped; restore grace respected; no file removed without a confirmed review.

### Phase 5 — Reviewed cleanup of rebuildable folders (2E)

1. From a Phase 1 suggestion (`node_modules` beside a manifest, the three Python caches, a proven `outDir`, Cargo `target`), offer **Review and delete** on that one folder.
2. Preview by candidate id (never a path): re-run the same evidence check, list size and file count, expire after 15 minutes.
3. On explicit confirmation, re-validate evidence and containment, refuse shared, busy or changed roots, then delete only that folder. Record intent and outcome events.
4. No bulk action, and no widening of the rules to logs, screenshots, videos or source copies.

Checks: evidence removed between preview and confirm refuses; a link swapped in for the folder refuses; busy conversation refuses; unconfirmed request refuses.

### Phase 6 — Backups and recovery (2F)

1. Snapshot `storage/archive.db` consistently with the other databases in `server/workspace-backup.ts` instead of copying a live file.
2. Carry the archive key only inside the encrypted backup's private payload; keep the raw key, credentials and quarantine excluded (already in `workspace-backup-policy.ts`). Bucket credentials never travel: a restored server must reconnect.
3. After a workspace restore, rewrite stored folder paths to the new data folder, keep policy and jobs paused until the destination is reconnected and tested, and keep removed files restorable.
4. Import of the recovery key file on a fresh server, reading manifests from the bucket to rebuild the catalog.
5. Stop cloud sync, bot moves and publishing from treating a locally removed file as a deletion; register `storage/` with the sandbox protected paths.
6. Document that downgrading needs all files restored first.

Checks: backup then restore on a fresh fixture, reconnect, restore a removed file; recovery-key import on an empty server; sync does not propagate a removal.

### Phase 7 — Audit trail and history view (2F)

1. Add a `storage` category to `server/admin-activity.ts` and write one human-readable row per connection change, archive, removal batch and restore, with actor and byte counts and no keys or URLs. Update its type, filters, UI and tests together.
2. Add a History fold row in Settings → Data showing `/api/storage/events` (already recorded and served), newest first, paged.

Checks: each operation leaves an admin-activity row and catalog events; neither contains credentials; a viewer never sees events for a conversation they cannot read.

### Phase 8 — Verification recipe, real provider, packaging

1. Add `docs/verification/storage.md` and map it in `docs/verification/README.md`: report → encrypted upload → read-back → reviewed removal → chat-link restore → Restore and continue → whole-conversation restore.
2. Run it against a disposable local MinIO bucket (needs MinIO installed, or a disposable bucket supplied). Optionally run the connection and integrity checks against disposable AWS S3, R2 and Backblaze buckets. Record which providers were actually exercised.
3. See the Settings report, the cloud storage form, the chat strip and the warning in a running window, including narrow layout and keyboard use; attach screenshots.
4. Check the desktop bundle and server packaging with the AWS SDK dependency.
5. Run the full regression list in the final verification table, then `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`.

### Open points to settle before or during these phases

- Who may press Restore and continue: anyone who can send to the conversation (planned above), or only the owner and admins.
- Archiving custom project folders and room folders is not built; the plan above keeps it out unless asked.
- A restored file cannot be removed again under its old archive; freeing it later needs a new upload. Acceptable, or track restored revisions.
- Empty folders are left after removal.
- New strings are English only until the locale packs are regenerated.

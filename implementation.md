# Implementation: storage reporting and S3 archiving (#5634)

## Primary goal

People running several bots can see which folders consume their disk, safely move inactive work to their own S3-compatible bucket, and open or restore that work without broken chat links or lost files.

Issue: https://github.com/milind-soni/OpenMausBot/issues/5634

Both implementation phases belong to **one branch (`fix/issue-5634`) and one PR**. Phase 1 is a review checkpoint, followed by phase 2 on the same branch. Reporting alone does not complete the issue. This document expands [PLAN.md](PLAN.md); it describes proposed implementation, not code already delivered.

## Delivery rules and status

- Work only in `D:\VS\OS\OpenMausBot-5634`. The worktree starts at `2d74ba9616270b4a1df1ebfa4a912b55bd5cb4ea` from fetched `origin/main`.
- Current state: research and documentation only. No feature code, dependency installation, migrations, or runtime verification have been performed for this issue. The handoff documents are committed and pushed at the user's request.
- Read root/nested `AGENTS.md`, `docs/verification/README.md`, and the relevant source before editing. Prefix shell commands with `rtk`, per the workspace instructions.
- Do not commit or push unless asked. Never add AI co-author attribution. Before an authorized push, verify the branch and use `git push -u origin HEAD`; the branch initially tracks `origin/main`.
- At each checkpoint, provide the diff, test results, known limitations, and example screens. Preserve the single PR and group its description by phase.

## Phase 0 — Confirm existing contracts

**How this serves the primary goal:** reuse the app's real ownership, file access, and persistence rules so storage management does not expose files or break existing workflows.

### Sources and patterns to read

| Concern | Existing source | Reuse or constraint |
| --- | --- | --- |
| Settings placement | `src/components/settings/pages/DataPages.tsx`, `DataPage` | Extend the Storage group beside existing attachment controls. |
| Settings request/result UI | `src/components/AttachmentStorageSettings.tsx` | Reuse request handling and Settings primitives, not its destructive clear operation. |
| Warning presentation | `src/components/LicenseExpiryBanner.tsx`, `src/App.tsx` | Follow the small banner pattern and existing app placement. |
| Working folders | `server/workspace.ts`, `server/store.ts`, `server/message-file.ts:30` | Derive roots from stored fields; `messageFileRoots` documents pinned versus configured cwd semantics. |
| Owner authorization | `server/request-auth.ts:67`, `ownerOrAdmin(auth)` | Reject guests, client-only sessions, and service-trust loopback. Apply server-side checks, not just hidden UI. |
| File traversal | `server/cloud-send-files.ts:63`, `server/cloud-sync-store.ts:68` | Study traversal/validation patterns, but reporting must include dependency/cache files those transfer scanners omit. |
| Secret exclusion | `server/secret-folder.ts`, `inSecretFolder(path)` | Never upload or serve `.openmausbot-secrets`. |
| Private persistence | `server/atomic.ts:49`, `server/vault-store.ts:188` | Reuse durable private-file writes and encryption primitives; ordinary Vault secrets are bot-accessible. |
| Persistent index | `server/cloud-sync-store.ts:104` | Follow the installed `node:sqlite` pattern; do not add another database dependency. |
| Authorized chat files | `server/routes/threads.ts`, `server/message-file.ts` | Preserve message-reference checks, roots, MIME handling, and existing preview/download limits. |
| Recovery/backup | `server/workspace-backup.ts`, `server/workspace-backup-paths.ts` | Integrate archive metadata explicitly; do not assume absolute paths or private keys transfer safely. |
| Busy operations | `server/index.ts`, current turn and routine lifecycle | Integrate with real turn admission before local cleanup; checking busy status once is insufficient. |

### Provider documentation / allowed external APIs

- Use AWS SDK v3 `S3Client`, command objects, and `Upload` from `@aws-sdk/lib-storage`, following the [official checksum and streaming upload example](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html). These packages are not currently direct dependencies; add them in phase 2 only, pinned according to repository conventions.
- Required operations: upload, multipart upload/abort, get, head, and delete for a connection-test object. Do not require bucket creation, public ACLs, or listing every object in the bucket.
- [AWS integrity documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html) explains why ETags are not universal content hashes. Size, metadata, or ETag alone never authorize local deletion.
- Read [R2 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) and [Backblaze S3 compatibility](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api) before configuring optional SDK checksum behavior. Keep verification independent of provider-specific checksum headers.
- Confirm the exact installed SDK types/options during implementation. Do not invent SDK options or promise compatibility based solely on an AWS mock.

**Verification:** recheck these entrypoints against the worktree baseline, enumerate callers of changed shared helpers, and record any changed assumptions in this document. The previously inspected code graph was stale; use a refreshed graph or source-backed searches rather than treating it as authoritative.

## Phase 1 — Read-only reporting and warnings

**How this serves the primary goal:** show where disk growth comes from and identify possible rebuildable data before adding any file moves or deletion.

### 1A. Root discovery and accounting

Add a focused storage service and shared response types. Proposed locations: `server/storage-usage.ts`, `shared/storage.ts`, and `server/routes/storage.ts`. Follow surrounding patterns rather than creating a generic filesystem framework.

1. Discover every managed bot folder and conversation folder, plus configured custom roots. Include retained managed folders whose bot/thread was deleted, labeled as unassigned work. Do not silently omit their bytes.
2. Resolve effective cwd from stored bot/task values with explicit null/undefined semantics. Do not call `ensureTaskWorkspace`, `pinTaskCwd`, or any helper that creates folders or mutates conversation state.
3. Normalize root identity and detect nested/shared roots. Assign file ownership to the most specific configured root; identical roots shared by several threads belong in a shared row. Bot/thread exclusive totals plus shared/unassigned totals must reconcile to the global total.
4. Use async metadata traversal with a directory queue. Do not follow directory symlinks, junctions, or nested mounts. Resolve a configured root itself once, then enforce containment while traversing. Count regular-file logical bytes; deduplicate reliable `(device, inode)` identities for hard links. When identity is unavailable, state that deduplication is approximate rather than collapsing unrelated files.
5. Include hidden files, dependencies, and generated outputs in totals. Accounting reads metadata only. Candidate classification may separately inspect allowlisted declarative project manifests/configuration up to 256 KiB each; never read artifact bodies, secrets, arbitrary source, or executable project configuration. Treat disappearance during a scan as churn; permission errors or traversal failures produce a partial result with counts/reasons.
6. Bound each scan to 200,000 visited entries and 30 seconds, using small batches that yield to the event loop. A limit produces an explicit partial result. Do not continue unlimited work in the background or present an incomplete value as an exact total.
7. Do not walk the whole home directory or drive when configured as cwd. Report such broad roots as unsupported for scanning, explain why, and ask for a narrower project folder through existing folder configuration.

Response contracts should contain:

- Snapshot: scan ID/time, completion status, aggregate bytes/file count, skipped/error counts, root rows, bot/thread ownership summaries, and cleanup candidates.
- Root row: opaque ID, owner references, display name/location, exclusive/shared classification, logical bytes, file count, and partial/unavailable reason.
- Candidate: opaque ID, root-relative location, logical bytes, category, and evidence/reason. No promise of reclaimable physical space.
- Disk result: stable volume identity, representative root IDs, total/available bytes, warning state, and unavailable reason. Do not return credentials or file contents.

Global shared attachments remain reported by existing attachment-storage controls. Do not charge their entire size independently to every referring conversation. Phase 1 does not change attachment deletion or retention.

### 1B. Candidate classification

Use a small deterministic allowlist. Initial suggestions: `node_modules` next to a package manifest/lockfile, Python `__pycache__`, and recognized tool cache directories such as `.pytest_cache` and `.mypy_cache`. Mark as "May be rebuilt" with the reason; the owner reviews it.

Generated build directories are candidates only where literal declarative project configuration proves the output directory. Do not execute project scripts or config files to classify them. If proof is unavailable, show their bytes as ordinary storage. `.git`, secrets, arbitrary `.cache` folders, code copies, screenshots, videos, and generic logs are not automatically safe candidates.

Phase 1 exposes no delete action or deletion endpoint. Suggestions must not imply that regenerating dependencies is guaranteed offline or without the original toolchain.

### 1C. HTTP and cache behavior

| Endpoint | Behavior |
| --- | --- |
| `GET /api/storage/usage` | Return the latest snapshot, starting a bounded scan if none exists or the cache is older than 60 seconds. Concurrent requests share one scan. |
| `GET /api/storage/usage?refresh=1` | Bypass a completed cache; join an already running scan instead of starting another. |
| `GET /api/storage/disk` | Read volume metadata only; never recursively scan. |

Use existing owner/admin authorization on every endpoint. Also apply existing `visibleTo(viewerFor(auth))` bot/thread visibility when returning identities, locations, or details; an admin scope must not accidentally reveal private-thread data beyond the current access model. Reject caller-supplied filesystem roots. Show authorization errors distinctly from "no storage". The read-only scanner must create no workspace directories, alter no configuration, and delete no files.

### 1D. UI and disk warnings

- Add `StorageSettings` inside Settings -> Data with loading, error/retry, Refresh, scan timestamp, partial-result explanation, and largest-first bot/thread/shared/unassigned rows.
- Expand rows for candidate details; show reasons and locations. Use existing Settings primitives, formatting, translated strings, and accessible disclosure controls.
- Warn independently on each volume when available bytes are below 10 GiB **or** below 10% of total. Missing disk statistics are "unavailable", not healthy or full.
- Add a small owner/admin warning banner that opens the Storage section. Poll the cheap disk endpoint every 60 seconds only while the app is visible; refresh immediately on return. Deduplicate/dismiss until warning state changes so repeated polls do not create repeated notices.
- Counts refer to the server currently selected in the app. Do not label a remote server's disk as this Mac. Per-server caches and async responses must not bleed across a server switch.

### Phase 1 review gate

- Root discovery/accounting performs no mkdir, task pinning, content reads, upload, or deletion. Classification reads only bounded allowlisted declarative evidence.
- Exact totals reconcile on a static fixture; shared/nested/hard-linked data is not double counted.
- Missing, denied, changing, broad, and truncated roots have honest UI states.
- Non-admin/client/service identities cannot obtain paths or usage.
- Candidate explanations and warnings work on narrow/mobile layouts and with keyboard navigation.
- Present the phase 1 diff and evidence for review; keep phase 2 in the same branch/PR.

## Phase 2 — Cloud archiving, cleanup, and restore

**How this serves the primary goal:** reclaim local storage only after a recoverable verified cloud copy exists, while keeping the person's files accessible through existing conversations.

### 2A. Connection, credentials, and encryption

- Add one active archive destination per workspace: S3 endpoint, region, bucket, prefix, path-style option, access key, secret key, optional session token. R2 can use region `auto`; AWS uses the supplied region; MinIO can use path-style addressing.
- Require HTTPS with normal certificate verification. Permit HTTP only for an explicitly confirmed loopback MinIO development endpoint; never add a disable-TLS-verification option. Reject endpoint userinfo, query credentials, and redirects. Resolve through a transport that blocks metadata/link-local destinations; custom LAN MinIO must be explicitly configured by the owner, not inferred from bot content.
- Store archive credentials in a dedicated encrypted server-private record, using existing encryption/private-write patterns. Do not expose them through Vault secret lookup, config/status JSON, child-process environments, prompts, tools, backups, audit logs, or renderer readback. Response metadata only says whether credentials exist.
- Keep the storage directory outside all bot roots, and add it explicitly to sandbox/protected-path rules. Test boxed and unboxed limitations honestly; same-user unsandboxed processes cannot be cryptographically prevented from accessing everything the server can read.
- Test a connection with a small random object under this installation's prefix: upload, fetch/verify, then delete. Report denied permissions separately. Do not list the user's entire bucket or alter its lifecycle/ACLs.
- Encrypt content before upload with versioned AES-256-GCM envelopes, a fresh nonce per object, and authenticated immutable object identity. Stream with bounded memory. Store filenames, relative paths, and plaintext hashes in encrypted manifests, not public object keys/metadata.
- Generate a workspace archive key and keep it server-private. Provide an explicit owner-only recovery export containing the key and destination identity, with a clear keep-safe instruction. Refuse key deletion while any archive depends on it. Do not silently rotate away access to old objects.
- Disconnect pauses new jobs and scheduling; it does not delete bucket objects, manifests, or keys. Destination edits create a new destination record; existing archives retain their original destination reference.

### 2B. Durable catalog and operation contracts

Use `node:sqlite` for a small archive catalog, with schema versioning and transactional updates. Keep database and private files under `<data>/storage/`. Proposed tables:

| Record | Required fields |
| --- | --- |
| Destination | ID, public connection metadata, private credential reference, validation status, creation time. |
| Archive | ID, destination/key references, bot/thread, root identity, encrypted manifest object key, creation time, state. |
| File revision | ID, archive ID, validated relative path, size, source identity/timestamps, plaintext SHA-256, object key/version if returned, verification time, local state. |
| Job | ID, operation, scope, idempotency key, progress, state, safe error, timestamps. |
| Event | Sequence, job/file IDs, actor category, action, outcome, time, redacted reason. |

Use opaque generated keys under `<prefix>/<installation-id>/`; never let a filename choose another object's key. Do not deduplicate objects across owners. Archive content and manifest objects are immutable revisions.

Proposed owner/admin-only routes:

| Method/path | Input/result |
| --- | --- |
| `GET/PUT /api/storage/destination` | Read redacted status or save validated settings/credentials. |
| `POST /api/storage/destination/test` | Test the configured destination; return safe capability/error status. |
| `GET/PUT /api/storage/policy` | Read/save policy fields and explicitly enable/disable scheduling. |
| `POST /api/storage/archive-preview` | Bot/thread IDs or root IDs; return immutable preview ID, eligible files/bytes, exclusions, and expiry. |
| `POST /api/storage/archive` | Preview ID plus idempotency key; start upload/verification job. |
| `POST /api/storage/cleanup` | Archive ID plus a current verified cleanup-preview ID and explicit confirmation; remove only that reviewed local set. |
| `POST /api/storage/restore` | Archive ID and optional file revision IDs; return a durable restore job. |
| `GET /api/storage/jobs/:id` | Progress, partial results, retryable errors; no raw SDK responses. |
| `GET /api/storage/archives` | Paginated bot/thread archive inventory, local/remote states, Restore action data. |
| `GET /api/storage/events` | Paginated chronological move/restore/cleanup history. |

Preview IDs expire after 15 minutes and are bound to caller scope, root identities, exact file revisions, and operation. Reject stale previews with 409 and require another review. Mutations take server-derived IDs, never arbitrary absolute paths. Use 202 for accepted jobs; retries with the same idempotency key return the same job.

### 2C. Archive and confirmed local cleanup

1. Derive eligible files from server-owned roots. Default automatic scope is managed, inactive conversation folders. Custom project folders require explicit owner opt-in; shared roots support archive-copy only, with local cleanup disabled. Never automatically remove bot-wide memory, skills, or live config.
2. Exclude links, multiply linked files from removal, secret folders, `.env`/credential/key files, private app state, and active/transient files. Enumerate skipped files and reasons. Archive exclusions differ from reporting: excluded bytes must remain visible in phase 1 totals.
3. Freeze app-managed writes for the thread via a lease integrated with turn/routine admission. Refuse busy threads, cancel if admission cannot be safely coordinated, and reject cleanup of custom folders with external writers unless the owner has quiesced them. Do not claim a one-time busy check prevents races.
4. Open each eligible regular file safely and record identity, size, mtime/ctime. Stream hash/encryption/upload. Use SDK multipart upload for large files; bound memory/concurrency and abort failed multipart uploads. Do not create another full local archive when the disk is already low.
5. Fetch each uploaded object back, authenticate/decrypt it, and recompute plaintext SHA-256 and byte count without retaining a full local copy. Fail verification on any mismatch or truncated stream. HEAD, user metadata, and ETag are not proof of payload identity.
6. Persist an encrypted remote manifest and durable local verified receipt before offering cleanup. Uploading alone never removes local files.
7. Show a separate cleanup review with files/bytes and explicit confirmation. An automatic policy can upload and verify unattended, but it queues cleanup for confirmation. Freshly restored or modified files are not covered by an old confirmation.
8. Reacquire the thread lease and revalidate containment, identity, metadata, and content before deleting. Record durable removal intent, move the exact file into same-volume private quarantine, recheck it, and remove only if unchanged and verified. If validation fails, preserve/recover it and report the conflict. Persist completion afterward. Avoid recursive deletion of an entire unverified folder.
9. On restart, reconcile journal intents and quarantine entries before admitting work on affected roots. Never infer successful verification from an interrupted job. Keep the local copy whenever state is uncertain.

Credentials protect the destination; encryption protects uploaded content. Filename exclusions cannot guarantee arbitrary code/media files contain no secrets, so show the reviewed transfer scope and do not make that guarantee in the UI.

### 2D. Restore and existing chat links

- Resolve archived content only after the existing thread/message authorization and referenced-link checks pass. Add archive lookup to the established message-file route; do not create an unauthenticated object proxy, widen file roots, or send presigned bucket URLs to clients.
- Match the original authorized root and relative path to its archived revision. Locally present files remain authoritative. A missing unrelated local file is still missing; do not search the bucket by filename.
- Fetch into an exclusive, private temporary file on the target volume, authenticate/decrypt, check SHA-256/length, and only then publish with a no-clobber operation. Keep normal preview/download limits and range behavior after hydration.
- Check available space using expected plaintext size plus the existing disk reserve convention. If insufficient, leave the archive intact and return a clear low-space error; never leave a partially restored file at the original path.
- One-click Restore starts a durable job for all selected archive revisions. If a destination differs, preserve both versions and report the restored sibling name; never overwrite edited local work. Repeated restore is idempotent when content already matches.
- Before a new bot turn uses an archived managed folder, restore its removed files under the same admission lease. Queue/fail the turn clearly if hydration cannot finish; never let it silently run against an incomplete project.
- Do not reuse `deleteAttachment`/`clearAttachments` for archived files: their accounting and box-copy removal semantics are different and can break historic links. Shared attachments remain local unless a separate reference-aware integration is added and tested within this PR.

### 2E. Automatic policies and rebuildable cleanup

- Scheduling is disabled initially. Opt-in defaults: scan eligible threads once per day while the server runs, archive explicitly archived/closed threads after 7 quiet days or other inactive threads after 30 quiet days. Quiet means no messages, turns, routines, processes, or observed file changes; use available authoritative state and skip when uncertain.
- At startup perform one overdue pass, not one job for every missed interval. Re-evaluate eligibility on execution. Low disk makes the warning prominent; it never grants deletion permission or overrides exclusions.
- One worker processes one thread at a time. Use bounded SDK retries for transient network failures; permission, configuration, checksum, and authentication failures require attention rather than infinite retries.
- Persist pending cleanup reviews. Disable/Pause stops new scheduling and prevents further removals; a completed verified upload remains discoverable.
- For rebuildable candidates, add a separate review showing the recognized generator, affected root, size, and reason. Revalidate candidates and refuse active/shared/changed roots. Delete only specifically confirmed recognized data; never expand a cache rule into all screenshots, logs, videos, or source copies.
- Restored files receive a 7-day grace period before automatic re-archiving to avoid upload/restore churn. Remote archives are retained until explicit future retention support; do not create provider lifecycle rules that may destroy the only surviving copy.

### 2F. Audit, backups, and compatibility

- Persist job events before irreversible steps and after their outcomes. Record actor, IDs, byte counts, and safe reason codes; do not log access keys, tokens, full SDK request headers, file contents, or secret-bearing URLs. Durable operation events are required for deletion; the existing fire-and-forget decision log alone is insufficient.
- Mirror human-readable summaries through `appendAdminAction` in `server/admin-activity.ts`. If adding a storage activity category, update its type, filters, UI, and tests together; the durable catalog remains the operation recovery source.
- Export an encrypted recovery manifest with archive/key/destination identities. Integrate archive catalog/path rewriting into workspace backup/restore, and include the archive decryption key only inside the existing encrypted backup's private payload. Omit S3 credentials and require reconnect after restore. Verify this explicitly because ordinary backups omit credential material.
- Add the archive database to consistent database snapshot handling (`SNAPSHOT_DATABASES` in `server/workspace-backup.ts`); do not copy a live SQLite file without its transactional state. Extend `server/workspace-backup-policy.ts` to exclude raw credential/key files and atomic-write siblings, with the decryption key carried only through the explicitly encrypted private recovery payload. Restored jobs/policies stay paused until destination and ownership are validated.
- Register the new private paths with sandbox, backup, sync/move, publishing, and protected-file rules. Prevent cloud sync from treating local eviction as an intentional deletion of the user's remote copies; archived evictions need explicit state. Revisit team-backup privacy filters before allowing any team deployment.
- Keep existing local files usable if cloud support is disabled or credentials expire. Older app releases cannot understand evicted files: document that downgrade requires restoring all local files first, and prevent silent deletion of archive metadata.
- Provider matrix: MinIO integration tests plus opt-in, disposable-bucket checks for AWS S3, R2, and Backblaze. State which providers were actually exercised; never label all four verified from mocked tests.

### Phase 2 review gate

- A failed upload, failed read-back, changed file, expired preview, busy thread, or audit/journal failure leaves local data intact.
- Confirmation is required for each reviewed cleanup batch, including batches proposed automatically.
- Interrupted jobs reconcile safely; retry does not duplicate removal, corrupt an archive, or overwrite a new local file.
- Historic chat links and new turns restore authorized archived content while preserving roots and file-size limits.
- Connection changes/disconnect do not strand existing archives; recovery with exported metadata/key is demonstrated.
- Review phase 2 changes and full regression evidence in the same PR before merge.

## Final verification — Prove the whole PR

**How this serves the primary goal:** demonstrate actual space reclamation and recovery, including the failures most likely to lose a person's work.

| Area | Required scenarios |
| --- | --- |
| Accounting | Exclusive, nested, shared, hard-linked, hidden, unassigned, missing, denied, changing, huge roots; limits and cache refresh. |
| Disk UI | Threshold boundaries, multiple disks, unknown statistics, visible/hidden app, server switching, accessible mobile report. |
| Authorization | Owner versus guest/client/service; spoofed IDs; traversal/encoded paths; symlink/root swaps; unrelated message links. |
| Connection | Bad endpoint, denied upload/get/delete, expired credentials, TLS/redirect rejection, path-style MinIO, R2 region. |
| Integrity | Empty/small/multipart/large files, changed source during transfer, corrupted/truncated object, wrong encryption key/tag, false ETag. |
| Cleanup | Upload-only retains files, missing confirmation, stale preview, changed inode/content, busy admission race, failure at each journal/quarantine boundary. |
| Restore | One file/all files, old chat links, ranges/previews, offline bucket, low disk, edited destination, simultaneous clicks, interrupted restore, turn hydration. |
| Scheduling | Disabled default, old/closed eligibility, missed intervals, pause/cancel, busy/uncertain threads, restored-file grace, no automatic deletion. |
| Recovery | Restart at each persisted state; encrypted backup/recovery export on a fresh fixture; reconnect; destination changes; key preservation. |
| Regressions | Existing attachment accounting/clear, thread archival, folder continuity, cloud sync, workspace/team backups, secret exclusion. |

Implementation verification order:

1. Run focused unit/HTTP/UI tests for each phase, including assertable filesystem snapshots proving phase 1 never mutates files.
2. Follow `docs/verification/README.md`: launch `node --experimental-strip-types scripts/control-omb.ts launch` directly, use only its printed URL, and keep all files/engines/credentials synthetic.
3. Add a mapped storage verification recipe for report -> encrypted upload -> read-back verification -> reviewed cleanup -> chat-link hydration -> whole-thread restore. Use a disposable local MinIO bucket, never the person's live data or bucket.
4. Run relevant existing regression tests, `pnpm typecheck`, `pnpm lint`, and `pnpm i18n:check`. Check desktop bundling/server packaging after adding the AWS SDK so tests passing in Node do not hide a packaged dependency failure.
5. Manually verify macOS APFS disk statistics, permissions, sleep/wake scheduling, and packaged restore flows. Record Windows/Linux checks actually run. Logical file totals are estimates of storage pressure, not promises about compression, sparse files, or APFS clone reclamation.
6. Put measured outcomes, screenshots, test commands, provider results, and remaining limitations into the single PR. Do not claim runtime or macOS verification from this documentation work.

## Review defaults and remaining limits

The concrete defaults above are proposed for implementation review, not settings already saved: 60-second cache/poll, 200,000-entry/30-second scan bound, 10-GiB-or-10% warning, 15-minute previews, daily opt-in scheduling, 7/30-day eligibility, and 7-day restore grace.

Reporting includes custom folders; destructive handling of shared/external-writer folders is deliberately restricted. No filesystem watcher, virtual filesystem mount, multi-bucket routing, provider lifecycle manager, or cross-install content deduplication is needed for this issue. Remote retention/deletion is deferred; local cleanup, verified archives, automatic policy proposals, restore, secret protection, and audits remain required for this PR.

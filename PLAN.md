# Issue #5634: storage reporting first, full archiving next

Issue: https://github.com/milind-soni/OpenMausBot/issues/5634

Detailed engineering steps, source references, API contracts, storage defaults, recovery behavior, and verification matrix: [implementation.md](implementation.md).

## Summary and handoff

Deliver both phases on `fix/issue-5634` in a single PR. The phases are sequential review checkpoints, not separate branches, PRs, or releases. Phase 1 covers per-bot/thread storage usage, low-disk warnings, and informational cleanup candidates for app-managed and configured custom working folders, with no deletion. Phase 2 adds the full cloud archiving feature to the same branch and PR. The overall issue is complete only after both phases are implemented and verified.

Worktree: `D:\VS\OS\OpenMausBot-5634`.
Branch: `fix/issue-5634`, created from fetched `origin/main` at `2d74ba9616270b4a1df1ebfa4a912b55bd5cb4ea`.

Current state: worktree created and plan saved; implementation has not started. Work only in this worktree. Read `AGENTS.md` and `docs/verification/README.md` before implementation. Do not commit or push unless asked; never add AI co-author attribution. The new branch initially tracks `origin/main`; when authorized to push, use `git push -u origin HEAD`, never push to main.

## Research findings

- Settings -> Data already has attachment-storage controls and advanced thread log-retention settings. Extend the Storage section using existing Settings components.
- Managed files live under `workspaces/<bot>` and `task-workspaces/<bot>/<thread>`; bots and threads can also configure custom working folders. Follow existing working-folder semantics, including explicit null versus inherited folders.
- The cloud-move file scanner excludes dependencies and other files and computes content hashes. Do not reuse it unchanged for storage accounting: reporting must include these files and should inspect metadata only.
- Existing disk-space checks use Node filesystem statistics. Company backups transfer encrypted whole-workspace archives; they do not provide per-file S3 archiving with transparent restoration.
- The code graph was stale during research. Revalidate relationships against the implementation baseline rather than relying on it.

## Phase 1 — Reporting and warnings

- Add a Storage report under Settings -> Data, beside existing attachment-storage controls. Show totals, bots expandable into threads, shared folders, scan time, and incomplete/unavailable results. Sort largest usage first.
- Measure managed bot/conversation folders plus configured custom folders using existing working-folder semantics. Attribute bot-wide files separately from thread files. Count overlapping folders and hard-linked files once in the overall total; show shared usage separately rather than charging it fully to each bot.
- Scan file metadata asynchronously without reading file contents or following directory links. Include dependencies, builds, screenshots, videos, logs, and hidden files in totals. Report inaccessible paths and bounded scans as partial results, never as zero usage.
- Identify conservative cleanup candidates: dependency caches with matching project manifests, recognized tool caches, and generated build folders confirmed by project configuration. Show location, size, and why they may be rebuildable. Do not classify screenshots, videos, source code, arbitrary logs, or folders by name alone as safe to delete.
- Add authenticated, owner/admin-only `GET /api/storage/usage` and `GET /api/storage/disk` endpoints, with shared response types. Accept no arbitrary filesystem paths from clients. Keep scans single-flight, cache completed results for 60 seconds, and provide a Refresh action.
- Check free space on each distinct volume containing a measured root. Warn when available space falls below 10 GiB or 10%. Display the warning in the report and an existing app notification/banner surface; poll disk metadata every 60 seconds while the app is active without rescanning folders.
- Reuse Settings components, byte formatting, authorization, and localization conventions. Preserve existing attachment clear and log-retention behavior.
- Keep phase 1 read-only: no uploads, restores, deletions, archive manifests, cloud credentials, or automatic cleanup. Present this checkpoint for review before building phase 2 on the same branch.

## Phase 2 — Full cloud archiving

After the phase 1 review checkpoint, implement the complete archiving workflow on the same branch and in the same PR:

- Connect AWS S3 or compatible storage (Cloudflare R2, Backblaze, MinIO) through bucket, endpoint, region, and securely stored credentials.
- Support manual archiving and opt-in automatic policies for old or finished threads. Preview eligibility and require confirmation before removing verified local copies.
- Persist an archive manifest and operation journal. Verify uploaded content, recheck local files for changes before removal, and recover safely from interrupted operations.
- Preserve chat links through authorized retrieval, offer one-click restore, check available space, and preserve conflicting local edits.
- Protect secrets, exclude credential/configuration material by default, record moves and failures without credentials, and provide reviewed cleanup of confirmed rebuildable files.
- Validate provider compatibility and failure recovery before enabling automatic cleanup. Reuse phase 1's ownership and folder reporting; do not add speculative archive infrastructure to phase 1.
- Follow the detailed provider, encryption/key recovery, confirmation, journal, and automatic-policy contracts in `implementation.md`; review those defaults before implementing destructive operations.

## Validation and acceptance

- Test managed/custom roots, shared and nested folders, hard links, symlinks, missing folders, permission failures, changing files, and bounded scans.
- Test disk-warning thresholds, multiple volumes, unavailable disk statistics, caching, refresh, and unauthorized access.
- Test report expansion, sorting, partial/error states, shared attribution, candidate explanations, and warning presentation.
- Verify against an isolated fixture following repository verification instructions; run relevant unit/UI checks, typechecking, lint, and localization checks.
- Phase 1 passes when usage is attributable without double counting, limitations are visible, warnings work, and reporting performs no file mutations.
- Phase 2 passes when verified archiving, confirmed local cleanup, automatic policies, working chat links, restore, secret protection, and audit logging are verified, including upload/download failures, interrupted operations, changed source files, and restore conflicts. Merge the single PR only after both phases pass.

## Limits

Phase 1 identifies disk pressure but does not reclaim space. Reported sizes are estimates during active writes; macOS filesystem compression and clones can make physical disk usage differ. Runtime and macOS verification have not been performed during planning.

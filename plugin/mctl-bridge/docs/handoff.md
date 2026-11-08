# Slot handoff export

`src/handoff.ts` is the slot's side of the publish handoff (#127). It turns a finished local
branch into the two files `mctl-publish publish` reads, `<task_id>.bundle` and
`<task_id>.manifest.json`, inside a handoff directory the slot was explicitly given.

It is a library with a small command line. It does not publish, and it makes no network or
socket call, uses no Valkey or GitHub credential and never calls `report_result`. The caller
passes the identity it was admitted under (`task_id`, `attempt_id`) and reports the result
itself. What the exporter returns describes files; it is not evidence of anything. The
publisher independently checks the audit trail and admission, the remote base, the allowed
scope, the hash, the bundle and its own ledger.

This change is code only. Creating the per-slot handoff directories, verifying that one slot
cannot read or write another's, and installing the exporter on the slots are a separate
operator stage; until then the lead's interim bundles stay in effect.

## Use

```ts
import { exportHandoff } from "./handoff.ts";

const r = await exportHandoff({
  repoPath: "/path/to/the/slot/checkout",   // top level of the work tree
  handoffRoot: "/path/to/own/handoff",      // must already exist
  taskId, attemptId,                        // as admitted
  repo: "mctlhq/example",
  baseSha, headSha, branch,
});
// r: { ok, idempotent, task_id, attempt_id, repo, base_sha, head_sha, branch,
//      bundle_path, manifest_path, sha256, bundle_bytes, changed_files }
```

```
bun src/handoff.ts export --repo-path P --handoff-root D --task-id T --attempt-id A \
    --repo OWNER/NAME --base-sha SHA --head-sha SHA --branch B
```

The command prints the result as one JSON line. Exit status: 0 exported, 1 usage, 3 refused
(`{"ok":false,"code":...}`), 2 the source could not be read.

## What is checked before anything is written

- Identifiers use the publisher's rules: task and attempt `[A-Za-z0-9._-]{1,100}`, full lower-case
  SHAs, the publisher's branch rules, `owner/name` for the repo. `repoPath` and `handoffRoot`
  must be absolute.
- The branch points at `head_sha`, the checked-out commit is `head_sha`, and the work tree and
  index are clean (untracked files count). `base_sha` exists and is an ancestor of `head_sha`;
  every object in `base..head` is readable; there is no merge commit.
- `changed_files` is taken from `git diff` between the two commits, never from the caller. Every
  commit in the range is checked, not only the final diff: a path with a control character, a
  `.` / `..` / `.git` component or a backslash, anything under `.github/workflows/` or
  `.github/actions/` (any letter case), and any mode other than a regular file (symbolic links,
  submodules) are refused. A range whose final diff is empty is refused.
- Git runs with argument arrays, hooks, credential helpers and the repository's fsmonitor
  switched off, no user or system configuration, and no optional locks. Nothing contacts a
  remote. The work tree, index and refs are left as they were.
- The handoff root must be an existing real directory owned by the user, not writable by group
  or others, with no symbolic link above it that a user planted. It is never created or
  chmod-ed.

## Output protocol

The manifest is the commit marker. A bundle without a manifest is not an export.

1. Reserve the task with an exclusive `<task_id>.export.lock`. A second exporter for the same
   task is refused (`busy`) and never removes the first one's reservation.
2. Look at what is already there. A complete export identical in every field (task, attempt,
   repo, base, head, branch, changed files) whose bundle still matches the manifest's SHA-256 and
   verifies is an idempotent success and writes nothing. Anything else already there is refused
   and left untouched: a different attempt or head (`output_conflict`), a bundle with no
   manifest (`output_partial`), a symbolic link, directory or other non-regular file
   (`output_unsafe`).
3. Write the bundle to `.<task_id>.bundle.<random>.tmp`, created exclusively and without following
   links, streaming `git bundle create` into it and stopping git at the size cap; flush it, hash
   it, check that it carries `head_sha` and requires exactly `base_sha`.
4. Link it to `<task_id>.bundle` (a hard link, which fails rather than overwrite), remove the
   temporary name, flush the directory.
5. Write `.<task_id>.manifest.json.<random>.tmp` (the eight fields `parseManifest` requires, checked
   with the publisher's own reader), flush it, check once more that the bundle in place is the file
   that was hashed, link it to `<task_id>.manifest.json`, flush the directory.
6. Release the reservation, only if it is still this call's.

The two links are not one atomic step. A kill between them leaves a bundle, no manifest and the
reservation, which the publisher sees as not ready and which every later export of the task
refuses (`busy`). An operator who has looked removes the leftovers. Nothing is stolen or
overwritten automatically.

On a refusal the call removes only the temporary files it created, and the bundle it linked if no
manifest followed. It never removes a file it did not make.

## Limits

Bundle 256 MiB, manifest 256 KiB: the publisher's own limits. Callers may pass lower ones (for
tests) and cannot raise them. The bundle is cut off at the cap while it is written, so an oversized
branch is refused without filling the disk.

Output files are created mode 0644; access is governed by the handoff directory.

## Known limits of this stage

- A stale reservation from a crashed exporter is never taken over; it needs an operator.
- The size cap applies to the finished bundle, not to the repository.
- Which directory a slot may use, and who may read it, is host configuration and is not
  decided here.

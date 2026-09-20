---
name: backlog
description: Use when creating, viewing, updating, or prioritizing work items for this repo. Overrides the global backlog skill — this project tracks work as GitHub Issues on cory-johannsen/foundry-deck-of-many-things instead of a local docs/backlog.md file, with the same backlog → spec → planned → in-progress → done lifecycle expressed as labels.
---

# Backlog (GitHub Issues)

This project stopped using a local `docs/backlog.md` for open work (migrated 2026-09-20 — see that file's `## Active` section for the pointer, and its `## Done` section for the pre-migration historical archive). Every open work item is now a GitHub Issue on `cory-johannsen/foundry-deck-of-many-things`, tracked and prioritized via `gh issue`. This file is project-scoped (`.claude/skills/backlog/`) and takes precedence over the user's global `backlog` skill whenever you're working in this repo.

**Do not add new items to `docs/backlog.md`.** That file is a closed historical record for anything finished before the migration; nothing new goes in it.

## Item shape

A work item is one GitHub Issue:

- **Title:** a short, descriptive title. Don't mint a new `ITEM-N` number — GitHub's own issue number is the identifier now. (Issues #93–#97 carry `ITEM-N:` title prefixes because they were migrated from the old numbering; that's a one-time transitional artifact, not a convention to continue.)
- **Labels — state:** exactly one of `state:backlog` | `state:spec` | `state:planned` | `state:in-progress`. An issue with none of these is assumed `state:backlog`. Closing the issue *is* the `done` state — there is no `state:done` label.
- **Labels — blocked:** add `blocked` when an item cannot proceed regardless of state; remove it once unblocked. Always accompany with a comment stating why (see Operations).
- **Labels — kind:** `enhancement` or `bug`, same as any other issue in this repo — pick whichever fits, same judgment call as filing any GitHub issue.
- **Body sections**, same shape the old backlog.md items used:
  ```markdown
  ## Summary
  One or two sentences.

  ## Spec
  {Full specification — required before moving to state:spec}

  ## Plan
  {Step-by-step implementation plan — required before moving to state:planned}
  ```
- **Dependencies:** no special field — write `Depends on #N` / `Required by #N` as plain lines in the body (or a comment). GitHub auto-links `#N` mentions and surfaces them in both issues' timelines, which is the dependency graph now; there's nothing separate to keep in sync.

## State definitions and transition rules

Identical lifecycle to before, just expressed as a label swap instead of editing a `**State:**` line:

| State | Meaning | Transition condition |
|-------|---------|---------------------|
| `state:backlog` | New item, not yet specified | → `state:spec` when the `## Spec` section is fully written |
| `state:spec` | Full spec exists, no plan yet | → `state:planned` when the `## Plan` section is fully written |
| `state:planned` | Plan exists, work not started | → `state:in-progress` when work actively begins |
| `state:in-progress` | Actively under development | → closed when work is complete and verified |
| *(closed)* | Finished | Terminal state — no label needed |

Never skip a state label — going straight from `state:backlog` to `state:in-progress` isn't allowed just because it's now a one-line label swap instead of a bigger file edit.

## Priority

There's no single sorted file to read anymore, so priority is computed on demand rather than maintained. Same algorithm as before, applied to a live query:

```bash
gh issue list --state open --json number,title,labels,body,createdAt
```

1. Build the dependency graph from each open issue's `Depends on #N` / `Required by #N` mentions in its body.
2. Items with more open dependents (things waiting on them) rank higher.
3. Topological sort — items with no unresolved open dependencies rank above those that still have some.
4. Within the same tier, `state:in-progress` > `state:planned` > `state:spec` > `state:backlog`.
5. `blocked` items sink below their tier peers.

## Operations

**Add item:**
```bash
gh issue create --title "<short descriptive title>" \
  --label "state:backlog" --label "enhancement" \
  --body "## Summary
<one or two sentences>"
```
No ID to assign — `gh issue create` prints the new issue's number and URL. If this item depends on or is required by an existing issue, mention `#N` in the body of both.

**Update state:** swap the label, and add whichever body section the new state requires:
```bash
gh issue edit N --remove-label "state:backlog" --add-label "state:spec"
```
Editing the body to add/extend `## Spec` or `## Plan` is a separate step from swapping the label — do both together, don't leave a `state:spec` issue with no `## Spec` section (or vice versa). Use `gh issue edit N --body-file <path>` for anything beyond a trivial body change (multi-line bodies are painful to get right as an inline `--body` string).

**Reprioritize:** nothing to write back — re-run the priority query above whenever you need current order. There's no `_Last updated_` timestamp to maintain.

**Mark blocked:**
```bash
gh issue edit N --add-label "blocked"
gh issue comment N --body "Blocked: <reason>"
```
Clear the label and add a follow-up comment once unblocked.

**Mark done:**
```bash
gh issue comment N --body "<verification summary — tests run, what was confirmed, anything deferred>"
gh issue close N
```
Post the verification summary as a comment before closing so it's part of the issue's permanent record, matching how the old backlog.md's `#### Plan` entries always ended with a `**Verification.**` paragraph.

**Viewing an item:**
```bash
gh issue view N
```

## Common mistakes

- **Skipping states:** `state:backlog` → `state:in-progress` with no `## Spec`/`## Plan` ever written. Still never allowed just because a label swap is easy.
- **Label/body drift:** changing the state label without updating the body section it implies (or vice versa) — the two are no longer physically the same edit the way they were in one Markdown block, so keep them deliberately in sync.
- **Forgetting the reciprocal `#N` mention:** when a new issue depends on an existing one, mention it in both issues' bodies (or at least a comment on the older one), not just the new one.
- **Minting a new `ITEM-N`:** the old numbering is retired; use the GitHub issue number GitHub already assigned.
- **Adding new work to `docs/backlog.md`:** that file is closed history now — new items are issues, full stop.

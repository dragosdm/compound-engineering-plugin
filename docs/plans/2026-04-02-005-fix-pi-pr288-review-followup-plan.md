---
title: "fix: Address PR #288 Pi review follow-up findings"
type: fix
status: completed
date: 2026-04-02
pr: https://github.com/EveryInc/compound-engineering-plugin/pull/288
sources:
  - https://github.com/EveryInc/compound-engineering-plugin/pull/288#pullrequestreview-4051612811
  - docs/plans/2026-04-02-004-fix-pi-review-bug-batch-plan.md
  - docs/plans/2026-04-01-003-fix-pi-capability-convergence-followups-plan.md
  - docs/plans/2026-04-01-002-fix-pi-transactional-parity-followups-plan.md
  - src/sync/pi.ts
  - src/utils/pi-skills.ts
  - tests/sync-pi.test.ts
  - tests/pi-writer.test.ts
---

# fix: Address PR #288 Pi review follow-up findings

## Overview

Address the two validated Codex review findings on PR #288: one correctness bug in Pi sync convergence and one filesystem regression in Pi skill materialization. The first fix must ensure same-run prompt and skill dependencies stabilize together before managed state is derived. The second fix must preserve executable file modes when Pi materialization copies bundled files.

## Problem Frame

The current Pi sync loop can incorrectly demote or publish artifacts because same-run stabilization is evaluated separately for prompt results and skill results even when they depend on each other. That breaks the intended published-only contract for managed artifacts, alias maps, and rerun narrowing. Separately, Pi materialization currently rewrites copied files with the atomic writer's default mode, which can strip executable bits from bundled scripts used by installed or synced skills.

## Requirements Trace

- R1. Pi sync must evaluate same-run prompt and skill publication status as a combined dependency graph so valid cross-type dependencies are not incorrectly demoted.
- R2. Managed Pi sync state must continue to reflect only artifacts that are truly published after stabilization, including rerun narrowing and stale cleanup behavior.
- R3. Pi materialization must preserve source file modes for copied files so executable bundled scripts remain executable after sync/install.
- R4. The fixes must follow existing Pi sync/materialization patterns and extend the current regression suite rather than introducing new persistence models or side-channel state.

## Scope Boundaries

- No changes to persisted alias semantics beyond what is required for correct same-run stabilization.
- No redesign of Pi sync status types, retry policy categories, or broader trust-boundary handling.
- No broader file metadata work beyond preserving source mode for copied materialized files.
- No implementation of unrelated review items from older PR #288 feedback plans.

## Context & Research

### Relevant Code and Patterns

- `src/sync/pi.ts` owns the sync pass loop, retry narrowing, published artifact aggregation, warning accumulation, and `stabilizeSameRunQualifiedDependencies()`.
- `src/sync/commands.ts` and `src/sync/pi-skills.ts` already attach `sameRunDependencies` to published prompt/skill results.
- `src/utils/pi-skills.ts` is the shared Pi materialization seam used by both sync and writer flows via `copySkillDirForPi()` and `copyDirForPiMaterialization()`.
- `src/utils/files.ts` already treats file modes as part of the atomic-write/snapshot contract via explicit `mode` handling and snapshot restore logic.
- `tests/sync-pi.test.ts` already contains contract-style coverage for same-run qualified refs, retry narrowing, published-only name maps, and sync cleanup behavior.
- `tests/pi-writer.test.ts` already covers shared Pi materialization and writer-side artifact lifecycle behavior.
- `tests/files.test.ts` is the local precedent for asserting permission preservation as part of file-helper correctness.

### Institutional Learnings

- `docs/plans/2026-04-02-004-fix-pi-review-bug-batch-plan.md`: same-run resolvability should stay separate from persisted alias maps; final state should be derived only from artifacts that actually publish.
- `docs/plans/2026-04-01-003-fix-pi-capability-convergence-followups-plan.md`: retry and publication state should converge deterministically across prompts and skills together.
- `docs/plans/2026-03-20-003-fix-pi-symlink-boundary-and-materialization-safety-plan.md`: Pi materialization should remain a shared helper contract rather than diverging by caller.
- `docs/plans/2026-04-01-002-fix-pi-transactional-parity-followups-plan.md`: filesystem permissions are part of correctness, not incidental metadata.
- `docs/solutions/codex-skill-prompt-entrypoints.md`: preserve canonical internal identities and generate target-safe entrypoints/output aliases as a separate layer.

### External References

- None. Local patterns and existing Pi-specific plans were sufficient for this follow-up.

## Key Technical Decisions

- Keep same-run stabilization in the sync convergence layer rather than widening persisted `nameMaps`.
  Rationale: the bug is about how current-run prompt/skill results are interpreted together, not about missing long-lived aliases. Persisted aliases should continue to represent only final published artifacts.
- Treat prompt and skill results as one publication set when evaluating same-run dependencies.
  Rationale: prompt-to-skill and skill-to-prompt references are cross-type by definition, so per-type stabilization cannot determine whether a dependency is published in the same pass.
- Preserve source mode at the shared Pi materialization seam instead of patching sync and writer callers independently.
  Rationale: both sync and writer flows already rely on `copySkillDirForPi()` and should continue to share one contract for copied file behavior.
- Extend existing regression suites in `tests/sync-pi.test.ts` and `tests/pi-writer.test.ts` rather than adding a new test harness.
  Rationale: the failure modes are already represented in those suites' lifecycle and convergence assertions.

## Open Questions

### Resolved During Planning

- Should this be a new plan or an update to older PR #288 follow-up plans?
  Resolution: new plan. These are newly validated review findings against the current PR state and should be tracked separately from older feedback rounds.
- Should the fix persist more same-run aliases to make cross-type stabilization succeed?
  Resolution: no. The plan keeps same-run stabilization logic separate from persisted alias maps and continues to derive final managed state only from published artifacts.
- Should file-mode preservation be fixed separately for sync and writer codepaths?
  Resolution: no. The shared materialization helper should own copied-file mode preservation so both codepaths stay in parity.

### Deferred to Implementation

- Whether the cleanest implementation is a combined stabilization helper that accepts both result sets or a precomputed combined published-dependency view.
  Why deferred: this is a code-shape choice that depends on the current implementation details once editing starts, but it should not change the planned behavior.
- Whether mode-only changes require a helper-level no-op detection adjustment in addition to passing explicit modes into writes.
  Why deferred: the desired behavior is clear, but the narrowest code change depends on how the existing materialization fast paths behave under tests.

## Implementation Units

- [x] **Unit 1: Fix cross-type same-run stabilization in Pi sync**

**Goal:** Ensure prompt and skill results stabilize against a combined same-run publication view so cross-type dependencies converge correctly before published artifacts, alias maps, rerun narrowing, and cleanup are derived.

**Requirements:** R1, R2, R4

**Dependencies:** None

**Files:**
- Modify: `src/sync/pi.ts`
- Verify/adjust if needed: `src/sync/commands.ts`
- Verify/adjust if needed: `src/sync/pi-skills.ts`
- Verify/adjust if needed: `src/utils/pi-skills.ts`
- Test: `tests/sync-pi.test.ts`

**Approach:**
- Change stabilization planning so same-run dependency checks can see published prompts and published skills together for the current pass rather than inferring both sets from a single per-type `results` array.
- Preserve the existing status model (`published`, `retryable`, `blocked-by-policy`, `unsupported-final`) and continue deriving final managed state from the post-stabilization published subset only.
- Ensure rerun narrowing still retries only the artifacts that remain retryable after combined stabilization, not artifacts that were already proven published or permanently unsupported.
- Keep current-run dependency handling separate from persisted alias state so no dead aliases or transient publish outcomes leak into managed `nameMaps`.

**Execution note:** Start with characterization coverage for the current broken cross-type behavior before changing the convergence logic.

**Patterns to follow:**
- `src/sync/pi.ts` published-only derivation via `filterPublishedPromptMap()` and `filterPublishedSkillMap()`
- `tests/sync-pi.test.ts` existing same-run qualified sibling and retry narrowing coverage
- `docs/plans/2026-04-02-004-fix-pi-review-bug-batch-plan.md` for the distinction between same-run resolvability and persisted aliases

**Test scenarios:**
- Happy path: prompt referencing a same-run skill remains published when the depended-on skill also publishes in the same pass, and both appear in final sync artifacts/name maps.
- Happy path: skill referencing a same-run prompt remains published when the depended-on prompt also publishes in the same pass.
- Error path: prompt depending on a same-run skill that becomes retryable or blocked is also demoted to `retryable` for that pass and omitted from final managed state.
- Error path: skill depending on a same-run prompt that becomes retryable or blocked is also demoted to `retryable` for that pass and omitted from final managed state.
- Integration: mixed dependency chain `prompt A -> skill B -> prompt C` where `prompt C` fails first pass causes `A` and `B` to demote together, then retries only the narrowed mixed set on the next pass.
- Integration: an artifact written earlier in the pass but later demoted during stabilization is removed from final on-disk outputs and not retained in cleanup inputs or `currentRunArtifacts`.
- Integration: narrow rerun mode produces the same final published prompt/skill state as full rerun mode for a mixed prompt+skill dependency case.

**Verification:**
- Cross-type same-run cases in `tests/sync-pi.test.ts` fail before the fix and pass afterward.
- Final sync state includes only artifacts that remain published after combined stabilization.
- Retry narrowing still converges deterministically without broadening the rerun set back to already-published artifacts.

- [x] **Unit 2: Preserve executable file modes during Pi materialization**

**Goal:** Preserve source file modes for copied Pi materialization outputs so executable bundled scripts remain executable across sync, writer, incremental updates, and rollback-sensitive paths.

**Requirements:** R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/utils/pi-skills.ts`
- Modify if needed: `src/utils/files.ts`
- Test: `tests/sync-pi.test.ts`
- Test: `tests/pi-writer.test.ts`
- Test: `tests/files.test.ts`

**Approach:**
- Update the shared copied-file materialization path so source mode is captured and reapplied whenever a file is copied into a materialized Pi skill tree.
- Preserve parity between initial replacement materialization and incremental updates so executable files do not lose their mode on first publish or later syncs.
- Confirm the chosen change still works with the repo’s atomic-write and rollback expectations instead of introducing a Pi-only permission path.
- Limit the scope to copied files; do not broaden the change into a general metadata sync system.
- This unit can land independently from Unit 1 even though Unit 1 remains the recommended first change because it affects the broader sync convergence contract.

**Execution note:** Add regression coverage first for executable copied assets in both sync and writer paths, then tighten the helper behavior only as much as those tests require.

**Patterns to follow:**
- `src/utils/files.ts` existing explicit `mode` support and snapshot restore logic
- `tests/files.test.ts` permission preservation assertions using `stat.mode & 0o777`
- `tests/pi-writer.test.ts` shared materialization lifecycle coverage

**Test scenarios:**
- Happy path: first Pi sync materialization preserves `0755` on an executable copied script under a skill directory.
- Happy path: writer/install materialization preserves `0755` on the same kind of copied executable asset.
- Edge case: incremental resync after changing an executable file’s contents keeps the executable bit intact.
- Edge case: mode-only source change (`0644 -> 0755` or `0755 -> 0644`) is reflected in the materialized target even when file bytes are unchanged.
- Integration: no-op rerun leaves copied executable files in place without stripping their mode.
- Integration: rollback-sensitive materialization path restores prior mode as well as prior content when a write path fails after mutation begins.

**Verification:**
- Sync and writer regression tests assert executable copied files retain `stat.mode & 0o777` across initial publish and reruns.
- The shared helper remains the single owner of copied-file materialization behavior for both sync and writer paths.
- Existing Pi materialization and file-helper tests continue to pass without introducing broader permission churn.

## System-Wide Impact

- **Interaction graph:** Unit 1 affects the full Pi sync convergence pipeline: per-pass prompt/skill results, retry narrowing, warning accumulation, managed artifacts, and sync `nameMaps`. Unit 2 affects the shared Pi materialization helper used by both `syncPiSkills()` and `writePiBundle()`.
- **Error propagation:** Unit 1 must preserve current classification of unsupported and blocked artifacts while only changing how cross-type published/retryable outcomes are stabilized. Unit 2 must preserve existing atomic-write failure and rollback behavior.
- **State lifecycle risks:** Unit 1 touches transiently written artifacts that may later be demoted in the same run; stale cleanup and final state derivation must stay aligned. Unit 2 touches copied-file metadata and must not cause repeated churn or false no-op detection.
- **API surface parity:** Both sync and writer Pi paths must keep consistent materialization semantics. Same-run dependency behavior must stay consistent across prompt and skill publication rather than favoring one artifact type.
- **Integration coverage:** Unit tests alone are insufficient; the plan relies on end-to-end sync tests that assert final on-disk outputs, rerun narrowing, and managed-state contents together.
- **Unchanged invariants:** Persisted alias maps remain published-only. Pi status categories remain unchanged. Trust-boundary, symlink-safety, and legacy cleanup policies are out of scope for this fix.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Fixing cross-type stabilization accidentally broadens reruns or persists transient aliases | Keep the change in the convergence layer, preserve existing status categories, and verify final `nameMaps`/artifacts are derived only from post-stabilization published subsets |
| Mode preservation fix causes no-op churn or misses incremental updates | Add explicit mode assertions for first publish, incremental content changes, and mode-only changes before settling on the narrowest helper change |
| Shared helper changes drift sync and writer behavior apart | Keep the file-mode fix at the shared materialization seam and verify both sync and writer regression suites |

## Documentation / Operational Notes

- No additional operational monitoring is required; this is a local correctness fix in conversion/sync behavior.
- After implementation, respond to the PR review threads with the concrete behavior change and the regression coverage added for each finding.

## Sources & References

- PR review: https://github.com/EveryInc/compound-engineering-plugin/pull/288#pullrequestreview-4051612811
- Related plan: `docs/plans/2026-04-02-004-fix-pi-review-bug-batch-plan.md`
- Related plan: `docs/plans/2026-04-01-003-fix-pi-capability-convergence-followups-plan.md`
- Related plan: `docs/plans/2026-04-01-002-fix-pi-transactional-parity-followups-plan.md`
- Related code: `src/sync/pi.ts`
- Related code: `src/utils/pi-skills.ts`
- Related tests: `tests/sync-pi.test.ts`
- Related tests: `tests/pi-writer.test.ts`

# Plan & Goals reference

`/goal IDEA` discusses a regular goal. `/sisyphus IDEA` discusses an ordered goal. The model proposes tasks and completion checks; review them in **Session tools > Plan & goals**, choose whether to use the auditor, then confirm. Work waits for that confirmation.

## Modes

Regular goals can add tasks and subtasks as work develops. Reviewed criteria and completed evidence remain intact. Ordered goals follow one acceptance checkpoint at a time. Native DSH questions and continuation remain in use.

## Commands

- `/goal-direct OBJECTIVE`: start without drafting.
- `/sisyphus-direct Goal :: Step | check; Step | check`: start a complete ordered plan.
- `/goal-list`, `/goal-status`: inspect saved work.
- `/goal-focus ID`, `/goal-unfocus`: switch focus or leave work open.
- `/goal-pause`, `/goal-resume`: control continuation.
- `/goal-tweak CHANGE`: amend the same goal. Retain completed evidence and stable IDs for retained unfinished work.
- `/goal-replace IDEA`: review a fresh goal. The source stays paused until confirmation, then is archived with its evidence intact.
- `/goal-replace regular :: IDEA` or `sisyphus :: IDEA`: choose the replacement type explicitly.
- `/goal-cancel`: discard the draft, preserving the paused goal when revising.
- `/goal-clear confirm`: archive; `/goal-prune ID confirm`: remove archived metadata.

## Audits and completion

Configure the independent auditor, task depth, history and review limits in Plugins. The auditor must use a different model. Missing evidence, failed review or changed inputs keep the goal open. `finish_goal` performs the required checks; task completion text alone is an attestation. Evidence Assurance applies when present.

## Persistence and continuation

Goals and drafts use private SQLite snapshots outside the workspace. They survive reload and native compaction. Native forks inherit state at their source cut. Goal history belongs to its conversation; use a native fork to continue it elsewhere. Native DSH's total round budget stays authoritative.

## Guided creation and task tools

Guided `/goal` and `/sisyphus` creation requires a native question with one recommended option, alternatives and custom input before a concise proposal. Human confirmation starts execution. `update_goal_task` explains blocking or requests evidenced deferral; `report_goal_progress` updates the compact chat report also supplied to the model. Only a human can approve exceptions or change chat completion rules. Strict mode requires every task; reviewed-exception mode still requires goal criteria and independent evidence.

Chat goal settings select an independent registered audit model and reasoning effort. Audits can run after every task or at goal completion, or be disabled. The auditor sees a bounded packet of criteria, task evidence and human clarifications, without the chat transcript. Failed reviews reopen named tasks and their ancestors and append actionable model-visible feedback. Ordered rework uses a reviewed revision of the remaining plan.

## Automatic compaction

`compactAfterTask` defaults to `true` and can be overridden in chat goal settings. After an accepted task completion, the active public compaction provider runs at the next idle boundary. Failed audits do not trigger it. Cancellation and errors leave task progress intact and report compaction failure.

## Chat presentation

The collapsible progress card follows the native composer’s width and side spacing. Planning and proposal review do not show task counts. Execution, pause, blocking, checkpoint review and completion retain the full task report, evidence and audit feedback. Cleared or archived goals leave no progress card. Generated planning requests use a separate plugin card; the original human message remains intact.

## Amendment and replacement

The review panel separates amendments from replacements, lists removed completion checks and changed tasks, and lets you inspect saved evidence. Cancelling an amendment restores the paused baseline; cancelling a replacement removes only its draft. Drafts block task mutation until confirmed. Changed unfinished checks invalidate their old attestations; goal audits are refreshed for the accepted scope.

Amendments retain the native goal identity and spent continuation rounds. Reaching the round limit leaves the accepted amendment paused; increase the total limit explicitly to resume. Replacements receive a new native goal and budget. Ordered amendments rebuild only the remaining checkpoints after the review is committed.

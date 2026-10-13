# Subagent compaction: transcript measurement for #176

Measured on 2026-10-13 against upstream `594287450ee37cd630f29ffbb4e6ba862f9259f4`, with `@earendil-works/pi-coding-agent` 1.0.2. This document describes the offline probe; production code is unchanged. [Issue #176](https://github.com/jonaslsaa/pi-optchat/issues/176) asks about both transcript access and task quality. **The subsequent [OpenAI subscription pilot](subagent-compaction-openai.md) adds three paired live runs with Sol/xhigh parents, Sol/high subagents and Terra/medium memory summaries.** Its synthetic quality results and limitations are separate from this plumbing measurement.

## Finding

Pi keeps the original messages in its append-only session entries. OptChat's live named zoom reads the compacted working context instead. Old tool calls and results therefore disappear from named zoom while the child is live, then reappear after the child finishes or the profile reloads. The compaction summary itself is also omitted by the run-transcript formatter.

There is a separate, pre-existing limitation: named zoom clips each tool call/result to 1,000 characters before pagination. Paging cannot recover the omitted middle, even from a finished run with intact session entries.

## Method and results

The [probe](../../test/subagent-compaction-probe.ts) launches a real `Children` instance and Pi SDK session. A synthetic provider schedules 120 sequential tool calls, each returning 9,000 characters with unique markers at the head and middle. It uses a 200,000-token window and OptChat's default 30% refresh setting: `reserveTokens = 108000`, hence a nominal compaction trigger of 92,000 tokens. Pi's default recent-context retention remains unchanged.

Pi performs its actual threshold checks, compaction preparation, context replacement, session persistence and reload. An extension supplies a canned summary; **the language-model summarizer is not exercised**. Provider usage is approximated by serialized context characters divided by four. A second arm disables compaction and returns a synthetic context-limit error at 200,000 estimated tokens. These counts describe the fixture, not real model capacity or task success.

At each checkpoint the probe consumes every page through the actual named-zoom tool. It also measures a candidate read path: the same tool and formatter fed the retained session messages instead of the live context. This candidate changes no production code. Raw results are in [subagent-compaction.json](subagent-compaction.json).

| Checkpoint, compaction enabled | Completed tool results | Current zoom: result heads | Retained-entry zoom: result heads | Current zoom: result middles |
| --- | ---: | ---: | ---: | ---: |
| Before first compaction | 39 | 39 | 39 | 0 |
| After first compaction | 39 | 8 | 39 | 0 |
| After second compaction | 70 | 8 | 70 | 0 |
| After third compaction | 101 | 8 | 101 | 0 |
| Live, just before completion | 120 | 27 | 120 | 0 |
| Finished | 120 | 120 | 120 | 0 |
| Reloaded | 120 | 120 | 120 | 0 |

At every checkpoint, raw session entries retain **all completed result heads and middles**. Tool-call counts visible through zoom equal the visible result-head counts in this fixture. The retained-entry candidate still loses every middle marker because it deliberately keeps the existing formatter.

Compaction also invalidates a previously issued pagination cursor: the first page offers offset 25,000, but after the first compaction that offset throws because the transcript has shrunk to 8,271 characters. The same happens at both later compactions.

With compaction disabled, the scripted run reaches its synthetic hard stop after 84 calls. All 84 result heads remain accessible live, finished and reloaded; zero middles are accessible through zoom. With compaction enabled, it makes all 120 calls and compacts three times. **This is a plumbing check, not evidence that either policy produces better answers.** The scripted provider advances regardless of what it remembers.

## Cause and scope of a possible fix

- [`Children.messages()`](../../src/agents.ts) uses `live.session.messages` while running; [`sessionMessages()`](../../src/runs.ts) reads retained message entries after completion. `Children.transcript()` currently delegates to those differing paths.
- [`runTranscript()`](../../src/transcript.ts) formats user/assistant/tool-result messages, ignores the SDK's compaction-summary message, and applies the 1,000-character head/tail cap.
- [`runPage()`](../../src/tools.ts) paginates the already-clipped string. Changing offsets cannot recover text discarded earlier.

[The original G4 commit, `57ce468`](https://github.com/recallmenot/pi-optchat/commit/57ce468e945884b810842ba49418af45ddc490b4), addressed more than the compaction read-path mismatch: it changed the shared live-message accessor, handled messages around SDK persistence events, included custom messages, removed per-step clipping, and changed page validation and tool documentation.

The measured evidence supports a smaller first change: make **live named zoom read retained message entries**, preserving its existing descendant-access checks. Keeping this in the named-zoom accessor would avoid changing the inspector's working-context display. A production patch still needs coverage for streaming tails and the SDK's message-end/persistence ordering so replies are not omitted or duplicated. This probe samples stable tool boundaries; it does not establish those event-time properties or behavior across session branches.

The clipping policy needs an explicit, separate decision. Retained entries alone fix the live/finished inconsistency, but do not make the advertised “whole chat” fully inspectable. Full retained text behind bounded paging, or a separate way to request an individual step whole, would address the measured missing middles. No new transcript storage is required for either issue.

**Recommendation:** retain the current compaction policy pending quality measurements, and propose the minimal retained-entry read-path fix. Do not build a summary tree or hybrid on the basis of this probe.

## Broader live comparison

The [OpenAI pilot](subagent-compaction-openai.md) implements paired runs, condition-independent grading and parent recovery on one synthetic audit family. It confirms the value of retained-message live zoom, and exposes Pi's summary-input clipping and repeated-read costs. It does not satisfy the broader workload requirement below: realistic coding tasks, additional task families and budget-sensitivity measurements remain follow-up work.

1. Freeze a substantial audit or coding task, its input files and an independent answer key before any runs. Require 100+ substantive tool calls, and size the evidence so a 200K context is actually crossed. Avoid a pure padding/recall task as the only quality workload. Record dataset hashes and the exact model ID, real context window, thinking settings, Pi version, tool limits and budget.
2. Run paired trials on identical inputs with only subagent compaction changed: default on versus off as before #170. Keep prompts, tools, memory view and output limits identical. Use at least three task/seed pairs and alternate execution order. Allow the off arm to reach its normal hard stop; preserve partial work. Record actual input/output/cache tokens, latency, cost, compaction events, completed calls and final artifacts. Verify that the on arm actually compacts and that the task requires 100+ calls; an early hard stop in the off arm is a measured outcome, not a reason to discard the trial.
3. Save outputs under randomized labels with the condition mapping withheld from graders. Grade final artifacts against the same task-completion rubric and executable checks; report correctness, omissions, unsupported claims and partial completion separately. Do not expose condition labels or compaction traces to the task-quality grader.
4. Measure parent recovery separately with a fixed set of verification questions about early and middle-run evidence: exact commands, arguments, result details and corrections. Give the parent only the child report and named zoom. Use the same parent model, prompt and retrieval budget. Score answers against the frozen evidence, not the child's final claims. Include checkpoints while the child remains live after compaction as well as after completion/reload; finished-only checks miss the reproduced bug.
5. Repeat the parent-recovery questions against a retained-entry candidate, with its text-clipping policy specified. Record missing-source failures separately from failures to retrieve available evidence. This distinguishes an access bug from a reasoning/compaction-quality problem.

Broader live comparisons are still needed for general answer-quality claims or a summary-tree/hybrid investment. Both this probe and the OpenAI pilot establish the narrower transcript-access defect.

## Reproduce and validation

```sh
node --import tsx --import ./test/support.ts test/subagent-compaction-probe.ts > /tmp/subagent-compaction.json
node node_modules/typescript/bin/tsc --noEmit
node --import tsx --import ./test/support.ts --test test/agents.test.ts test/agent-transcripts.test.ts
```

The probe uses isolated temporary profiles and a synthetic provider; it makes no live model calls. TypeScript checking passed, and the 29 existing agent/transcript tests passed. The probe asserts fixture integrity and reports observed visibility rather than treating the current bug as desired behavior.

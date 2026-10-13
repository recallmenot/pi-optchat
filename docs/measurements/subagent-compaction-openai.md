# Subagent compaction: OpenAI subscription pilot for #176

Run on 2026-10-13 against upstream `594287450ee37cd630f29ffbb4e6ba862f9259f4` using Pi SDK 1.0.2. **This is an OpenAI-based test**, authenticated through an existing OpenAI Pro subscription login in Pi (`openai` OAuth). It is not an Anthropic result or a comparison between providers. Production OptChat code is unchanged.

**Outcome:** the three paired runs support a minimal retained-message fix for live named zoom. Compaction allows more progress under the configured context budget, but only one of three compacting runs completes this audit within the fixed read budget. Pi's own tool-result truncation causes a separate evidence problem. Keep compaction for now, investigate that truncation and broader workloads, and do not infer a need for a summary tree from this pilot.

## Models and scope

| Role | Provider/model | Reasoning |
| --- | --- | --- |
| Parent/main agent verifying the child | `openai/gpt-6.1-sol` | `xhigh` |
| Subagent performing the audit | `openai/gpt-6.1-sol` | `high` |
| OptChat memory compactor | `openai/gpt-5.6-terra` | `medium` |
| Pi's built-in subagent compaction | `openai/gpt-6.1-sol` | `high` |

The last two roles are different mechanisms. Terra produces real OptChat memory summaries for the briefing and child reports. Pi's built-in compaction summarizes the child's working context using its own Sol/high model. This pilot does not compare memory-compactor models, exercise a full main-agent task with repeated OptChat view refreshes, or change that production behavior.

Model IDs and reasoning levels were checked against the installed runtime, successful subscription requests and the official [Sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and [Terra model page](https://developers.openai.com/api/docs/models/gpt-5.6-terra). Pi's installed catalog reports a **272,000-token context window**; the Sol page advertises a larger native window. Both arms use an explicit guard that stops before a normal request when Pi estimates more than 272,000 tokens. This is a controlled application-budget comparison, **not a measured OpenAI server context limit**, and differs from the issue's proposed 200K model experiment.

The on arm uses OptChat's unchanged 30% refresh policy: `reserveTokens = 158400`, a nominal trigger at 113,600 tokens. Pi's default recent-context retention remains unchanged. The off arm disables Pi compaction. Both use SSE, the same prompts/tools and a 16,384-token maximum response (including Pi summaries), with a 45-minute child deadline and 144 successful evidence reads allowed. Further read attempts return an error. That cap allows 24 re-reads beyond one pass through the task; it is an experiment constraint, not an OptChat limit, and was not announced in the task prompt before exhaustion. Separate pairs overlap in wall time, so elapsed times are descriptive rather than a controlled performance comparison.

## Workload and grading

The [frozen fixture](../../test/subagent-compaction-fixture.ts) is a synthetic release audit over 12 services and 120 chronological packets. Every roughly 10 KB packet has one authoritative event embedded among synthetic HTTP traces. Services' release, approval, error rate, latency, vulnerabilities, rollback verification and freeze status arrive separately; later approvals, error corrections and release changes supersede earlier values. The final answer must reconcile these fields and apply six explicit release rules.

This requires 120 evidence reads and nontrivial reconciliation across compactions, but is still a narrow, repetitive synthetic workload with substantial filler. It is not evidence of general coding quality. The three seeds vary the facts and identifiers, not the task family. The child has only `read_packet` and `checkpoint`, cannot edit files, and cannot query saved checkpoints; checkpoint arguments remain in its ordinary session history. Its system context is the isolated Pi/OptChat SDK setup, not a full interactive user configuration.

The fixture seeds are `20261013`, `20261014` and `20261015`; execution order is on/off, off/on, on/off. Model sampling is not seeded, and there is one run per condition per fixture. The task and answer key were frozen before the runs. Random labels conceal the condition from an exact, deterministic grader, which receives only each final saved audit and the answer key. There is no human or independent-model judge. Each of 12 rows earns nine points: seven facts, the GO/NO_GO decision and the complete set of blocking reasons (108 total). Row order and reason order do not matter; missing or duplicate rows fail their fields. Completion claims and evidence coverage are reported separately.

The [analysis](../../test/subagent-compaction-analysis.ts) also replays successful tool results to recover the exact evidence set at each checkpoint. At checkpoints shared by both arms, it scores only facts already observed, using the most recent event in packet order. Future fields are excluded; repeated reads do not inflate coverage. These additional diagnostics were specified while the runs were in progress, before final grading; they do not replace the frozen final-answer score. The runner's raw `read` counter includes attempts rejected by the tool budget; published coverage is corrected from successful tool results, not that counter. A Pi run state of `completed` likewise means the model stopped normally, not that the audit was complete.

## Results

| Seed | Pi compaction | Unique packets / 120 | Successful reads (repeats) | Compactions | Final saved audit / 108 | Decisions / 12 | Full task | Child minutes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 20261013 | On | 113 | 144 (31) | 4 | 100 | 12 | Incomplete: read budget | 13.13 |
| 20261013 | Off | 90 | 90 (0) | 0 | 77 | 10 | Incomplete: context guard | 5.60 |
| 20261014 | On | 120 | 144 (24) | 4 | 108 | 12 | Complete and correct | 12.49 |
| 20261014 | Off | 90 | 90 (0) | 0 | 80 | 10 | Incomplete: context guard | 5.68 |
| 20261015 | On | 108 | 144 (36) | 4 | 98 | 10 | Incomplete: read budget | 12.04 |
| 20261015 | Off | 90 | 90 (0) | 0 | 84 | 10 | Incomplete: context guard | 5.68 |

All three off arms stop when Pi estimates roughly 282K tokens, before the next normal model request. Their last saved audit covers 84 packets; six more packets are read before the guard prevents another checkpoint. They receive no score penalty for a false completion claim: none claims completion. The on arms each compact four times. Two acknowledge incomplete evidence, and the third both reads everything and scores perfectly. No deadline expires.

The final-answer scores favor on in this workload, but they combine access to later evidence with accuracy. The matched-evidence comparison is narrower: at the shared checkpoints after 12, 24, 36, 48, 60, 72 and 84 packets, both arms have identical observed-fact scores in seeds 20261014 and 20261015. In seed 20261013, on has one wrong fact at checkpoints 60, 72 and 84, while off has none. This is the same persistent vulnerability-count error, not three independent mistakes. All six runs' last saved audits accurately represent the facts observed by those checkpoints; the missing final evidence still prevents five of them from completing the task.

Compaction therefore extends coverage under the 272K guard, but repeated evidence reads become costly under the separate 144-read budget. This does not establish that compaction universally improves quality, nor that the two incomplete on runs could never finish with a larger read allowance. Request-level token usage and timing are included in the [machine-readable artifact](subagent-compaction-openai.json); wall times are not a controlled speed comparison.

## Parent verification through named zoom

The Sol/xhigh parent receives the OptChat memory view plus four packet indices. It must recover each packet's exact receipt (near the start) and decision-event evidence tag (in the middle), returning `null` if unavailable. Only named `zoom` is available, with eight calls and ten minutes allowed. This tests access and exact recovery, not whether the parent can independently recompute the release decision from all evidence.

The live-on checkpoint is a frozen snapshot immediately after the first successful real Pi compaction. The candidate replays the same checkpoint, questions and formatter, changing only the input from compacted working-context messages to retained session messages. It is an experiment, not a production patch. Finished snapshots use the current finished-run transcript path, which already reads retained entries. For off arms, the “live” snapshot is taken at termination because there is no compaction event; it must not be treated as a matched live-on checkpoint.

Questions sample the first, one-third, two-thirds and last packet read at the relevant snapshot. Consequently live versus finished and on versus off do not necessarily ask about the same packets; the current-versus-candidate comparison within each live-on snapshot does. The analysis separately counts answers physically present in the formatted transcript, correctly recovered answers and wrong non-null answers. Existing per-step head/tail clipping remains enabled in every condition.

| Seed | On: live current / 8 | On: live retained / 8 | On: finished current / 8 | Off: finished current / 8 |
| --- | ---: | ---: | ---: | ---: |
| 20261013 | 1 | 4 | 3 | 4 |
| 20261014 | 1 | 4 | 4 | 4 |
| 20261015 | 1 | 4 | 3 | 4 |

Every score equals the number of requested values physically present in the respective formatted transcript. The off “live” repeats also score 4/8 each. Across all 15 parent sessions, there are **zero wrong non-null answers**. The parent uses one zoom call for each live-current snapshot, two for each live-retained snapshot, five for off snapshots and seven for on-finished snapshots; none exceeds the eight-call limit.

At all three live-on snapshots, the current path exposes only one of four requested receipts; the candidate exposes all four. Aggregate receipt recovery rises from **3/12 to 12/12**. All middle evidence tags are unavailable in both paths because of the unchanged per-step clipping. The finished scores of 3/8 in seeds 20261013 and 20261015 have another explicit cause: question selection uses the runner's attempted-read indices and includes packet 119 or 113 respectively, which the exhausted read tool never returned. The parent correctly abstains; these are not failures to retrieve available evidence.

Over the whole pilot, 278 recorded model responses account for 3,151,772 uncached input tokens, 14,459,776 cache-read tokens and 83,422 output tokens. This includes parents, children, Pi summaries and Terra memory summaries. SDK cost fields are retained for transparency, but are not a measurement of subscription charges or quota consumption.

## Interpretation

There are two distinct truncation mechanisms. In SDK 1.0.2, `serializeConversation()` in `core/compaction/utils.js` sends only the first **2,000 characters** of each tool result to Pi's summarizer. All 120 decision events in each fixture fall outside that excerpt. Their facts can still survive in assistant text, checkpoint arguments or recent retained context, but the summarizer cannot independently read them from the original tool-result excerpts. This limitation was identified during the runs and checked against the installed SDK serializer. It materially limits interpretation: this pilot stresses compaction-input truncation and checkpoint placement as well as model summarization.

In seed `20261013`, packet 48 gives `service-00` one critical vulnerability. The second compaction's summary instead says every service has zero. Checkpoints at 60, 72 and 84 successful packets preserve that wrong count; the child later re-reads the relevant packets and corrects it by checkpoint 96. Those re-reads consume the fixed evidence budget. This is a concrete stale-fact failure in this workload, not evidence that Sol/high received the full underlying evidence in its summarization request and forgot it.

OptChat's named-zoom formatter separately clips each tool call/result to a **1,000-character head/tail excerpt** before pagination. Changing the source to retained messages repairs access to earlier excerpts but cannot restore their missing middles. Fixing named zoom also does not change what Pi sends to its compactor.

**Recommendation:** take a minimal retained-message read path for live named zoom, preserving access checks and covering persistence/streaming boundaries. It repairs a measured inconsistency without adding transcript storage. Keep Pi compaction enabled while separately investigating its 2,000-character summary-input limit and OptChat's 1,000-character zoom limit. Before choosing a summary tree or hybrid, test a realistic long coding/audit workload, disclose the read budget to the agent and measure sensitivity to a larger allowance and the model's native context capacity. This pilot does not compare those architectures or justify switching compaction off.

The [earlier offline measurement](subagent-compaction.md) documents the live/finished transcript mismatch and the separate per-step clipping limitation, including profile reload and pagination-cursor behavior. The live pilot adds real model summaries, task outcomes and parent recovery; it does not retest reload or streaming/persistence boundary races.

## Reproduction and artifacts

The live runner is opt-in and excluded from the ordinary test suite. It requires a Pi subscription login for the `openai` provider and access to the pinned model IDs. It uses the existing OAuth store, isolates extension/config discovery and writes explicit experiment profiles; no credentials or raw sessions are included in the published artifact.

```sh
# Each invocation makes live subscription requests. Use fresh output directories.
node --import tsx test/subagent-compaction.live.ts /tmp/optchat-openai-20261013 20261013
node --import tsx test/subagent-compaction.live.ts /tmp/optchat-openai-20261014 20261014
node --import tsx test/subagent-compaction.live.ts /tmp/optchat-openai-20261015 20261015
node --import tsx test/subagent-compaction-analysis.ts \
  docs/measurements/subagent-compaction-openai.json \
  /tmp/optchat-openai-20261013 /tmp/optchat-openai-20261014 /tmp/optchat-openai-20261015
```

The curated JSON records fixture hashes, protocols, final audits, grading mistakes, common-evidence scores, transcript visibility, parent answers, request usage and timings. Raw SDK sessions are retained outside the repository. Cost fields are SDK API-price estimates, **not subscription charges**. No claim about remaining subscription quota is made.

Validation: TypeScript checking passed. The full suite passed 288 tests with one existing Windows-only profile-lock test skipped on Linux. The three fixture/grading tests also passed after adding the Pi-serializer check. These checks make no live model calls.

```sh
node node_modules/typescript/bin/tsc --noEmit
node --import tsx --import ./test/support.ts --test test/*.test.ts
```

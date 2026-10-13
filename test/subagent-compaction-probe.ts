// Offline measurement for #176, not a quality benchmark or a regression expectation.
// Run: node --import tsx --import ./test/support.ts test/subagent-compaction-probe.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, type SessionManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Children, subagentCompaction } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { memoryTools, result } from '../src/tools.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const WINDOW = 200_000, CALLS = 120, RESULT_CHARS = 9_000;
const marker = (where: 'HEAD' | 'MIDDLE', n: number) => `PROBE_${where}_${String(n).padStart(3, '0')}_END`;
const summaryMarker = 'PROBE_COMPACTION_SUMMARY';
const retained = (manager: SessionManager) => manager.getEntries().flatMap(e => e.type === 'message' ? [e.message] : []);
const count = (text: string, where: 'HEAD' | 'MIDDLE') => new Set(text.match(new RegExp(`PROBE_${where}_\\d{3}_END`, 'g'))).size;

// Consume the actual named-zoom tool and its continuation offsets, not just the first page.
async function allPages(memory: Memory, id: string, messages: () => readonly AgentMessage[]) {
  const zoom = memoryTools(() => memory, () => messages())[0];
  let offset = 0, text = '', pages = 0, firstContinuation: number | undefined;
  for (;;) {
    const response = await zoom.execute('probe', { id, offset });
    const page = response.content.flatMap(c => c.type === 'text' ? [c.text] : []).join('');
    const footer = /\n\[characters (\d+)-(\d+) of (\d+)(?:; go on with offset (\d+))?\]$/.exec(page);
    assert.ok(footer, 'zoom must return a continuation footer');
    assert.equal(Number(footer[1]), offset);
    const body = page.slice(0, footer.index);
    assert.equal(body.length, Number(footer[2]) - offset);
    text += body; pages++;
    if (pages === 1 && footer[4]) firstContinuation = Number(footer[4]);
    if (!footer[4]) { assert.equal(text.length, Number(footer[3])); break; }
    assert.ok(Number(footer[4]) > offset);
    offset = Number(footer[4]);
  }
  return { pages, firstContinuation, characters: text.length, resultHeads: count(text, 'HEAD'), resultMiddles: count(text, 'MIDDLE'),
    toolCalls: (text.match(/^tool\|probe_read /gm) ?? []).length, includesSummary: text.includes(summaryMarker) };
}

async function measure(enabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-compaction-probe-'));
  const memory = new Memory(dir, async () => 'unused', () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const snapshots: unknown[] = [], compactions: unknown[] = [], warnings: string[] = [];
  let completed = 0, calls = 0, maxEstimatedTokens = 0, continuation: number | undefined;
  let children: Children, id: string;
  let snapshot: (phase: string) => Promise<void>;
  runtime.registerProvider('compaction-probe', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'scripted-200k', name: 'Scripted transcript probe (not a language model)', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: WINDOW, maxTokens: 1_000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      // Deterministic accounting to exercise Pi's thresholds. These are NOT provider token measurements.
      const input = Math.ceil(JSON.stringify(context).length / 4);
      maxEstimatedTokens = Math.max(maxEstimatedTokens, input);
      const overflow = input >= WINDOW, done = completed === CALLS;
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: { ...emptyUsage(), input, output: 20, totalTokens: input + 20 },
        stopReason: overflow ? 'error' : done ? 'stop' : 'toolUse',
        content: overflow ? [] : done ? [{ type: 'text', text: 'Scripted workload finished; this is not a task-quality result.' }]
          : [{ type: 'toolCall', id: `read-${++calls}`, name: 'probe_read', arguments: { index: completed } }],
        ...(overflow ? { errorMessage: 'Synthetic hard stop: estimated context exceeds 200000 tokens.' } : {}) };
      void (async () => {
        // Snapshot while the run is still live, before the final report/hard stop is persisted.
        if (done || overflow) await snapshot(done ? 'live-before-completion' : 'live-before-hard-stop');
        if (overflow) stream.push({ type: 'error', reason: 'error', error: message });
        else stream.push({ type: 'done', reason: done ? 'stop' : 'toolUse', message });
        stream.end();
      })().catch(error => {
        message.stopReason = 'error'; message.errorMessage = String(error);
        stream.push({ type: 'error', reason: 'error', error: message }); stream.end();
      });
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime);
  const choice = () => ({ provider: 'compaction-probe', model: 'scripted-200k', thinking: 'off' as const });
  children = new Children(memory, registry, choice, () => '', async () => {}, text => warnings.push(text), dir, {
    settings: () => ({ refreshAt: 0.3, subagentLevels: 1 }),
    createSession: async options => {
      assert.ok(options?.settingsManager);
      if (!enabled) options.settingsManager.setCompactionEnabled(false);
      options.settingsManager.setRetryEnabled(false);
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: options.settingsManager,
        noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
        extensionFactories: [pi => {
          pi.on('session_before_compact', async event => {
            await snapshot(`before-compaction-${compactions.length + 1}`);
            const { firstKeptEntryId, tokensBefore } = event.preparation;
            compactions.push({ reason: event.reason, completedTools: completed, tokensBefore });
            return { compaction: { firstKeptEntryId, tokensBefore, summary: `${summaryMarker}_${compactions.length}` } };
          });
          pi.on('session_compact', async () => { await snapshot(`after-compaction-${compactions.length}`); });
        }],
      });
      await loader.reload();
      return createAgentSession({ ...options, modelRuntime: runtime, resourceLoader: loader, tools: ['probe_read'],
        customTools: [{ name: 'probe_read', label: 'Read synthetic record', description: 'Return one synthetic record.',
          parameters: Type.Object({ index: Type.Integer() }), execute: async (_id, { index }) => {
            assert.equal(index, completed);
            const body = `${marker('HEAD', index)}\n${'x'.repeat(4_400)}\n${marker('MIDDLE', index)}\n`;
            completed++;
            return result(body.padEnd(RESULT_CHARS, 'x'));
          } }],
      });
    },
  });
  snapshot = async phase => {
    const live = children.live(id), messages = live ? retained(live.session.sessionManager) : children.messages(id);
    const raw = JSON.stringify(messages);
    assert.equal(count(raw, 'HEAD'), completed, 'canonical entries must contain every completed result');
    assert.equal(count(raw, 'MIDDLE'), completed, 'canonical entries must retain full result bodies');
    const currentZoom = await allPages(memory, id, () => children.transcript(id) ?? []);
    let previousContinuation: { offset: number; error?: string } | undefined;
    if (phase.startsWith('after-compaction') && continuation !== undefined) {
      previousContinuation = { offset: continuation };
      try { await memoryTools(() => memory, run => children.transcript(run))[0].execute('probe', { id, offset: continuation }); }
      catch (error) { previousContinuation.error = String(error); }
    }
    if (phase.startsWith('before-compaction')) continuation = currentZoom.firstContinuation;
    snapshots.push({ phase, completedTools: completed,
      canonical: { resultHeads: count(raw, 'HEAD'), resultMiddles: count(raw, 'MIDDLE') },
      projectedSummary: live?.session.messages.some(m => JSON.stringify(m).includes(summaryMarker)) ?? false,
      currentZoom, previousContinuation,
      retainedEntriesZoom: await allPages(memory, id, () => messages) });
  };
  try {
    [id] = await children.spawn([{ task: `Read ${CALLS} synthetic records sequentially.` }], dir);
    const live = children.live(id);
    assert.ok(live?.completion);
    const timeout = setTimeout(() => { void children.stop(id); }, 30_000);
    try { await live.completion; } finally { clearTimeout(timeout); }
    assert.equal(children.history.records.get(id)?.state, enabled ? 'completed' : 'failed');
    assert.ok(enabled ? compactions.length > 0 && completed === CALLS : compactions.length === 0 && completed < CALLS);
    await snapshot('finished');
    await children.close();
    children = new Children(memory, registry, choice, () => '', async () => {}, text => warnings.push(text), dir);
    await snapshot('reloaded');
    assert.deepEqual(warnings, []);
    return { compactionEnabled: enabled, settings: enabled ? subagentCompaction(WINDOW, 0.3) : { enabled: false },
      scheduledTools: CALLS, completedTools: completed, maxEstimatedTokens, compactions, snapshots };
  } finally { await children.close(); await memory.close(); removeDir(dir); }
}

console.log(JSON.stringify({ kind: 'offline transcript measurement; no language-model quality evidence',
  node: process.version, platform: process.platform,
  window: WINDOW, resultCharacters: RESULT_CHARS, runs: [await measure(true), await measure(false)] }, null, 2));

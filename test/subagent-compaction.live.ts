// Opt-in live OpenAI subscription experiment. Never imported by the ordinary test suite.
// node --import tsx test/subagent-compaction.live.ts /absolute/output/directory [seed]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, getAgentDir, type AgentSession } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { createCompressor, type ModelChoice } from '../src/compactor.ts';
import { Memory } from '../src/memory.ts';
import { defaults, saveConfig } from '../src/profiles.ts';
import { memoryTools, result } from '../src/tools.ts';
import { runTranscript } from '../src/transcript.ts';
import { emptyUsage, addUsage } from '../src/usage.ts';
import { makeFixture, gradeAudit, PACKETS, RULES, type Audit } from './subagent-compaction-fixture.ts';

const output = resolve(process.argv[2] ?? (() => { throw new Error('Pass an output directory; this script makes live subscription requests.'); })());
const seed = Number(process.argv[3] ?? 20261013);
assert.ok(Number.isSafeInteger(seed));
assert.ok(!existsSync(join(output, 'protocol.json')), 'Use a fresh directory; existing results must not be overwritten.');
mkdirSync(output, { recursive: true, mode: 0o700 });
const save = (name: string, data: unknown) => writeFileSync(join(output, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const log = (event: string, data: unknown = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data as object }));
const MAIN = { provider: 'openai', model: 'gpt-6.1-sol', thinking: 'xhigh' } satisfies ModelChoice;
const CHILD = { ...MAIN, thinking: 'high' } satisfies ModelChoice;
const COMPACTOR = { provider: 'openai', model: 'gpt-5.6-terra', thinking: 'medium' } satisfies ModelChoice;
const agentDir = getAgentDir();
const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
  modelsStorePath: join(output, 'models-store.json'), refreshOnCreate: false });
assert.equal((await runtime.checkAuth('openai'))?.type, 'oauth', 'This experiment requires the requested subscription login.');
// Isolate extension/config discovery while the explicit runtime keeps using the real OAuth store.
const isolatedAgentDir = join(output, 'pi');
mkdirSync(isolatedAgentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
const registry = new ModelRegistry(runtime), model = runtime.getModel(CHILD.provider, CHILD.model);
assert.ok(model);
const WINDOW = model.contextWindow;
const fixture = makeFixture(seed);
const auditSchema = Type.Object({ complete: Type.Boolean(), services: Type.Array(Type.Object({ service: Type.String(), release: Type.String(),
  approvedRelease: Type.String(), errorPct: Type.Number(), p95Ms: Type.Number(), criticalVulns: Type.Number(), rollbackVerified: Type.Boolean(),
  freeze: Type.Boolean(), decision: Type.String(), blockingReasons: Type.Array(Type.String()) })) });
const retain = (manager: SessionManager) => manager.getEntries().flatMap(e => e.type === 'message' ? [e.message] : []);
const usage: { role: string; model: string; thinking: string; usage: ReturnType<typeof emptyUsage>; stopReason: string; ms?: number }[] = [];
save('protocol.json', { kind: 'OpenAI-based live pilot; synthetic release audit', seed, fixtureSha256: fixture.sha256,
  models: { main: MAIN, subagent: CHILD, memoryCompactor: COMPACTOR }, piVersion: JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8')).version,
  node: process.version, configuredContextWindow: WINDOW, toolCallsRequired: PACKETS,
  contextLimitPolicy: 'Both arms stop before a request when Pi estimates context above its configured window. This is an experiment guard, not a claim about the OpenAI server limit.',
  task: RULES, grader: 'Exact field equality against a frozen answer key, blind to condition. No LLM judge.',
  started: new Date().toISOString() });
save('answer-key.json', fixture.expected);

function track(session: AgentSession, role: string, thinking: string, state: { compacting: boolean }, limit = true) {
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (selected, context, options) => {
    const tokens = session.getContextUsage()?.tokens;
    if (limit && !state.compacting && tokens !== null && tokens !== undefined && tokens > WINDOW)
      throw new Error(`BENCHMARK_CONTEXT_LIMIT: Pi estimates ${tokens} tokens, above its configured ${WINDOW}-token window.`);
    const started = Date.now(), purpose = state.compacting ? `${role}:pi-compaction` : role;
    const response = await stream(selected, context, { ...options, transport: 'sse', maxTokens: 16_384 });
    void response.result().then(message => {
      usage.push({ role: purpose, model: message.model, thinking, usage: message.usage, stopReason: message.stopReason, ms: Date.now() - started });
      save('usage.json', usage);
      log('request', { role: purpose, input: message.usage.input + message.usage.cacheRead, output: message.usage.output, ms: Date.now() - started, stop: message.stopReason });
    });
    return response;
  };
}

type Snapshot = { current: AgentMessage[]; retained: AgentMessage[]; read: number[] };
type Arm = { label: string; enabled: boolean; id: string; directory: string; state: string; report: string; checkpoints: { read: number; audit: Audit }[];
  compactions: unknown[]; reads: number[]; live?: Snapshot; finished: Snapshot; elapsedMs: number; warnings: string[] };

async function runArm(enabled: boolean, label: string): Promise<Arm> {
  const directory = join(output, label); mkdirSync(directory, { recursive: true });
  saveConfig(directory, { ...defaults, compactor: COMPACTOR, subagent: CHILD });
  const compressor = createCompressor(registry, () => COMPACTOR, message => {
    usage.push({ role: `${label}:memory-compactor`, model: message.model, thinking: COMPACTOR.thinking, usage: message.usage, stopReason: message.stopReason });
    save('usage.json', usage);
  });
  const memory = new Memory(directory, compressor, text => log('memory-warning', { label, text }));
  const warnings: string[] = [], reads: number[] = [], checkpoints: Arm['checkpoints'] = [], compactions: unknown[] = [];
  let liveSnapshot: Snapshot | undefined, children: Children, id = '', session: AgentSession | undefined;
  const compactState = { compacting: false };
  const snapshot = (): Snapshot => {
    assert.ok(session);
    return { current: structuredClone([...session.messages]), retained: structuredClone(retain(session.sessionManager)), read: [...reads] };
  };
  const started = Date.now();
  children = new Children(memory, registry, () => CHILD, () => '', async () => {}, text => warnings.push(text), directory, {
    settings: () => ({ refreshAt: 0.3, subagentLevels: 1 }),
    createSession: async options => {
      assert.ok(options?.settingsManager);
      options.settingsManager.setCompactionEnabled(enabled);
      options.settingsManager.setRetryEnabled(true);
      const loader = new DefaultResourceLoader({ cwd: directory, agentDir: isolatedAgentDir, settingsManager: options.settingsManager,
        noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true });
      await loader.reload();
      const made = await createAgentSession({ ...options, resourceLoader: loader, modelRuntime: runtime, tools: ['read_packet', 'checkpoint'],
        customTools: [
          { name: 'read_packet', label: 'Read evidence packet', description: 'Read one complete evidence packet by its index (0 through 119).',
            parameters: Type.Object({ index: Type.Integer({ minimum: 0, maximum: PACKETS - 1 }) }), execute: async (_id, { index }) => {
              if (index < 0 || index >= PACKETS) throw new Error('Packet out of range.');
              reads.push(index);
              if (reads.length > PACKETS + 24) throw new Error('Evidence-read budget exhausted.');
              log('read', { label, index, total: reads.length });
              return result(fixture.packets[index]);
            } },
          { name: 'checkpoint', label: 'Save audit', description: 'Record your current audit. No validation or feedback on correctness is provided. Use numeric 0 and strings unknown for facts not yet observed, and NO_GO until eligibility is established.',
            parameters: auditSchema, execute: async (_id, value) => {
              const audit = value as Audit; // Validated against auditSchema by Pi before execution.
              checkpoints.push({ read: new Set(reads).size, audit });
              save(`${label}/checkpoints.json`, checkpoints);
              log('checkpoint', { label, read: new Set(reads).size, complete: audit.complete });
              return result('Checkpoint recorded.');
            } },
        ] });
      session = made.session;
      assert.equal(session.thinkingLevel, CHILD.thinking);
      session.subscribe(event => {
        if (event.type === 'compaction_start') { compactState.compacting = true; log('compaction-start', { label, read: new Set(reads).size }); }
        if (event.type === 'compaction_end') {
          compactState.compacting = false;
          compactions.push({ read: new Set(reads).size, reason: event.reason, result: event.result, aborted: event.aborted, error: event.errorMessage });
          if (event.result && !liveSnapshot) liveSnapshot = snapshot();
          log('compaction-end', { label, read: new Set(reads).size, success: !!event.result });
        }
      });
      track(session, `${label}:subagent`, CHILD.thinking, compactState);
      return made;
    },
  });
  try {
    // Real Terra memory summaries for the shared parent/task briefing.
    memory.append('user', `Shared release-audit instructions:\n${RULES}`);
    await memory.settle(AbortSignal.timeout(180_000), 'tree');
    [id] = await children.spawn([{ task: RULES }], directory);
    const running = children.live(id); assert.ok(running?.completion);
    const timer = setTimeout(() => { void children.stop(id); }, 45 * 60_000);
    try { await running.completion; } finally { clearTimeout(timer); }
    const info = children.history.records.get(id); assert.ok(info);
    if (!liveSnapshot && session) liveSnapshot = snapshot();
    const messages = children.transcript(id) ?? [];
    const finished = { current: structuredClone(messages), retained: structuredClone(messages), read: [...reads] };
    const arm: Arm = { label, enabled, id, directory, state: info.state, report: info.report ?? '', checkpoints, compactions, reads,
      live: liveSnapshot, finished, elapsedMs: Date.now() - started, warnings };
    // Retain local SDK sessions for reproducibility; published artifacts omit credentials and hidden reasoning blocks.
    save(`${label}/arm.json`, { ...arm, live: undefined, finished: undefined });
    save(`${label}/snapshots.json`, { live: liveSnapshot, finished });
    log('arm-finished', { label, state: arm.state, read: new Set(reads).size, compactions: compactions.length });
    return arm;
  } finally { await children.close(); await memory.close(); }
}

async function recover(arm: Arm, stage: 'live' | 'finished', candidate: boolean) {
  const snapshot = stage === 'live' ? arm.live : arm.finished;
  if (!snapshot) return undefined;
  const available = [...new Set(snapshot.read)].sort((a, b) => a - b);
  const indices = [...new Set([available[0], available[Math.floor(available.length / 3)], available[Math.floor(available.length * 2 / 3)], available.at(-1)])].filter((n): n is number => n !== undefined);
  const messages = candidate ? snapshot.retained : snapshot.current;
  const label = `${arm.label}-${stage}-${candidate ? 'retained' : 'current'}`;
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: true } });
  const loader = new DefaultResourceLoader({ cwd: output, agentDir: isolatedAgentDir, settingsManager: settings,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true });
  await loader.reload();
  const memory = new Memory(join(output, `${label}-memory`), createCompressor(registry, () => COMPACTOR, message => {
    usage.push({ role: `${label}:memory-compactor`, model: message.model, thinking: COMPACTOR.thinking, usage: message.usage, stopReason: message.stopReason });
  }), () => {});
  const zoom = memoryTools(() => memory, run => run === arm.id ? messages : undefined)[0];
  let calls = 0;
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel(MAIN.provider, MAIN.model), thinkingLevel: MAIN.thinking,
    cwd: output, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.create(output, join(output, `${label}-sessions`)),
    tools: ['zoom'], customTools: [{ ...zoom, execute: async (...args) => { if (++calls > 8) throw new Error('Eight-call retrieval budget exhausted.'); return zoom.execute(args[0], args[1] as Parameters<typeof zoom.execute>[1]); } }] });
  await session.bindExtensions({});
  assert.equal(session.thinkingLevel, MAIN.thinking);
  track(session, `${label}:parent`, MAIN.thinking, { compacting: false });
  try {
    memory.append('work', stage === 'finished' ? arm.report : `Audit in progress: ${available.length} evidence packets have been read.\n${RULES}`);
    await memory.settle(AbortSignal.timeout(180_000), 'tree');
    const prompt = `${memory.render()}\n\nYou are the parent verifying a child's evidence. Only its named zoom is available. Read zoom("${arm.id}") and page through it as needed, using at most eight calls. You cannot access files.\nFor packets ${indices.join(', ')}, recover the exact Receipt and DECISION_EVENT evidenceTag strings. Use null when the value is unavailable; never infer or guess. The final answer must be JSON only: {"answers":[{"packet":0,"receipt":null,"evidenceTag":null}]}. Include one answer for each requested packet. State no extra prose.`;
    const timer = setTimeout(() => { void session.abort(); }, 10 * 60_000);
    try { await session.prompt(prompt); } finally { clearTimeout(timer); }
    const answer = session.getLastAssistantText() ?? '';
    let parsed: { answers?: { packet: number; receipt: string | null; evidenceTag: string | null }[] } = {};
    try { parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* invalid JSON scores no answers */ }
    let correct = 0, invented = 0;
    const rows = indices.map(packet => {
      const row = parsed.answers?.find(a => a.packet === packet);
      const expected = { receipt: fixture.receipts[packet], evidenceTag: fixture.evidenceTags[packet] };
      for (const field of ['receipt', 'evidenceTag'] as const) {
        if (row?.[field] === expected[field]) correct++;
        else if (row?.[field] != null) invented++;
      }
      return { packet, actual: row ?? null, expected };
    });
    const formatted = runTranscript(messages);
    const accessible = indices.reduce((n, i) => n + Number(formatted.includes(fixture.receipts[i])) + Number(formatted.includes(fixture.evidenceTags[i])), 0);
    const result = { label, stage, candidate, packetsRead: available.length, indices, calls, correct, total: indices.length * 2, accessible, invented, answer, rows };
    save(`${label}.json`, result); log('parent-finished', { label, correct, total: result.total, accessible, calls });
    return result;
  } finally { session.dispose(); await memory.close(); }
}

// Random labels keep the objective grader independent of the compaction condition.
const conditions = (seed % 2 ? [true, false] : [false, true]).map(enabled => ({ enabled, label: randomUUID().slice(0, 8) }));
save('conditions.json', conditions);
const arms: Arm[] = [];
for (const condition of conditions) arms.push(await runArm(condition.enabled, condition.label));
const blinded = arms.map(arm => ({ label: arm.label, audit: arm.checkpoints.at(-1)?.audit ?? null }));
save('blinded-audits.json', blinded);
const grades = blinded.map(item => ({ label: item.label, ...gradeAudit(item.audit, fixture.expected) }));
save('blinded-grades.json', grades);
const recovery = [];
for (const arm of arms) {
  for (const stage of ['live', 'finished'] as const) {
    recovery.push(await recover(arm, stage, false));
    // Finished current zoom already uses retained entries, so a second identical run adds no new condition.
    if (stage === 'live' && arm.enabled) recovery.push(await recover(arm, stage, true));
  }
}
const totals = emptyUsage(); for (const entry of usage) addUsage(totals, entry.usage);
save('results.json', { kind: 'OpenAI-based live pilot', seed, fixtureSha256: fixture.sha256, models: { main: MAIN, subagent: CHILD, memoryCompactor: COMPACTOR },
  configuredContextWindow: WINDOW, arms: arms.map(arm => ({ ...arm, live: undefined, finished: undefined, directory: undefined })), grades, recovery, usage, totals,
  billingNote: 'Cost fields are SDK API-price estimates, not the subscription bill.', completed: new Date().toISOString() });
log('complete', { output, totals });

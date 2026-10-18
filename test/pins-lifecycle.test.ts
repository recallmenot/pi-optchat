import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, getSystemMessageText, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { Pins } from '../src/pins.ts';
import { GuidanceRequests } from '../src/guidance-recall.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { COMPACT, TURN_REFRESHED } from '../src/prompts.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const system = (c: Context) => { const head = c.messages[0]; return head?.role === 'system' ? getSystemMessageText(head) : ''; };
const full = (c: Context) => c.messages.map(m => m.role === 'system' ? getSystemMessageText(m) : textContent(m.content)).join('\n');
const tool = (n: number, name: string, args: Record<string, string | number>): AssistantMessage['content'] => [{ type: 'toolCall', id: `tool-${n}`, name, arguments: args }];
async function runtime(dir: string, respond: (c: Context) => AssistantMessage['content']) {
  const rt = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  rt.registerProvider('pins-test', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'model', name: 'Pins fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const content = system(context) === COMPACT ? [{ type: 'text' as const, text: 'Summary.' }] : respond(context);
      const stopReason = content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop';
      const message: AssistantMessage = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
      const stream = createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); }); return stream;
    } });
  return rt;
}
const choice = () => ({ provider: 'pins-test', model: 'model', thinking: 'off' as const });

test('real main-agent tools pin full files across refresh/restart, move them, and recover by unpinning a missing source', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'optchat-pins-main-'))), cwd = join(dir, 'project'); mkdirSync(cwd);
  const oldHome = process.env.OPTCHAT_HOME, oldBudget = process.env.OPTCHAT_REFRESH_AT;
  process.env.OPTCHAT_HOME = dir; process.env.OPTCHAT_REFRESH_AT = '0.04';
  createProfile('fixture'); const profile = profilePath('fixture'); saveConfig(profile, { ...loadConfig(profile), compactor: choice() });
  const spec = join(cwd, 'SPEC.md'), plan = join(cwd, 'PLAN.md');
  writeFileSync(spec, 'UNIQUE_SPEC_BODY'); writeFileSync(plan, 'UNIQUE_PLAN_V1');
  const captured: Context[] = []; let calls = 0;
  const rt = await runtime(dir, context => {
    captured.push(structuredClone(context)); calls++;
    if (calls === 1) return tool(calls, 'pin_file', { path: spec, block: 'pre-memory', kind: 'requirements', purpose: 'System specification', scope: 'project' });
    if (calls === 2) return tool(calls, 'pin_file', { path: plan, block: 'post-memory', kind: 'plan', purpose: 'Active plan' });
    if (calls === 3) { writeFileSync(plan, 'UNIQUE_PLAN_V2'); return tool(calls, 'pinned_files', {}); }
    if (calls < 10) return [{ type: 'text', text: 'Useful progress. '.repeat(80) }, ...tool(calls, 'date', { id: 0 })];
    if (calls === 11) return tool(calls, 'pin_file', { path: plan, block: 'pre-memory', kind: 'plan', purpose: 'Active plan' });
    if (calls === 12) return tool(calls, 'unpin_file', { path: plan });
    if (calls === 13) { rmSync(spec); return tool(calls, 'pinned_files', {}); }
    if (calls === 14) return tool(calls, 'unpin_file', { path: spec, scope: 'project' });
    return [{ type: 'text', text: 'Done.' }];
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const errors: string[] = [];
  async function open(manager: SessionManager) {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    session = (await createAgentSession({ cwd, modelRuntime: rt, model: rt.getModel('pins-test', 'model'), resourceLoader: loader, settingsManager, sessionManager: manager })).session;
    await session.bindExtensions({ onError: error => errors.push(error.error) });
  }
  try {
    const manager = SessionManager.create(cwd, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    await open(manager); await session!.prompt('Implement the system. ' + 'Keep following the plan. '.repeat(20));
    assert.equal(captured.length, 10);
    assert.match(system(captured[1]), /UNIQUE_SPEC_BODY/);
    assert.doesNotMatch(system(captured[2]), /UNIQUE_PLAN_V1/);
    assert.match(full(captured[2]), /UNIQUE_PLAN_V1/);
    assert.ok(full(captured[2]).indexOf('</chat>') < full(captured[2]).indexOf('UNIQUE_PLAN_V1'));
    assert.ok(full(captured[2]).indexOf('UNIQUE_PLAN_V1') < full(captured[2]).indexOf('Implement the system.'));
    assert.match(full(captured[3]), /previous excerpt.*UNIQUE_PLAN_V1.*current excerpt.*UNIQUE_PLAN_V2/);
    assert.ok(captured.some(c => full(c).includes(TURN_REFRESHED)), 'memory actually refreshed while both files were pinned');
    for (const c of captured.slice(3)) { assert.match(system(c), /UNIQUE_SPEC_BODY/); assert.match(full(c), /UNIQUE_PLAN_V2/); }
    const file = manager.getSessionFile()!;
    await session!.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session!.dispose(); session = undefined;
    await open(SessionManager.open(file)); await session!.prompt('Continue after restart.');
    assert.equal(captured.length, 15);
    assert.match(full(captured[10]), /UNIQUE_PLAN_V2/); assert.doesNotMatch(system(captured[10]), /UNIQUE_PLAN_V2/);
    assert.match(system(captured[11]), /UNIQUE_PLAN_V2/);
    assert.doesNotMatch(system(captured[12]), /UNIQUE_PLAN_V2/);
    assert.match(system(captured[13]), /<unavailable_pin/); assert.doesNotMatch(system(captured[13]), /UNIQUE_SPEC_BODY/);
    assert.doesNotMatch(system(captured[14]), /<unavailable_pin|UNIQUE_SPEC_BODY/);
    const log = readdirSync(join(profile, 'main')).map(name => readFileSync(join(profile, 'main', name), 'utf8')).join('');
    const tree = readdirSync(join(profile, 'tree')).map(name => readFileSync(join(profile, 'tree', name), 'utf8')).join('');
    assert.doesNotMatch(log + tree, /UNIQUE_SPEC_BODY|UNIQUE_PLAN_V1|UNIQUE_PLAN_V2|guidance_update|<pinned_files/);
    const rows = log.trim().split('\n').map(line => JSON.parse(line));
    const pinnedWork = rows.find(e => e.kind === 'tool' && e.text.startsWith('pinned_files'));
    const recall = new GuidanceRequests(profile).describe([pinnedWork.guidance]);
    assert.ok(recall.includes(plan) && recall.includes('post-memory; plan'));
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    if (oldBudget === undefined) delete process.env.OPTCHAT_REFRESH_AT; else process.env.OPTCHAT_REFRESH_AT = oldBudget;
    removeDir(dir);
  }
});

test('parallel project children inherit only relevant pins, refresh their own revisions, and retain task pins when resumed', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'optchat-pins-children-'))), a = join(dir, 'alpha'), b = join(dir, 'beta'), profile = join(dir, 'profile');
  for (const path of [a, b, profile]) mkdirSync(path);
  const specA = join(a, 'SPEC.md'), specB = join(b, 'SPEC.md'), plan = join(a, 'PLAN.md');
  writeFileSync(specA, 'ALPHA_SPEC_V1'); writeFileSync(specB, 'BETA_SPEC'); writeFileSync(plan, 'ALPHA_TASK_PLAN');
  const main = new Pins(profile, a, 'session:main'); main.bind();
  main.pin(specA, 'pre-memory', 'requirements', 'Alpha specification', 'project'); main.pin(plan, 'post-memory', 'plan', 'Alpha plan');
  new Pins(profile, b, 'session:other').pin(specB, 'pre-memory', 'requirements', 'Beta specification', 'project');
  const memory = new Memory(profile, async () => 'Summary.'); memory.append('user', 'Implement independent projects.');
  const captured: Context[] = []; let alpha = 0;
  const rt = await runtime(dir, context => {
    captured.push(structuredClone(context));
    if (system(context).includes('ALPHA_SPEC')) {
      alpha++;
      if (alpha === 1) { writeFileSync(specA, 'ALPHA_SPEC_V2'); return tool(alpha, 'date', { id: 0 }); }
    }
    return [{ type: 'text', text: 'Done.' }];
  });
  const warnings: string[] = [];
  const children = new Children(memory, new ModelRegistry(rt), choice, () => '', async () => {}, warning => warnings.push(warning), profile,
    { parentSession: 'main', createSession: options => createAgentSession({ ...options, modelRuntime: rt }), settings: () => ({ refreshAt: 0 }) });
  const settle = async () => { const deadline = Date.now() + 10000; while (children.active) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); } };
  try {
    const [id] = await children.spawn([{ task: 'Alpha work.', cwd: a }, { task: 'Beta work.', cwd: b }], dir); await settle();
    const alphaCalls = captured.filter(c => system(c).includes('ALPHA_SPEC')), betaCalls = captured.filter(c => system(c).includes('BETA_SPEC'));
    assert.equal(alphaCalls.length, 2); assert.equal(betaCalls.length, 1);
    assert.match(full(alphaCalls[0]), /ALPHA_TASK_PLAN/); assert.match(system(alphaCalls[1]), /ALPHA_SPEC_V2/);
    assert.match(full(alphaCalls[1]), /previous excerpt.*ALPHA_SPEC_V1/);
    assert.doesNotMatch(full(betaCalls[0]), /ALPHA_SPEC|ALPHA_TASK_PLAN/); assert.doesNotMatch(full(alphaCalls[0]), /BETA_SPEC/);
    await children.tell(id, 'Continue after restart.'); await settle();
    assert.match(full(captured.at(-1)!), /ALPHA_TASK_PLAN/);
    assert.match(system(captured.at(-1)!), /ALPHA_SPEC_V2/);
    assert.deepEqual(warnings, []);
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});

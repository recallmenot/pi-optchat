// Opt-in real provider check. All files, history and instructions are synthetic; no private project context is sent.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelRuntime, convertToLlm } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Guidance, type GuidanceState } from '../src/guidance.ts';
import { Pins } from '../src/pins.ts';
import { textContent } from '../src/transcript.ts';
import { cachePayload } from '../src/cache.ts';

const runtime = await ModelRuntime.create({ refreshOnCreate: false });
const provider = process.env.OPTCHAT_GUIDANCE_PROVIDER ?? 'openai', modelId = process.env.OPTCHAT_GUIDANCE_MODEL ?? 'gpt-6.1-sol';
const model = (await runtime.getAvailable(provider)).find(m => m.id === modelId);
assert.ok(model, `No usable login/model for ${provider}/${modelId}; no live requests were sent.`);
const dir = mkdtempSync(join(tmpdir(), 'optchat-pins-live-')), cwd = join(dir, 'project'), profile = join(dir, 'profile');
mkdirSync(cwd); mkdirSync(profile);
const guidance = new Guidance(profile, { discover: false }), pins = new Pins(profile, cwd, 'live', undefined, () => []);
const background = Array.from({ length: 400 }, (_, i) => `Requirement ${i}: preserve this synthetic project's deliberate architecture and verify the work against its current specification.`).join('\n');
const spec = (database: string) => writeFileSync(join(cwd, 'SPEC.md'), `The required database is ${database}.\n${background}`);
const plan = (step: string) => writeFileSync(join(cwd, 'PLAN.md'), `The current step is ${step}.\nKeep the specification's architecture intact.`);
let state: GuidanceState | undefined;
const head: AgentMessage = { role: 'system', content: 'This is a synthetic validation. Follow current file roles and explicit user instructions. Answer only the requested JSON.', timestamp: 0 };
const work: AgentMessage[] = [];
const rows: { phase: string; answer: unknown; input: number; cacheRead: number; prefixHash: string }[] = [];
try {
  spec('SQLite'); plan('design');
  pins.pin('SPEC.md', 'pre-memory', 'requirements', 'System requirements'); pins.pin('PLAN.md', 'post-memory', 'plan', 'Current implementation step');
  for (const [i, phase] of ['initial', 'memory-changed', 'plan-changed', 'unchanged', 'spec-changed'].entries()) {
    if (i === 2) plan('implement');
    if (i === 4) spec('PostgreSQL');
    const view = `<chat>\n0+1|Earlier work used SQLite under the then-current specification.\n${i ? '1+1|Design completed.\n' : ''}</chat>`;
    work.push({ role: 'user', content: 'Reply JSON with database (current required database), step (current plan step), pinned (array of pinned basenames), mayUnpinWhenDone (boolean), pinOneOffReads (boolean), earlierSQLiteNecessarilyViolation (boolean).', timestamp: i + 1 });
    const [first, ...rest] = work; assert.equal(first.role, 'user');
    const messages: AgentMessage[] = [head, { ...first, content: [{ type: 'text', text: view }, { type: 'text', text: '\n\n' + textContent(first.content) }] }, ...rest];
    const prepared = guidance.prepare(messages, cwd, state, next => { state = next; }, undefined, { files: pins.effective(), model });
    assert.equal(prepared.revision.unavailable, undefined);
    const leading = prepared.messages[0]; assert.equal(leading.role, 'system');
    const prefixHash = createHash('sha256').update(textContent(leading.content)).digest('hex');
    const reply = await runtime.streamSimple(model, { messages: convertToLlm(prepared.messages) }, {
      maxTokens: 800, sessionId: `pins-validation-${dir}`, onPayload: p => model.api === 'anthropic-messages' ? cachePayload(p) : p,
    }).result();
    assert.notEqual(reply.stopReason, 'error', reply.errorMessage);
    const answer = JSON.parse(textContent(reply.content).replace(/^```(?:json)?\s*|\s*```$/g, ''));
    rows.push({ phase, answer, input: reply.usage.input, cacheRead: reply.usage.cacheRead, prefixHash }); console.log(JSON.stringify(rows.at(-1)));
    assert.equal(answer.database, i === 4 ? 'PostgreSQL' : 'SQLite'); assert.equal(answer.step, i >= 2 ? 'implement' : 'design');
    assert.deepEqual(answer.pinned.sort(), ['PLAN.md', 'SPEC.md']);
    assert.equal(answer.mayUnpinWhenDone, true); assert.equal(answer.pinOneOffReads, false); assert.equal(answer.earlierSQLiteNecessarilyViolation, false);
    work.push(reply);
  }
  assert.equal(new Set(rows.slice(0, 4).map(r => r.prefixHash)).size, 1);
  assert.notEqual(rows[3].prefixHash, rows[4].prefixHash);
  console.log('PASS: two-block contents, pin awareness/lifetime, changed requirements and stable pre-memory prefix. Cache counters are observations, not guarantees.');
} finally { rmSync(dir, { recursive: true, force: true }); }

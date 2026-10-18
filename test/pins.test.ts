import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getSystemMessageText } from '@earendil-works/pi-ai';
import { Pins, pinProject } from '../src/pins.ts';
import { Guidance, type GuidanceState } from '../src/guidance.ts';
import { GuidanceRequests } from '../src/guidance-recall.ts';
import { PINNING } from '../src/prompts.ts';
import { textContent } from '../src/transcript.ts';
import { removeDir } from './support.ts';

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'optchat-pins-'))), cwd = join(dir, 'project'), profile = join(dir, 'profile');
  mkdirSync(cwd); mkdirSync(profile); mkdirSync(join(cwd, '.git'));
  const spec = join(cwd, 'SPEC.md'), plan = join(cwd, 'PLAN.md');
  writeFileSync(spec, 'SPEC_FULL: retain the unusual architecture.'); writeFileSync(plan, 'PLAN_FULL: first implement the protocol.');
  const pins = new Pins(profile, cwd, 'main'); pins.bind();
  const guidance = new Guidance(profile, { discover: false });
  let state: GuidanceState | undefined;
  const base: AgentMessage[] = [{ role: 'system', content: 'STABLE', timestamp: 0 }, { role: 'user', content: [{ type: 'text', text: '<chat>\n0+1|MEMORY\n</chat>' }, { type: 'text', text: '\n\nRECENT_WORK' }], timestamp: 1 }];
  const prepare = (messages = base, model?: { contextWindow: number; maxTokens: number }) => guidance.prepare(messages, cwd, state, next => { state = next; }, undefined, { files: pins.effective(), model });
  return { dir, cwd, profile, spec, plan, pins, guidance, base, prepare };
}
const full = (messages: AgentMessage[]) => messages.map(m => m.role === 'system' ? getSystemMessageText(m) : 'content' in m ? textContent(m.content) : '').join('\n');
const updates = (messages: AgentMessage[]) => messages.filter(m => m.role === 'custom' && m.customType === 'optchat-guidance-update');

test('two full blocks, stable requests, moves without new contents, block-independent unpin and historical recall', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.profile, 'AGENTS.md'), 'AUTOMATIC_GUIDANCE');
    f.prepare();
    f.pins.pin('PLAN.md', 'post-memory', 'plan', 'Active work');
    f.pins.pin('SPEC.md', 'pre-memory', 'requirements', 'Preserve project intent', 'project');
    const first = f.prepare(), text = full(first.messages);
    const order = ['STABLE', 'AUTOMATIC_GUIDANCE', 'SPEC_FULL', 'MEMORY', 'PLAN_FULL', 'RECENT_WORK'];
    for (let i = 1; i < order.length; i++) assert.ok(text.indexOf(order[i - 1]) < text.indexOf(order[i]), order.join(' → '));
    assert.match(text, /kind="requirements".*purpose="Preserve project intent"/);
    assert.ok(text.includes(PINNING));
    assert.match(PINNING, /only for important files/); assert.match(PINNING, /Keep them pinned while needed/); assert.match(PINNING, /freely unpin_file/);
    assert.deepEqual(first.revision.files.map(f => f.path), [join(f.profile, 'AGENTS.md'), f.spec, f.plan], 'archive order matches injection order');
    const unchanged = f.prepare(); assert.deepEqual(unchanged, first);
    utimesSync(f.plan, new Date(), new Date(Date.now() + 10000)); assert.deepEqual(f.prepare(), first);
    assert.match(f.pins.pin('PLAN.md', 'post-memory', 'plan', 'Active work'), /Already pinned/);
    assert.deepEqual(f.prepare(), first);
    const contents = readdirSync(join(f.profile, 'guidance', 'contents'));
    assert.match(f.pins.pin('PLAN.md', 'pre-memory', 'plan', 'Active work'), /Moved .* from post-memory to pre-memory/);
    const moved = f.prepare();
    assert.equal(full(moved.messages).split('PLAN_FULL').length - 1, 1);
    assert.ok(full(moved.messages).indexOf('PLAN_FULL') < full(moved.messages).indexOf('MEMORY'));
    assert.deepEqual(readdirSync(join(f.profile, 'guidance', 'contents')), contents, 'placement does not duplicate archived contents');
    const requests = new GuidanceRequests(f.profile), ref = requests.prepare(moved.revision, 'main', f.base);
    f.pins.unpin('PLAN.md'); const removed = f.prepare();
    assert.equal(removed.messages[0].role, 'system');
    assert.doesNotMatch(getSystemMessageText(removed.messages[0]), /PLAN_FULL/);
    assert.match(full(removed.messages), /does not mean deletion or revoked requirements/);
    rmSync(f.plan);
    const old = new GuidanceRequests(f.profile).describe([ref]);
    assert.ok(old.includes(f.plan) && old.includes('pre-memory; plan'));
    const archived = moved.revision.files.find(p => p.path === f.plan)!;
    assert.match(readFileSync(archived.archive, 'utf8'), /PLAN_FULL/);
    assert.throws(() => f.pins.pin(archived.archive, 'pre-memory', 'reference', 'Past'), /Historical archives/);
    assert.throws(() => f.pins.unpin(join(f.profile, 'AGENTS.md')), /Automatic project guidance/);
  } finally { removeDir(f.dir); }
});

test('project persistence, live inheritance, local overrides and unrelated projects/worktrees stay separate', () => {
  const f = fixture();
  try {
    const subdir = join(f.cwd, 'src'); mkdirSync(subdir);
    const child = new Pins(f.profile, subdir, 'child', 'main'); child.bind();
    const grandchild = new Pins(f.profile, subdir, 'grandchild', 'child'); grandchild.bind();
    const sibling = new Pins(f.profile, f.cwd, 'sibling', 'main'); sibling.bind();
    f.pins.pin('SPEC.md', 'pre-memory', 'requirements', 'Shared architecture', 'project');
    f.pins.pin('PLAN.md', 'post-memory', 'plan', 'Shared task plan');
    assert.deepEqual(child.effective(), f.pins.effective());
    child.pin(f.plan, 'pre-memory', 'plan', 'Child override');
    assert.equal(grandchild.effective().find(p => p.path === f.plan)?.block, 'pre-memory');
    assert.equal(sibling.effective().find(p => p.path === f.plan)?.block, 'post-memory');
    child.unpin(f.spec); assert.ok(!grandchild.effective().some(p => p.path === f.spec));
    assert.ok(sibling.effective().some(p => p.path === f.spec));
    f.pins.unpin(f.plan); assert.ok(!sibling.effective().some(p => p.path === f.plan));
    assert.ok(child.effective().some(p => p.path === f.plan), 'explicit child override survives parent removal');
    child.unpin(f.plan); assert.equal(child.effective().length, 0);
    const restored = new Pins(f.profile, subdir, 'child', 'different-parent'); restored.bind();
    assert.deepEqual(restored.effective(), []);
    assert.equal(new Pins(f.profile, f.cwd, 'new-session').effective().length, 1, 'project pin survives a new session, task pins do not');
    f.pins.unpin(f.spec, 'project'); assert.equal(sibling.effective().length, 0);
    const other = join(f.dir, 'other'); mkdirSync(other); mkdirSync(join(other, '.git'));
    const worktree = join(f.cwd, 'worktree'); mkdirSync(worktree); writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere');
    f.pins.pin('SPEC.md', 'pre-memory', 'requirements', 'Project', 'project');
    assert.deepEqual(new Pins(f.profile, other, 'foreign', 'main').effective(), []);
    assert.deepEqual(new Pins(f.profile, worktree, 'worktree-child', 'main').effective(), []);
    assert.equal(pinProject(subdir), f.cwd); assert.equal(pinProject(worktree), worktree);
    assert.throws(() => f.pins.pin(join(other, 'file.md'), 'pre-memory', 'reference', 'Wrong project', 'project'), /missing file/);
    writeFileSync(join(other, 'file.md'), 'other');
    assert.throws(() => f.pins.pin(join(other, 'file.md'), 'pre-memory', 'reference', 'Wrong project', 'project'), /inside this worktree/);
  } finally { removeDir(f.dir); }
});

test('edited, missing, unsupported and oversized files produce truthful recoverable revisions and no stale text', () => {
  const f = fixture();
  try {
    f.pins.pin('SPEC.md', 'pre-memory', 'requirements', 'Specification');
    f.pins.pin('PLAN.md', 'post-memory', 'plan', 'Plan');
    const initial = f.prepare();
    writeFileSync(f.spec, 'SPEC_V2: use the new protocol.');
    const changed = f.prepare();
    assert.match(full(changed.messages), /SPEC_V2/);
    assert.match(full(updates(changed.messages)), /previous excerpt.*SPEC_FULL.*current excerpt.*SPEC_V2/);
    assert.match(full(updates(changed.messages)), /no manual reread/);
    assert.match(full(updates(changed.messages)), /earlier instructions, requirements or plans/);
    assert.ok(full(updates(changed.messages)).includes(initial.revision.files.find(p => p.path === f.spec)!.archive));
    assert.deepEqual(f.prepare(), changed);
    rmSync(f.plan); const missing = f.prepare();
    assert.equal(missing.revision.unavailable?.length, 1);
    assert.match(full(missing.messages), /UNAVAILABLE/); assert.doesNotMatch(full(missing.messages), /PLAN_FULL/);
    assert.deepEqual(f.prepare(), missing);
    const ref = new GuidanceRequests(f.profile).prepare(missing.revision, 'main', f.base);
    assert.match(new GuidanceRequests(f.profile).describe([ref]), /NOT supplied: .*PLAN.md/);
    writeFileSync(f.plan, Buffer.from([0xff])); assert.equal(f.prepare().revision.unavailable?.length, 1);
    writeFileSync(f.plan, 'binary\0data'); assert.match(full(f.prepare().messages), /binary\/control/);
    writeFileSync(f.plan, 'x'.repeat(1_000_001)); assert.match(full(f.prepare().messages), /no partial guidance/);
    f.pins.unpin(f.plan); const recovered = f.prepare();
    assert.equal(recovered.revision.unavailable, undefined); assert.ok(!f.pins.effective().some(p => p.path === f.plan));
    assert.throws(() => f.pins.pin(f.plan, 'pre-memory', 'plan', 'Too big'), /exceeds/);
    writeFileSync(f.plan, 'RESTORED_PLAN'); f.pins.pin(f.plan, 'post-memory', 'plan', 'Repaired');
    assert.match(full(f.prepare().messages), /RESTORED_PLAN/);
  } finally { removeDir(f.dir); }
});

test('combined blocks account for context, tools and output headroom, and recover on a larger model or fewer pins', () => {
  const f = fixture();
  try {
    const spec = 'Specification requirements.\n'.repeat(1200), plan = 'Active plan steps.\n'.repeat(1200);
    writeFileSync(f.spec, spec); writeFileSync(f.plan, plan);
    f.pins.pin(f.spec, 'pre-memory', 'requirements', 'Long-lived specification');
    f.pins.pin(f.plan, 'post-memory', 'plan', 'Active plan');
    const big = { contextWindow: 128000, maxTokens: 16000 }, small = { contextWindow: 32000, maxTokens: 8000 };
    const accepted = f.prepare(f.base, big); assert.equal(accepted.revision.files.length, 2); assert.ok(full(accepted.messages).includes(spec) && full(accepted.messages).includes(plan));
    const failed = f.prepare(f.base, small); assert.equal(failed.revision.files.length, 0); assert.equal(failed.revision.unavailable?.length, 2);
    assert.doesNotMatch(full(failed.messages), /Specification requirements\.\n/);
    assert.match(full(failed.messages), /combined pins exceed available context/);
    assert.deepEqual(f.prepare(f.base, small), failed, 'failed budget state does not churn');
    f.pins.unpin(f.plan); assert.equal(f.prepare(f.base, small).revision.files.length, 1);
    const loaded: AgentMessage[] = [{ role: 'system', content: 'STABLE', toolsAdded: [{ name: 'large_tool', description: 'x'.repeat(50000), parameters: { type: 'object', properties: {} } }], timestamp: 0 }, ...f.base.slice(1)];
    assert.equal(f.prepare(loaded, small).revision.files.length, 0, 'tool schemas count against the same request');
    assert.equal(f.prepare(loaded, big).revision.files.length, 1);
  } finally { removeDir(f.dir); }
});

test('real linked worktrees have independent registrations and canonical file paths do not follow retargeted symlinks', () => {
  const f = fixture();
  try {
    execFileSync('git', ['init', '-q', f.cwd]);
    execFileSync('git', ['-C', f.cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']);
    const other = join(f.dir, 'worktree'); execFileSync('git', ['-C', f.cwd, 'worktree', 'add', '--detach', other], { stdio: 'pipe' });
    f.pins.pin(f.spec, 'pre-memory', 'requirements', 'Worktree-specific', 'project');
    assert.equal(new Pins(f.profile, other, 'other', 'main').effective().length, 0);
    if (process.platform !== 'win32') {
      const alias = join(f.cwd, 'alias.md'); symlinkSync(f.spec, alias);
      f.pins.pin(alias, 'pre-memory', 'requirements', 'Alias'); assert.equal(f.pins.effective().filter(p => p.path === f.spec).length, 1);
      rmSync(alias); symlinkSync(f.plan, alias);
      assert.match(full(f.prepare().messages), /SPEC_FULL/);
      rmSync(f.spec); symlinkSync(f.plan, f.spec);
      assert.match(full(f.prepare().messages), /canonical path now redirects/);
      f.pins.unpin(f.spec); assert.ok(!f.pins.effective().some(p => p.path === f.spec), 'retargeted paths can still be unpinned');
    }
  } finally { removeDir(f.dir); }
});

test('registry corruption and failed persistence do not silently change registrations or advance guidance', () => {
  const f = fixture();
  try {
    f.pins.pin(f.spec, 'pre-memory', 'requirements', 'Intent');
    const supplied = f.prepare();
    const registry = readFileSync(f.pins.file, 'utf8');
    writeFileSync(f.pins.file, JSON.stringify({ version: 1, projects: [], tasks: {} }));
    assert.throws(() => f.pins.effective(), /Invalid pinned-file registry/);
    assert.throws(() => f.prepare(), /Invalid pinned-file registry/);
    writeFileSync(f.pins.file, registry);
    assert.deepEqual(f.prepare(), supplied);
    const blockedWrite = `${f.pins.file}.${process.pid}.tmp`; mkdirSync(blockedWrite);
    assert.throws(() => f.pins.pin(f.plan, 'post-memory', 'plan', 'Unwritable registration'));
    assert.equal(readFileSync(f.pins.file, 'utf8'), registry);
    assert.deepEqual(f.prepare(), supplied, 'failed registry write leaves the supplied set intact');
    rmSync(blockedWrite, { recursive: true });
    const archived = supplied.revision.files[0]; writeFileSync(archived.archive, 'corrupted object');
    assert.throws(() => f.prepare(), /Damaged historical guidance/);
  } finally { removeDir(f.dir); }
});

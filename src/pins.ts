import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Type, type Static } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { atomicWrite } from './store.ts';
import { record } from './cache.ts';
import { currentGuidance, readPinnedSource, type GuidanceSource } from './guidance.ts';

export const BLOCKS = ['pre-memory', 'post-memory'] as const;
export const PIN_KINDS = ['requirements', 'plan', 'reference'] as const;
export const PIN_SCOPES = ['task', 'project'] as const;
export interface Pin {
  path: string; block: typeof BLOCKS[number]; kind: typeof PIN_KINDS[number]; purpose: string;
  scope: typeof PIN_SCOPES[number]; project: string; owner?: string;
}
interface TaskPins { project: string; owner: string; parent?: string; pins: Pin[]; hidden: string[] }
interface Registry { version: 1; projects: Record<string, Pin[]>; tasks: Record<string, TaskPins> }
const key = (text: string) => createHash('sha256').update(text).digest('hex');
const inside = (root: string, path: string) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };
const absolute = (cwd: string, path: string) => resolve(cwd, path.replace(/^~(?=$|[\\/])/, homedir()));
/** Each linked worktree has its own .git entry. Outside Git, the exact working directory is the project. */
export function pinProject(cwd: string) {
  const start = realpathSync(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return start;
  }
}
function validPin(value: unknown): value is Pin {
  if (!value || typeof value !== 'object') return false;
  const p = value as Pin;
  return typeof p.path === 'string' && isAbsolute(p.path) && BLOCKS.includes(p.block) && PIN_KINDS.includes(p.kind)
    && typeof p.purpose === 'string' && !!p.purpose.trim() && p.purpose.length <= 500 && PIN_SCOPES.includes(p.scope)
    && typeof p.project === 'string' && isAbsolute(p.project) && (p.owner === undefined || typeof p.owner === 'string');
}

/** All agents in one profile share its lock. Synchronous read/modify/atomic-write avoids stale in-memory registries. */
export class Pins {
  readonly project: string;
  readonly file: string;
  private readonly task: string;
  constructor(readonly profile: string, readonly cwd: string, readonly owner: string, readonly parent?: string, private readonly guidance?: () => GuidanceSource[]) {
    this.project = pinProject(cwd); this.file = join(profile, 'context-pins.json'); this.task = this.taskKey(owner);
  }
  private taskKey(owner: string) { return key(`${this.project}\0${owner}`); }
  private automatic() { return this.guidance?.() ?? currentGuidance(this.cwd, this.profile); }
  private read(): Registry {
    let state: Registry;
    try { state = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projects: {}, tasks: {} }; throw error; }
    if (state?.version !== 1 || !record(state.projects) || !record(state.tasks) ||
      !Object.entries(state.projects).every(([id, pins]) => Array.isArray(pins) && pins.every(p => validPin(p) && p.scope === 'project' && p.owner === undefined && key(p.project) === id)) ||
      !Object.entries(state.tasks).every(([id, t]) => t && typeof t.project === 'string' && isAbsolute(t.project) && typeof t.owner === 'string' && key(`${t.project}\0${t.owner}`) === id &&
        (t.parent === undefined || typeof t.parent === 'string') && Array.isArray(t.pins) && t.pins.every(p => validPin(p) && p.scope === 'task' && p.owner === t.owner && p.project === t.project)
        && Array.isArray(t.hidden) && t.hidden.every(p => typeof p === 'string' && isAbsolute(p))))
      throw new Error(`Invalid pinned-file registry: ${this.file}. Restore or repair it before continuing.`);
    return state;
  }
  private own(state: Registry) {
    return state.tasks[this.task] ??= { project: this.project, owner: this.owner, ...(this.parent ? { parent: this.parent } : {}), pins: [], hidden: [] };
  }
  /** Persist the parent once so resumed descendants keep the same task lineage. */
  bind() { const state = this.read(); if (!state.tasks[this.task]) { this.own(state); this.write(state); } }
  private write(state: Registry) { atomicWrite(this.file, JSON.stringify(state, null, 2)); }
  effective(state = this.read()): Pin[] {
    const selected = new Map((state.projects[key(this.project)] ?? []).map(pin => [pin.path, pin]));
    const chain: TaskPins[] = [], seen = new Set<string>();
    let owner: string | undefined = this.owner;
    while (owner) {
      if (seen.has(owner)) throw new Error('Cyclic pinned-file inheritance');
      seen.add(owner);
      const task: TaskPins | undefined = state.tasks[this.taskKey(owner)] ?? (owner === this.owner ? this.own(state) : undefined);
      if (!task || task.project !== this.project) break;
      chain.unshift(task); owner = task.parent;
    }
    for (const task of chain) {
      for (const path of task.hidden) selected.delete(path);
      for (const pin of task.pins) selected.set(pin.path, pin);
    }
    return [...selected.values()];
  }
  private path(path: string) {
    const resolved = absolute(this.cwd, path);
    // Resolve a symlink only on registration. Later reads use the original canonical target.
    try { return realpathSync(resolved); } catch { return resolved; }
  }
  pin(path: string, block: Pin['block'], kind: Pin['kind'], purpose: string, scope: Pin['scope'] = 'task') {
    path = this.path(path);
    const pin: Pin = { path, block, kind, purpose: purpose.trim(), scope, project: this.project, ...(scope === 'task' ? { owner: this.owner } : {}) };
    if (!validPin(pin)) throw new Error('Specify a block, document kind and a short purpose (1–500 characters).');
    if (inside(this.path(join(this.profile, 'guidance')), path)) throw new Error('Historical archives cannot be pinned as current files. Pin the current source instead.');
    if (this.automatic().some(file => this.path(file.path) === path)) throw new Error('This file is automatic project guidance, already before memory; it cannot be moved or unpinned.');
    const source = readPinnedSource(path);
    if (!source) throw new Error(`Cannot pin missing file: ${path}. Restore it or choose its new path.`);
    if (scope === 'project' && !inside(this.project, path)) throw new Error('Project pins must be inside this worktree/project. Use a task pin for an external document.');
    const state = this.read(), before = this.effective(state).find(p => p.path === path);
    const pins = scope === 'project' ? state.projects[key(this.project)] ??= [] : this.own(state).pins;
    const at = pins.findIndex(p => p.path === path);
    if (at >= 0) pins[at] = pin; else pins.push(pin);
    // An explicit registration replaces this task's suppression. Project changes also release its local override.
    const own = this.own(state); own.hidden = own.hidden.filter(p => p !== path);
    if (scope === 'project') own.pins = own.pins.filter(p => p.path !== path);
    if (this.effective(state).length > 32) throw new Error('At most 32 effective pins; unpin files no longer needed before adding more.');
    this.write(state);
    return before?.block !== undefined && before.block !== block ? `Moved ${path} from ${before.block} to ${block} (${scope} scope).`
      : before && JSON.stringify(before) === JSON.stringify(pin) ? `Already pinned ${path} in ${block}; no duplicate.`
      : `Pinned ${path} in ${block} (${scope}, ${kind}): ${pin.purpose}. Complete contents are checked for the next request.`;
  }
  unpin(path: string, scope: Pin['scope'] = 'task') {
    const state = this.read(), requested = absolute(this.cwd, path);
    // An unavailable canonical path may itself have become a symlink; still let the caller release that exact registration.
    const registered = [...Object.values(state.projects).flat(), ...Object.values(state.tasks).flatMap(task => task.pins)];
    path = registered.some(pin => pin.path === requested) ? requested : this.path(path);
    if (this.automatic().some(file => this.path(file.path) === path)) throw new Error('Automatic project guidance stays before memory; it cannot be unpinned. Edit its source to change it.');
    if (scope === 'project') {
      state.projects[key(this.project)] = (state.projects[key(this.project)] ?? []).filter(p => p.path !== path);
    } else {
      const own = this.own(state); own.pins = own.pins.filter(p => p.path !== path);
      if (!own.hidden.includes(path)) own.hidden.push(path); // Also suppress an inherited pin for this task and its descendants.
    }
    this.write(state);
    const remaining = this.effective(state).some(p => p.path === path);
    return `Unpinned ${path} for ${scope === 'project' ? 'the project' : 'this task and its descendants'}. Historical versions remain; this does not delete the file or revoke its requirements.${remaining ? ' A task override still includes it; unpin with scope task to remove that too.' : ''}`;
  }
  list() {
    const guidance = this.automatic(), identities = new Set(guidance.map(file => this.path(file.path)));
    const automatic = guidance.map(f => `automatic | pre-memory | guidance | ${f.path}`);
    const pins = this.effective().filter(p => !identities.has(p.path)).map(p => {
      let status: string;
      try { status = readPinnedSource(p.path) ? 'readable; request budget checked before inclusion' : 'UNAVAILABLE: missing; restore or unpin'; }
      catch (error) { status = `UNAVAILABLE: ${String(error)}`; }
      return `${p.scope}${p.owner && p.owner !== this.owner ? ' (inherited)' : ''} | ${p.block} | ${p.kind} | ${p.path}\nPurpose: ${p.purpose}\n${status}`;
    });
    return `Pinned files for ${this.project}:\n${[...automatic, ...pins].join('\n\n') || '(none)'}`;
  }
}

const pinParameters = Type.Object({ path: Type.String(), block: StringEnum(BLOCKS), kind: StringEnum(PIN_KINDS), purpose: Type.String({ minLength: 1, maxLength: 500 }), scope: Type.Optional(StringEnum(PIN_SCOPES)) });
const unpinParameters = Type.Object({ path: Type.String(), scope: Type.Optional(StringEnum(PIN_SCOPES)) });
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
export function pinTools(current: (ctx: ExtensionContext) => Pins) {
  return [{ name: 'pin_file', label: 'Pin important context',
    description: 'Keep a file fully available across refreshes. Choose pre-memory for stable files, post-memory for frequent edits. Task scope (default) follows this task and same-project descendants; project scope is shared in this worktree across sessions. Task overrides affect only that task and its descendants. Registering in the other block moves the file; repeating a registration creates no duplicate.',
    parameters: pinParameters,
    execute: async (_id: string, args: Static<typeof pinParameters>, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => answer(current(ctx).pin(args.path, args.block, args.kind, args.purpose, args.scope)),
  }, { name: 'unpin_file', label: 'Release pinned context',
    description: 'Stop including a file from either block; no block argument is needed. Default task scope also hides an inherited pin for this task and its descendants; project scope removes the shared registration. The file and historical copies remain; requirements are not revoked.',
    parameters: unpinParameters,
    execute: async (_id: string, args: Static<typeof unpinParameters>, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => answer(current(ctx).unpin(args.path, args.scope)),
  }, { name: 'pinned_files', label: 'List pinned context', description: 'List automatic and effective registered files, placements, purposes, scopes and read problems for this project/task. Current inclusion status is also supplied in the pinned-file blocks.',
    parameters: Type.Object({}), execute: async (_id: string, _args: {}, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => answer(current(ctx).list()),
  }];
}

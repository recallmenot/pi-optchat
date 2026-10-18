import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, lstatSync, linkSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import { estimateTokens, getAgentDir, loadProjectContextFiles, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { atomicWrite } from './store.ts';
import { isAtWork } from './cache.ts';
import type { Pin } from './pins.ts';
import { PINNING } from './prompts.ts';

export const GUIDANCE_STATE = 'optchat.guidance';
const LIMIT = 1_000_000;
const CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const normalize = (text: string) => text.replace(/^\uFEFF/, '');
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export interface GuidanceSource { path: string; scope: string; content: string; supplied: string; modified: string; pin?: Pin }
export interface GuidanceFile { path: string; scope: string; version: string; archive: string; supplied: string; pin?: Pin }
export interface PinIssue { pin: Pin; reason: string }
export interface GuidanceRevision { id: string; files: GuidanceFile[]; unavailable?: PinIssue[] }
interface Transition { before: string; after: string; anchor: string; occurrence?: number }
export interface GuidanceState { revision: GuidanceRevision; transitions: Transition[] }

/** Read once through one handle. Never truncate, silently fall back, or mistake a failed read for deletion. */
export function readSource(path: string, scope: string): GuidanceSource | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A dangling symlink is a broken source, not a deliberate removal.
      try { lstatSync(path); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined; }
    }
    throw new Error(`Cannot read current guidance ${path}: ${String(error)}`);
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('not a regular file');
    if (before.size > LIMIT) throw new Error(`exceeds ${LIMIT.toLocaleString('en-US')} bytes; no partial guidance will be sent`);
    const buffer = Buffer.alloc(Math.min(before.size + 1, LIMIT + 1));
    const length = readSync(fd, buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, length), after = fstatSync(fd);
    if (bytes.length > LIMIT || bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('changed while being read; retry the request');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (scope.startsWith('pin') && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) throw new Error('not supported UTF-8 text (binary/control bytes)');
    return { path: resolve(path), scope, content, supplied: normalize(content), modified: after.mtime.toISOString() };
  } catch (error) { throw new Error(`Cannot read current guidance ${path}: ${String(error)}`); }
  finally { closeSync(fd); }
}

/** A registration names a canonical target, not a symlink whose destination can later change. */
export function readPinnedSource(path: string, scope = 'pin') {
  const source = readSource(path, scope);
  if (source && realpathSync(path) !== resolve(path)) throw new Error('canonical path now redirects to another file; unpin and explicitly register the intended source');
  return source;
}

/** Match Pi's candidate priority, global → ancestors → cwd ordering and linked-worktree shadowing.
 * Pi's loader warns and skips unreadable sources; preflight prevents that weaker guarantee here. */
export function currentGuidance(cwd: string, profile: string, agentDir = getAgentDir(), discover = true): GuidanceSource[] {
  const archived = (path: string) => {
    const part = relative(join(profile, 'guidance', 'sources'), resolve(path));
    return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
  };
  const dirs = new Set(discover ? [resolve(agentDir)] : []);
  if (discover) for (let dir = resolve(cwd); ; dir = dirname(dir)) { dirs.add(dir); if (dirname(dir) === dir) break; }
  const checked = new Map<string, GuidanceSource>();
  for (const dir of dirs) {
    if (archived(dir)) continue;
    for (const name of CANDIDATES) {
      const source = readSource(join(dir, name), dir === resolve(agentDir) ? 'global' : `project:${dir}`);
      if (source) { checked.set(source.path, source); break; }
    }
  }
  const files = (discover ? loadProjectContextFiles({ cwd, agentDir }) : []).filter(file => !archived(file.path)).map(file => {
    const source = checked.get(resolve(file.path));
    if (!source || source.supplied !== file.content) throw new Error(`Guidance changed during discovery: ${file.path}; retry the request`);
    return source;
  });
  const personal = readSource(join(profile, 'AGENTS.md'), `profile:${resolve(profile)}`);
  if (personal) {
    // Profile instructions have always followed project instructions, even when the profile is the cwd.
    const duplicate = files.findIndex(file => file.path === personal.path);
    if (duplicate >= 0) files.splice(duplicate, 1);
    files.push(personal);
  }
  if (files.reduce((sum, file) => sum + Buffer.byteLength(file.supplied), 0) > LIMIT)
    throw new Error(`Current guidance exceeds ${LIMIT.toLocaleString('en-US')} bytes in total; no partial guidance will be sent`);
  return files;
}

/** Immutable, human-readable source copies. Metadata and supplied text are separate from the original bytes. */
export class GuidanceArchive {
  readonly directory: string;
  constructor(profile: string) { this.directory = join(profile, 'guidance'); }
  preserve(sources: GuidanceSource[], unavailable: PinIssue[] = []): GuidanceRevision {
    const files = sources.map(source => {
      const version = hash(source.content);
      const label = source.path.replace(/[^a-zA-Z0-9._-]+/g, '%').slice(-48);
      const dir = join(this.directory, 'sources', `${label}-${hash(source.path).slice(0, 16)}`, version);
      const archive = join(dir, basename(source.path));
      const supplied = source.content === source.supplied ? archive : join(dir, 'supplied.txt');
      const keep = (path: string, text: string) => {
        const object = join(this.directory, 'contents', `${hash(text)}.txt`);
        if (existsSync(object)) { if (readFileSync(object, 'utf8') !== text) throw new Error(`Damaged guidance content: ${object}`); }
        else atomicWrite(object, text);
        if (existsSync(path)) { if (readFileSync(path, 'utf8') !== text) throw new Error(`Damaged guidance archive: ${path}`); }
        else {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          linkSync(object, path); // Same bytes once, with a recognizable name at every original source location.
        }
      };
      keep(archive, source.content);
      if (supplied !== archive) keep(supplied, source.supplied);
      const metadata = join(dir, 'metadata.json');
      if (!existsSync(metadata)) atomicWrite(metadata, JSON.stringify({ source: source.path, version, modified: source.modified,
        captured: new Date().toISOString(), transformation: supplied === archive ? 'none' : 'leading UTF-8 BOM removed', supplied: basename(supplied) }, null, 2));
      return { path: source.path, scope: source.scope, version, archive, supplied, ...(source.pin ? { pin: source.pin } : {}) };
    });
    const stored = files.map(file => ({ ...file, archive: relative(this.directory, file.archive).split('\\').join('/'), supplied: relative(this.directory, file.supplied).split('\\').join('/') }));
    const issues = unavailable.length ? { unavailable } : {};
    const id = hash(JSON.stringify(unavailable.length ? { files: stored, unavailable } : stored));
    const file = join(this.directory, 'revisions', `${id}.json`), text = JSON.stringify({ id, files: stored, ...issues }, null, 2);
    if (existsSync(file)) { if (readFileSync(file, 'utf8') !== text) throw new Error(`Damaged guidance revision: ${file}`); }
    else atomicWrite(file, text);
    return { id, files, ...issues };
  }
  revision(id: string): GuidanceRevision {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid guidance revision');
    const revision = JSON.parse(readFileSync(join(this.directory, 'revisions', `${id}.json`), 'utf8')) as GuidanceRevision;
    if (revision.id !== id || hash(JSON.stringify(revision.unavailable?.length ? { files: revision.files, unavailable: revision.unavailable } : revision.files)) !== id) throw new Error(`Damaged guidance revision: ${id}`);
    const locate = (path: string) => {
      if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`Invalid guidance archive path: ${path}`);
      return join(this.directory, path);
    };
    const files = revision.files.map(file => ({ ...file, archive: locate(file.archive), supplied: locate(file.supplied) }));
    for (const file of files) {
      const raw = readFileSync(file.archive, 'utf8');
      if (hash(raw) !== file.version || readFileSync(file.supplied, 'utf8') !== normalize(raw)) throw new Error(`Damaged historical guidance: ${file.archive}`);
    }
    return { ...revision, files };
  }
}

const quote = (text: string) => JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 160));
/** Mechanical excerpts, never a guessed semantic summary. Counts make broader edits explicit. */
function difference(before: GuidanceRevision, after: GuidanceRevision) {
  const changes: string[] = [];
  for (const old of before.files) {
    const next = after.files.find(file => file.path === old.path);
    if (!next) { changes.push(after.unavailable?.some(issue => issue.pin.path === old.path) ? `${old.path} is unavailable; its current contents are NOT supplied`
      : old.pin ? `${old.path} is no longer pinned; this does not mean deletion or revoked requirements` : `${old.path} no longer applies`); continue; }
    if (old.pin?.block !== next.pin?.block && old.pin && next.pin) changes.push(`Moved ${old.path} from ${old.pin.block} to ${next.pin.block}; placement does not change authority`);
    if (JSON.stringify(old.pin) !== JSON.stringify(next.pin) && old.pin?.block === next.pin?.block) changes.push(`${old.path}: registration scope, kind or purpose changed`);
    if (old.version !== next.version) {
      const a = readFileSync(old.supplied, 'utf8').split('\n'), b = readFileSync(next.supplied, 'utf8').split('\n');
      const oldLines = new Set(a), newLines = new Set(b);
      const removed = a.filter(line => line.trim() && !newLines.has(line)), added = b.filter(line => line.trim() && !oldLines.has(line));
      changes.push(`${old.path}: ${removed.length || added.length ? `${removed.length} previous lines absent from current text and ${added.length} current lines absent from previous text` : 'line ordering, repetition or whitespace changed'} (previous excerpt ${quote(removed[0] ?? a.join('\n'))}; current excerpt ${quote(added[0] ?? b.join('\n'))}; excerpts are not an exhaustive description)`);
    }
  }
  for (const file of after.files) if (!before.files.some(old => old.path === file.path)) changes.push(`${file.path} ${file.pin ? 'is now supplied as pinned context (no earlier supplied version is implied)' : 'now applies'}`);
  for (const issue of after.unavailable ?? []) if (!before.unavailable?.some(old => JSON.stringify(old) === JSON.stringify(issue))) changes.push(`${issue.pin.path}: ${issue.reason}`);
  for (const issue of before.unavailable ?? []) if (!after.unavailable?.some(next => next.pin.path === issue.pin.path) && !after.files.some(file => file.path === issue.pin.path))
    changes.push(`${issue.pin.path} is no longer pinned; this does not mean deletion or revoked requirements`);
  if (JSON.stringify(before.files.map(f => [f.path, f.scope])) !== JSON.stringify(after.files.map(f => [f.path, f.scope])))
    changes.push('the applicable sources, scopes or ordering changed');
  return `${changes.slice(0, 4).join('; ')}${changes.length > 4 ? `; ${changes.length - 4} additional source/order changes (consult the full revisions)` : ''}.`;
}

/** Source bytes can change without changing supplied instructions (for example, adding a BOM). */
function sameEffectiveGuidance(before: GuidanceRevision, after: GuidanceRevision) {
  return JSON.stringify(before.unavailable ?? []) === JSON.stringify(after.unavailable ?? []) && before.files.length === after.files.length && before.files.every((old, index) => {
    const next = after.files[index];
    return old.path === next.path && old.scope === next.scope && JSON.stringify(old.pin) === JSON.stringify(next.pin) &&
      (old.version === next.version || readFileSync(old.supplied, 'utf8') === readFileSync(next.supplied, 'utf8'));
  });
}

export function guidanceKey(message: AgentMessage) {
  return hash(JSON.stringify(message));
}
export function guidanceState(ctx: ExtensionContext): GuidanceState | undefined {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === GUIDANCE_STATE);
  if (!entry || entry.type !== 'custom') return undefined;
  const state = entry.data as GuidanceState;
  if (!state?.revision?.id || !Array.isArray(state.transitions)) throw new Error('Invalid saved guidance state');
  return state;
}

/** Project guidance is independent of the prompt Pi cached at turn start. Strip its original injection at construction. */
export function guidancePrompt(prompt: string, sources: GuidanceSource[]) {
  return `${prompt}\n\n${PINNING}\n\n<optchat_guidance block="pre-memory">\nCurrent applicable guidance, in established source order. A newer revision supersedes that source's older revision; it does not override explicit user instructions. Historical copies explain earlier work and do not become current instructions.\n${sources.map(source => `<project_instructions path="${xml(source.path)}" scope="${xml(source.scope)}">\n${source.supplied}\n</project_instructions>`).join('\n\n')}\n</optchat_guidance>`;
}

function pinBlock(block: Pin['block'], sources: GuidanceSource[], unavailable: PinIssue[]) {
  const attrs = (p: Pin) => `path="${xml(p.path)}" kind="${p.kind}" scope="${p.scope}" project="${xml(p.project)}"${p.owner ? ` owner="${xml(p.owner)}"` : ''} purpose="${xml(p.purpose)}"`;
  const files = sources.filter(s => s.pin?.block === block).map(s => `<pinned_file ${attrs(s.pin!)}>\n${s.supplied}\n</pinned_file>`);
  const issues = unavailable.filter(i => i.pin.block === block).map(i => `<unavailable_pin ${attrs(i.pin)}>\nUNAVAILABLE: ${xml(i.reason)}. No contents supplied; repair or unpin before dependent work.\n</unavailable_pin>`);
  return `<pinned_files block="${block}">\n${[...files, ...issues].join('\n\n') || '(no manually pinned files in this block)'}\n</pinned_files>`;
}

/** Split the memory/task boundary without putting any injected text into canonical messages or tool results. */
function postMemory(messages: AgentMessage[], text: string): AgentMessage[] {
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user') continue;
    const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    const first = content[0];
    if (first?.type !== 'text' || !first.text.startsWith('<chat>\n')) continue;
    const task = first.text.indexOf('\n</chat>\n\nYour task:\n');
    const end = task >= 0 ? task + '\n</chat>'.length : first.text.endsWith('\n</chat>') ? first.text.length : -1;
    if (end < 0) continue;
    return messages.map((m, i) => i === index ? { ...message, content: [{ type: 'text', text: first.text.slice(0, end) },
      { type: 'text', text: `\n\n${text}` }, ...(first.text.slice(end) ? [{ type: 'text' as const, text: first.text.slice(end) }] : []), ...content.slice(1)] } : m);
  }
  // After Pi compaction, the summary replaces the old memory/task prefix. Never insert between a tool call and its result.
  const summary = messages.findLastIndex(m => m.role === 'compactionSummary' || m.role === 'branchSummary');
  const at = summary >= 0 ? summary + 1 : messages.findIndex(m => m.role !== 'system');
  const marker: AgentMessage = { role: 'custom', customType: 'optchat-pinned-files', display: false, content: text, timestamp: 0 };
  return [...messages.slice(0, at < 0 ? messages.length : at), marker, ...messages.slice(at < 0 ? messages.length : at)];
}

export interface PinnedContext { files: Pin[]; model?: { contextWindow: number; maxTokens: number } }
/** Estimates include both blocks, existing work, system/tool schemas and room for a reply. No partial file is ever admitted. */
function pinSources(pins: PinnedContext, messages: AgentMessage[], automatic: GuidanceSource[], overhead = 0) {
  const sources: GuidanceSource[] = [], unavailable: PinIssue[] = [];
  if (!pins.files.length) return { sources, unavailable };
  const identities = automatic.map(source => { try { return realpathSync(source.path); } catch { return source.path; } });
  for (const pin of pins.files) {
    if (identities.includes(pin.path)) continue; // Automatic guidance is always pre-memory, once, including symlink aliases.
    try {
      const source = readPinnedSource(pin.path, `pin:${pin.scope}:${pin.owner ?? pin.project}`);
      if (!source) throw new Error('source is missing; restore it or unpin the old path and pin the new one');
      sources.push({ ...source, pin });
    } catch (error) { unavailable.push({ pin, reason: String(error) }); }
  }
  const bytes = Buffer.byteLength(pinBlock('pre-memory', sources, unavailable) + pinBlock('post-memory', sources, unavailable));
  const window = pins.model?.contextWindow;
  // Pi's estimator includes images and tool schemas. A 25% margin and a two-bytes/token pin estimate cover denser prose/code.
  const base = overhead + Math.ceil(messages.reduce((sum, message) => sum + estimateTokens(message), 0) * 1.25) + Math.ceil(Buffer.byteLength(automatic.map(s => s.supplied).join('\n') + PINNING) / 2);
  const reserve = window ? Math.min(pins.model!.maxTokens || 8192, Math.floor(window / 4)) + Math.ceil(window / 10) : 0;
  const available = window ? Math.max(0, window - base - reserve) : Infinity;
  if (sources.length && (bytes > LIMIT || pins.files.length > 32 || Math.ceil(bytes / 2) > available)) {
    const reason = bytes > LIMIT || pins.files.length > 32 ? `combined pins exceed the 1 MB / 32-file safety limit`
      : 'combined pins exceed available context after memory, work, tools and reply headroom; reduce pins, refresh work or use a larger model';
    unavailable.push(...sources.map(source => ({ pin: source.pin!, reason })));
    sources.length = 0;
  }
  return { sources, unavailable };
}

// Pi maps hidden custom context to the provider's user-compatible role, including APIs that
// collapse later system messages into the head. It never enters the canonical session or memory.
function notice(content: string): AgentMessage {
  return { role: 'custom', customType: 'optchat-guidance-update', display: false,
    content: `<guidance_update>\nHarness-supplied guidance transition, not a new user task.\n${content}\n</guidance_update>`, timestamp: 0 };
}

export interface GuidanceOptions { agentDir?: string; discover?: boolean }

export class Guidance {
  readonly archive: GuidanceArchive;
  private agentDir = getAgentDir();
  /** A custom Pi agent directory is visible in its loaded global source. */
  configure(files: readonly { path: string; content: string }[], cwd: string) {
    const ancestors = new Set<string>();
    for (let dir = resolve(cwd); ; dir = dirname(dir)) { ancestors.add(dir); if (dir === dirname(dir)) break; }
    const global = files.find(file => !ancestors.has(dirname(resolve(file.path))));
    if (global && !this.options.agentDir) this.agentDir = dirname(resolve(global.path));
  }
  constructor(readonly profile: string, private readonly options: GuidanceOptions = {}) {
    this.archive = new GuidanceArchive(profile);
    this.agentDir = options.agentDir ?? getAgentDir();
  }
  current(cwd: string, agentDir?: string) { return currentGuidance(cwd, this.profile, agentDir ?? this.agentDir, this.options.discover); }
  private transitionText(transition: Transition) {
    const before = this.archive.revision(transition.before), after = this.archive.revision(transition.after);
    const changed = before.files.filter(old => !after.files.some(file => file.path === old.path && file.version === old.version && JSON.stringify(file.pin) === JSON.stringify(old.pin)));
    const paths = (changed.length ? changed : before.files).slice(0, 3).map(file => `${file.path} → ${file.supplied}`).join('\n') || '(no previous sources)';
    const all = before.files.length > 3 ? `\nAll previous sources in order: ${join(this.archive.directory, 'revisions', `${before.id}.json`)}` : '';
    return `Project guidance / pinned context has been updated directly in your context; ${after.unavailable?.length ? 'pins marked UNAVAILABLE have NO current contents supplied; pause dependent work and repair or unpin them' : 'the complete current contents are already supplied, so no manual reread is needed'}.\n${difference(before, after)}\nThis revision applies from this step onward; earlier work may reflect earlier instructions, requirements or plans and may need adaptation, but a difference alone does not establish an earlier instruction violation.\nPrevious guidance (historical copies):\n${paths}${all}\nOpen a previous copy only if needed to understand something relevant to continuing the task; it does not replace current guidance.`;
  }
  prepare(messages: AgentMessage[], cwd: string, previous: GuidanceState | undefined, save: (state: GuidanceState) => void, agentDir?: string, pins: PinnedContext = { files: [] }) {
    const head = getCurrentSystemMessage(messages);
    if (!head) throw new Error('Cannot inject guidance without a system prompt');
    if (previous) previous = { ...previous, revision: this.archive.revision(previous.revision.id) };
    const automatic = this.current(cwd, agentDir);
    // Existing notices are outside canonical work; include them in the budget plus room for a new transition.
    const notices = pins.files.length ? previous?.transitions.map(t => notice(this.transitionText(t))) ?? [] : [];
    const overhead = 1500 + Math.ceil(Buffer.byteLength(JSON.stringify(pins.files)) / 2);
    const pinned = pinSources(pins, [...messages, ...notices], automatic, overhead);
    pinned.sources.sort((a, b) => Number(a.pin!.block === 'post-memory') - Number(b.pin!.block === 'post-memory'));
    const sources = [...automatic, ...pinned.sources];
    const revision = this.archive.preserve(sources, pinned.unavailable);
    let state = previous;
    if (previous?.revision.id !== revision.id) {
      const keys = new Set(messages.filter(message => message.role !== 'system').map(guidanceKey));
      const earlier = previous?.transitions.findLast(t => !keys.has(t.anchor));
      const transitions = (previous?.transitions ?? []).filter(t => keys.has(t.anchor) || t === earlier);
      if (previous && !sameEffectiveGuidance(previous.revision, revision)) {
        const work = messages.filter(message => message.role !== 'system' && !isAtWork(message));
        const last = work.at(-1), anchor = last ? guidanceKey(last) : '';
        transitions.push({ before: previous.revision.id, after: revision.id, anchor, occurrence: work.filter(message => guidanceKey(message) === anchor).length - 1 });
      }
      state = { revision, transitions };
      save(state);
    }
    const output: AgentMessage[] = [{ role: 'system', content: `${guidancePrompt(getSystemMessageText(head), automatic)}\n\n${pinBlock('pre-memory', pinned.sources, pinned.unavailable)}`, toolsAdded: head.toolsAdded, timestamp: 0 }];
    const body = messages.filter(message => message.role !== 'system');
    const keys = body.map(guidanceKey);
    // Once a boundary leaves the visible work, retain the latest such transition, explicitly as history.
    const historical = state!.transitions.findLast(transition => keys.filter(key => key === transition.anchor).length <= (transition.occurrence ?? 0));
    const occurrences = new Map<string, number>();
    for (const [index, message] of body.entries()) {
      output.push(message);
      if (index === 0 && historical) output.push(notice(`Earlier guidance transition (already applied, not a new change):\n${this.transitionText(historical)}`));
      const occurrence = occurrences.get(keys[index]) ?? 0; occurrences.set(keys[index], occurrence + 1);
      for (const transition of state!.transitions) if (transition.anchor === keys[index] && occurrence === (transition.occurrence ?? 0))
        output.push(notice(this.transitionText(transition)));
    }
    const hasPost = pinned.sources.some(s => s.pin!.block === 'post-memory') || pinned.unavailable.some(i => i.pin.block === 'post-memory');
    return { messages: hasPost ? postMemory(output, pinBlock('post-memory', pinned.sources, pinned.unavailable)) : output, revision };
  }
}

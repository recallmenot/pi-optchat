// Publish only synthetic evidence/results, never raw sessions or hidden reasoning.
// node --import tsx test/subagent-compaction-analysis.ts <output.json> <run-directory>...
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { serializeConversation } from '@earendil-works/pi-coding-agent';
import { makeFixture, type Audit } from './subagent-compaction-fixture.ts';
import { runTranscript, textContent } from '../src/transcript.ts';

/** Score only observed facts; absent future evidence must not count as forgetting. */
export function gradeObserved(audit: Audit, packets: string[], indices: readonly number[]) {
  const expected = new Map<string, Record<string, unknown>>();
  for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
    const line = packets[index].split('\n').find(s => s.startsWith('DECISION_EVENT ')); assert.ok(line);
    const event = JSON.parse(line.slice('DECISION_EVENT '.length));
    expected.set(event.service, { ...expected.get(event.service), ...event.changes });
  }
  let correct = 0, total = 0;
  const mistakes: { service: string; field: string; expected: unknown; actual: unknown }[] = [];
  for (const [service, fields] of expected) {
    const matching = audit.services.filter(s => s.service === service);
    const row = matching.length === 1 ? matching[0] : undefined;
    for (const [field, value] of Object.entries(fields)) {
      total++;
      const got = row?.[field as keyof typeof row];
      if (got === value) correct++;
      else mistakes.push({ service, field, expected: value, actual: got ?? null });
    }
  }
  return { correct, total, mistakes };
}

/** Replay successful tool results so repeated reads do not shift checkpoint boundaries. */
export function observedCheckpoints(messages: AgentMessage[]) {
  const reads = new Set<number>();
  const calls = new Map<string, { name: string; arguments: unknown }>();
  const checkpoints: { indices: number[]; audit: Audit }[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'toolCall') calls.set(block.id, block);
    } else if (message.role === 'toolResult' && !message.isError) {
      if (message.toolName === 'read_packet') {
        const match = textContent(message.content).match(/^EVIDENCE PACKET (\d+) of /); assert.ok(match);
        reads.add(Number(match[1]));
      } else if (message.toolName === 'checkpoint') {
        const call = calls.get(message.toolCallId); assert.equal(call?.name, 'checkpoint');
        checkpoints.push({ indices: [...reads].sort((a, b) => a - b), audit: call!.arguments as Audit });
      }
    }
  }
  return checkpoints;
}

function analyze(directory: string) {
  const read = (name: string) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
  const data = read('results.json'), protocol = read('protocol.json');
  const fixture = makeFixture(data.seed); assert.equal(fixture.sha256, data.fixtureSha256);
  const comparable = new Map<string, { indices: number[]; on?: ReturnType<typeof gradeObserved>; off?: ReturnType<typeof gradeObserved> }>();
  const successfulReads = (messages: AgentMessage[]) => messages.flatMap(message => {
    if (message.role !== 'toolResult' || message.toolName !== 'read_packet' || message.isError) return [];
    const match = textContent(message.content).match(/^EVIDENCE PACKET (\d+) of /); assert.ok(match);
    return [Number(match[1])];
  });
  const recovery = data.recovery.map((r: any) => {
    const arm = data.arms.find((a: any) => r.label.startsWith(a.label)); assert.ok(arm);
    const snapshot = read(`${arm.label}/snapshots.json`)[r.stage];
    return { ...r, attemptedPackets: r.packetsRead, packetsRead: new Set(successfulReads(snapshot.retained)).size };
  });
  const arms = data.arms.map((arm: any) => {
    const snapshots = read(`${arm.label}/snapshots.json`);
    const successful = successfulReads(snapshots.finished.retained), unique = new Set(successful);
    const checkpoints = observedCheckpoints(snapshots.finished.retained);
    assert.deepEqual(checkpoints.map(c => c.audit), arm.checkpoints.map((c: any) => c.audit));
    const grades = checkpoints.map(c => {
      const grade = gradeObserved(c.audit, fixture.packets, c.indices);
      const key = c.indices.join(','), pair = comparable.get(key) ?? { indices: c.indices };
      pair[arm.enabled ? 'on' : 'off'] = grade; comparable.set(key, pair);
      return { read: c.indices.length, completeClaim: c.audit.complete, ...grade };
    });
    const visibility = ['live', 'finished'].flatMap(stage => {
      const snapshot = snapshots[stage];
      if (!snapshot) return [];
      const indices = [...new Set(successfulReads(snapshot.retained))];
      return ['current', 'retained'].map(source => {
        const formatted = runTranscript(snapshot[source]);
        return { stage, source, packets: indices.length,
          receipts: indices.filter(i => formatted.includes(fixture.receipts[i])).length,
          evidenceTags: indices.filter(i => formatted.includes(fixture.evidenceTags[i])).length };
      });
    });
    const requests = data.usage.filter((u: any) => u.role === `${arm.label}:subagent` || u.role === `${arm.label}:subagent:pi-compaction`);
    const sum = (field: string) => requests.reduce((n: number, u: any) => n + u.usage[field], 0);
    return { label: arm.label, compaction: arm.enabled, state: arm.state, readCalls: arm.reads.length,
      uniquePackets: unique.size, repeatedReads: successful.length - unique.size,
      successfulReadCalls: successful.length, failedReadCalls: arm.reads.length - successful.length,
      elapsedMs: arm.elapsedMs, successfulCompactions: arm.compactions.filter((c: any) => c.result).length,
      compactions: arm.compactions.map((c: any) => ({ read: c.read, reason: c.reason, success: !!c.result, aborted: c.aborted, error: c.error })),
      grade: data.grades.find((g: any) => g.label === arm.label), checkpointGrades: grades,
      finalAudit: arm.checkpoints.at(-1)?.audit ?? null, report: arm.report, warnings: arm.warnings,
      usage: { requests: requests.length, input: sum('input'), cacheRead: sum('cacheRead'), output: sum('output'), totalTokens: sum('totalTokens') }, visibility };
  });
  const summaryInput = serializeConversation(fixture.packets.map((text, i) => ({ role: 'toolResult' as const,
    toolCallId: `read-${i}`, toolName: 'read_packet', content: [{ type: 'text' as const, text }], isError: false, timestamp: 0 })));
  return { seed: data.seed, fixtureSha256: data.fixtureSha256, protocol, completed: data.completed,
    piSummaryToolResultSerialization: { packets: fixture.packets.length,
      receipts: fixture.receipts.filter(s => summaryInput.includes(s)).length,
      decisionEvents: fixture.evidenceTags.filter(s => summaryInput.includes(s)).length },
    order: arms.map((a: any) => a.compaction ? 'on' : 'off'), arms,
    commonEvidenceCheckpoints: [...comparable.values()].filter(c => c.on && c.off).map(c => ({
      packets: c.indices.length, indices: c.indices, on: c.on, off: c.off })),
    parentRecovery: recovery, requests: data.usage, totals: data.totals };
}

// Keep numerical records and service rows on individual lines for reviewable diffs.
function format(value: unknown, key = '', indent = ''): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    if (value.every(v => v === null || typeof v !== 'object')) return JSON.stringify(value);
    const inline = ['requests', 'services', 'mistakes', 'rows', 'checkpointGrades', 'visibility', 'compactions'].includes(key);
    return `[\n${value.map(v => indent + '  ' + (inline ? JSON.stringify(v) : format(v, '', indent + '  '))).join(',\n')}\n${indent}]`;
  }
  return `{\n${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) =>
    `${indent}  ${JSON.stringify(k)}: ${format(v, k, indent + '  ')}`).join(',\n')}\n${indent}}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [destination, ...directories] = process.argv.slice(2);
  assert.ok(destination && directories.length, 'Pass output.json and completed run directories.');
  const pairs = directories.map(analyze);
  writeFileSync(destination, format({ kind: 'OpenAI-based synthetic compaction pilot',
    upstream: '594287450ee37cd630f29ffbb4e6ba862f9259f4',
    limitations: ['Three seeded variants of one synthetic workload; not a general coding benchmark.',
      'Application guard at Pi-configured 272K window; not a measured OpenAI native context limit.',
      'Parent live tests replay frozen snapshots; off live snapshot is captured at termination.',
      'Candidate changes only message source, preserving existing per-step clipping.',
      'Cost fields are SDK API-price estimates, not subscription charges.'], pairs }) + '\n');
}

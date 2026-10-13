import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeAudit, makeFixture } from './subagent-compaction-fixture.ts';
import { runTranscript } from '../src/transcript.ts';
import { gradeObserved, observedCheckpoints } from './subagent-compaction-analysis.ts';
import { serializeConversation } from '@earendil-works/pi-coding-agent';

test('the frozen live workload contains all decision evidence, including late corrections', () => {
  const fixture = makeFixture(20261013);
  assert.equal(fixture.sha256, 'd6d6c7742c494f75acbb55743df451a1e514bae79251ab2517bfd5760faf4e02');
  assert.equal(fixture.packets.length, 120);
  const states = new Map<string, Record<string, unknown>>();
  for (const [i, packet] of fixture.packets.entries()) {
    assert.ok(packet.includes(fixture.receipts[i]));
    const line = packet.split('\n').find(line => line.startsWith('DECISION_EVENT ')); assert.ok(line);
    const event = JSON.parse(line.slice('DECISION_EVENT '.length));
    assert.equal(event.evidenceTag, fixture.evidenceTags[i]);
    states.set(event.service, { ...states.get(event.service), ...event.changes });
  }
  for (const row of fixture.expected.services) {
    const { service, decision, blockingReasons, ...facts } = row;
    assert.deepEqual(states.get(service), facts, 'the answer key must match the evidence actually sent to the model');
  }
  assert.deepEqual(fixture.expected.services.filter(s => s.decision === 'GO').map(s => s.service), ['service-01', 'service-03']);
  const evidence = { role: 'toolResult' as const, toolCallId: 'test', toolName: 'read_packet', isError: false,
    content: [{ type: 'text' as const, text: fixture.packets[0] }], timestamp: 0 };
  const rendered = runTranscript([evidence]);
  assert.ok(rendered.includes(fixture.receipts[0]));
  assert.ok(!rendered.includes(fixture.evidenceTags[0]), 'the middle question measures the existing per-step clipping');
  const summaryInput = serializeConversation([evidence]);
  assert.ok(summaryInput.includes(fixture.packets[0].slice(0, 2000)));
  assert.ok(summaryInput.includes('more characters truncated'));
  assert.ok(!summaryInput.includes(fixture.evidenceTags[0]), 'Pi also clips this event out of its summarizer input');
});

test('blind grading is order independent and rejects missing, wrong or duplicate service answers', () => {
  const expected = makeFixture(20261013).expected;
  const reordered = structuredClone(expected);
  reordered.services.reverse(); reordered.services.forEach(s => s.blockingReasons.reverse());
  assert.equal(gradeAudit(reordered, expected).correct, 108);
  reordered.services[0].errorPct = 999;
  assert.equal(gradeAudit(reordered, expected).correct, 107);
  assert.equal(gradeAudit(null, expected).correct, 0);
  const duplicate = structuredClone(expected); duplicate.services.push(duplicate.services[0]);
  const grade = gradeAudit(duplicate, expected);
  assert.equal(grade.correct, 99); assert.equal(grade.duplicateRows, 1);
});

test('checkpoint comparison ignores unseen facts and counts repeated evidence only once', () => {
  const fixture = makeFixture(20261013), audit = structuredClone(fixture.expected);
  for (let i = 0; i < 12; i++) audit.services[i].release = `r13-${i}-a`;
  audit.services[0].errorPct = 999; // Unseen at this checkpoint, so it is not scored.
  assert.deepEqual(gradeObserved(audit, fixture.packets, [...Array(12).keys(), 0]), { correct: 12, total: 12, mistakes: [] });
  audit.services[0].release = 'wrong';
  assert.equal(gradeObserved(audit, fixture.packets, [...Array(12).keys()]).correct, 11);
  const checkpoints = observedCheckpoints([
    ...[0, 0, 1].map(i => ({ role: 'toolResult' as const, toolCallId: `read-${i}`, toolName: 'read_packet',
      content: [{ type: 'text' as const, text: fixture.packets[i] }], isError: false, timestamp: 0 })),
    { role: 'assistant', content: [{ type: 'toolCall', id: 'checkpoint-1', name: 'checkpoint', arguments: audit }],
      api: 'openai-responses', provider: 'openai', model: 'fixture', stopReason: 'toolUse', timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: 'toolResult', toolCallId: 'checkpoint-1', toolName: 'checkpoint', content: [{ type: 'text', text: 'Checkpoint recorded.' }], isError: false, timestamp: 0 },
  ]);
  assert.deepEqual(checkpoints, [{ indices: [0, 1], audit }]);
});

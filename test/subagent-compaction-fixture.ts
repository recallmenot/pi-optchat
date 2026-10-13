import { createHash } from 'node:crypto';

export const PACKETS = 120;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const number = (seed: number, service: number, field: string) => parseInt(hash(`${seed}:${service}:${field}`).slice(0, 8), 16);
export interface AuditRow {
  service: string; release: string; approvedRelease: string; errorPct: number; p95Ms: number;
  criticalVulns: number; rollbackVerified: boolean; freeze: boolean; decision: string; blockingReasons: string[];
}
export interface Audit { services: AuditRow[]; complete: boolean }
export const RULES = `Audit a synthetic release fleet. There are 12 services and 120 chronological evidence packets, indexed 0 through 119.
Each packet contains one authoritative DECISION_EVENT among routine request traces. Apply events in packet order; later updates replace only the fields they name. Request-trace diagnostics are not release decisions.
A service is GO only if its approvedRelease equals its current release, errorPct <= 1.0, p95Ms <= 200, criticalVulns = 0, rollbackVerified is true, and freeze is false.
Otherwise it is NO_GO. Use these blockingReasons exactly where applicable: approval_mismatch, error_budget, latency, security, rollback, freeze.
Read all 120 packets using read_packet, at most six calls in one batch. Do not skip evidence. After each group of 12 packets, submit your current audit with checkpoint; mark complete=false until all packets are read. A checkpoint records your work but does not validate it or offer a way to read it back.
After the final packet, submit complete=true with exactly one row for each service, including every required field and all blocking reasons. Then give a concise final report. Do not call other tools or request more work.`;

export function makeFixture(seed: number) {
  const initial = Array.from({ length: 12 }, (_, i) => ({ service: `service-${String(i).padStart(2, '0')}`,
    release: `r${seed % 100}-${i}-a`, approvedRelease: 'none', errorPct: 99, p95Ms: 999,
    criticalVulns: 99, rollbackVerified: false, freeze: true }));
  const states = initial.map(s => ({ ...s }));
  const receipts: string[] = [], evidenceTags: string[] = [], packets: string[] = [];
  for (let index = 0; index < PACKETS; index++) {
    const service = index % 12, round = Math.floor(index / 12), state = states[service], base = initial[service].release;
    // Late approval/error corrections and release changes require cross-packet reconciliation.
    const event = [
      { release: base },
      { errorPct: (number(seed, service, 'old-errors') % 35) / 10 },
      { p95Ms: 120 + number(seed, service, 'latency') % 150 },
      { approvedRelease: base },
      { criticalVulns: number(seed, service, 'vulns') % 5 === 0 ? 1 : 0 },
      { rollbackVerified: number(seed, service, 'rollback') % 5 !== 0 },
      { freeze: number(seed, service, 'freeze') % 6 === 0 },
      { approvedRelease: number(seed, service, 'approval') % 3 === 0 ? `${base}-next` : base },
      { errorPct: (number(seed, service, 'final-errors') % 17) / 10 },
      { release: number(seed, service, 'release') % 3 === 0 ? `${base}-next` : base },
    ][round];
    Object.assign(state, event);
    receipts.push(`receipt-${hash(`${seed}:${index}:receipt`).slice(0, 16)}`);
    evidenceTags.push(`evidence-${hash(`${seed}:${index}:evidence`).slice(0, 16)}`);
    const lines = [`EVIDENCE PACKET ${index} of ${PACKETS}; service=${state.service}; chronological revision=${round}`,
      `Receipt: ${receipts[index]}`, 'The following routine traces and one signed decision event are synthetic audit evidence.'];
    for (let row = 0; row < 72; row++) {
      if (row === 36) lines.push(`DECISION_EVENT ${JSON.stringify({ service: state.service, revision: round, evidenceTag: evidenceTags[index], changes: event })}`);
      const request = hash(`${seed}:${index}:${row}`).slice(0, 16);
      lines.push(`request=${request} shard=${row % 8} method=GET path=/health/cache/${row % 13} status=${row % 29 === 0 ? 503 : 200} duration_ms=${12 + row * 7 % 83} bytes=${1024 + row * 11} sampled=true source=edge-trace`);
    }
    lines.push(`END PACKET ${index}. Routine traces do not override the signed decision event.`);
    packets.push(lines.join('\n'));
  }
  const services = states.map(state => {
    const blockingReasons = [state.approvedRelease !== state.release ? 'approval_mismatch' : '', state.errorPct > 1 ? 'error_budget' : '',
      state.p95Ms > 200 ? 'latency' : '', state.criticalVulns !== 0 ? 'security' : '', !state.rollbackVerified ? 'rollback' : '', state.freeze ? 'freeze' : ''].filter(Boolean);
    return { ...state, decision: blockingReasons.length ? 'NO_GO' : 'GO', blockingReasons };
  });
  return { seed, packets, receipts, evidenceTags, expected: { services, complete: true } satisfies Audit,
    sha256: hash(JSON.stringify({ seed, task: RULES, packets })) };
}

/** Exact, condition-independent grading. No model judge sees compaction flags or run identities. */
export function gradeAudit(actual: unknown, expected: Audit) {
  const data = actual && typeof actual === 'object' ? actual as Partial<Audit> : {};
  const rows = Array.isArray(data.services) ? data.services : [];
  const fields = ['release', 'approvedRelease', 'errorPct', 'p95Ms', 'criticalVulns', 'rollbackVerified', 'freeze', 'decision', 'blockingReasons'] as const;
  const mistakes: { service: string; field: string; expected: unknown; actual: unknown }[] = [];
  let correct = 0, decisions = 0;
  for (const expectedRow of expected.services) {
    const matching = rows.filter(r => r && r.service === expectedRow.service);
    const row = matching.length === 1 ? matching[0] : undefined;
    for (const field of fields) {
      const want = expectedRow[field], got = row?.[field];
      const equal = Array.isArray(want) ? Array.isArray(got) && JSON.stringify([...got].sort()) === JSON.stringify([...want].sort()) : got === want;
      if (equal) { correct++; if (field === 'decision') decisions++; }
      else mistakes.push({ service: expectedRow.service, field, expected: want, actual: got ?? null });
    }
  }
  const expectedIds = new Set(expected.services.map(r => r.service));
  return { correct, total: expected.services.length * fields.length, decisionsCorrect: decisions, decisionsTotal: expected.services.length,
    completeClaim: data.complete === true, extraRows: rows.filter(r => !r || !expectedIds.has(r.service)).length,
    duplicateRows: rows.length - new Set(rows.map(r => r?.service)).size, mistakes };
}

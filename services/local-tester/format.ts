import { EvidenceSubmission, TaskAssignment, TesterProfile } from '../../src/types';
import { SAFETY_FORBIDDEN, detectUnsafe, effectiveTrustScore } from './index';

/**
 * Telegram formatters for the local-tester commands (EPIC 015):
 * /testers, /assignments, /submission_review, /tester_score. Pure, read-only.
 * Privacy-first: never echoes raw submission text that could leak data — it
 * surfaces status, trust and safety flags only. Nothing here approves/publishes.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const trustIcon = (l: string) =>
  l === 'trusted' ? '🟢' : l === 'high' ? '🔵' : l === 'medium' ? '🟡' : '🔴';
const statusIcon = (s: string) =>
  s === 'approved' ? '✅' : s === 'rejected' ? '❌' : s === 'needs_redaction' ? '🚫' : '🕒';

const footer =
  '\n\n<i>Testers propose evidence; a human reviewer decides. Unsafe evidence is blocked until redacted — nothing auto-approves or auto-publishes.</i>';

export function formatTesters(testers: TesterProfile[], now: Date = new Date()): string {
  if (!testers.length) return '🧑‍🔬 <b>Local testers</b>\n\nNone registered yet.' + footer;
  const lines = ['🧑‍🔬 <b>Local testers</b>', ''];
  for (const t of [...testers].sort((a, b) => effectiveTrustScore(b, now) - effectiveTrustScore(a, now))) {
    lines.push(
      `${trustIcon(t.trustLevel)} <b>${esc(t.nickname)}</b> <code>${esc(t.id)}</code> — ${esc(t.trustLevel)} (${effectiveTrustScore(t, now)})\n` +
        `   GEO ${t.geos.map(esc).join(',') || '—'} · ${t.specialties.map(esc).join(',') || 'general'} · ✅${t.approvedSubmissions} ❌${t.rejectedSubmissions} 🚫${t.unsafeSubmissions}`,
    );
  }
  return lines.join('\n') + footer;
}

export function formatAssignments(assignments: TaskAssignment[]): string {
  if (!assignments.length) return '📨 <b>Tester assignments</b>\n\nNo open tasks.' + footer;
  const lines = ['📨 <b>Tester assignments</b>', ''];
  assignments.slice(0, 14).forEach((a, i) => {
    const who = a.unassigned ? '⚠️ UNASSIGNED' : `→ ${esc(a.nickname ?? a.testerId ?? '')}`;
    lines.push(
      `${i + 1}. <b>${esc(a.task.exchange)}/${esc(a.task.topic)}/${esc(a.task.geo)}</b> · ${esc(a.task.stepId)} ${who} (match ${a.matchScore})\n` +
        `   🔎 ${esc(a.task.whatToTest)}\n` +
        `   🧠 ${a.reasons.map(esc).join(' · ')}`,
    );
  });
  return lines.join('\n') + footer;
}

export function formatSubmissionReview(subs: EvidenceSubmission[]): string {
  const pending = subs.filter((s) => s.status === 'pending_review' || s.status === 'needs_redaction');
  if (!pending.length) return '📥 <b>Submissions to review</b>\n\nNothing pending.' + footer;
  const lines = ['📥 <b>Submissions to review</b>', ''];
  for (const s of pending) {
    const safety = detectUnsafe(s);
    const flag = safety.unsafe ? `🚫 unsafe: ${esc(safety.reasons.join('; '))}` : '🔒 safe-scan clear';
    lines.push(
      `${statusIcon(s.status)} <code>${esc(s.id)}</code> · ${esc(s.exchange)}/${esc(s.geo)} · tester ${esc(s.testerId)}\n` +
        `   flow: ${esc(s.testedFlow)} · suggests <b>${esc(s.evidenceLevelSuggested)}</b> · ${s.screenshotIds.length} screenshot(s)\n` +
        `   ${flag}`,
    );
  }
  lines.push('', '<b>Reviewer actions</b>: approve · reject · request_redaction · downgrade_evidence · request_retest');
  lines.push('<b>Always blocked</b>: ' + SAFETY_FORBIDDEN.map(esc).join(', '));
  return lines.join('\n') + footer;
}

export function formatTesterScore(tester: TesterProfile | undefined, now: Date = new Date()): string {
  if (!tester) return '📊 <b>Tester score</b>\n\nNot found. Usage: <code>/tester_score almaz_kz</code>' + footer;
  const total = tester.approvedSubmissions + tester.rejectedSubmissions;
  const ratio = total ? Math.round((tester.approvedSubmissions / total) * 100) : 0;
  return (
    `📊 <b>${esc(tester.nickname)}</b> <code>${esc(tester.id)}</code>\n\n` +
    `${trustIcon(tester.trustLevel)} Trust: <b>${tester.trustScore}</b> (${esc(tester.trustLevel)}) · effective ${effectiveTrustScore(tester, now)}\n` +
    `Accepted ${tester.approvedSubmissions} / rejected ${tester.rejectedSubmissions} (${ratio}% accepted) · unsafe ${tester.unsafeSubmissions}\n` +
    `GEO: ${tester.geos.map(esc).join(', ') || '—'} · specialties: ${tester.specialties.map(esc).join(', ') || 'general'}\n` +
    `Last active: ${esc(tester.lastActiveAt ?? 'never')}` +
    (tester.reviewerNotes ? `\nNotes: ${esc(tester.reviewerNotes)}` : '') +
    footer
  );
}

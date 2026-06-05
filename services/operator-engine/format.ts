import { OperatorReport } from '../../src/types';

/**
 * Telegram formatters for the operator commands (EPIC 010): /operator, /today,
 * /blocked, /health. Pure, READ-ONLY builders. Every view restates the
 * human-in-the-loop guarantee — the operator recommends, the human acts.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const healthIcon = (s: string) => (s === 'green' ? '🟢' : s === 'amber' ? '🟡' : '🔴');
const kindIcon = (k: string) =>
  ({ verify: '🔒', review_queue: '👀', create_draft: '✍️', tune: '🧠', investigate: '🔬', maintain: '🟢' } as Record<string, string>)[k] ?? '•';

const footer = '\n\n<i>Operator recommendations only — a human executes every action. No auto-publishing, no auto-approval, no autonomous writes.</i>';

function healthLines(r: OperatorReport): string[] {
  const h = r.health;
  return [
    `${healthIcon(h.status)} <b>System health: ${esc(h.status.toUpperCase())}</b>`,
    `verification conf avg ${h.verificationConfidenceAvg} · stale ${h.staleClaims} · unverified bonuses ${h.unverifiedBonuses}`,
    `queue active ${h.queueActive} · blocked ${h.queueBlocked} · published posts ${h.publishedPosts}`,
  ];
}

function actionLines(r: OperatorReport, limit = 8): string[] {
  if (!r.nextActions.length) return ['No actions.'];
  return r.nextActions.slice(0, limit).map(
    (a, i) =>
      `${i + 1}. ${kindIcon(a.kind)} <b>${esc(a.title)}</b> (prio ${a.priority})\n` +
      `   ${esc(a.reason)}${a.command ? ` · run <code>${esc(a.command)}</code>` : ''}`,
  );
}

export function formatOperator(r: OperatorReport): string {
  const lines = [
    '🎛 <b>Operator command center</b>',
    `${r.generatedAt.slice(0, 10)}`,
    '',
    ...healthLines(r),
    '',
    '<b>Next best actions</b>:',
    ...actionLines(r),
  ];
  if (r.draftOpportunities.length) {
    lines.push('', '<b>Draft opportunities</b>:');
    r.draftOpportunities.slice(0, 5).forEach((o) => lines.push(`  ✍️ ${esc(o.title)} (prio ${o.priority})`));
  }
  lines.push('', `<b>Queue</b>: ${Object.entries(r.queueStatus).map(([s, n]) => `${esc(s)} ${n}`).join(' · ') || '(empty)'}`);
  return lines.join('\n') + footer;
}

export function formatToday(r: OperatorReport): string {
  const lines = ['📅 <b>Today</b> — what to work on', '', '<b>Next best actions</b>:', ...actionLines(r)];
  if (r.draftOpportunities.length) {
    lines.push('', '<b>Draft opportunities</b>:');
    r.draftOpportunities.forEach((o) => lines.push(`  ✍️ ${esc(o.title)} (prio ${o.priority})${o.exchange ? ` · /draft ${esc(o.exchange)}` : ''}`));
  }
  return lines.join('\n') + footer;
}

export function formatBlocked(r: OperatorReport): string {
  const lines = ['🚧 <b>Blocked & stale</b>', ''];
  lines.push('<b>Verification-blocked queue items</b>:');
  if (r.blockedItems.length) {
    r.blockedItems.forEach((i) => lines.push(`  🔒 ${esc(i.title)} — needs ${esc(i.requiredVerification ?? '')}`));
  } else lines.push('  none');
  lines.push('', `<b>Stale verification claims</b> (${r.staleVerifications.length}):`);
  if (r.staleVerifications.length) {
    r.staleVerifications.slice(0, 12).forEach((id) => lines.push(`  🕒 <code>${esc(id)}</code>`));
    if (r.staleVerifications.length > 12) lines.push(`  …and ${r.staleVerifications.length - 12} more`);
  } else lines.push('  none');
  return lines.join('\n') + footer;
}

export function formatHealth(r: OperatorReport): string {
  const lines = ['🩺 <b>System health</b>', '', ...healthLines(r)];
  if (r.health.notes.length) {
    lines.push('', '<b>Notes</b>:');
    r.health.notes.forEach((n) => lines.push(`  • ${esc(n)}`));
  }
  return lines.join('\n') + footer;
}

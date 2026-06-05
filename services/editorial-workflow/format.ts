import { QueueItem, QueueReviewSummary } from '../../src/types';
import { generateDailyQueue, prioritize } from './index';

/**
 * Telegram formatters for the editorial workflow commands (EPIC 008): /queue,
 * /review, /next (and the /queue_add acknowledgement). Pure string builders.
 * Output always foregrounds the verification gate + the human-gate reminder.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const statusIcon = (s: string) =>
  ({ idea: '💡', draft_requested: '📝', drafted: '📄', in_review: '👀', approved: '✅', rejected: '❌', scheduled: '🗓', published: '📢' } as Record<string, string>)[s] ?? '•';

const sourceIcon = (s: string) =>
  ({ planner: '🧭', research: '🔬', verification: '🔒', optimization: '🧠', manual: '✍️' } as Record<string, string>)[s] ?? '•';

const gate = (i: QueueItem) =>
  i.requiredVerification ? (i.verificationCleared ? '🔓 verified' : `🔒 needs:${esc(i.requiredVerification)}`) : '';

const footer = '\n\n<i>Workflow tracks state only — a human approves and publishes. Nothing auto-advances or auto-posts.</i>';

function itemLine(i: QueueItem): string {
  const g = gate(i);
  return (
    `${statusIcon(i.status)}${sourceIcon(i.source)} <b>${esc(i.title)}</b>\n` +
    `   ${esc(i.status)} · prio ${i.priority} · ${esc(i.source)}${g ? ` · ${g}` : ''}\n` +
    `   🧠 ${esc(i.reason)}`
  );
}

export function formatQueue(items: QueueItem[], limit = 10): string {
  const active = prioritize(items);
  if (!active.length) return '🗂 <b>Editorial queue</b>\n\nQueue is empty.' + footer;
  const rows = active.slice(0, limit).map((i, idx) => `${idx + 1}. ${itemLine(i)}`);
  const more = active.length > limit ? `\n…and ${active.length - limit} more.` : '';
  return ['🗂 <b>Editorial queue</b> (active, prioritized)', '', ...rows].join('\n\n') + more + footer;
}

export function formatReview(summary: QueueReviewSummary): string {
  const counts = Object.entries(summary.byStatus)
    .map(([s, n]) => `${esc(s)} ${n}`)
    .join(' · ');
  const lines = ['👀 <b>Review-ready summary</b>', counts, ''];
  if (summary.reviewReady.length) {
    lines.push('<b>Awaiting decision</b>:');
    summary.reviewReady.slice(0, 8).forEach((i) => lines.push(`  ${statusIcon(i.status)} ${esc(i.title)} ${gate(i)}`));
  } else {
    lines.push('Nothing awaiting review.');
  }
  if (summary.blockedByVerification.length) {
    lines.push('', '<b>Blocked by verification</b>:');
    summary.blockedByVerification.slice(0, 8).forEach((i) =>
      lines.push(`  🔒 ${esc(i.title)} — needs ${esc(i.requiredVerification ?? '')}`),
    );
  }
  lines.push('', ...summary.notes.map((n) => `• ${esc(n)}`));
  return lines.join('\n');
}

export function formatNext(items: QueueItem[]): string {
  const next = generateDailyQueue(items, 1)[0];
  if (!next) return '⏭ <b>Next up</b>\n\nNothing actionable in the queue.' + footer;
  return ['⏭ <b>Next up</b>', '', itemLine(next)].join('\n') + footer;
}

export function formatAdded(result: { item: QueueItem; added: boolean }): string {
  if (!result.added) {
    return `↩️ Already in the queue (no duplicate added): <b>${esc(result.item.title)}</b> [${esc(result.item.status)}]`;
  }
  return `✅ Added to queue: <b>${esc(result.item.title)}</b>\n${esc(result.item.id)} · prio ${result.item.priority}`;
}

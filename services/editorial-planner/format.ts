import { EditorialPlan, EditorialTopic } from '../../src/types';

/**
 * Telegram formatters for the editorial planning commands (EPIC 005 · Phase 5):
 * /plan, /weekplan, /backlog. Pure string builders. Output is moderation-ready:
 * it always shows priority, confidence and the verification required before a
 * topic could be published — the planner recommends, the human decides.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const bandIcon = (b: string) => (b === 'high' ? '🟢' : b === 'medium' ? '🟡' : '🟠');
const verIcon = (s: string) => (s === 'verified' ? '🔒' : s === 'outdated' ? '🕒' : '⚠️');

function topicLine(t: EditorialTopic): string {
  return (
    `${bandIcon(t.priorityBand)} <b>${esc(t.title)}</b>\n` +
    `   ${esc(t.type)}${t.exchange ? ` · ${esc(t.exchange)}` : ''} · ${esc(t.locale)} · ` +
    `prio ${t.priority} · conf ${t.confidence} · ${verIcon(t.requiredVerification)} needs:${esc(
      t.requiredVerification,
    )}\n` +
    `   🧠 ${esc(t.reason)}`
  );
}

export function formatPlan(plan: EditorialPlan): string {
  const head = plan.period === 'weekly' ? '🗓 <b>Weekly editorial plan</b>' : '📋 <b>Daily editorial plan</b>';
  const mix = plan.contentMix
    .map((m) => `${esc(m.bucket)} ${m.selected}/${m.planned}`)
    .join(' · ');

  const lines = [
    head,
    `🌍 GEO: ${esc(plan.geoFocus)} · ${plan.generatedAt.slice(0, 10)}`,
    `⚖️ Mix: ${mix}`,
    '',
  ];
  if (plan.topics.length) {
    plan.topics.forEach((t, i) => lines.push(`${i + 1}. ${topicLine(t)}`, ''));
  } else {
    lines.push('No candidate topics — add data (analytics/bonuses/verification).', '');
  }
  if (plan.notes.length) {
    lines.push('<b>Notes</b>:');
    for (const n of plan.notes) lines.push(`• ${esc(n)}`);
  }
  return lines.join('\n');
}

export function formatBacklog(topics: EditorialTopic[], limit = 15): string {
  if (!topics.length) return '🗂 <b>Topic backlog</b>\n\nEmpty.';
  const rows = topics.slice(0, limit).map(
    (t, i) =>
      `${i + 1}. ${bandIcon(t.priorityBand)} <b>${esc(t.title)}</b> — ${esc(t.type)} · prio ${t.priority} · ${verIcon(
        t.requiredVerification,
      )}${esc(t.requiredVerification)}`,
  );
  const more = topics.length > limit ? `\n…and ${topics.length - limit} more.` : '';
  return ['🗂 <b>Topic backlog</b> (ranked)', '', ...rows].join('\n') + more;
}

import { OptimizationSnapshot, OptimizationSuggestion, SuggestionType } from '../../src/types';

/**
 * Telegram formatters for the optimization commands (EPIC 007): /insights,
 * /suggestions, /learn. Pure, READ-ONLY string builders. Output always reminds
 * the moderator that these are suggestions requiring human review — the system
 * changes nothing on its own.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const confIcon = (c: string) => (c === 'high' ? '🟢' : c === 'medium' ? '🟡' : '⚪');
const dirIcon = (d: string) =>
  d === 'increase' ? '⬆️' : d === 'decrease' ? '⬇️' : d === 'maintain' ? '➡️' : '🔍';

const footer = '\n\n<i>Recommendations only — human review required. No config, scoring or content is changed automatically.</i>';

function line(s: OptimizationSuggestion): string {
  return (
    `${confIcon(s.confidence)}${dirIcon(s.direction)} <b>${esc(s.target)}</b> (${esc(s.type)})\n` +
    `   ${esc(s.recommendation)}\n` +
    `   📊 ${esc(s.observation)} · conf ${esc(s.confidence)} · n=${s.sampleSize}`
  );
}

export function formatInsights(snap: OptimizationSnapshot): string {
  const byType = Object.entries(snap.summary.byType)
    .map(([t, n]) => `${esc(t)} ${n}`)
    .join(' · ');
  const lines = [
    '🧠 <b>Optimization insights</b>',
    `${snap.generatedAt.slice(0, 10)} · ${snap.summary.total} suggestion(s) · ${snap.summary.highConfidence} high-confidence`,
    byType ? `By type: ${byType}` : '',
    '',
  ];
  // Show the strongest few (already sorted high-confidence first).
  if (snap.suggestions.length) {
    snap.suggestions.slice(0, 6).forEach((s, i) => lines.push(`${i + 1}. ${line(s)}`, ''));
  } else {
    lines.push('No suggestions yet — need more published-post + verification data.', '');
  }
  if (snap.notes.length) {
    lines.push('<b>Notes</b>:');
    for (const n of snap.notes) lines.push(`• ${esc(n)}`);
  }
  return lines.join('\n');
}

export function formatSuggestions(snap: OptimizationSnapshot, type?: SuggestionType, limit = 15): string {
  const items = type ? snap.suggestions.filter((s) => s.type === type) : snap.suggestions;
  const head = `💡 <b>Suggestions${type ? ` — ${esc(type)}` : ''}</b>`;
  if (!items.length) return `${head}\n\nNone.${footer}`;
  const rows = items.slice(0, limit).map((s, i) => `${i + 1}. ${line(s)}`);
  return [head, '', ...rows].join('\n\n') + footer;
}

/** /learn — the engagement-pattern subset (successful vs weak). */
export function formatLearn(snap: OptimizationSnapshot): string {
  const patterns = snap.suggestions.filter((s) => s.type === 'engagement_pattern');
  const lines = ['📚 <b>Engagement-pattern learning</b>', ''];
  if (!patterns.length) {
    lines.push('No engagement patterns yet — collect more post metrics first.');
  } else {
    for (const p of patterns) lines.push(`${dirIcon(p.direction)} ${esc(p.recommendation)}`, `   📊 ${esc(p.observation)}`);
  }
  return lines.join('\n') + footer;
}

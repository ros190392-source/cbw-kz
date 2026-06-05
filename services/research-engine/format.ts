import { ResearchSnapshot } from '../../src/types';

/**
 * Telegram formatters for the research/intelligence commands (EPIC 006 ·
 * Phase 5): /research, /trends, /discoveries, /signals. Pure, READ-ONLY string
 * builders — they surface intelligence for a human, never an action.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const prioIcon = (p: string) => (p === 'HIGH' ? '🔴' : p === 'MEDIUM' ? '🟡' : '⚪');
const trustIcon = (t: string) => (t === 'trusted' ? '🟢' : t === 'weak' ? '🔴' : '🟡');
const statusIcon = (s: string) =>
  s === 'trending' ? '🔥' : s === 'undercovered' ? '🕳' : s === 'emerging' ? '🌱' : '➖';

const footer = '\n\n<i>Research only — human verification required. Nothing is published or added automatically.</i>';

export function formatResearch(snap: ResearchSnapshot, limit = 12): string {
  const c = snap.counts;
  const head = [
    '🔬 <b>Research findings</b>',
    `HIGH ${c.high} · MEDIUM ${c.medium} · LOW ${c.low}`,
    '',
  ];
  if (!snap.findings.length) return head.join('\n') + 'No findings.' + footer;
  const rows = snap.findings.slice(0, limit).map((f) => {
    const ex = f.exchanges.length ? ` · ${esc(f.exchanges.join(', '))}` : '';
    const geo = f.geos.length ? ` · ${esc(f.geos.join(','))}` : '';
    return (
      `${prioIcon(f.priority)} <b>${esc(f.title)}</b>\n` +
      `   ${esc(f.category)}${ex}${geo} · ${trustIcon(f.sourceTrust)} ${esc(f.source)} · conf ${f.confidence}`
    );
  });
  return head.join('\n') + rows.join('\n') + footer;
}

export function formatTrends(snap: ResearchSnapshot, limit = 12): string {
  if (!snap.trends.length) return '📈 <b>Trends</b>\n\nNo trends detected.' + footer;
  const rows = snap.trends.slice(0, limit).map(
    (t) =>
      `${statusIcon(t.status)} <b>${esc(t.key)}</b> (${esc(t.kind)}) — ${esc(t.status)} · momentum ${t.momentum} · ×${t.count}`,
  );
  return ['📈 <b>Trends</b>', '', ...rows].join('\n') + footer;
}

export function formatDiscoveries(snap: ResearchSnapshot, limit = 12): string {
  const safe = snap.discoveries.filter((d) => !d.rejected);
  const rejected = snap.discoveries.filter((d) => d.rejected);
  const lines = ['🧭 <b>Discoveries</b> (candidates for MANUAL review)', ''];
  if (!safe.length) lines.push('No new candidates.');
  for (const d of safe.slice(0, limit)) {
    lines.push(
      `• <b>${esc(d.name)}</b> (${esc(d.kind)}) · conf ${d.confidence} · risk ${d.scamRisk}\n` +
        `   ${esc(d.suggestedAction)}`,
    );
  }
  if (rejected.length) {
    lines.push('', `🚫 <b>Rejected (scam patterns): ${rejected.length}</b>`);
    for (const d of rejected.slice(0, 5)) lines.push(`   ✗ ${esc(d.name)} — risk ${d.scamRisk}`);
  }
  return lines.join('\n') + footer;
}

/** /signals — the actionable shortlist: HIGH findings + undercovered/emerging trends. */
export function formatSignals(snap: ResearchSnapshot, limit = 8): string {
  const high = snap.findings.filter((f) => f.priority === 'HIGH').slice(0, limit);
  const gaps = snap.trends.filter((t) => t.status === 'undercovered' || t.status === 'emerging').slice(0, limit);
  const lines = ['🚨 <b>Priority signals</b>', ''];
  lines.push('<b>HIGH-priority findings</b>:');
  if (high.length) {
    for (const f of high) lines.push(`  🔴 ${esc(f.title)} (${esc(f.category)} · conf ${f.confidence})`);
  } else lines.push('  none');
  lines.push('', '<b>Undercovered / emerging</b>:');
  if (gaps.length) {
    for (const t of gaps) lines.push(`  ${t.status === 'undercovered' ? '🕳' : '🌱'} ${esc(t.key)} (${esc(t.kind)})`);
  } else lines.push('  none');
  return lines.join('\n') + footer;
}

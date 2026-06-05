import { MergeGuardianReport } from '../../src/types';

/**
 * Telegram formatters for the merge-guardian commands (EPIC 012):
 * /merge_guardian, /pr_risk, /safe_to_merge. Pure, read-only. Every verdict
 * restates that auto-merge is NOT enabled — this is advisory only.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const verdictIcon = (v: string) =>
  v === 'SAFE_TO_AUTO_MERGE' ? '🟢' : v === 'REQUIRES_HUMAN_REVIEW' ? '🟡' : '🔴';
const riskBar = (r: number) => (r >= 85 ? '🔴' : r >= 40 ? '🟠' : r >= 20 ? '🟡' : '🟢');

const footer = '\n\n<i>Advisory only — real auto-merge is DISABLED. A human merges every PR.</i>';

export function formatGuardian(r: MergeGuardianReport): string {
  const lines = [
    `${verdictIcon(r.verdict)} <b>Merge Guardian — ${esc(r.verdict)}</b>`,
    `${esc(r.branch)} → ${esc(r.baseBranch)} · ${riskBar(r.riskScore)} risk ${r.riskScore}/100`,
    '',
  ];
  if (r.blockedReasons.length) {
    lines.push('<b>🔴 Blocked</b>:', ...r.blockedReasons.map((b) => `  • ${esc(b)}`), '');
  }
  lines.push('<b>Reasons</b>:', ...r.reasons.map((x) => `  • ${esc(x)}`));
  if (r.requiredHumanActions.length) {
    lines.push('', '<b>Required human actions</b>:', ...r.requiredHumanActions.map((a) => `  • ${esc(a)}`));
  }
  lines.push('', '<b>Checklist</b>:');
  for (const c of r.checklist) lines.push(`  ${c.ok ? '✅' : '❌'} ${esc(c.name)}${c.note ? ` (${esc(c.note)})` : ''}`);
  return lines.join('\n') + footer;
}

export function formatPrRisk(r: MergeGuardianReport): string {
  return [
    `${riskBar(r.riskScore)} <b>PR risk: ${r.riskScore}/100</b> · ${verdictIcon(r.verdict)} ${esc(r.verdict)}`,
    `${esc(r.branch)} → ${esc(r.baseBranch)}`,
    '',
    ...r.reasons.map((x) => `• ${esc(x)}`),
  ].join('\n') + footer;
}

export function formatSafeToMerge(r: MergeGuardianReport): string {
  const head =
    r.verdict === 'SAFE_TO_AUTO_MERGE'
      ? '🟢 <b>SAFE TO AUTO-MERGE</b> (policy-clean — but auto-merge is disabled)'
      : r.verdict === 'BLOCKED'
        ? '🔴 <b>BLOCKED</b>'
        : '🟡 <b>REQUIRES HUMAN REVIEW</b>';
  const detail = r.verdict === 'BLOCKED' ? r.blockedReasons : r.reasons;
  return [head, `${esc(r.branch)} → ${esc(r.baseBranch)} · risk ${r.riskScore}/100`, '', ...detail.map((x) => `• ${esc(x)}`)].join('\n') + footer;
}

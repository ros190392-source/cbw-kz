import { ManualTrustSummary, MissingEvidenceTask, ScreenshotRecord } from '../../src/types';
import { EVIDENCE_LEGEND, evidenceCoverageByExchange } from './index';
import { REDACTION_RULES, needsRedaction } from '../screenshot-registry';

/**
 * Telegram formatters for the evidence commands (EPIC 013): /evidence_levels,
 * /screenshots, /missing_evidence, /manual_trust. Pure, read-only. Output is
 * honesty-first — low evidence and redaction needs are surfaced, never hidden.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const levelIcon = (l: string) => (l === 'A' || l === 'B' ? '🟢' : l === 'C' ? '🟡' : l === 'D' ? '🟠' : '🔴');
const readyIcon = (r: string) => (r === 'ready' ? '🟢' : r === 'needs_review' ? '🟡' : '🔴');

const footer = '\n\n<i>Honesty over fake screenshots — low evidence is flagged, never hidden. Human review required; nothing auto-publishes.</i>';

export function formatEvidenceLevels(screenshots: ScreenshotRecord[]): string {
  const lines = ['🔎 <b>Evidence levels</b>', ''];
  for (const [, label] of Object.entries(EVIDENCE_LEGEND)) lines.push(`  ${esc(label)}`);
  const cov = evidenceCoverageByExchange(screenshots);
  lines.push('', '<b>Screenshot coverage by exchange</b>:');
  const entries = Object.entries(cov);
  if (!entries.length) lines.push('  (no screenshots captured yet — all claims rely on lower evidence)');
  for (const [ex, counts] of entries) {
    lines.push(`  • ${esc(ex)}: A${counts.A} B${counts.B} C${counts.C} D${counts.D} E${counts.E}`);
  }
  return lines.join('\n') + footer;
}

export function formatScreenshots(records: ScreenshotRecord[]): string {
  if (!records.length) return '🖼 <b>Screenshots</b>\n\nNone registered yet.' + footer;
  const lines = ['🖼 <b>Screenshot registry</b>', ''];
  for (const s of records) {
    const redaction = needsRedaction(s) ? '🚫 NEEDS REDACTION' : s.redactionStatus;
    lines.push(
      `${levelIcon(s.evidenceLevel)} <b>${esc(s.exchange)}/${esc(s.geo)}</b> · ${esc(s.screenshotType)} · ${esc(s.evidenceLevel)}\n` +
      `   claim: ${esc(s.claimId)} · sensitive: ${s.containsSensitiveData ? 'yes' : 'no'} · ${esc(redaction)}`,
    );
  }
  lines.push('', '<b>Redaction rules</b>:', ...REDACTION_RULES.map((r) => `  • ${esc(r)}`));
  return lines.join('\n') + footer;
}

export function formatMissingEvidence(tasks: MissingEvidenceTask[]): string {
  if (!tasks.length) return '🧩 <b>Missing evidence</b>\n\nNothing outstanding.' + footer;
  const lines = ['🧩 <b>Missing-evidence queue</b>', ''];
  tasks.slice(0, 12).forEach((t, i) => {
    lines.push(
      `${i + 1}. <b>${esc(t.exchange)}/${esc(t.geo)}</b> — ${esc(t.claimOrStep)} (prio ${t.priority})\n` +
      `   📸 ${esc(t.whatToCapture)}\n` +
      `   🧠 ${esc(t.whyItMatters)} · reviewer: ${esc(t.requiredReviewer)}\n` +
      `   🔒 ${esc(t.safeCaptureInstructions)}`,
    );
  });
  return lines.join('\n') + footer;
}

export function formatManualTrust(manuals: ManualTrustSummary[]): string {
  if (!manuals.length) return '📑 <b>Manual trust</b>\n\nNo manuals tracked.' + footer;
  const lines = ['📑 <b>Manual trust summaries</b>', ''];
  for (const m of manuals) {
    lines.push(
      `${readyIcon(m.publishReadiness)} <b>${esc(m.exchange)} ${esc(m.topic)} (${esc(m.geo)})</b> — ${esc(m.publishReadiness)}\n` +
      `   coverage ${m.evidenceCoverage}% · weakest: ${m.weakestStep ? `${esc(m.weakestStep.id)} (${esc(m.weakestStep.level)})` : '—'} · missing ${m.missingEvidence.length} step(s)`,
    );
  }
  return lines.join('\n') + footer;
}

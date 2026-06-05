import { GeoManual, GuideStep, LocalTesterTask } from '../../src/types';
import { GUIDE_SAFETY_RULES, screenshotIssues } from './index';

/**
 * Telegram formatters for the manual-builder commands (EPIC 014):
 * /manual, /manual_step, /guide_status, /tester_tasks. Pure, read-only.
 * Honesty-first: unverified steps, missing/unsafe screenshots and GEO
 * restrictions are surfaced, never hidden. Nothing here publishes.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const levelIcon = (l: string) => (l === 'A' || l === 'B' ? '🟢' : l === 'C' ? '🟡' : l === 'D' ? '🟠' : '🔴');
const readyIcon = (r: string) => (r === 'ready' ? '🟢' : r === 'needs_review' ? '🟡' : '🔴');
const shotIcon = (s: string) =>
  s === 'present' ? '📸' : s === 'missing' ? '⬜' : s === 'outdated' ? '🕒' : '🚫';

const footer =
  '\n\n<i>Honest, evidence-aware guides. Unverified steps need a local tester; nothing auto-publishes — a human reviews every manual.</i>';

export function formatManual(manual: GeoManual | undefined): string {
  if (!manual) return '📖 <b>Manual</b>\n\nNot found. Usage: <code>/manual bybit p2p KZ</code>' + footer;
  const lines = [
    `📖 <b>${esc(manual.title)}</b>`,
    `${readyIcon(manual.readiness)} ${esc(manual.readiness)} · coverage ${manual.evidenceCoverage}% · locale ${esc(manual.locale)}` +
      (manual.fullyVerified ? ' · ✅ fully verified' : ' · ⚠️ not fully verified'),
    '',
  ];
  manual.steps.forEach((s, i) => {
    lines.push(
      `${i + 1}. ${levelIcon(s.evidenceLevel)} <b>${esc(s.title)}</b> <code>${esc(s.id)}</code> — ${esc(s.verificationStatus)} (${s.confidence}%) ${shotIcon(s.screenshotStatus)}` +
        (s.warning ? `\n   ${esc(s.warning)}` : ''),
    );
  });
  if (manual.warnings.length) {
    lines.push('', '<b>Warnings</b>:', ...manual.warnings.map((w) => `  • ${esc(w)}`));
  }
  return lines.join('\n') + footer;
}

export function formatManualStep(manual: GeoManual | undefined, step: GuideStep | undefined): string {
  if (!manual || !step) {
    return '🔬 <b>Manual step</b>\n\nNot found. Usage: <code>/manual_step bybit p2p select-fiat KZ</code>' + footer;
  }
  const lines = [
    `🔬 <b>${esc(manual.title)}</b>`,
    `${levelIcon(step.evidenceLevel)} <b>${esc(step.title)}</b> <code>${esc(step.id)}</code>`,
    '',
    esc(step.description),
    '',
    `Evidence: <b>${esc(step.evidenceLevel)}</b> · status: ${esc(step.verificationStatus)} · confidence ${step.confidence}%`,
    `Screenshots: ${shotIcon(step.screenshotStatus)} ${esc(step.screenshotStatus)}` +
      (step.screenshotIds.length ? ` (${step.screenshotIds.map(esc).join(', ')})` : ' (none)'),
    step.requiresLocalTester ? '🧪 Requires a local tester before this step can be claimed.' : '',
  ].filter(Boolean);
  if (step.warning) lines.push('', `⚠️ ${esc(step.warning)}`);
  return lines.join('\n') + footer;
}

export function formatGuideStatus(manuals: GeoManual[]): string {
  if (!manuals.length) return '🗂 <b>Guide status</b>\n\nNo manuals built yet.' + footer;
  const ready = manuals.filter((m) => m.readiness === 'ready').length;
  const review = manuals.filter((m) => m.readiness === 'needs_review').length;
  const notReady = manuals.filter((m) => m.readiness === 'not_ready').length;
  const lines = [
    '🗂 <b>Guide status</b>',
    `${manuals.length} manuals · 🟢 ${ready} ready · 🟡 ${review} review · 🔴 ${notReady} not ready`,
    '',
  ];
  for (const m of manuals.slice(0, 20)) {
    const issues = screenshotIssues(m).length;
    lines.push(
      `${readyIcon(m.readiness)} <b>${esc(m.exchange)}/${esc(m.topic)}/${esc(m.geo)}</b> — ${m.evidenceCoverage}%` +
        ` · weakest ${m.weakestStep ? esc(m.weakestStep.level) : '—'}` +
        (issues ? ` · ${issues} screenshot issue(s)` : ''),
    );
  }
  if (manuals.length > 20) lines.push(`…and ${manuals.length - 20} more.`);
  return lines.join('\n') + footer;
}

export function formatTesterTasks(tasks: LocalTesterTask[]): string {
  if (!tasks.length) return '🧪 <b>Local tester tasks</b>\n\nNothing outstanding.' + footer;
  const lines = ['🧪 <b>Local tester tasks</b>', ''];
  tasks.slice(0, 12).forEach((t, i) => {
    lines.push(
      `${i + 1}. <b>${esc(t.exchange)}/${esc(t.topic)}/${esc(t.geo)}</b> · ${esc(t.stepId)} (prio ${t.priority}, want ${esc(t.expectedEvidenceLevel)})\n` +
        `   🔎 ${esc(t.whatToTest)}\n` +
        `   📸 ${t.screenshotsRequired.map(esc).join(' · ')}`,
    );
  });
  lines.push('', '<b>Always redact</b>:', ...GUIDE_SAFETY_RULES.map((r) => `  • ${esc(r)}`));
  return lines.join('\n') + footer;
}

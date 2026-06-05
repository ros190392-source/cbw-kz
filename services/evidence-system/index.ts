import {
  EvidenceAssessment,
  EvidenceLevel,
  ManualStep,
  ManualTopic,
  ManualTrustSummary,
  MissingEvidenceTask,
  ScreenshotRecord,
} from '../../src/types';

/**
 * Evidence system (EPIC 013 · Phases 1, 3, 4, 6).
 *
 * Models evidence strength (A–E), turns manuals into trust summaries, generates
 * a missing-evidence queue for a local tester, and supplies verification-aware
 * phrasing for the content engine. Core principle: honesty over fake
 * screenshots — low evidence is surfaced, never hidden, and nothing publishes.
 *
 * Pure + deterministic; helpers exported for testing.
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const DAY_MS = 24 * 60 * 60 * 1000;

/** Base confidence per evidence level. */
const LEVEL_BASE: Record<EvidenceLevel, number> = { A: 95, B: 80, C: 65, D: 35, E: 10 };

/** Ordering for "weakest step" (E weakest → A strongest). */
const LEVEL_RANK: Record<EvidenceLevel, number> = { E: 0, D: 1, C: 2, B: 3, A: 4 };

const LIMITATIONS: Record<EvidenceLevel, string> = {
  A: 'Confirmed by our own live test — strongest evidence.',
  B: 'Confirmed by an interface screenshot — UI seen, not transacted.',
  C: 'Per official documentation — may lag the live product.',
  D: 'Community/user report — anecdotal, not independently verified.',
  E: 'Not verified — requires a local tester before any claim is made.',
};

export const EVIDENCE_LEGEND: Record<EvidenceLevel, string> = {
  A: 'A — our own live test',
  B: 'B — interface screenshot',
  C: 'C — official documentation',
  D: 'D — community/user report',
  E: 'E — not verified / needs local tester',
};

/** Assess evidence, decaying confidence when the check is stale. */
export function assessEvidence(
  level: EvidenceLevel,
  lastCheckedAt: string | null,
  now: Date = new Date(),
  staleAfterDays = 60,
): EvidenceAssessment {
  let confidence = LEVEL_BASE[level];
  if (lastCheckedAt) {
    const ageDays = (now.getTime() - new Date(lastCheckedAt).getTime()) / DAY_MS;
    if (ageDays > staleAfterDays * 2) confidence = Math.round(confidence * 0.5);
    else if (ageDays > staleAfterDays) confidence = Math.round(confidence * 0.75);
  } else if (level !== 'E') {
    // A claim with no check date can't keep full confidence.
    confidence = Math.round(confidence * 0.7);
  }
  return {
    level,
    confidence: clamp(confidence, 0, 100),
    lastCheckedAt,
    requiresLocalTester: level === 'E',
    limitations: LIMITATIONS[level],
  };
}

// ── Content phrasing (Phase 6) ───────────────────────────────────────────────

/** How a draft may phrase a claim given its evidence level. */
export function evidencePhrasing(level: EvidenceLevel): string {
  switch (level) {
    case 'A':
    case 'B':
      return 'verified';
    case 'C':
      return 'according to official documentation';
    case 'D':
      return 'reported by users';
    case 'E':
    default:
      return 'requires local verification';
  }
}

/** A draft warning when evidence is weak (D/E). Empty for A/B/C. */
export function evidenceWarning(level: EvidenceLevel): string | null {
  if (level === 'E') return '⚠️ Not verified — needs a local tester before publishing this claim.';
  if (level === 'D') return '⚠️ Based on user reports only — verify before presenting as fact.';
  return null;
}

// ── Manual trust (Phase 3) ───────────────────────────────────────────────────

const ADEQUATE: EvidenceLevel[] = ['A', 'B', 'C'];

export function buildManualTrust(
  manual: Omit<ManualTrustSummary, 'evidenceCoverage' | 'weakestStep' | 'missingEvidence' | 'publishReadiness'>,
): ManualTrustSummary {
  const steps = manual.steps;
  const adequate = steps.filter((s) => ADEQUATE.includes(s.evidenceLevel));
  const evidenceCoverage = steps.length ? Math.round((adequate.length / steps.length) * 100) : 0;

  let weakestStep: ManualTrustSummary['weakestStep'] = null;
  for (const s of steps) {
    if (!weakestStep || LEVEL_RANK[s.evidenceLevel] < LEVEL_RANK[weakestStep.level]) {
      weakestStep = { id: s.id, level: s.evidenceLevel };
    }
  }

  const missingEvidence = steps
    .filter((s) => s.evidenceLevel === 'D' || s.evidenceLevel === 'E' || s.requiresLocalTester)
    .map((s) => s.id);

  const anyNotReady = steps.some((s) => s.evidenceLevel === 'E' || s.requiresLocalTester);
  const anyWeak = steps.some((s) => s.evidenceLevel === 'D');
  const publishReadiness: ManualTrustSummary['publishReadiness'] = anyNotReady
    ? 'not_ready'
    : anyWeak || evidenceCoverage < 100
      ? 'needs_review'
      : 'ready';

  return { ...manual, evidenceCoverage, weakestStep, missingEvidence, publishReadiness };
}

// ── Missing evidence queue (Phase 4) ─────────────────────────────────────────

export function missingEvidenceForManual(manual: ManualTrustSummary): MissingEvidenceTask[] {
  return manual.steps
    .filter((s) => s.evidenceLevel === 'D' || s.evidenceLevel === 'E' || s.requiresLocalTester)
    .map((s) => {
      const isE = s.evidenceLevel === 'E' || s.requiresLocalTester;
      return {
        id: `${manual.manualId}:${s.id}`,
        exchange: manual.exchange,
        geo: manual.geo,
        claimOrStep: s.description,
        whatToCapture: `Screenshot evidencing: ${s.description}`,
        whyItMatters: isE
          ? 'No verification yet — we cannot claim this step without local proof.'
          : 'Only user-reported — needs interface/official confirmation.',
        priority: isE ? 85 : 55,
        requiredReviewer: (isE ? 'local_tester' : 'either') as MissingEvidenceTask['requiredReviewer'],
        safeCaptureInstructions:
          'Capture the interface only. Redact card numbers, names, phone numbers, bank/IBAN, QR/payment details. No private chats unredacted.',
      };
    })
    .sort((a, b) => b.priority - a.priority);
}

export function missingEvidenceQueue(manuals: ManualTrustSummary[]): MissingEvidenceTask[] {
  return manuals.flatMap(missingEvidenceForManual).sort((a, b) => b.priority - a.priority);
}

// ── Seed manuals (honest baseline: mostly unverified) ────────────────────────

function step(id: string, description: string, level: EvidenceLevel, screenshotId: string | null = null): ManualStep {
  return { id, description, evidenceLevel: level, screenshotId, requiresLocalTester: level === 'E' };
}

/**
 * Baseline manuals start at LOW evidence (E/D) on purpose — we have not run live
 * tests or captured screenshots yet, and the system says so rather than faking
 * confidence. A local tester raises these as real evidence arrives.
 */
export function seedManuals(): ManualTrustSummary[] {
  const defs: { exchange: string; topic: ManualTopic; steps: ManualStep[] }[] = [
    {
      exchange: 'bybit', topic: 'P2P',
      steps: [
        step('open-p2p', 'Open Bybit P2P and select KZT', 'E'),
        step('filter-kzt', 'Filter offers by KZT + Kaspi payment method', 'E'),
        step('order-screen', 'Review the order screen before payment', 'E'),
      ],
    },
    {
      exchange: 'bybit', topic: 'deposit',
      steps: [
        step('kaspi-visible', 'Confirm Kaspi appears as a deposit method', 'D'),
        step('halyk-visible', 'Confirm Halyk appears as a deposit method', 'E'),
      ],
    },
  ];
  return defs.map((d) =>
    buildManualTrust({
      manualId: `${d.exchange}-${d.topic.toLowerCase()}-KZ`,
      geo: 'KZ', exchange: d.exchange, topic: d.topic, steps: d.steps,
    }),
  );
}

/** Aggregate evidence-coverage view across screenshots (for /evidence_levels). */
export function evidenceCoverageByExchange(screenshots: ScreenshotRecord[]): Record<string, Record<EvidenceLevel, number>> {
  const out: Record<string, Record<EvidenceLevel, number>> = {};
  for (const s of screenshots) {
    out[s.exchange] ??= { A: 0, B: 0, C: 0, D: 0, E: 0 };
    out[s.exchange][s.evidenceLevel]++;
  }
  return out;
}

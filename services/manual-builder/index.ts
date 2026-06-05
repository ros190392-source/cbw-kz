import {
  EvidenceLevel,
  ExchangeRecord,
  GeoManual,
  GuideStep,
  GuideTopic,
  LocalTesterTask,
  PublishReadiness,
  ScreenshotMappingStatus,
  ScreenshotRecord,
  StepVerificationStatus,
} from '../../src/types';
import { assessEvidence, evidenceWarning } from '../evidence-system';
import { REDACTION_RULES, needsRedaction } from '../screenshot-registry';
import { isAvailable, supportsP2P } from '../geo-engine';
import { GUIDE_GEOS, geoGuideProfile } from './geo-data';
import { GUIDE_TOPICS, StepTemplate, TOPIC_TITLES, stepTemplates } from './templates';

/**
 * Manual builder / GEO guide engine (EPIC 014).
 *
 * Turns templates + GEO data + real screenshots into honest, evidence-aware
 * exchange manuals. Core rules:
 *  - steps are never fabricated as "done"; each carries its own evidence level,
 *  - a present, safe, fresh screenshot RAISES a step's evidence — an unsafe or
 *    outdated one never does (and is flagged instead),
 *  - any unverified (E) step keeps the whole manual out of "fully verified",
 *  - nothing here publishes. Low evidence routes to a local-tester task.
 *
 * Pure + deterministic; helpers exported for testing.
 */

export { GUIDE_GEOS, geoGuideProfile, GEO_GUIDES } from './geo-data';
export { GUIDE_TOPICS, TOPIC_TITLES, stepTemplates } from './templates';

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_SCREENSHOT_DAYS = 90;
const ADEQUATE: EvidenceLevel[] = ['A', 'B', 'C'];
const LEVEL_RANK: Record<EvidenceLevel, number> = { E: 0, D: 1, C: 2, B: 3, A: 4 };

/** Steps that genuinely require a live transaction → expect level A evidence. */
const LIVE_TEST_STEPS = new Set([
  'confirm-payment', 'confirm-deposit', 'verify-credit', 'liveness', 'confirm-withdrawal', 'claim-bonus', 'claim-rewards', 'stake-tokens',
]);

/** Guide safety rules — what must NEVER appear unredacted in any guide asset. */
export const GUIDE_SAFETY_RULES: string[] = [
  ...REDACTION_RULES,
  'No live order / transaction IDs',
  'No email addresses',
];

/** Deterministic claim id linking a screenshot to a manual step. */
export function claimIdFor(exchange: string, geo: string, topic: GuideTopic, stepId: string): string {
  return `${exchange}:${geo}:${topic}:${stepId}`;
}

function verificationStatusFor(level: EvidenceLevel): StepVerificationStatus {
  switch (level) {
    case 'A':
    case 'B':
      return 'verified';
    case 'C':
      return 'documented';
    case 'D':
      return 'reported';
    case 'E':
    default:
      return 'unverified';
  }
}

function isStale(capturedAt: string, now: Date): boolean {
  return (now.getTime() - new Date(capturedAt).getTime()) / DAY_MS > STALE_SCREENSHOT_DAYS;
}

/** Screenshots mapped to a step (by exact claim id, or claim id ending in step). */
export function screenshotsForStep(
  exchange: string, geo: string, topic: GuideTopic, stepId: string, screenshots: ScreenshotRecord[],
): ScreenshotRecord[] {
  const exact = claimIdFor(exchange, geo, topic, stepId);
  return screenshots.filter(
    (s) => s.exchange === exchange && s.geo === geo && (s.claimId === exact || s.claimId.endsWith(`:${stepId}`)),
  );
}

interface StepEvidence {
  level: EvidenceLevel;
  screenshotIds: string[];
  status: ScreenshotMappingStatus;
  capturedAt: string | null;
}

/** Resolve a step's effective evidence from its template + mapped screenshots. */
function resolveStepEvidence(template: StepTemplate, mapped: ScreenshotRecord[], now: Date): StepEvidence {
  const ids = mapped.map((s) => s.id);

  // Unsafe screenshots block use entirely and never raise evidence.
  const unsafe = mapped.filter(needsRedaction);
  if (unsafe.length) {
    return { level: template.baseEvidence, screenshotIds: ids, status: 'unsafe', capturedAt: null };
  }

  const fresh = mapped.filter((s) => !isStale(s.capturedAt, now));
  if (mapped.length && !fresh.length) {
    // Have screenshots, but all are stale → don't raise evidence, flag outdated.
    return { level: template.baseEvidence, screenshotIds: ids, status: 'outdated', capturedAt: null };
  }

  if (fresh.length) {
    // Use the strongest fresh, safe screenshot — but only to RAISE, never lower.
    const strongest = fresh.reduce((a, b) => (LEVEL_RANK[b.evidenceLevel] > LEVEL_RANK[a.evidenceLevel] ? b : a));
    const level =
      LEVEL_RANK[strongest.evidenceLevel] > LEVEL_RANK[template.baseEvidence] ? strongest.evidenceLevel : template.baseEvidence;
    return { level, screenshotIds: ids, status: 'present', capturedAt: strongest.capturedAt };
  }

  // No screenshots at all.
  const status: ScreenshotMappingStatus = template.needsScreenshot ? 'missing' : 'present';
  return { level: template.baseEvidence, screenshotIds: ids, status, capturedAt: null };
}

function fill(s: string, currency: string, payment: string): string {
  return s.replace(/\{currency\}/g, currency).replace(/\{payment\}/g, payment);
}

function buildStep(
  template: StepTemplate, exchange: string, geo: string, topic: GuideTopic,
  currency: string, payment: string, screenshots: ScreenshotRecord[], now: Date,
): GuideStep {
  const mapped = screenshotsForStep(exchange, geo, topic, template.id, screenshots);
  const ev = resolveStepEvidence(template, mapped, now);
  const confidence = assessEvidence(ev.level, ev.capturedAt, now).confidence;

  const warnings: string[] = [];
  const evWarn = evidenceWarning(ev.level);
  if (evWarn) warnings.push(evWarn);
  if (ev.status === 'unsafe') warnings.push('🚫 Screenshot needs redaction before use.');
  else if (ev.status === 'outdated') warnings.push('⚠️ Screenshot is outdated — re-capture it.');
  else if (ev.status === 'missing') warnings.push('📸 No screenshot yet for this step.');

  return {
    id: template.id,
    title: fill(template.title, currency, payment),
    description: fill(template.description, currency, payment),
    evidenceLevel: ev.level,
    screenshotIds: ev.screenshotIds,
    warning: warnings.length ? warnings.join(' ') : null,
    confidence,
    verificationStatus: verificationStatusFor(ev.level),
    requiresLocalTester: ev.level === 'E',
    screenshotStatus: ev.status,
  };
}

export interface BuildManualOptions {
  screenshots?: ScreenshotRecord[];
  now?: Date;
}

/** Build a GEO-specific, evidence-aware manual for one exchange + topic. */
export function buildGeoManual(
  exchange: ExchangeRecord, topic: GuideTopic, country: string, opts: BuildManualOptions = {},
): GeoManual {
  const now = opts.now ?? new Date();
  const screenshots = opts.screenshots ?? [];
  const geo = (country ?? '').trim().toUpperCase();
  const profile = geoGuideProfile(geo);
  const currency = profile.currency;
  const payment = profile.paymentMethods.slice(0, 3).join(' / ');

  const steps = stepTemplates(topic).map((t) =>
    buildStep(t, exchange.slug, geo, topic, currency, payment, screenshots, now),
  );

  // Manual-level warnings (GEO + evidence + screenshot safety).
  const warnings: string[] = [];
  if (!isAvailable(exchange, geo)) {
    warnings.push(`⚠️ ${exchange.name} may not be available in ${profile.country} — verify before publishing.`);
  }
  if (topic === 'p2p' && !supportsP2P(exchange, geo)) {
    warnings.push(`⚠️ P2P may be unavailable for ${exchange.name} in ${profile.country} — verify.`);
  }
  for (const r of profile.restrictions) warnings.push(`⚠️ ${profile.country}: ${r}`);
  if (steps.some((s) => s.evidenceLevel === 'E')) {
    warnings.push('⚠️ Contains unverified steps (E) — a local tester must capture evidence before publishing.');
  }
  if (steps.some((s) => s.screenshotStatus === 'unsafe')) {
    warnings.push('🚫 One or more screenshots need redaction before this guide can be used.');
  }

  const adequate = steps.filter((s) => ADEQUATE.includes(s.evidenceLevel));
  const evidenceCoverage = steps.length ? Math.round((adequate.length / steps.length) * 100) : 0;

  let weakestStep: GeoManual['weakestStep'] = null;
  for (const s of steps) {
    if (!weakestStep || LEVEL_RANK[s.evidenceLevel] < LEVEL_RANK[weakestStep.level]) {
      weakestStep = { id: s.id, level: s.evidenceLevel };
    }
  }

  const anyNotReady = steps.some((s) => s.evidenceLevel === 'E');
  const anyWeak = steps.some((s) => s.evidenceLevel === 'D');
  const readiness: PublishReadiness = anyNotReady
    ? 'not_ready'
    : anyWeak || evidenceCoverage < 100
      ? 'needs_review'
      : 'ready';

  const hasScreenshotIssue = steps.some((s) => s.screenshotStatus !== 'present');
  const fullyVerified = readiness === 'ready' && evidenceCoverage === 100 && !hasScreenshotIssue;

  return {
    id: `${exchange.slug}-${topic}-${geo}`,
    title: `${exchange.name} — ${TOPIC_TITLES[topic]} (${profile.country})`,
    geo,
    locale: profile.locale,
    exchange: exchange.slug,
    topic,
    steps,
    warnings,
    evidenceCoverage,
    weakestStep,
    readiness,
    requiresLocalTester: steps.some((s) => s.requiresLocalTester),
    fullyVerified,
  };
}

// ── Screenshot integration (Phase 3) ─────────────────────────────────────────

export interface StepScreenshotIssue {
  stepId: string;
  title: string;
  status: ScreenshotMappingStatus;
  screenshotIds: string[];
}

/** Steps whose screenshot mapping is not clean (missing/outdated/unsafe). */
export function screenshotIssues(manual: GeoManual): StepScreenshotIssue[] {
  return manual.steps
    .filter((s) => s.screenshotStatus !== 'present')
    .map((s) => ({ stepId: s.id, title: s.title, status: s.screenshotStatus, screenshotIds: s.screenshotIds }));
}

// ── Local tester tasks (Phase 5) ─────────────────────────────────────────────

/** Generate precise, safety-aware tester tasks for a manual's weak steps. */
export function generateTesterTasks(manual: GeoManual): LocalTesterTask[] {
  const tasks: LocalTesterTask[] = [];
  for (const s of manual.steps) {
    const needsWork =
      s.evidenceLevel === 'E' ||
      s.evidenceLevel === 'D' ||
      s.screenshotStatus === 'missing' ||
      s.screenshotStatus === 'unsafe' ||
      s.screenshotStatus === 'outdated';
    if (!needsWork) continue;

    const expectsLive = LIVE_TEST_STEPS.has(s.id);
    const expectedEvidenceLevel: EvidenceLevel = expectsLive ? 'A' : 'B';

    let priority = 40;
    if (s.evidenceLevel === 'E') priority = Math.max(priority, 85);
    if (s.screenshotStatus === 'unsafe') priority = Math.max(priority, 75);
    if (s.screenshotStatus === 'missing') priority = Math.max(priority, 70);
    if (s.evidenceLevel === 'D') priority = Math.max(priority, 55);
    if (s.screenshotStatus === 'outdated') priority = Math.max(priority, 50);

    const screenshotsRequired = [
      expectsLive
        ? `Live-test screenshot proving: ${s.title}`
        : `Interface screenshot proving: ${s.title}`,
    ];
    if (s.screenshotStatus === 'unsafe') screenshotsRequired.push('Re-capture a properly REDACTED version.');
    if (s.screenshotStatus === 'outdated') screenshotsRequired.push('Re-capture a current version (UI has likely changed).');

    tasks.push({
      id: `${manual.id}:${s.id}`,
      exchange: manual.exchange,
      geo: manual.geo,
      topic: manual.topic,
      stepId: s.id,
      whatToTest: s.description,
      screenshotsRequired,
      mustRedact: GUIDE_SAFETY_RULES,
      expectedEvidenceLevel,
      priority,
    });
  }
  return tasks.sort((a, b) => b.priority - a.priority);
}

export function testerTasksForManuals(manuals: GeoManual[]): LocalTesterTask[] {
  return manuals.flatMap(generateTesterTasks).sort((a, b) => b.priority - a.priority);
}

// ── Guide matrix (bot convenience) ───────────────────────────────────────────

export interface MatrixOptions extends BuildManualOptions {
  geos?: string[];
  topics?: GuideTopic[];
}

/** Build manuals across exchanges × topics × geos (bounded by the inputs). */
export function buildGuideMatrix(exchanges: ExchangeRecord[], opts: MatrixOptions = {}): GeoManual[] {
  const geos = opts.geos ?? GUIDE_GEOS;
  const topics = opts.topics ?? GUIDE_TOPICS;
  const out: GeoManual[] = [];
  for (const ex of exchanges) {
    for (const topic of topics) {
      for (const geo of geos) out.push(buildGeoManual(ex, topic, geo, opts));
    }
  }
  return out;
}

export function findStep(manual: GeoManual, stepId: string): GuideStep | undefined {
  return manual.steps.find((s) => s.id === stepId);
}

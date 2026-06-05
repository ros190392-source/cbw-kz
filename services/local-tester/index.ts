import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../src/logger';
import {
  EvidenceLevel,
  EvidenceSubmission,
  GuideTopic,
  LocalTesterTask,
  ReviewAction,
  ScreenshotRecord,
  SubmissionStatus,
  TaskAssignment,
  TesterProfile,
  TesterSpecialty,
  TesterTrustLevel,
} from '../../src/types';
import { needsRedaction } from '../screenshot-registry';

/**
 * Local tester program / evidence-review network (EPIC 015).
 *
 * Routes missing-evidence tasks to real testers in the right GEO, takes their
 * evidence submissions, and runs a HUMAN review flow. Core rules:
 *  - nothing auto-approves and nothing auto-publishes,
 *  - unsafe (unredacted) evidence is BLOCKED from approval until redacted,
 *  - tester trust is earned by accepted submissions and lost by rejected/unsafe,
 *  - private data is never exposed — the safety scan refuses it.
 *
 * Pure helpers are exported for testing; the stores wrap JSON persistence.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 90;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const norm = (s: string) => (s ?? '').trim().toUpperCase();

const LEVEL_RANK: Record<EvidenceLevel, number> = { E: 0, D: 1, C: 2, B: 3, A: 4 };
const RANK_LEVEL: EvidenceLevel[] = ['E', 'D', 'C', 'B', 'A'];

// ── Trust scoring (Phase 5) ──────────────────────────────────────────────────

export const STARTING_TRUST = 50;

/** Trust score deltas per review outcome. */
export const TRUST_DELTA = {
  approve: 6,
  reject: -12,
  unsafe: -20,
  downgrade: -3,
  request_redaction: -4,
  request_retest: -2,
} as const;

export function trustLevelFor(score: number): TesterTrustLevel {
  if (score >= 85) return 'trusted';
  if (score >= 65) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

/** Trust after a staleness penalty (not stored — computed for ranking/display). */
export function effectiveTrustScore(profile: TesterProfile, now: Date = new Date()): number {
  if (!profile.lastActiveAt) return profile.trustScore;
  const ageDays = (now.getTime() - new Date(profile.lastActiveAt).getTime()) / DAY_MS;
  const penalty = ageDays > STALE_DAYS ? 15 : 0;
  return clamp(profile.trustScore - penalty, 0, 100);
}

export function newTester(over: Partial<TesterProfile> & { id: string; nickname: string }): TesterProfile {
  const trustScore = over.trustScore ?? STARTING_TRUST;
  return {
    geos: [], languages: [], exchanges: [], specialties: [],
    approvedSubmissions: 0, rejectedSubmissions: 0, unsafeSubmissions: 0,
    lastActiveAt: null, reviewerNotes: '',
    ...over,
    trustScore: clamp(trustScore, 0, 100),
    trustLevel: trustLevelFor(clamp(trustScore, 0, 100)),
  };
}

// ── Safety & privacy scan (Phase 6) ──────────────────────────────────────────

/** What must NEVER appear unredacted in tester evidence. */
export const SAFETY_FORBIDDEN: string[] = [
  'Bank card numbers',
  'IBAN / account numbers',
  'QR / payment codes',
  'Phone numbers',
  'Email addresses',
  'Personal names',
  'Unredacted chats',
  'Live transaction IDs',
];

const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'card number', re: /\b(?:\d[ -]?){13,19}\b/ },
  { label: 'IBAN', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/ },
  { label: 'email address', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
  { label: 'phone number', re: /\+?\d[\d\s().-]{7,}\d/ },
];

export interface SafetyResult {
  unsafe: boolean;
  reasons: string[];
}

/** Scan a submission + its screenshots for anything that blocks approval. */
export function detectUnsafe(
  submission: EvidenceSubmission,
  screenshots: ScreenshotRecord[] = [],
): SafetyResult {
  const reasons: string[] = [];
  if (submission.sensitiveDataDetected) reasons.push('Tester flagged sensitive data present');
  if (submission.requiresRedaction) reasons.push('Tester flagged redaction required');

  const text = `${submission.notes} ${submission.testedFlow} ${submission.warnings.join(' ')}`;
  for (const { label, re } of PATTERNS) {
    if (re.test(text)) reasons.push(`Possible ${label} in submission text`);
  }

  const byId = new Map(screenshots.map((s) => [s.id, s]));
  for (const id of submission.screenshotIds) {
    const shot = byId.get(id);
    if (shot && needsRedaction(shot)) reasons.push(`Screenshot ${id} still needs redaction`);
  }

  return { unsafe: reasons.length > 0, reasons };
}

export function newSubmission(
  over: Partial<EvidenceSubmission> & { id: string; testerId: string; exchange: string; geo: string },
): EvidenceSubmission {
  return {
    taskId: null, testedFlow: '', screenshotIds: [], notes: '',
    evidenceLevelSuggested: 'E', warnings: [], sensitiveDataDetected: false, requiresRedaction: false,
    status: 'pending_review', submittedAt: new Date().toISOString(),
    reviewedBy: null, reviewerNote: '', reviewedAt: null, finalEvidenceLevel: null,
    ...over,
    geo: norm(over.geo),
  };
}

// ── Review flow (Phase 4) ────────────────────────────────────────────────────

export interface ReviewOutcome {
  submission: EvidenceSubmission;
  trustDelta: number;
  counters: { approved: number; rejected: number; unsafe: number };
  blocked: boolean; // true when an approve was blocked by the safety gate
}

function downgrade(level: EvidenceLevel): EvidenceLevel {
  return RANK_LEVEL[Math.max(0, LEVEL_RANK[level] - 1)];
}

/**
 * Pure review computation. NEVER approves unsafe evidence — an approve on unsafe
 * evidence is forced to `needs_redaction` with no trust gain.
 */
export function reviewSubmission(
  submission: EvidenceSubmission,
  action: ReviewAction,
  reviewerId: string,
  note: string,
  screenshots: ScreenshotRecord[] = [],
  now: Date = new Date(),
): ReviewOutcome {
  if (!reviewerId) throw new Error('reviewerId is required to review a submission');
  const at = now.toISOString();
  const safety = detectUnsafe(submission, screenshots);
  const base = { ...submission, reviewedBy: reviewerId, reviewerNote: note ?? '', reviewedAt: at };
  const counters = { approved: 0, rejected: 0, unsafe: 0 };

  // Safety gate: an approve/downgrade on unsafe evidence is blocked.
  if ((action === 'approve' || action === 'downgrade_evidence') && safety.unsafe) {
    counters.unsafe = 1;
    return {
      submission: {
        ...base,
        status: 'needs_redaction',
        requiresRedaction: true,
        reviewerNote: `${note ?? ''} [BLOCKED — unsafe: ${safety.reasons.join('; ')}]`.trim(),
      },
      trustDelta: TRUST_DELTA.unsafe,
      counters,
      blocked: true,
    };
  }

  switch (action) {
    case 'approve':
      counters.approved = 1;
      return {
        submission: { ...base, status: 'approved', finalEvidenceLevel: submission.evidenceLevelSuggested },
        trustDelta: TRUST_DELTA.approve, counters, blocked: false,
      };
    case 'downgrade_evidence':
      counters.approved = 1;
      return {
        submission: { ...base, status: 'approved', finalEvidenceLevel: downgrade(submission.evidenceLevelSuggested) },
        trustDelta: TRUST_DELTA.downgrade, counters, blocked: false,
      };
    case 'reject':
      counters.rejected = 1;
      return { submission: { ...base, status: 'rejected', finalEvidenceLevel: null }, trustDelta: TRUST_DELTA.reject, counters, blocked: false };
    case 'request_redaction':
      if (safety.unsafe) counters.unsafe = 1;
      return {
        submission: { ...base, status: 'needs_redaction', requiresRedaction: true },
        trustDelta: TRUST_DELTA.request_redaction, counters, blocked: false,
      };
    case 'request_retest':
      counters.rejected = 1;
      return { submission: { ...base, status: 'rejected', finalEvidenceLevel: null, reviewerNote: `${note ?? ''} [retest requested]`.trim() }, trustDelta: TRUST_DELTA.request_retest, counters, blocked: false };
    default:
      throw new Error(`Unknown review action: ${action}`);
  }
}

// ── Task assignment / routing (Phase 2) ──────────────────────────────────────

const SPECIALTY_FOR_TOPIC: Record<GuideTopic, TesterSpecialty[]> = {
  p2p: ['p2p'],
  kyc: ['kyc'],
  deposit: ['deposit', 'banking_methods'],
  withdrawal: ['withdrawal', 'banking_methods'],
  launchpool: ['launchpool'],
  bonus: ['launchpool'],
  account_security: ['mobile_app'],
};

/** GEOs where coverage matters most → assignment bonus. */
export const HIGH_TRAFFIC_GEOS = ['KZ'];

export function assignTask(task: LocalTesterTask, testers: TesterProfile[], now: Date = new Date()): TaskAssignment {
  const geo = norm(task.geo);
  const wantSpecs = SPECIALTY_FOR_TOPIC[task.topic] ?? [];
  const candidates = testers.filter((t) => t.geos.map(norm).includes(geo));

  let best: { tester: TesterProfile; score: number; reasons: string[] } | null = null;
  for (const t of candidates) {
    const reasons: string[] = [`GEO ${geo}`];
    let score = task.priority;

    if (wantSpecs.some((s) => t.specialties.includes(s))) {
      score += 20;
      reasons.push('specialty match');
    }
    if (t.exchanges.includes(task.exchange)) {
      score += 15;
      reasons.push(`exchange ${task.exchange}`);
    } else if (t.exchanges.length === 0) {
      score += 5;
      reasons.push('generalist');
    }
    if (HIGH_TRAFFIC_GEOS.includes(geo)) {
      score += 10;
      reasons.push('high-traffic GEO');
    }
    const eff = effectiveTrustScore(t, now);
    score += Math.round(eff / 10);
    reasons.push(`trust ${eff}`);

    // Compare RAW scores so a high base priority doesn't clamp away the
    // specialty/exchange/trust advantage; clamp only for the displayed value.
    if (!best || score > best.score || (score === best.score && eff > effectiveTrustScore(best.tester, now))) {
      best = { tester: t, score, reasons };
    }
  }

  if (!best) {
    return {
      task, testerId: null, nickname: null, matchScore: clamp(task.priority, 0, 100),
      reasons: [`No tester covers GEO ${geo}`], unassigned: true,
    };
  }
  return { task, testerId: best.tester.id, nickname: best.tester.nickname, matchScore: clamp(best.score, 0, 100), reasons: best.reasons, unassigned: false };
}

export function assignTasks(tasks: LocalTesterTask[], testers: TesterProfile[], now: Date = new Date()): TaskAssignment[] {
  return tasks
    .map((t) => assignTask(t, testers, now))
    .sort((a, b) => Number(a.unassigned) - Number(b.unassigned) || b.matchScore - a.matchScore || b.task.priority - a.task.priority);
}

// ── Persistence ──────────────────────────────────────────────────────────────

class JsonStore<T extends { id: string }> {
  protected byId: Record<string, T> = {};
  private file: string;
  private dir: string;
  private label: string;

  constructor(fileName: string, dir: string, label: string) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.label = label;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) this.byId = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, T>;
    } catch (err) {
      logger.error(this.label, `Failed to load, starting fresh: ${(err as Error).message}`);
      this.byId = {};
    }
  }

  protected persist(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.byId, null, 2));
    } catch (err) {
      logger.error(this.label, `Failed to persist: ${(err as Error).message}`);
    }
  }

  get(id: string): T | undefined {
    return this.byId[id];
  }

  all(): T[] {
    return Object.values(this.byId);
  }
}

export class TesterRegistry extends JsonStore<TesterProfile> {
  constructor(fileName = 'testers.json', dir = config.paths.data) {
    super(fileName, dir, 'testers');
  }

  add(profile: TesterProfile): TesterProfile {
    this.byId[profile.id] = profile;
    this.persist();
    return profile;
  }

  /** Apply a trust delta + counter changes (called by the review flow). */
  applyOutcome(testerId: string, outcome: ReviewOutcome, now: Date = new Date()): TesterProfile | undefined {
    const t = this.byId[testerId];
    if (!t) return undefined;
    t.trustScore = clamp(t.trustScore + outcome.trustDelta, 0, 100);
    t.trustLevel = trustLevelFor(t.trustScore);
    t.approvedSubmissions += outcome.counters.approved;
    t.rejectedSubmissions += outcome.counters.rejected;
    t.unsafeSubmissions += outcome.counters.unsafe;
    t.lastActiveAt = now.toISOString();
    this.persist();
    return t;
  }

  seed(): TesterProfile[] {
    if (this.all().length) return this.all();
    const seeds: TesterProfile[] = [
      newTester({ id: 'almaz_kz', nickname: 'Almaz', geos: ['KZ'], languages: ['ru', 'kk'], exchanges: ['bybit', 'binance'], specialties: ['p2p', 'banking_methods'], trustScore: 70 }),
      newTester({ id: 'aigerim_kz', nickname: 'Aigerim', geos: ['KZ'], languages: ['ru'], exchanges: [], specialties: ['kyc', 'mobile_app'], trustScore: 50 }),
      newTester({ id: 'mehmet_tr', nickname: 'Mehmet', geos: ['TR'], languages: ['tr'], exchanges: ['binance'], specialties: ['p2p', 'deposit'], trustScore: 55 }),
    ];
    for (const s of seeds) this.add(s);
    return this.all();
  }
}

export class SubmissionStore extends JsonStore<EvidenceSubmission> {
  constructor(fileName = 'submissions.json', dir = config.paths.data) {
    super(fileName, dir, 'submissions');
  }

  add(submission: EvidenceSubmission): EvidenceSubmission {
    this.byId[submission.id] = submission;
    this.persist();
    return submission;
  }

  forStatus(status: SubmissionStatus): EvidenceSubmission[] {
    return this.all().filter((s) => s.status === status);
  }

  pending(): EvidenceSubmission[] {
    return this.forStatus('pending_review');
  }

  /** Review a submission and apply the trust outcome to the tester registry. */
  review(
    registry: TesterRegistry,
    submissionId: string,
    action: ReviewAction,
    reviewerId: string,
    note: string,
    screenshots: ScreenshotRecord[] = [],
    now: Date = new Date(),
  ): ReviewOutcome {
    const sub = this.byId[submissionId];
    if (!sub) throw new Error(`Submission not found: ${submissionId}`);
    const outcome = reviewSubmission(sub, action, reviewerId, note, screenshots, now);
    this.byId[submissionId] = outcome.submission;
    this.persist();
    registry.applyOutcome(sub.testerId, outcome, now);
    logger.audit('tester_review', `Submission ${submissionId} → ${outcome.submission.status} by ${reviewerId}`, {
      action, blocked: outcome.blocked, trustDelta: outcome.trustDelta,
    });
    return outcome;
  }
}

export { SPECIALTY_FOR_TOPIC };

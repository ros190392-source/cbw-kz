import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../src/logger';
import {
  BonusRecord,
  ClaimType,
  ClaimVerdict,
  Evidence,
  EvidenceType,
  ExchangeRecord,
  FreshnessStatus,
  KycLevel,
  KzGeoSnapshot,
  VerificationClaim,
} from '../../src/types';
import { effectiveVerification } from '../exchange-registry';
import { seedClaimsFromExchanges } from './data';

export { seedClaimsFromExchanges } from './data';

/**
 * Verification / trust engine (EPIC 003).
 *
 * Scores how much we should TRUST each Kazakhstan exchange/GEO/bonus claim,
 * based on the evidence behind it and how fresh that evidence is. Core
 * principle: accuracy over speed, uncertainty over hallucination — a claim with
 * weak or stale evidence gets a LOW confidence score and is flagged unreliable
 * rather than presented as fact. Nothing here publishes or auto-verifies; a
 * human attaches evidence and the engine scores it deterministically.
 *
 * All scoring/freshness helpers are pure + exported for testing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n);

export const DEFAULT_STALE_AFTER_DAYS = 30;

// ── Freshness engine (Phase 4) ───────────────────────────────────────────────

/**
 * Map an age (since a check) to a freshness band:
 *   ≤50% of TTL → fresh · ≤TTL → aging · ≤2×TTL → stale · else → expired.
 * Never-checked (no timestamp) is treated as `expired` (recheck required).
 */
export function freshnessFromAge(
  lastCheckedAt: string | null,
  staleAfterDays: number,
  now: Date = new Date(),
): FreshnessStatus {
  if (!lastCheckedAt) return 'expired';
  const t = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(t)) return 'expired';
  const ageDays = (now.getTime() - t) / DAY_MS;
  if (ageDays <= staleAfterDays * 0.5) return 'fresh';
  if (ageDays <= staleAfterDays) return 'aging';
  if (ageDays <= staleAfterDays * 2) return 'stale';
  return 'expired';
}

/** Freshness of one evidence item, respecting its hard expiry. */
export function evidenceFreshness(
  e: Evidence,
  staleAfterDays: number,
  now: Date = new Date(),
): FreshnessStatus {
  if (e.expiresAt && now.getTime() > new Date(e.expiresAt).getTime()) return 'expired';
  return freshnessFromAge(e.verifiedAt, staleAfterDays, now);
}

/** Freshness of a whole claim (from its last review). */
export function claimFreshness(claim: VerificationClaim, now: Date = new Date()): FreshnessStatus {
  return freshnessFromAge(claim.lastCheckedAt, claim.staleAfterDays, now);
}

export function needsRecheck(status: FreshnessStatus): boolean {
  return status === 'stale' || status === 'expired';
}

// ── Confidence scoring (Phase 3) ─────────────────────────────────────────────

/** Authority weight per evidence type (higher = more trustworthy source). */
const TYPE_WEIGHT: Record<EvidenceType, number> = {
  official_docs: 65,
  official_support: 55,
  manual_review: 50,
  exchange_ui: 45,
  user_report: 40,
};

const FRESHNESS_FACTOR: Record<FreshnessStatus, number> = {
  fresh: 1.0,
  aging: 0.85,
  stale: 0.55,
  expired: 0.25,
};

/** How much an evidence's verification status counts. */
function statusFactor(e: Evidence): number {
  if (e.status === 'verified') return 1;
  if (e.status === 'outdated') return 0.5;
  return 0.4; // unverified — weak signal
}

/**
 * Confidence 0-100 that a claim is true. Factors: source authority × freshness ×
 * verification status (strongest piece), diminishing bonus for additional
 * confirmations, bonuses for human + official verification, penalty for
 * conflicting evidence. Empty evidence → 0 (we know nothing → say nothing).
 *
 * Scale is illustrative: official docs + recent manual review ≈ 90+, a single
 * old user report ≈ low band. The engine always prefers a LOW score to a
 * confident guess.
 */
export function computeConfidence(claim: VerificationClaim, now: Date = new Date()): number {
  const ev = claim.evidence;
  if (!ev.length) return 0;

  const scored = ev
    .map((e) => TYPE_WEIGHT[e.type] * FRESHNESS_FACTOR[evidenceFreshness(e, claim.staleAfterDays, now)] * statusFactor(e))
    .sort((a, b) => b - a);

  let raw = scored[0];
  for (let i = 1; i < scored.length; i++) raw += (scored[i] * 0.3) / i; // diminishing confirmations

  if (ev.some((e) => e.type === 'manual_review' && e.status === 'verified')) raw += 8;
  if (ev.some((e) => (e.type === 'official_docs' || e.type === 'official_support') && e.status === 'verified')) raw += 5;

  if (claim.conflicting) raw -= 25;

  return clamp(round(raw), 0, 100);
}

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'very_low';

export function confidenceBand(c: number): ConfidenceBand {
  if (c >= 80) return 'high';
  if (c >= 50) return 'medium';
  if (c >= 25) return 'low';
  return 'very_low';
}

/** A claim is reliable only when confidence is solid AND data is fresh/aging. */
export function isReliable(confidence: number, freshness: FreshnessStatus): boolean {
  return confidence >= 60 && (freshness === 'fresh' || freshness === 'aging');
}

export function verdictFor(claim: VerificationClaim, now: Date = new Date()): ClaimVerdict {
  const confidence = computeConfidence(claim, now);
  const freshness = claimFreshness(claim, now);
  return {
    id: claim.id,
    exchangeSlug: claim.exchangeSlug,
    country: claim.country,
    type: claim.type,
    assertion: claim.assertion,
    confidence,
    freshness,
    reliable: isReliable(confidence, freshness),
    evidenceCount: claim.evidence.length,
  };
}

// ── Evidence validation (Phase 2/8) ──────────────────────────────────────────

const EVIDENCE_TYPES = new Set<EvidenceType>([
  'official_docs', 'official_support', 'exchange_ui', 'user_report', 'manual_review',
]);

export interface EvidenceValidation {
  ok: boolean;
  errors: string[];
}

export function validateEvidence(e: Evidence): EvidenceValidation {
  const errors: string[] = [];
  if (!e.id) errors.push('missing id');
  if (!EVIDENCE_TYPES.has(e.type)) errors.push(`invalid evidence type: ${e.type}`);
  // Anything claiming to be official MUST carry a source URL.
  if ((e.type === 'official_docs' || e.type === 'official_support') && !e.sourceUrl) {
    errors.push('official evidence requires a sourceUrl');
  }
  if (!e.reviewer) errors.push('missing reviewer');
  if (!e.verifiedAt || Number.isNaN(Date.parse(e.verifiedAt))) errors.push('invalid verifiedAt');
  if (e.expiresAt && Number.isNaN(Date.parse(e.expiresAt))) errors.push('invalid expiresAt');
  if (
    e.expiresAt && e.verifiedAt &&
    new Date(e.expiresAt).getTime() < new Date(e.verifiedAt).getTime()
  ) {
    errors.push('expiresAt is before verifiedAt');
  }
  return { ok: errors.length === 0, errors };
}

// ── GEO snapshots (Phase 5) ──────────────────────────────────────────────────

const KZ_BANKS = ['Kaspi', 'Halyk', 'Freedom'];
const worstFreshness = (a: FreshnessStatus, b: FreshnessStatus): FreshnessStatus => {
  const order: FreshnessStatus[] = ['expired', 'stale', 'aging', 'fresh'];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
};

/**
 * Build a Kazakhstan snapshot for one exchange. The VALUES (kyc/p2p/kzt/banks)
 * come from the registry's current best-known data; the verification engine
 * supplies the CONFIDENCE + FRESHNESS in that data from the attached claims.
 * With no claims the snapshot is confidence 0 / not reliable — uncertainty, not
 * a confident guess.
 */
export function buildKzSnapshot(
  ex: ExchangeRecord,
  claims: VerificationClaim[],
  now: Date = new Date(),
): KzGeoSnapshot {
  const kz = ex.kazakhstan;
  const relevant = claims.filter(
    (c) =>
      c.exchangeSlug === ex.slug &&
      c.country.toUpperCase() === 'KZ' &&
      (['availability', 'kyc', 'p2p', 'fiat'] as ClaimType[]).includes(c.type),
  );

  const confidence = relevant.length
    ? round(relevant.reduce((a, c) => a + computeConfidence(c, now), 0) / relevant.length)
    : 0;
  const freshness = relevant.length
    ? relevant.map((c) => claimFreshness(c, now)).reduce(worstFreshness)
    : 'expired';
  const reliable = relevant.length > 0 && isReliable(confidence, freshness);

  return {
    exchangeSlug: ex.slug,
    name: ex.name,
    country: 'KZ',
    kyc: kz.kyc as KycLevel,
    p2p: kz.p2p,
    kzt: kz.fiat.map((f) => f.toLowerCase()).includes('kzt'),
    localBanks: kz.fiat.filter((f) => KZ_BANKS.includes(f)),
    notes: reliable ? kz.notes : `${kz.notes} ⚠️ low confidence — verify before use.`,
    confidence,
    freshness,
    reliable,
    generatedAt: now.toISOString(),
  };
}

// ── Analytics integration (Phase 7) ──────────────────────────────────────────

export interface VerificationAnalytics {
  totalClaims: number;
  avgConfidence: number;
  byBand: Record<ConfidenceBand, number>;
  staleClaims: string[];       // claim ids needing recheck
  recentlyChecked: number;     // claims checked within the freshness window
  outdatedBonuses: string[];   // bonus ids that are unverified/outdated
}

export function staleClaims(claims: VerificationClaim[], now: Date = new Date()): VerificationClaim[] {
  return claims.filter((c) => needsRecheck(claimFreshness(c, now)));
}

export function verificationAnalytics(
  claims: VerificationClaim[],
  bonuses: BonusRecord[] = [],
  now: Date = new Date(),
): VerificationAnalytics {
  const byBand: Record<ConfidenceBand, number> = { high: 0, medium: 0, low: 0, very_low: 0 };
  let confSum = 0;
  let recent = 0;
  for (const c of claims) {
    const conf = computeConfidence(c, now);
    confSum += conf;
    byBand[confidenceBand(conf)]++;
    const fresh = claimFreshness(c, now);
    if (fresh === 'fresh' || fresh === 'aging') recent++;
  }
  return {
    totalClaims: claims.length,
    avgConfidence: claims.length ? round(confSum / claims.length) : 0,
    byBand,
    staleClaims: staleClaims(claims, now).map((c) => c.id),
    recentlyChecked: recent,
    outdatedBonuses: bonuses
      .filter((b) => effectiveVerification(b, now) !== 'verified')
      .map((b) => b.id),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

export class VerificationStore {
  private file: string;
  private dir: string;
  private byId = new Map<string, VerificationClaim>();

  constructor(
    exchanges: ExchangeRecord[] = [],
    fileName = 'verifications.json',
    dir = config.paths.data,
  ) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.load(exchanges);
  }

  private load(exchanges: ExchangeRecord[]): void {
    try {
      if (fs.existsSync(this.file)) {
        const list = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as VerificationClaim[];
        for (const c of list) this.byId.set(c.id, c);
        return;
      }
    } catch (err) {
      logger.error('verify', `Failed to load verifications, reseeding: ${(err as Error).message}`);
    }
    for (const c of seedClaimsFromExchanges(exchanges)) this.byId.set(c.id, c);
    this.persist();
  }

  private persist(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.all(), null, 2));
    } catch (err) {
      logger.error('verify', `Failed to persist verifications: ${(err as Error).message}`);
    }
  }

  get(id: string): VerificationClaim | undefined {
    return this.byId.get(id);
  }

  all(): VerificationClaim[] {
    return [...this.byId.values()];
  }

  forExchange(slug: string): VerificationClaim[] {
    return this.all().filter((c) => c.exchangeSlug === slug.toLowerCase());
  }

  upsert(claim: VerificationClaim): void {
    this.byId.set(claim.id, claim);
    this.persist();
  }

  /**
   * Attach a piece of evidence to a claim and mark it freshly checked. Rejects
   * structurally-invalid evidence (no fake/empty official claims).
   */
  addEvidence(claimId: string, evidence: Evidence, now: Date = new Date()): VerificationClaim | undefined {
    const claim = this.byId.get(claimId);
    if (!claim) return undefined;
    const v = validateEvidence(evidence);
    if (!v.ok) {
      logger.warn('verify', `Rejected invalid evidence for ${claimId}: ${v.errors.join(', ')}`);
      return undefined;
    }
    claim.evidence.push(evidence);
    claim.lastCheckedAt = now.toISOString();
    this.persist();
    logger.audit('verification_evidence', `Evidence added to ${claimId}`, {
      type: evidence.type, reviewer: evidence.reviewer, confidence: computeConfidence(claim, now),
    });
    return claim;
  }

  /** Record a human recheck without new evidence (refreshes the timestamp). */
  recordCheck(claimId: string, now: Date = new Date()): VerificationClaim | undefined {
    const claim = this.byId.get(claimId);
    if (!claim) return undefined;
    claim.lastCheckedAt = now.toISOString();
    this.persist();
    return claim;
  }
}

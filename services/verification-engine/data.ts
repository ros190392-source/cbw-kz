import { ClaimType, Evidence, ExchangeRecord, VerificationClaim } from '../../src/types';

/** Mirror of DEFAULT_STALE_AFTER_DAYS (kept local to avoid an import cycle). */
const STALE_AFTER_DAYS = 30;

/**
 * Baseline claim seeds for the verification engine.
 *
 * TRUST FIRST: every exchange starts with claims backed only by a single
 * `manual_review` / `unverified` "baseline assumption" with NO recent check.
 * That deliberately yields a VERY LOW confidence score — the system says "we
 * haven't really verified this" instead of pretending the static registry data
 * is confirmed. A human raises confidence by attaching real evidence.
 */

const BASELINE_VERIFIED_AT = '2026-01-01T00:00:00.000Z';

function baselineEvidence(slug: string, type: ClaimType): Evidence {
  return {
    id: `${slug}-${type}-baseline`,
    sourceUrl: '',
    type: 'manual_review',
    note: 'Baseline assumption from static registry — NOT independently verified.',
    verifiedAt: BASELINE_VERIFIED_AT,
    expiresAt: null,
    status: 'unverified',
    reviewer: 'system',
  };
}

/** The KZ claims we track per exchange. */
const KZ_CLAIMS: { type: ClaimType; assertion: (e: ExchangeRecord) => string }[] = [
  { type: 'availability', assertion: (e) => String(e.kazakhstan.available) },
  { type: 'kyc', assertion: (e) => e.kazakhstan.kyc },
  { type: 'p2p', assertion: (e) => String(e.kazakhstan.p2p) },
  { type: 'fiat', assertion: (e) => e.kazakhstan.fiat.join(',') },
];

/** Generate baseline (low-confidence) KZ claims for every exchange. */
export function seedClaimsFromExchanges(exchanges: ExchangeRecord[]): VerificationClaim[] {
  const claims: VerificationClaim[] = [];
  for (const ex of exchanges) {
    for (const { type, assertion } of KZ_CLAIMS) {
      claims.push({
        id: `${ex.slug}:KZ:${type}`,
        exchangeSlug: ex.slug,
        country: 'KZ',
        type,
        assertion: assertion(ex),
        evidence: [baselineEvidence(ex.slug, type)],
        conflicting: false,
        staleAfterDays: STALE_AFTER_DAYS,
        lastCheckedAt: null, // never properly checked → freshness "expired"
      });
    }
  }
  return claims;
}

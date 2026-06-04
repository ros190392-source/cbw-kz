import { ExchangeRecord, KycLevel } from '../../src/types';

/**
 * GEO compatibility engine (EPIC 002 · Phase 3).
 *
 * Answers "does exchange X work in country Y?" with GEO correctness as the top
 * priority — misleading GEO info is explicitly forbidden, so the rules are
 * conservative and explainable. Kazakhstan (`KZ`) is the initial focus and is
 * resolved from each exchange's dedicated `kazakhstan` block; other countries
 * fall back to `supportedGeos` / `restrictedGeos`.
 *
 * Pure functions operate on a single ExchangeRecord; the GeoEngine class wraps a
 * registry lookup by slug for convenience.
 */

export const KZ = 'KZ';

const norm = (c: string) => (c ?? '').trim().toUpperCase();
const isKz = (country: string) => norm(country) === KZ;

/** Does this exchange serve the given country? */
export function isAvailable(ex: ExchangeRecord, country: string): boolean {
  const c = norm(country);
  if (ex.restrictedGeos.map(norm).includes(c)) return false; // hard block wins
  if (isKz(country)) return ex.kazakhstan.available;
  return ex.supportedGeos.includes('*') || ex.supportedGeos.map(norm).includes(c);
}

/** Does it support P2P in that country? (Requires availability.) */
export function supportsP2P(ex: ExchangeRecord, country: string): boolean {
  if (!isAvailable(ex, country)) return false;
  return isKz(country) ? ex.kazakhstan.p2p : ex.p2p;
}

/** KYC depth required in that country. */
export function kycLevel(ex: ExchangeRecord, country: string): KycLevel {
  return isKz(country) ? ex.kazakhstan.kyc : ex.kyc;
}

/** Boolean form: is any KYC required? */
export function requiresKYC(ex: ExchangeRecord, country: string): boolean {
  return kycLevel(ex, country) !== 'none';
}

/** Does it support the given fiat currency/rail in that country? */
export function supportsFiat(ex: ExchangeRecord, country: string, currency: string): boolean {
  if (!isAvailable(ex, country)) return false;
  const want = (currency ?? '').trim().toLowerCase();
  const rails = (isKz(country) ? ex.kazakhstan.fiat : ex.fiat).map((f) => f.toLowerCase());
  return rails.includes(want);
}

export interface GeoProfile {
  slug: string;
  name: string;
  country: string;
  available: boolean;
  p2p: boolean;
  kyc: KycLevel;
  fiat: string[];
  trustLevel: ExchangeRecord['trustLevel'];
}

/** Full GEO profile for one exchange in one country. */
export function geoProfile(ex: ExchangeRecord, country: string): GeoProfile {
  return {
    slug: ex.slug,
    name: ex.name,
    country: norm(country),
    available: isAvailable(ex, country),
    p2p: supportsP2P(ex, country),
    kyc: kycLevel(ex, country),
    fiat: isKz(country) ? ex.kazakhstan.fiat : ex.fiat,
    trustLevel: ex.trustLevel,
  };
}

/** Convenience wrapper around a list of exchanges, resolving by slug. */
export class GeoEngine {
  private bySlug = new Map<string, ExchangeRecord>();

  constructor(exchanges: ExchangeRecord[]) {
    for (const e of exchanges) this.bySlug.set(e.slug.toLowerCase(), e);
  }

  private must(slug: string): ExchangeRecord | null {
    return this.bySlug.get((slug ?? '').toLowerCase()) ?? null;
  }

  isExchangeAvailable(slug: string, country: string): boolean {
    const ex = this.must(slug);
    return ex ? isAvailable(ex, country) : false;
  }

  supportsP2P(slug: string, country: string): boolean {
    const ex = this.must(slug);
    return ex ? supportsP2P(ex, country) : false;
  }

  requiresKYC(slug: string, country: string): boolean {
    const ex = this.must(slug);
    return ex ? requiresKYC(ex, country) : false;
  }

  supportsFiat(slug: string, country: string, currency: string): boolean {
    const ex = this.must(slug);
    return ex ? supportsFiat(ex, country, currency) : false;
  }

  /** All exchanges available in a country, as GEO profiles (best trust first). */
  profilesFor(country: string): GeoProfile[] {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return [...this.bySlug.values()]
      .filter((ex) => isAvailable(ex, country))
      .map((ex) => geoProfile(ex, country))
      .sort((a, b) => order[a.trustLevel] - order[b.trustLevel] || a.name.localeCompare(b.name));
  }
}

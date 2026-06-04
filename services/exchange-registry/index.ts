import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../src/logger';
import { BonusRecord, ExchangeRecord, VerificationStatus } from '../../src/types';
import { DEFAULT_BONUSES, DEFAULT_EXCHANGES } from './data';

export { DEFAULT_BONUSES, DEFAULT_EXCHANGES } from './data';

/**
 * Exchange registry + bonus engine (EPIC 002 · Phases 1-2-5).
 *
 * Structured, trust-first intelligence about exchanges, their GEO/KYC/fiat
 * profile, and their bonuses. Pure validation/verification helpers are exported
 * separately so they can be unit-tested without any filesystem.
 *
 * Nothing here publishes or injects links — it only models reality so a human
 * moderator can make accurate, GEO-correct decisions.
 */

// ── Verification (Phase 5) ───────────────────────────────────────────────────

/** A bonus claim is "stale" once its last check is older than this many days. */
export const VERIFICATION_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Effective verification status, factoring in freshness:
 *  - never checked            → 'unverified'
 *  - verified but check stale  → 'outdated'
 *  - otherwise                → the stored status
 */
export function effectiveVerification(
  bonus: BonusRecord,
  now: Date = new Date(),
  ttlDays = VERIFICATION_TTL_DAYS,
): VerificationStatus {
  const { status, lastCheckedAt } = bonus.verification;
  if (!lastCheckedAt) return 'unverified';
  if (status === 'unverified') return 'unverified';
  const ageMs = now.getTime() - new Date(lastCheckedAt).getTime();
  if (ageMs > ttlDays * DAY_MS) return 'outdated';
  return status;
}

/** True only when a bonus is verified-fresh AND currently active (Phase 5). */
export function isPublishableBonus(bonus: BonusRecord, now: Date = new Date()): boolean {
  return effectiveVerification(bonus, now) === 'verified' && isBonusActive(bonus, now);
}

// ── Bonus validation (Phase 2/8) ─────────────────────────────────────────────

/** Is the bonus within its [startDate, expiryDate] window right now? */
export function isBonusActive(bonus: BonusRecord, now: Date = new Date()): boolean {
  const t = now.getTime();
  if (bonus.startDate && new Date(bonus.startDate).getTime() > t) return false;
  if (bonus.expiryDate && new Date(bonus.expiryDate).getTime() < t) return false;
  return true;
}

export interface BonusValidation {
  ok: boolean;
  errors: string[];
}

const BONUS_TYPES = new Set<BonusRecord['type']>([
  'signup', 'deposit', 'trading', 'launchpool', 'launchpad', 'campaign', 'competition',
]);

/** Structural validation — catches malformed/unsafe bonus records. */
export function validateBonus(bonus: BonusRecord): BonusValidation {
  const errors: string[] = [];
  if (!bonus.id) errors.push('missing id');
  if (!bonus.exchangeSlug) errors.push('missing exchangeSlug');
  if (!BONUS_TYPES.has(bonus.type)) errors.push(`invalid type: ${bonus.type}`);
  if (!bonus.title) errors.push('missing title');
  if (!bonus.sourceUrl) errors.push('missing sourceUrl (every claim needs a source)');
  if (!Array.isArray(bonus.geos) || bonus.geos.length === 0) errors.push('missing geos');
  if (bonus.startDate && Number.isNaN(Date.parse(bonus.startDate))) errors.push('invalid startDate');
  if (bonus.expiryDate && Number.isNaN(Date.parse(bonus.expiryDate))) errors.push('invalid expiryDate');
  if (
    bonus.startDate && bonus.expiryDate &&
    new Date(bonus.startDate).getTime() > new Date(bonus.expiryDate).getTime()
  ) {
    errors.push('startDate is after expiryDate');
  }
  return { ok: errors.length === 0, errors };
}

// ── Registry persistence (Phase 1) ───────────────────────────────────────────

export class ExchangeRegistry {
  private file: string;
  private dir: string;
  private bySlug = new Map<string, ExchangeRecord>();

  constructor(fileName = 'exchanges.json', dir = config.paths.data, seed = DEFAULT_EXCHANGES) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.load(seed);
  }

  private load(seed: ExchangeRecord[]): void {
    try {
      if (fs.existsSync(this.file)) {
        const list = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as ExchangeRecord[];
        for (const e of list) this.bySlug.set(e.slug, e);
        return;
      }
    } catch (err) {
      logger.error('exchanges', `Failed to load registry, reseeding: ${(err as Error).message}`);
    }
    for (const e of seed) this.bySlug.set(e.slug, e);
    this.persist();
  }

  private persist(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.all(), null, 2));
    } catch (err) {
      logger.error('exchanges', `Failed to persist registry: ${(err as Error).message}`);
    }
  }

  get(slug: string): ExchangeRecord | undefined {
    return this.bySlug.get(slug.toLowerCase());
  }

  all(): ExchangeRecord[] {
    return [...this.bySlug.values()];
  }

  /** Exchanges available in Kazakhstan (the initial GEO focus). */
  availableInKz(): ExchangeRecord[] {
    return this.all().filter((e) => e.kazakhstan.available);
  }

  upsert(record: ExchangeRecord): void {
    this.bySlug.set(record.slug.toLowerCase(), record);
    this.persist();
  }
}

// ── Bonus persistence (Phase 2) ──────────────────────────────────────────────

export class BonusStore {
  private file: string;
  private dir: string;
  private byId = new Map<string, BonusRecord>();

  constructor(fileName = 'bonuses.json', dir = config.paths.data, seed = DEFAULT_BONUSES) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.load(seed);
  }

  private load(seed: BonusRecord[]): void {
    try {
      if (fs.existsSync(this.file)) {
        const list = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as BonusRecord[];
        for (const b of list) this.byId.set(b.id, b);
        return;
      }
    } catch (err) {
      logger.error('bonuses', `Failed to load bonuses, reseeding: ${(err as Error).message}`);
    }
    for (const b of seed) this.byId.set(b.id, b);
    this.persist();
  }

  private persist(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.all(), null, 2));
    } catch (err) {
      logger.error('bonuses', `Failed to persist bonuses: ${(err as Error).message}`);
    }
  }

  get(id: string): BonusRecord | undefined {
    return this.byId.get(id);
  }

  all(): BonusRecord[] {
    return [...this.byId.values()];
  }

  forExchange(slug: string): BonusRecord[] {
    return this.all().filter((b) => b.exchangeSlug === slug.toLowerCase());
  }

  byType(type: BonusRecord['type']): BonusRecord[] {
    return this.all().filter((b) => b.type === type);
  }

  /** Active launchpools/launchpads, newest-window first. */
  launchpools(now: Date = new Date()): BonusRecord[] {
    return this.all().filter(
      (b) => (b.type === 'launchpool' || b.type === 'launchpad') && isBonusActive(b, now),
    );
  }

  upsert(record: BonusRecord): void {
    this.byId.set(record.id, record);
    this.persist();
  }

  /** Record a human verification decision (Phase 5). */
  setVerification(
    id: string,
    status: VerificationStatus,
    source: string,
    now: Date = new Date(),
  ): BonusRecord | undefined {
    const rec = this.byId.get(id);
    if (!rec) return undefined;
    rec.verification = { status, source, lastCheckedAt: now.toISOString() };
    this.persist();
    logger.audit('bonus_verified', `Bonus verification set to ${status}`, { id, source });
    return rec;
  }
}

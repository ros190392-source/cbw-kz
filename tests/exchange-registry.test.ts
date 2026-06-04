import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BonusStore,
  DEFAULT_BONUSES,
  DEFAULT_EXCHANGES,
  ExchangeRegistry,
  effectiveVerification,
  isBonusActive,
  isPublishableBonus,
  validateBonus,
} from '../services/exchange-registry';
import {
  AFFILIATE_AUTO_INJECT,
  affiliateMetaFor,
  buildAffiliateUrl,
  buildCta,
} from '../services/affiliate-layer';
import { BonusRecord } from '../src/types';

function bonus(over: Partial<BonusRecord> = {}): BonusRecord {
  return {
    id: over.id ?? 'b1',
    exchangeSlug: over.exchangeSlug ?? 'bybit',
    type: over.type ?? 'signup',
    title: over.title ?? 'Test bonus',
    description: over.description ?? '',
    value: over.value ?? null,
    geos: over.geos ?? ['*'],
    startDate: over.startDate ?? null,
    expiryDate: over.expiryDate ?? null,
    sourceUrl: over.sourceUrl ?? 'https://example.com/bonus',
    verification: over.verification ?? { status: 'unverified', source: '', lastCheckedAt: null },
  };
}

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-exch-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const NOW = new Date('2026-06-10T12:00:00.000Z');

describe('bonus validation', () => {
  it('accepts a well-formed bonus', () => {
    expect(validateBonus(bonus()).ok).toBe(true);
  });

  it('rejects missing sourceUrl (every claim needs a source)', () => {
    const r = validateBonus(bonus({ sourceUrl: '' }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('sourceUrl');
  });

  it('rejects an invalid type and bad date order', () => {
    expect(validateBonus(bonus({ type: 'bogus' as BonusRecord['type'] })).ok).toBe(false);
    const r = validateBonus(bonus({ startDate: '2026-02-01', expiryDate: '2026-01-01' }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('after');
  });

  it('all seed bonuses are structurally valid', () => {
    for (const b of DEFAULT_BONUSES) expect(validateBonus(b).ok).toBe(true);
  });
});

describe('bonus active window', () => {
  it('is active when inside [start, expiry]', () => {
    expect(isBonusActive(bonus({ startDate: '2026-06-01', expiryDate: '2026-06-30' }), NOW)).toBe(true);
  });
  it('is inactive when expired or not yet started', () => {
    expect(isBonusActive(bonus({ expiryDate: '2026-06-01' }), NOW)).toBe(false);
    expect(isBonusActive(bonus({ startDate: '2026-07-01' }), NOW)).toBe(false);
  });
});

describe('trust verification (Phase 5)', () => {
  it('never-checked → unverified', () => {
    expect(effectiveVerification(bonus(), NOW)).toBe('unverified');
  });
  it('verified + fresh → verified', () => {
    const b = bonus({ verification: { status: 'verified', source: 'official', lastCheckedAt: '2026-06-05T00:00:00.000Z' } });
    expect(effectiveVerification(b, NOW)).toBe('verified');
  });
  it('verified + stale → outdated', () => {
    const b = bonus({ verification: { status: 'verified', source: 'official', lastCheckedAt: '2026-01-01T00:00:00.000Z' } });
    expect(effectiveVerification(b, NOW)).toBe('outdated');
  });
  it('isPublishableBonus requires verified-fresh AND active', () => {
    const good = bonus({
      startDate: '2026-06-01', expiryDate: '2026-06-30',
      verification: { status: 'verified', source: 'official', lastCheckedAt: '2026-06-05T00:00:00.000Z' },
    });
    expect(isPublishableBonus(good, NOW)).toBe(true);
    // unverified seed must NOT be publishable
    expect(isPublishableBonus(bonus(), NOW)).toBe(false);
  });
});

describe('ExchangeRegistry persistence', () => {
  it('seeds, persists and reloads from disk; lookup is case-insensitive', () => {
    const dir = freshDir();
    const reg = new ExchangeRegistry('exchanges.json', dir);
    expect(reg.all().length).toBe(DEFAULT_EXCHANGES.length);
    expect(fs.existsSync(path.join(dir, 'exchanges.json'))).toBe(true);
    expect(reg.get('BYBIT')?.name).toBe('Bybit');

    const reloaded = new ExchangeRegistry('exchanges.json', dir);
    expect(reloaded.all().length).toBe(DEFAULT_EXCHANGES.length);
    expect(reloaded.availableInKz().length).toBeGreaterThan(0);
  });
});

describe('BonusStore', () => {
  it('filters by exchange/type and lists active launchpools', () => {
    const dir = freshDir();
    const store = new BonusStore('bonuses.json', dir);
    expect(store.forExchange('bybit').length).toBeGreaterThan(0);
    expect(store.byType('launchpool').length).toBeGreaterThan(0);
    expect(store.launchpools().every((b) => b.type === 'launchpool' || b.type === 'launchpad')).toBe(true);
  });

  it('setVerification records the decision and persists', () => {
    const dir = freshDir();
    const store = new BonusStore('bonuses.json', dir);
    const id = DEFAULT_BONUSES[0].id;
    const updated = store.setVerification(id, 'verified', 'https://official', NOW);
    expect(updated!.verification.status).toBe('verified');
    expect(updated!.verification.lastCheckedAt).toBe(NOW.toISOString());

    const reloaded = new BonusStore('bonuses.json', dir);
    expect(reloaded.get(id)!.verification.status).toBe('verified');
  });
});

describe('affiliate layer (Phase 4)', () => {
  const bybit = DEFAULT_EXCHANGES.find((e) => e.slug === 'bybit')!;

  it('never auto-injects', () => {
    expect(AFFILIATE_AUTO_INJECT).toBe(false);
  });

  it('builds metadata and a base URL untouched when no ref code', () => {
    const meta = affiliateMetaFor(bybit);
    expect(meta.exchangeSlug).toBe('bybit');
    expect(buildAffiliateUrl(meta)).toBe(bybit.affiliateUrl);
  });

  it('appends ref + campaign params when present', () => {
    const url = buildAffiliateUrl(affiliateMetaFor(bybit, 'CBWKZ', 'launch'));
    expect(url).toContain('ref=CBWKZ');
    expect(url).toContain('utm_campaign=launch');
  });

  it('buildCta returns a suggestion string containing the exchange + url', () => {
    const cta = buildCta(bybit, { refCode: 'CBWKZ' });
    expect(cta).toContain('Bybit');
    expect(cta).toContain('ref=CBWKZ');
  });
});

import { describe, it, expect } from 'vitest';
import {
  GeoEngine,
  isAvailable,
  kycLevel,
  requiresKYC,
  supportsFiat,
  supportsP2P,
} from '../services/geo-engine';
import { DEFAULT_EXCHANGES } from '../services/exchange-registry';
import { ExchangeRecord } from '../src/types';

function ex(over: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    name: 'Test', slug: 'test', officialUrl: 'https://x', affiliateUrl: 'https://x',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['USD', 'EUR'],
    kazakhstan: { available: true, p2p: true, kyc: 'basic', fiat: ['KZT', 'Kaspi'], notes: '' },
    trustLevel: 'medium', notes: '', lastReviewedAt: null,
    ...over,
  };
}

describe('geo-engine: availability', () => {
  it('hard restriction wins over global support', () => {
    expect(isAvailable(ex(), 'US')).toBe(false);
  });

  it('global default allows other countries', () => {
    expect(isAvailable(ex(), 'DE')).toBe(true);
  });

  it('KZ availability comes from the kazakhstan block', () => {
    expect(isAvailable(ex({ kazakhstan: { available: false, p2p: false, kyc: 'full', fiat: [], notes: '' } }), 'KZ')).toBe(false);
    expect(isAvailable(ex(), 'kz')).toBe(true); // case-insensitive
  });

  it('non-global support list restricts unknown countries', () => {
    expect(isAvailable(ex({ supportedGeos: ['KZ', 'DE'] }), 'FR')).toBe(false);
  });
});

describe('geo-engine: P2P / KYC / fiat', () => {
  it('P2P requires availability and uses KZ block for KZ', () => {
    expect(supportsP2P(ex(), 'KZ')).toBe(true);
    expect(supportsP2P(ex({ kazakhstan: { available: true, p2p: false, kyc: 'basic', fiat: [], notes: '' } }), 'KZ')).toBe(false);
    expect(supportsP2P(ex(), 'US')).toBe(false); // restricted → not available
  });

  it('KYC level + requiresKYC reflect the KZ block', () => {
    expect(kycLevel(ex({ kazakhstan: { available: true, p2p: true, kyc: 'none', fiat: [], notes: '' } }), 'KZ')).toBe('none');
    expect(requiresKYC(ex({ kazakhstan: { available: true, p2p: true, kyc: 'none', fiat: [], notes: '' } }), 'KZ')).toBe(false);
    expect(requiresKYC(ex(), 'KZ')).toBe(true);
  });

  it('fiat support is case-insensitive and KZ-aware', () => {
    expect(supportsFiat(ex(), 'KZ', 'kzt')).toBe(true);
    expect(supportsFiat(ex(), 'KZ', 'Kaspi')).toBe(true);
    expect(supportsFiat(ex(), 'KZ', 'JPY')).toBe(false);
    expect(supportsFiat(ex(), 'DE', 'EUR')).toBe(true); // non-KZ uses global fiat
    expect(supportsFiat(ex(), 'US', 'USD')).toBe(false); // restricted
  });
});

describe('geo-engine: GeoEngine wrapper', () => {
  const engine = new GeoEngine(DEFAULT_EXCHANGES);

  it('resolves by slug and returns false for unknown', () => {
    expect(engine.isExchangeAvailable('bybit', 'KZ')).toBe(true);
    expect(engine.isExchangeAvailable('does-not-exist', 'KZ')).toBe(false);
  });

  it('MEXC requires no KYC in KZ (seed baseline)', () => {
    expect(engine.requiresKYC('mexc', 'KZ')).toBe(false);
    expect(engine.requiresKYC('binance', 'KZ')).toBe(true);
  });

  it('profilesFor sorts high-trust first', () => {
    const profiles = engine.profilesFor('KZ');
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles[0].trustLevel).toBe('high');
    expect(profiles.every((p) => p.available)).toBe(true);
  });
});

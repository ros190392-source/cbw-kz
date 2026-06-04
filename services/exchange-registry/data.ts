import { BonusRecord, ExchangeRecord } from '../../src/types';

/**
 * Canonical seed data for the exchange registry + bonus engine.
 *
 * IMPORTANT — TRUST FIRST: these are conservative BASELINE values for an MVP.
 * Every `kazakhstan`/`kyc`/`p2p` field and every bonus MUST be human-verified
 * before it is used in published content. Bonuses ship as `unverified` on
 * purpose — nothing here is presented as fact until a moderator confirms it and
 * flips the verification status. `affiliateUrl` defaults to the official URL
 * (no real ref codes yet); the structure is tracking-ready for when codes land.
 *
 * The registry persists an editable copy to data/exchanges.json on first load;
 * this file remains the source of truth / reset baseline.
 */

const KZ_FIAT = ['KZT', 'Kaspi', 'Halyk', 'Freedom', 'local-cards'];

function kz(over: Partial<ExchangeRecord['kazakhstan']> = {}): ExchangeRecord['kazakhstan'] {
  return {
    available: true,
    p2p: true,
    kyc: 'basic',
    fiat: KZ_FIAT,
    notes: 'Baseline assumption — verify current KZ status before publishing.',
    ...over,
  };
}

export const DEFAULT_EXCHANGES: ExchangeRecord[] = [
  {
    name: 'Bybit', slug: 'bybit',
    officialUrl: 'https://www.bybit.com', affiliateUrl: 'https://www.bybit.com',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['USD', 'EUR', 'KZT'],
    kazakhstan: kz({ kyc: 'basic' }), trustLevel: 'high',
    notes: 'Popular in CIS; strong P2P with KZT.', lastReviewedAt: null,
  },
  {
    name: 'Binance', slug: 'binance',
    officialUrl: 'https://www.binance.com', affiliateUrl: 'https://www.binance.com',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'full', p2p: true, fiat: ['USD', 'EUR', 'KZT'],
    kazakhstan: kz({ kyc: 'full' }), trustLevel: 'high',
    notes: 'Largest global exchange; full KYC. Binance.US is separate.', lastReviewedAt: null,
  },
  {
    name: 'OKX', slug: 'okx',
    officialUrl: 'https://www.okx.com', affiliateUrl: 'https://www.okx.com',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['USD', 'EUR', 'KZT'],
    kazakhstan: kz({ kyc: 'basic' }), trustLevel: 'high',
    notes: 'Broad product suite; P2P available.', lastReviewedAt: null,
  },
  {
    name: 'Bitget', slug: 'bitget',
    officialUrl: 'https://www.bitget.com', affiliateUrl: 'https://www.bitget.com',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['USD', 'KZT'],
    kazakhstan: kz({ kyc: 'basic' }), trustLevel: 'medium',
    notes: 'Known for copy-trading; verify KZ P2P liquidity.', lastReviewedAt: null,
  },
  {
    name: 'MEXC', slug: 'mexc',
    officialUrl: 'https://www.mexc.com', affiliateUrl: 'https://www.mexc.com',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'none', p2p: true, fiat: ['USD', 'KZT'],
    kazakhstan: kz({ kyc: 'none' }), trustLevel: 'medium',
    notes: 'Many listings; KYC often optional for spot. Verify limits.', lastReviewedAt: null,
  },
  {
    name: 'BingX', slug: 'bingx',
    officialUrl: 'https://bingx.com', affiliateUrl: 'https://bingx.com',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['USD', 'KZT'],
    kazakhstan: kz({ kyc: 'basic' }), trustLevel: 'medium',
    notes: 'Social/copy trading focus.', lastReviewedAt: null,
  },
  {
    name: 'KuCoin', slug: 'kucoin',
    officialUrl: 'https://www.kucoin.com', affiliateUrl: 'https://www.kucoin.com',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['USD', 'EUR'],
    kazakhstan: kz({ kyc: 'basic', fiat: ['KZT', 'local-cards'] }), trustLevel: 'medium',
    notes: 'Wide altcoin selection; confirm current KZT rails.', lastReviewedAt: null,
  },
  {
    name: 'HTX', slug: 'htx',
    officialUrl: 'https://www.htx.com', affiliateUrl: 'https://www.htx.com',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['USD'],
    kazakhstan: kz({ kyc: 'basic', fiat: ['KZT', 'local-cards'] }), trustLevel: 'medium',
    notes: 'Formerly Huobi.', lastReviewedAt: null,
  },
  {
    name: 'Gate.io', slug: 'gate',
    officialUrl: 'https://www.gate.io', affiliateUrl: 'https://www.gate.io',
    supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['USD'],
    kazakhstan: kz({ kyc: 'basic', fiat: ['KZT', 'local-cards'] }), trustLevel: 'medium',
    notes: 'Large listing catalogue; verify regional access.', lastReviewedAt: null,
  },
];

/**
 * Seed bonuses — all `unverified` by design. They demonstrate the schema and
 * are intentionally NOT presented as fact. A moderator must confirm each one
 * against its sourceUrl and flip the status to `verified` before use.
 */
export const DEFAULT_BONUSES: BonusRecord[] = [
  {
    id: 'bybit-signup',
    exchangeSlug: 'bybit', type: 'signup',
    title: 'Bybit new-user rewards', description: 'Sign-up + deposit reward hub for new users.',
    value: 'Up to $5,000 (varies)', geos: ['*'],
    startDate: null, expiryDate: null, sourceUrl: 'https://www.bybit.com/en/bonus',
    verification: { status: 'unverified', source: '', lastCheckedAt: null },
  },
  {
    id: 'bybit-launchpool',
    exchangeSlug: 'bybit', type: 'launchpool',
    title: 'Bybit Launchpool', description: 'Stake to earn new-token rewards.',
    value: null, geos: ['*'],
    startDate: null, expiryDate: null, sourceUrl: 'https://www.bybit.com/en/trade/spot/launchpool',
    verification: { status: 'unverified', source: '', lastCheckedAt: null },
  },
  {
    id: 'binance-launchpool',
    exchangeSlug: 'binance', type: 'launchpool',
    title: 'Binance Launchpool', description: 'Stake BNB/FDUSD to farm new tokens.',
    value: null, geos: ['*'],
    startDate: null, expiryDate: null, sourceUrl: 'https://www.binance.com/en/launchpool',
    verification: { status: 'unverified', source: '', lastCheckedAt: null },
  },
  {
    id: 'okx-trading-campaign',
    exchangeSlug: 'okx', type: 'campaign',
    title: 'OKX trading campaign', description: 'Periodic trading-volume reward campaigns.',
    value: null, geos: ['*'],
    startDate: null, expiryDate: null, sourceUrl: 'https://www.okx.com/campaigns',
    verification: { status: 'unverified', source: '', lastCheckedAt: null },
  },
];

import { logger } from '../../src/logger';

/**
 * Promo radar (EPIC 024) — collects live promotions/activities straight from
 * exchange announcement APIs and normalizes them into PromoItems for the
 * Bonus Alert autopublish lane.
 *
 * Sources are official public announcement endpoints (no login, no scraping
 * of authenticated pages). Every fetcher fails open: an exchange being down
 * or blocking the server IP never breaks the run — it just contributes
 * nothing.
 *
 * Honesty constraint: we only repeat what the exchange's own announcement
 * title says; no invented amounts, no expired campaigns (endsAt is checked
 * when the API provides it).
 */

export interface PromoItem {
  /** CBW exchange slug — must match a live /exchanges/<slug>/ page. */
  exchangeSlug: string;
  exchangeName: string;
  title: string;
  /** Public announcement URL on the exchange's own site. */
  url: string;
  /** Publish time, ms epoch. */
  publishedAt: number;
  /** Campaign end, ms epoch; null when the API does not provide one. */
  endsAt: number | null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 15_000;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Reward filter ───────────────────────────────────────────────────────────

/**
 * Keep only announcements that actually offer the reader something. Plain
 * listing/maintenance/launch notes pass through the activities feeds too,
 * and a "Bonus Alert" post about a futures listing would be clickbait.
 */
const REWARD_SIGNALS = [
  'bonus', 'reward', 'prize', 'giveaway', 'airdrop', 'cashback', 'voucher',
  'share up to', 'share a', 'win ', ' apr', ' apy', 'free ', 'zero fee',
  'zero-fee', 'fee promotion', 'earn ', 'rebate', 'lucky draw', 'pool',
  'celebrat', 'grab ', 'ticket',
];

export function isRewardPromo(title: string): boolean {
  const t = ` ${title.toLowerCase()} `;
  return REWARD_SIGNALS.some((kw) => t.includes(kw));
}

/**
 * Region-locked or otherwise non-global campaigns we should not advertise
 * to a worldwide audience.
 */
const EXCLUDE_SIGNALS = ['exclusive country', 'exclusive region', 'selected countries', 'vip only', 'vip-only'];

/** Bracketed exclusivity tags: "[Vietnam Exclusive]", "[MENA exclusive]", … */
const BRACKET_EXCLUSIVE = /\[[^\]]*\bexclusive\b[^\]]*\]/i;

export function isGlobalPromo(title: string): boolean {
  const t = title.toLowerCase();
  if (BRACKET_EXCLUSIVE.test(title)) return false;
  return !EXCLUDE_SIGNALS.some((kw) => t.includes(kw));
}

// ── Fetchers (one per exchange, all fail-open) ──────────────────────────────

export async function fetchBybitPromos(): Promise<PromoItem[]> {
  const data = await getJson(
    'https://api.bybit.com/v5/announcements/index?locale=en-US&type=latest_activities&limit=20',
  );
  const list: any[] = data?.result?.list ?? [];
  return list.map((a) => ({
    exchangeSlug: 'bybit',
    exchangeName: 'Bybit',
    title: String(a.title ?? '').trim(),
    url: String(a.url ?? ''),
    publishedAt: Number(a.publishTime ?? a.dateTimestamp ?? 0),
    endsAt: a.endDateTimestamp ? Number(a.endDateTimestamp) : null,
  }));
}

export async function fetchBinancePromos(): Promise<PromoItem[]> {
  // catalogId 93 = "Latest Activities" on the official announcements CMS.
  const data = await getJson(
    'https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query?type=1&pageNo=1&pageSize=20&catalogId=93',
  );
  const articles: any[] = data?.data?.catalogs?.[0]?.articles ?? [];
  return articles.map((a) => ({
    exchangeSlug: 'binance',
    exchangeName: 'Binance',
    title: String(a.title ?? '').trim(),
    url: `https://www.binance.com/en/support/announcement/${a.code}`,
    publishedAt: Number(a.releaseDate ?? 0),
    endsAt: null,
  }));
}

export async function fetchKucoinPromos(): Promise<PromoItem[]> {
  const data = await getJson(
    'https://api.kucoin.com/api/v3/announcements?annType=activities&lang=en_US&pageSize=20',
  );
  const items: any[] = data?.data?.items ?? [];
  return items.map((a) => ({
    exchangeSlug: 'kucoin',
    exchangeName: 'KuCoin',
    title: String(a.annTitle ?? '').trim(),
    url: String(a.annUrl ?? ''),
    publishedAt: Number(a.cTime ?? 0),
    endsAt: null,
  }));
}

/**
 * Registry of live fetchers. Adding an exchange = adding one entry (and a
 * matching CBW page must exist — the funnel footer links to it).
 */
const FETCHERS: { name: string; fetch: () => Promise<PromoItem[]> }[] = [
  { name: 'bybit', fetch: fetchBybitPromos },
  { name: 'binance', fetch: fetchBinancePromos },
  { name: 'kucoin', fetch: fetchKucoinPromos },
];

// ── Collection + selection ──────────────────────────────────────────────────

/** Max age of an announcement to still be worth posting. */
export const MAX_PROMO_AGE_H = 72;

export interface CollectOptions {
  now?: Date;
  maxAgeH?: number;
}

/** Title/url validity + freshness + reward + global checks. */
export function isEligiblePromo(p: PromoItem, now: Date, maxAgeH: number = MAX_PROMO_AGE_H): boolean {
  if (!p.title || !p.url || !p.url.startsWith('https://')) return false;
  if (!Number.isFinite(p.publishedAt) || p.publishedAt <= 0) return false;
  if (now.getTime() - p.publishedAt > maxAgeH * 60 * 60 * 1000) return false;
  if (p.endsAt !== null && p.endsAt <= now.getTime()) return false; // already over
  return isRewardPromo(p.title) && isGlobalPromo(p.title);
}

/**
 * Fetch all sources in parallel, keep eligible promos, newest first.
 * Individual source failures are logged and skipped.
 */
export async function collectPromos(opts: CollectOptions = {}): Promise<PromoItem[]> {
  const now = opts.now ?? new Date();
  const results = await Promise.allSettled(FETCHERS.map((f) => f.fetch()));
  const all: PromoItem[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      all.push(...r.value);
    } else {
      logger.warn('promo-radar', `${FETCHERS[i].name} fetch failed: ${(r.reason as Error).message}`);
    }
  });
  return all
    .filter((p) => isEligiblePromo(p, now, opts.maxAgeH))
    .sort((a, b) => b.publishedAt - a.publishedAt);
}

/**
 * Pick the best promo not yet posted. Rotation: prefer an exchange different
 * from the most recently posted one, so the channel doesn't become a single
 * exchange's billboard; falls back to newest unposted overall.
 */
export function selectPromo(
  promos: PromoItem[],
  postedUrls: string[],
  lastExchangeSlug: string | null,
): PromoItem | null {
  const posted = new Set(postedUrls);
  const unposted = promos.filter((p) => !posted.has(p.url));
  if (unposted.length === 0) return null;
  const rotated = unposted.find((p) => p.exchangeSlug !== lastExchangeSlug);
  return rotated ?? unposted[0];
}

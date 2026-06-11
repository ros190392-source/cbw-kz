import { logger } from '../../src/logger';

/**
 * Engagement layer (EPIC 022) — real popularity signals for news ranking.
 *
 * RSS carries no likes/views, so we pull two free external "heat" feeds:
 *
 *   1. CryptoPanic hot posts — community votes (positive/important/liked).
 *      Needs a free API token in CRYPTOPANIC_KEY; silently skipped without one.
 *   2. Reddit r/CryptoCurrency hot — upvotes on the stories the crowd is
 *      actually discussing right now. No key needed, but Reddit now blocks
 *      many server IPs (403) — kept fail-open; works where it works.
 *   3. CoinGecko trending — the coins people are searching for right now.
 *      No key needed. News mentioning a trending coin gets a moderate boost.
 *
 * Each external item is reduced to a 0-10 heat score. The index matches our
 * RSS items to external items by significant-token overlap (different outlets
 * word the same story differently — exact title match would never fire) and
 * the pipeline feeds the resulting boost into the popularity dimension of the
 * scoring layer.
 *
 * Fail-open by design: any network/parse error logs a warning and contributes
 * nothing. The pipeline must never stall because a third party is down.
 */

export interface EngagementItem {
  title: string;
  /** Normalized heat, 0-10. */
  heat: number;
}

const FETCH_TIMEOUT_MS = 10_000;

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'after', 'amid', 'over',
  'into', 'says', 'said', 'could', 'would', 'should', 'about', 'their',
  'more', 'than', 'just', 'what', 'when', 'where', 'here', 'why',
  'crypto', 'cryptocurrency', 'bitcoin', 'price', 'market', 'daily',
  'discussion', 'news', 'update', 'report', 'today',
]);

/** Short tokens that matter in crypto headlines despite being < 4 chars. */
const SHORT_KEEP = new Set(['etf', 'sec', 'btc', 'eth', 'sol', 'xrp', 'nft', 'irs', 'cme', 'fed', 'imf']);

/**
 * Crude suffix stemmer so "approves" / "approved" / "approving" land on the
 * same token. Deliberately minimal — headlines, not linguistics.
 */
function stem(t: string): string {
  if (t.length > 6 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 5 && (t.endsWith('ed') || t.endsWith('es'))) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

/** Significant tokens of a title: lowercase, stemmed, no stopwords/short noise. */
export function significantTokens(title: string): Set<string> {
  const tokens = (title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((t) => (t.length >= 4 || SHORT_KEEP.has(t)) && !STOPWORDS.has(t))
    .map(stem);
  return new Set(tokens);
}

/** Shared-token count between two token sets. */
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** Min shared significant tokens to call two titles the same story. */
const MATCH_THRESHOLD = 3;

/**
 * Matches news titles against externally-observed hot stories and returns the
 * heat boost (0-10) for the scoring layer's popularity dimension.
 */
export interface TrendingCoin {
  name: string;
  symbol: string;
}

/** Heat granted when a headline mentions a currently-trending coin. */
const TRENDING_HEAT = 5;

export class EngagementIndex {
  private entries: { tokens: Set<string>; heat: number }[];
  private trending: TrendingCoin[];

  constructor(items: EngagementItem[], trending: TrendingCoin[] = []) {
    this.entries = items
      .map((i) => ({ tokens: significantTokens(i.title), heat: i.heat }))
      .filter((e) => e.tokens.size >= MATCH_THRESHOLD);
    this.trending = trending;
  }

  get size(): number {
    return this.entries.length + this.trending.length;
  }

  /** Heat from external hot stories worded like this title. */
  private storyHeat(title: string): number {
    const tokens = significantTokens(title);
    if (tokens.size < MATCH_THRESHOLD) return 0;
    let best = 0;
    for (const e of this.entries) {
      if (e.heat <= best) continue;
      if (overlap(tokens, e.tokens) >= MATCH_THRESHOLD) best = e.heat;
    }
    return best;
  }

  /** Heat from mentioning a coin people are searching for right now. */
  private trendingHeat(title: string): number {
    const lower = ` ${title.toLowerCase()} `;
    for (const c of this.trending) {
      // Full coin name (≥ 4 chars to avoid generic hits) as a word.
      if (c.name.length >= 4 && lower.includes(` ${c.name.toLowerCase()} `)) return TRENDING_HEAT;
      // Ticker symbol, uppercase whole-word in the original headline (≥ 3 chars).
      if (c.symbol.length >= 3 && new RegExp(`\\b${c.symbol.toUpperCase()}\\b`).test(title)) return TRENDING_HEAT;
    }
    return 0;
  }

  /** Highest engagement heat (0-10) for this title across all signals. */
  boostFor(title: string): number {
    return Math.max(this.storyHeat(title), this.trendingHeat(title));
  }
}

/** Empty index — used when all external feeds are unavailable. */
export const EMPTY_ENGAGEMENT = new EngagementIndex([]);

// ── Heat scaling ─────────────────────────────────────────────────────────────

/** Reddit upvotes → 0-10 heat. */
export function redditHeat(ups: number): number {
  if (ups >= 500) return 10;
  if (ups >= 200) return 7;
  if (ups >= 50) return 4;
  if (ups >= 10) return 2;
  return 0;
}

/** CryptoPanic combined votes → 0-10 heat. */
export function cryptoPanicHeat(votes: { positive?: number; important?: number; liked?: number }): number {
  const total = (votes.positive ?? 0) + (votes.important ?? 0) + (votes.liked ?? 0);
  if (total >= 30) return 10;
  if (total >= 10) return 7;
  if (total >= 3) return 4;
  if (total >= 1) return 2;
  return 0;
}

// ── Fetchers (fail-open) ─────────────────────────────────────────────────────

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CBW-NewsBot/1.0 (engagement signals)', ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Hot posts with community votes from CryptoPanic. Empty without an API key. */
export async function fetchCryptoPanicHot(apiKey: string): Promise<EngagementItem[]> {
  if (!apiKey) return [];
  try {
    const data = (await fetchJson(
      `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&public=true&filter=hot`,
    )) as { results?: { title?: string; votes?: { positive?: number; important?: number; liked?: number } }[] };
    return (data.results ?? [])
      .filter((p) => p.title)
      .map((p) => ({ title: p.title!, heat: cryptoPanicHeat(p.votes ?? {}) }))
      .filter((i) => i.heat > 0);
  } catch (err) {
    logger.warn('engagement', `CryptoPanic fetch failed: ${(err as Error).message}`);
    return [];
  }
}

/** Hot stories from r/CryptoCurrency — what the crowd is upvoting right now. */
export async function fetchRedditHot(): Promise<EngagementItem[]> {
  try {
    const data = (await fetchJson(
      'https://www.reddit.com/r/CryptoCurrency/hot.json?limit=50&raw_json=1',
    )) as { data?: { children?: { data?: { title?: string; ups?: number; stickied?: boolean } }[] } };
    return (data.data?.children ?? [])
      .map((c) => c.data)
      .filter((p): p is { title: string; ups?: number; stickied?: boolean } => Boolean(p?.title) && !p?.stickied)
      .map((p) => ({ title: p.title, heat: redditHeat(p.ups ?? 0) }))
      .filter((i) => i.heat > 0);
  } catch (err) {
    logger.warn('engagement', `Reddit fetch failed: ${(err as Error).message}`);
    return [];
  }
}

/** Coins people are searching for right now (CoinGecko trending, no key). */
export async function fetchCoinGeckoTrending(): Promise<TrendingCoin[]> {
  try {
    const data = (await fetchJson('https://api.coingecko.com/api/v3/search/trending')) as {
      coins?: { item?: { name?: string; symbol?: string } }[];
    };
    return (data.coins ?? [])
      .map((c) => c.item)
      .filter((i): i is { name: string; symbol: string } => Boolean(i?.name && i?.symbol))
      .map((i) => ({ name: i.name, symbol: i.symbol }));
  } catch (err) {
    logger.warn('engagement', `CoinGecko trending fetch failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Build the engagement index from all available external feeds. Never throws;
 * with no key and no network this is just EMPTY_ENGAGEMENT.
 */
export async function buildEngagementIndex(cryptoPanicKey: string): Promise<EngagementIndex> {
  const [panic, reddit, trending] = await Promise.all([
    fetchCryptoPanicHot(cryptoPanicKey),
    fetchRedditHot(),
    fetchCoinGeckoTrending(),
  ]);
  const items = [...panic, ...reddit];
  if (items.length || trending.length) {
    logger.info(
      'engagement',
      `Engagement index: ${panic.length} CryptoPanic + ${reddit.length} Reddit stories, ${trending.length} trending coins`,
    );
  }
  return new EngagementIndex(items, trending);
}

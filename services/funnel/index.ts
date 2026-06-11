/**
 * Traffic funnel layer (EPIC 023) — every channel post routes readers to
 * CryptoBonusWorld.com.
 *
 * Mechanics: when a news item clearly concerns one of the exchanges CBW has a
 * review page for, the post footer links straight to that exchange's page
 * (warm intent — news about Bybit → Bybit bonuses). Otherwise the footer
 * falls back to the general bonuses index. All links carry UTM tags so site
 * analytics attribute traffic to the channel.
 *
 * Honesty constraint: footers never state concrete bonus amounts — those live
 * on the site where they are verified. The footer is navigation, not a claim.
 */

export const SITE_BASE = 'https://cryptobonusworld.com';

/** UTM suffix attributing clicks to the news channel. */
export const UTM = 'utm_source=telegram&utm_medium=news&utm_campaign=cbw_news';

interface ExchangeDef {
  slug: string;
  name: string;
  /** Lowercase keywords; matched against padded lowercase text. */
  keywords: string[];
}

/**
 * Exchanges with live pages at cryptobonusworld.com/exchanges/<slug>/
 * (all 12 verified 200 OK on 2026-06-11). Order matters only for ties.
 */
const EXCHANGES: ExchangeDef[] = [
  { slug: 'bybit',    name: 'Bybit',    keywords: ['bybit'] },
  { slug: 'binance',  name: 'Binance',  keywords: ['binance'] },
  { slug: 'mexc',     name: 'MEXC',     keywords: ['mexc'] },
  { slug: 'okx',      name: 'OKX',      keywords: ['okx'] },
  { slug: 'bitget',   name: 'Bitget',   keywords: ['bitget'] },
  { slug: 'bingx',    name: 'BingX',    keywords: ['bingx'] },
  { slug: 'kucoin',   name: 'KuCoin',   keywords: ['kucoin'] },
  { slug: 'htx',      name: 'HTX',      keywords: [' htx ', 'huobi'] },
  { slug: 'coinex',   name: 'CoinEx',   keywords: ['coinex'] },
  { slug: 'phemex',   name: 'Phemex',   keywords: ['phemex'] },
  { slug: 'bitunix',  name: 'Bitunix',  keywords: ['bitunix'] },
  { slug: 'lbank',    name: 'LBank',    keywords: ['lbank'] },
];

export interface FunnelTarget {
  slug: string;
  name: string;
}

/** Most-mentioned CBW-listed exchange in the text, or null. */
export function detectExchange(text: string): FunnelTarget | null {
  const t = ` ${(text ?? '').toLowerCase().replace(/[\n\t]/g, ' ')} `;
  let best: { def: ExchangeDef; hits: number } | null = null;
  for (const def of EXCHANGES) {
    let hits = 0;
    for (const kw of def.keywords) {
      let i = t.indexOf(kw);
      while (i !== -1) {
        hits++;
        i = t.indexOf(kw, i + kw.length);
      }
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { def, hits };
  }
  return best ? { slug: best.def.slug, name: best.def.name } : null;
}

/** Landing URL for a detected exchange (or the bonuses index) with UTM tags. */
export function funnelUrl(target: FunnelTarget | null): string {
  return target
    ? `${SITE_BASE}/exchanges/${target.slug}/?${UTM}`
    : `${SITE_BASE}/bonuses/?${UTM}`;
}

/**
 * Post footer routing the reader to CBW. Exchange-specific when the news is
 * about a listed exchange, generic otherwise.
 */
export function buildFunnelFooter(text: string): string {
  const target = detectExchange(text);
  const label = target ? `${target.name} bonuses & promo codes` : 'Best exchange bonuses today';
  return `🎁 ${label}\n${funnelUrl(target)}`;
}

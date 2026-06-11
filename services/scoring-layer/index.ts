import { NewsItem, Priority, ScoreResult } from '../../src/types';

/**
 * News scoring layer (global edition — EPIC 021).
 *
 * Ranks every NewsItem 0-100 across five weighted dimensions, assigns a
 * priority (HIGH / MEDIUM / LOW / REJECT), a type category, and a short
 * human-readable reason. Deterministic and keyword-driven — fast, testable,
 * and explainable (no external API call).
 *
 * Popularity is an honest proxy: RSS carries no likes/views, so we use
 * freshness (how recently published) + cross-source coverage (the same story
 * appearing in several independent feeds = trending). The pipeline counts
 * coverage during its de-dupe pass and feeds it in here.
 *
 * The pipeline uses this as the gate before producing drafts: REJECT items are
 * dropped + logged, the rest are ranked and the top N become drafts.
 */

interface Weighted {
  kw: string;
  p: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Minimum total score to survive as a (LOW) draft. Below this an item is a
 * REJECT — pure market noise / price chatter / off-topic. Priority bands:
 *   REJECT < 20 ≤ LOW < 45 ≤ MEDIUM < 65 ≤ HIGH
 */
const REJECT_FLOOR = 20;

function sumMatches(text: string, table: Weighted[]): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];
  for (const { kw, p } of table) {
    if (text.includes(kw)) {
      score += p;
      matched.push(kw.trim());
    }
  }
  return { score, matched };
}

// --- 1. Global crypto importance (0-25) -------------------------------------
const IMPORTANCE: Weighted[] = [
  { kw: 'bitcoin', p: 6 }, { kw: 'ethereum', p: 6 }, { kw: 'etf', p: 8 },
  { kw: 'sec', p: 6 }, { kw: 'regulation', p: 6 }, { kw: 'hack', p: 8 },
  { kw: 'exploit', p: 8 }, { kw: 'breach', p: 7 }, { kw: 'billion', p: 5 },
  { kw: 'blackrock', p: 7 }, { kw: 'federal reserve', p: 6 }, { kw: 'lawsuit', p: 5 },
  { kw: 'ban', p: 5 }, { kw: 'stablecoin', p: 5 }, { kw: 'institutional', p: 5 },
  { kw: 'halving', p: 6 }, { kw: 'tokenized', p: 4 }, { kw: 'cbdc', p: 5 },
  { kw: 'coinbase', p: 4 }, { kw: 'sanction', p: 5 },
];

// --- 3. Exchange / bonus relevance (0-20) -----------------------------------
const EXCHANGES: Weighted[] = [
  { kw: 'bybit', p: 6 }, { kw: 'binance', p: 6 }, { kw: 'okx', p: 6 },
  { kw: 'bitget', p: 6 }, { kw: 'mexc', p: 6 }, { kw: 'bingx', p: 6 },
  { kw: 'kucoin', p: 6 }, { kw: 'gate.io', p: 6 }, { kw: 'gate ', p: 4 },
  { kw: 'htx', p: 6 },
];
const BONUS_STRONG: Weighted[] = [
  { kw: 'launchpool', p: 12 }, { kw: 'launchpad', p: 12 }, { kw: 'megadrop', p: 11 },
  { kw: 'listing', p: 9 }, { kw: 'rewards', p: 8 }, { kw: 'reward', p: 7 },
  { kw: 'bonus', p: 9 }, { kw: 'campaign', p: 7 }, { kw: 'referral', p: 7 },
  { kw: 'trading competition', p: 9 }, { kw: 'p2p update', p: 7 },
  { kw: 'deposit bonus', p: 9 }, { kw: 'airdrop', p: 8 }, { kw: 'p2p', p: 4 },
];

// --- 4. User value (0-20) ---------------------------------------------------
const USER_VALUE: Weighted[] = [
  { kw: 'how to', p: 6 }, { kw: 'guide', p: 6 }, { kw: 'explained', p: 5 },
  { kw: 'available', p: 6 }, { kw: 'launch', p: 5 }, { kw: 'listing', p: 6 },
  { kw: 'airdrop', p: 6 }, { kw: 'reward', p: 6 }, { kw: 'security', p: 6 },
  { kw: 'warning', p: 6 }, { kw: 'scam', p: 5 }, { kw: 'regulation', p: 5 },
  { kw: 'upgrade', p: 4 }, { kw: 'integration', p: 4 }, { kw: 'partnership', p: 3 },
];

// --- 5. Trust / hype penalties ----------------------------------------------
const HYPE: Weighted[] = [
  { kw: '100x', p: 1 }, { kw: '1000x', p: 1 }, { kw: 'to the moon', p: 1 },
  { kw: 'moonshot', p: 1 }, { kw: 'pump', p: 1 }, { kw: 'gem alert', p: 1 },
  { kw: 'next big', p: 1 }, { kw: 'price prediction', p: 1 }, { kw: 'could hit', p: 1 },
  { kw: 'set to explode', p: 1 }, { kw: 'skyrocket', p: 1 }, { kw: 'elon', p: 1 },
  { kw: 'here is why', p: 1 }, { kw: "here's why", p: 1 }, { kw: 'shocking', p: 1 },
  { kw: "you won't", p: 1 }, { kw: 'insane', p: 1 }, { kw: 'massive surge', p: 1 },
];
const MEME: Weighted[] = [
  { kw: 'meme coin', p: 1 }, { kw: 'memecoin', p: 1 }, { kw: 'shitcoin', p: 1 },
  { kw: 'dogecoin', p: 1 }, { kw: 'shiba', p: 1 }, { kw: 'pepe', p: 1 },
  { kw: 'bonk', p: 1 }, { kw: 'floki', p: 1 },
];
const PRICE_NOISE: Weighted[] = [
  { kw: 'price prediction', p: 1 }, { kw: 'technical analysis', p: 1 },
  { kw: 'support level', p: 1 }, { kw: 'resistance level', p: 1 },
  { kw: 'could reach', p: 1 }, { kw: 'eyes $', p: 1 }, { kw: 'targets $', p: 1 },
  { kw: 'price analysis', p: 1 }, { kw: 'rally', p: 1 }, { kw: 'dips', p: 1 },
];

// --- 2. Popularity proxy (0-25): freshness + cross-source coverage ----------

/** Extra context the pipeline can pass about an item's popularity. */
export interface PopularitySignals {
  /** How many independent sources carried (near-)identical stories this run. */
  crossSourceCount?: number;
  /** "Now" override for deterministic tests. */
  now?: Date;
}

/** Freshness component (0-10): newer stories score higher. */
export function freshnessScore(publishDateIso: string, now: Date = new Date()): number {
  const published = new Date(publishDateIso).getTime();
  if (!Number.isFinite(published)) return 0;
  const ageH = (now.getTime() - published) / (60 * 60 * 1000);
  if (ageH < 0) return 0; // future-dated feed garbage
  if (ageH <= 6) return 10;
  if (ageH <= 12) return 7;
  if (ageH <= 24) return 4;
  return 0;
}

/** Coverage component (0-15): the same story in N feeds = trending. */
export function coverageScore(crossSourceCount: number): number {
  if (crossSourceCount >= 3) return 15;
  if (crossSourceCount === 2) return 8;
  return 0;
}

function pickCategory(exBonus: number, text: string): string {
  if (/hack|exploit|breach|stolen|phishing|drained|vulnerability/.test(text)) return 'Security';
  if (exBonus >= 12 && /launchpool|launchpad|bonus|reward|campaign|airdrop|megadrop|competition/.test(text)) {
    return 'Bonus';
  }
  if (/listing|will list|delisting|trading pair/.test(text)) return 'Listing';
  if (/regulation|regulator|sec |mica|lawsuit|license|ban|sanction/.test(text)) return 'Regulation';
  if (/bitcoin| btc /.test(text)) return 'Bitcoin';
  if (/ethereum| eth /.test(text)) return 'Ethereum';
  if (/defi|protocol|liquidity|staking|yield/.test(text)) return 'DeFi';
  return 'Global';
}

export function scoreItem(
  item: NewsItem,
  sourceWeight = 0,
  signals: PopularitySignals = {},
): ScoreResult {
  // Pad with spaces so word-boundary keywords like " btc " match safely.
  const text = ` ${item.title} ${item.summary} `.toLowerCase();

  const importance = sumMatches(text, IMPORTANCE);
  const exch = sumMatches(text, EXCHANGES);
  const bonus = sumMatches(text, BONUS_STRONG);
  const value = sumMatches(text, USER_VALUE);

  const hype = sumMatches(text, HYPE);
  const meme = sumMatches(text, MEME);
  const priceNoise = sumMatches(text, PRICE_NOISE);

  const importance_score = clamp(importance.score, 0, 25);
  const crossSourceCount = signals.crossSourceCount ?? 1;
  const popularity_score = clamp(
    freshnessScore(item.publishDate, signals.now) + coverageScore(crossSourceCount),
    0,
    25,
  );
  const exchange_bonus_score = clamp(exch.score + bonus.score, 0, 20);
  const user_value_score = clamp(value.score, 0, 20);

  const hypeHits = hype.matched.length + priceNoise.matched.length;
  const trust_score = clamp(6 + sourceWeight - hypeHits * 2, 0, 10);

  let score_total = clamp(
    importance_score + popularity_score + exchange_bonus_score + user_value_score + trust_score - hypeHits * 3,
    0,
    100,
  );

  const category = pickCategory(exchange_bonus_score, text);

  // ---- Reject / downrank rules --------------------------------------------
  const noRedeeming = importance_score < 8 && exchange_bonus_score < 8;
  let priority: Priority;
  let reason: string;

  if (meme.matched.length > 0 && noRedeeming) {
    priority = 'REJECT';
    reason = `meme/shitcoin noise (${meme.matched.join(', ')}) with no importance/bonus value`;
  } else if (hypeHits >= 2 && importance_score < 10 && noRedeeming) {
    priority = 'REJECT';
    reason = 'hype without substance (price prediction / influencer noise)';
  } else if (score_total < REJECT_FLOOR) {
    priority = 'REJECT';
    reason = `low-signal (score ${score_total} < ${REJECT_FLOOR})`;
  } else {
    // Trending coverage and strong bonus signals are floors — CBW priorities.
    if (crossSourceCount >= 3 && importance_score >= 8) score_total = Math.max(score_total, 70);
    else if (exchange_bonus_score >= 16) score_total = Math.max(score_total, 65);

    if (score_total >= 65) priority = 'HIGH';
    else if (score_total >= 45) priority = 'MEDIUM';
    else priority = 'LOW';

    reason = buildReason(category, crossSourceCount, [...exch.matched, ...bonus.matched], importance.matched, hypeHits);
  }

  return {
    importance_score,
    popularity_score,
    exchange_bonus_score,
    user_value_score,
    trust_score,
    score_total,
    category,
    reason,
    priority,
  };
}

function buildReason(
  category: string,
  crossSourceCount: number,
  exBonusMatched: string[],
  importanceMatched: string[],
  hypeHits: number,
): string {
  const parts: string[] = [];
  if (crossSourceCount >= 2) parts.push(`trending — covered by ${crossSourceCount} sources`);
  if (exBonusMatched.length) parts.push(`exchange/bonus signal (${exBonusMatched.slice(0, 3).join(', ')}) — CBW monetization`);
  if (importanceMatched.length) parts.push(`global importance (${importanceMatched.slice(0, 3).join(', ')})`);
  if (!parts.length) parts.push('general crypto news');
  let reason = `${category}: ${parts.join('; ')}.`;
  if (hypeHits) reason += ' Hype markers present — trust reduced.';
  return reason;
}

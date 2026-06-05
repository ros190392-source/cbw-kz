import {
  NewsItem,
  ResearchCategory,
  ResearchFinding,
  ResearchPriority,
  SourceTrust,
} from '../../src/types';
import { normalizeTitle } from '../../src/storage';

/**
 * Research engine (EPIC 006 · Phase 2).
 *
 * Aggregates news inputs and classifies each into a research finding:
 * launchpool / listing / bonus / regulation / KZ / restriction / news. Computes
 * a research priority, detects duplicates and weak sources, and ALWAYS marks
 * findings as human-verification-required. It discovers + recommends — it never
 * publishes, approves, or fabricates confidence.
 *
 * Deterministic + keyword-driven; helpers exported for testing.
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const lc = (s: string) => (s ?? '').toLowerCase();

// ── Source trust ─────────────────────────────────────────────────────────────

const TRUSTED_SOURCES = [
  'cointelegraph', 'the block', 'theblock', 'decrypt', 'coindesk', 'reuters', 'bloomberg',
];
const WEAK_SOURCE_HINTS = [
  'medium', 'substack', 'blogspot', 'wordpress', 'telegram', 't.me', 'reddit', 'forum', 'press release', 'prnewswire',
];

/** Classify how much to trust a news source by name/url. */
export function sourceTrustFor(source: string): SourceTrust {
  const s = lc(source);
  if (TRUSTED_SOURCES.some((t) => s.includes(t))) return 'trusted';
  if (WEAK_SOURCE_HINTS.some((w) => s.includes(w))) return 'weak';
  return 'neutral';
}

// ── Detection tables ─────────────────────────────────────────────────────────

const EXCHANGES: Record<string, string[]> = {
  binance: ['binance'], bybit: ['bybit'], okx: ['okx'], mexc: ['mexc'], kucoin: ['kucoin'],
  gate: ['gate.io', 'gateio'], bitget: ['bitget'], htx: ['htx', 'huobi'], bingx: ['bingx'],
  kraken: ['kraken'], coinbase: ['coinbase'],
};

const KZ_TERMS = [
  'kazakhstan', 'kazakh', 'astana', 'almaty', 'tenge', 'kzt', 'kaspi', 'halyk', 'freedom', 'aifc',
];

const TABLES: Record<Exclude<ResearchCategory, 'news' | 'kz'>, string[]> = {
  launchpool: ['launchpool', 'launchpad', 'launch pool', 'farming pool'],
  listing: ['listing', 'will list', 'lists ', 'spot listing', 'gets listed', 'to list'],
  bonus: ['bonus', 'airdrop', 'reward', 'campaign', 'referral', 'cashback', 'trading competition'],
  regulation: ['regulation', 'regulatory', 'sec ', 'license', 'licence', 'compliance', 'legal', 'approved', 'law'],
  restriction: ['restrict', 'ban', 'sanction', 'blocked', 'geo-block', 'prohibit', 'suspend', 'delist', 'exit market', 'halt service'],
};

/** Priority chosen by which category wins (most actionable first). */
const CATEGORY_ORDER: ResearchCategory[] = [
  'launchpool', 'restriction', 'bonus', 'listing', 'regulation', 'kz', 'news',
];

const BASE_PRIORITY: Record<ResearchCategory, ResearchPriority> = {
  launchpool: 'HIGH',
  restriction: 'HIGH',
  bonus: 'HIGH',
  listing: 'MEDIUM',
  regulation: 'MEDIUM',
  kz: 'MEDIUM',
  news: 'LOW',
};

export function detectExchanges(text: string): string[] {
  const hay = lc(text);
  return Object.entries(EXCHANGES)
    .filter(([, needles]) => needles.some((n) => hay.includes(n)))
    .map(([name]) => name);
}

export function detectKz(text: string): boolean {
  const hay = lc(text);
  return KZ_TERMS.some((t) => hay.includes(t));
}

/** All matched category keywords (for explainability). */
function matchedSignals(text: string): { category: Exclude<ResearchCategory, 'news' | 'kz'>; hits: string[] }[] {
  const hay = lc(text);
  const out: { category: Exclude<ResearchCategory, 'news' | 'kz'>; hits: string[] }[] = [];
  for (const [cat, kws] of Object.entries(TABLES) as [Exclude<ResearchCategory, 'news' | 'kz'>, string[]][]) {
    const hits = kws.filter((k) => hay.includes(k));
    if (hits.length) out.push({ category: cat, hits });
  }
  return out;
}

const bump = (p: ResearchPriority): ResearchPriority =>
  p === 'LOW' ? 'MEDIUM' : 'HIGH';

/** Classify one news item into a research finding. */
export function classifyItem(item: NewsItem, now = new Date().toISOString()): ResearchFinding {
  const text = `${item.title} ${item.summary}`;
  const matches = matchedSignals(text);
  const isKz = detectKz(text);
  const exchanges = detectExchanges(text);

  // Pick the dominant category by priority order.
  const matchedCats = new Set(matches.map((m) => m.category));
  let category: ResearchCategory = 'news';
  for (const c of CATEGORY_ORDER) {
    if (c === 'kz') { if (isKz) { category = 'kz'; break; } continue; }
    if (c === 'news') break;
    if (matchedCats.has(c as Exclude<ResearchCategory, 'news' | 'kz'>)) { category = c; break; }
  }

  let priority = BASE_PRIORITY[category];
  // KZ boost: a Kazakhstan angle raises non-HIGH findings one level.
  if (isKz && priority !== 'HIGH') priority = bump(priority);

  const trust = sourceTrustFor(item.source);
  const signals = matches.flatMap((m) => m.hits);
  if (isKz) signals.push('kz');

  // Confidence: source authority + signal strength, weak sources downranked.
  const base = trust === 'trusted' ? 80 : trust === 'weak' ? 35 : 60;
  const confidence = clamp(base + Math.min(signals.length, 4) * 4 + (isKz ? 6 : 0), 0, 100);

  const reasonBits = [
    `${category}${isKz ? ' (KZ)' : ''}`,
    `${trust} source`,
    signals.length ? `signals: ${[...new Set(signals)].slice(0, 5).join(', ')}` : 'no strong signals',
  ];

  return {
    id: item.id,
    title: item.title,
    link: item.link,
    source: item.source,
    category,
    priority,
    exchanges,
    geos: isKz ? ['KZ'] : [],
    signals: [...new Set(signals)],
    sourceTrust: trust,
    confidence,
    reason: reasonBits.join(' · '),
    humanVerificationRequired: true,
    foundAt: now,
  };
}

const PRIORITY_RANK: Record<ResearchPriority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Classify a batch of news items into findings: de-duplicated by normalized
 * title, sorted by priority then confidence. Weak-source low-signal items are
 * kept but naturally sink (low confidence).
 */
export function research(items: NewsItem[], now = new Date().toISOString()): ResearchFinding[] {
  const seen = new Set<string>();
  const findings: ResearchFinding[] = [];
  for (const item of items) {
    const norm = normalizeTitle(item.title);
    if (norm && seen.has(norm)) continue;
    if (norm) seen.add(norm);
    findings.push(classifyItem(item, now));
  }
  return findings.sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.confidence - a.confidence,
  );
}

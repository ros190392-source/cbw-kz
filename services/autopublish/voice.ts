import { makeRng } from './schedule';
import { detectExchange, funnelUrl } from '../funnel';

/**
 * Voice layer (EPIC 027) — de-templatizes captions so the channel reads like
 * a human editor, not a mail-merge. Every choice is *deterministic per post*
 * (seeded from the post id / url), so the same post always renders the same
 * way and tests stay stable, but different posts vary their opener, source
 * attribution, CTA wording and banner label.
 *
 * Strictly stylistic: openers are neutral editorial framing, never factual
 * claims, hype, or financial advice. The funnel URL (with UTM) is untouched.
 */

// ── Seeded chooser ────────────────────────────────────────────────────────────

/** FNV-1a hash → uint32 seed. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A chooser that yields successive, decorrelated picks for one seed. */
export function makeChooser(seed: number): <T>(arr: readonly T[]) => T {
  const rng = makeRng(seed);
  return <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
}

// ── Pools ─────────────────────────────────────────────────────────────────────

/** Optional opener line. Empty entries → sometimes no opener at all. */
const NEWS_OPENERS = [
  '', '', '',
  '👀 On the radar',
  '🗞 ICYMI',
  '📌 Worth noting',
  '🔔 Heads up',
  '⚡ Quick one',
  '🔎 Spotted',
] as const;

const SOURCE_FMTS: ((source: string, link: string) => string)[] = [
  (s, l) => `📰 ${s}\n${l}`,
  (s, l) => `via ${s}\n${l}`,
  (s, l) => `📰 Source: ${s}\n${l}`,
  (s, l) => `${s} reports —\n${l}`,
];

const EX_FOOTERS: ((name: string, url: string) => string)[] = [
  (n, u) => `🎁 All ${n} bonuses & promo codes\n${u}`,
  (n, u) => `💰 Current ${n} bonuses & codes\n${u}`,
  (n, u) => `🎯 ${n} deals on CryptoBonusWorld\n${u}`,
  (n, u) => `🎁 See the ${n} bonus\n${u}`,
];

const GENERIC_FOOTERS: ((url: string) => string)[] = [
  (u) => `🎁 Best exchange bonuses today\n${u}`,
  (u) => `🌍 Every exchange bonus in one place\n${u}`,
  (u) => `🎁 Browse all crypto bonuses\n${u}`,
  (u) => `💰 Compare exchange bonuses\n${u}`,
];

const PROMO_HEADERS: ((name: string) => string)[] = [
  (n) => `🎁 Bonus Alert — ${n}`,
  (n) => `🎁 ${n} — new promo`,
  (n) => `🔔 ${n} bonus is live`,
  (n) => `🎁 Fresh from ${n}`,
];

const PROMO_SOURCES: ((name: string, url: string) => string)[] = [
  (n, u) => `📰 Official announcement\n${u}`,
  (n, u) => `📰 Straight from ${n}\n${u}`,
  (n, u) => `🔗 ${n} announcement\n${u}`,
  (n, u) => `📰 Details on ${n}\n${u}`,
];

// ── Builders ────────────────────────────────────────────────────────────────

export interface NewsVoice { opener: string; attribution: string; footer: string }

/** Varied opener + source attribution + CTA footer for a news post. */
export function newsVoice(seed: number, source: string, link: string, storyText: string): NewsVoice {
  const choose = makeChooser(seed);
  const target = detectExchange(storyText);
  const url = funnelUrl(target);
  return {
    opener: choose(NEWS_OPENERS),
    attribution: choose(SOURCE_FMTS)(source, link),
    footer: target ? choose(EX_FOOTERS)(target.name, url) : choose(GENERIC_FOOTERS)(url),
  };
}

export interface PromoVoice { header: string; source: string; footer: string }

export function promoVoice(seed: number, name: string, slug: string, announcementUrl: string, siteUrl: string): PromoVoice {
  const choose = makeChooser(seed);
  return {
    header: choose(PROMO_HEADERS)(name),
    source: choose(PROMO_SOURCES)(name, announcementUrl),
    footer: choose(EX_FOOTERS)(name, siteUrl),
  };
}

// ── Banner labels ─────────────────────────────────────────────────────────────

/** A label for the gold-frame banner, varied by what the story is about. */
export function bannerLabel(lane: 'exchange' | 'global' | 'bonus', text: string, seed: number): string {
  const t = ` ${(text ?? '').toLowerCase()} `;
  if (lane === 'bonus') return 'BONUS ALERT';
  if (lane === 'exchange') {
    if (/\bairdrop/.test(t)) return 'AIRDROP';
    if (/launchpool|launchpad/.test(t)) return 'LAUNCHPOOL';
    if (/\blist(s|ing|ed)?\b|delist/.test(t)) return 'NEW LISTING';
    return makeChooser(seed)(['EXCHANGE NEWS', 'EXCHANGE UPDATE']);
  }
  if (/regulat|sec\b|lawsuit|ban\b|court/.test(t)) return 'REGULATION';
  if (/\betf/.test(t)) return 'ETF';
  if (/bitcoin|\bbtc\b/.test(t)) return 'BITCOIN';
  if (/ethereum|\beth\b/.test(t)) return 'ETHEREUM';
  return makeChooser(seed)(['CRYPTO NEWS', 'MARKETS']);
}

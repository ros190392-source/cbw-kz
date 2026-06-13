import { DraftStore } from '../../src/draft-store';
import { DraftRecord } from '../../src/types';
import { SenderBot, validateContentSafety } from '../content-center';
import { renderNewsCard, detectCountry } from '../news-card';
import { buildFunnelFooter, detectExchange } from '../funnel';
import { renderBrandedBanner } from '../promo-radar/banner';
import { AutopublishStore } from './index';
import { normalizeTitle } from '../../src/storage';
import { logger } from '../../src/logger';

/**
 * News autopublish lane (EPIC 021 — global news channel).
 *
 * Publishes the top pending news draft at fixed UTC slots, behind the same
 * /autopublish_on toggle as everything else. Selection is honest popularity:
 * drafts are already scored (score_total includes freshness + cross-source
 * coverage); here we re-check freshness so stale drafts never ship.
 *
 *   - slots: 08:00 / 13:00 / 18:00 UTC (±5 min window)
 *   - max 1 post per slot (per-slot idempotency key persisted in the store)
 *   - branded card image with watermark, rendered per post
 *   - safety: validateContentSafety() on the caption; violators are skipped
 *   - failures: shared consecutive-failure counter → auto-disable
 */

// ── Slots ───────────────────────────────────────────────────────────────────

export interface NewsSlot { hour: number; minute: number }

export const NEWS_SLOTS_UTC: NewsSlot[] = [
  { hour: 8, minute: 0 },
  { hour: 13, minute: 0 },
  { hour: 18, minute: 0 },
];

export const NEWS_WINDOW_MIN = 5;

/** Max age of a draft's source story to still be publishable. */
export const MAX_NEWS_AGE_H = 36;

/** Index of the slot whose ±window contains `now`, or null. */
export function currentNewsSlot(now: Date, slots: NewsSlot[] = NEWS_SLOTS_UTC, windowMin: number = NEWS_WINDOW_MIN): number | null {
  for (let i = 0; i < slots.length; i++) {
    const target = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slots[i].hour, slots[i].minute, 0, 0);
    if (Math.abs(now.getTime() - target) <= windowMin * 60 * 1000) return i;
  }
  return null;
}

/** Idempotency key for one slot on one UTC day, e.g. "2026-06-11#1". */
export function newsSlotKey(now: Date, slotIndex: number): string {
  return `${now.toISOString().slice(0, 10)}#${slotIndex}`;
}

// ── Selection ───────────────────────────────────────────────────────────────

/**
 * Exchange-first positioning (EPIC 025): the channel is about exchanges —
 * their news, products, listings, incidents — not general macro. A story
 * counts as an exchange story when it mentions a CBW-listed exchange or any
 * clearly exchange-domain term (incl. major exchanges without a CBW page:
 * exchange news about Coinbase is still exchange news; the footer just
 * falls back to /bonuses/).
 */
const EXCHANGE_TERMS = [
  'exchange', ' listing', ' lists ', 'delist', 'launchpool', 'launchpad',
  'airdrop', 'trading fee', 'withdrawal', 'coinbase', 'kraken', 'gate.io',
  'crypto.com', 'upbit', 'bithumb',
];

export function isExchangeStory(text: string): boolean {
  if (detectExchange(text)) return true;
  const t = ` ${(text ?? '').toLowerCase()} `;
  return EXCHANGE_TERMS.some((k) => t.includes(k));
}

// ── Cross-day duplicate guard ─────────────────────────────────────────────────

/**
 * How far back to remember already-published stories when checking a new
 * candidate for duplication. The same story routinely resurfaces a day later
 * from a *different* source (different link, slightly reworded headline), so a
 * 36h freshness window is not enough — we look back several days.
 */
export const DEDUP_WINDOW_H = 96;

/** Min significant tokens before fuzzy matching kicks in (else require exact). */
const MIN_DEDUP_TOKENS = 4;

/** Overlap-coefficient threshold above which two headlines are "the same story". */
const DEDUP_OVERLAP = 0.7;

/** Tokens that carry no story identity — dropped before comparing headlines. */
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'after', 'into', 'from', 'over', 'amid', 'its',
  'new', 'now', 'set', 'how', 'why', 'are', 'was', 'has', 'will', 'some', 'get',
  'gets', 'say', 'says', 'this', 'that', 'than', 'but', 'not', 'out', 'all',
]);

/** Significant tokens of a headline (length ≥3, non-stopword), from titleNorm. */
function significantTokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(' ')
      .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w)),
  );
}

/**
 * Overlap coefficient |A∩B| / min(|A|,|B|). Robust to one headline being a
 * reworded superset of the other (added "IPO", "after some get smoked", etc.).
 */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  const small = a.size <= b.size ? a : b;
  const big = small === a ? b : a;
  if (small.size === 0) return 0;
  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;
  return hit / small.size;
}

/** True when `candidate` tells the same story as one of `published` headlines. */
export function isDuplicateStory(candidate: string, published: string[]): boolean {
  const cand = significantTokens(candidate);
  const candNorm = normalizeTitle(candidate);
  for (const p of published) {
    if (normalizeTitle(p) === candNorm) return true; // exact (post-normalization)
    const pt = significantTokens(p);
    if (cand.size < MIN_DEDUP_TOKENS || pt.size < MIN_DEDUP_TOKENS) continue;
    if (tokenOverlap(cand, pt) >= DEDUP_OVERLAP) return true;
  }
  return false;
}

/**
 * Pick the best publishable pending draft: fresh (≤ MAX_NEWS_AGE_H), passes
 * the safety validator, highest score first (ties → newer story).
 *
 * Exchange stories are preferred outright; the best general story is only a
 * fallback so a slot is never silently skipped when exchange news is quiet.
 */
export function selectTopNewsDraft(drafts: DraftRecord[], now: Date = new Date()): DraftRecord | null {
  const cutoff = now.getTime() - MAX_NEWS_AGE_H * 60 * 60 * 1000;

  // Stories already shipped to the channel in the last few days. The same story
  // resurfaces from a different source (different link, reworded headline), so
  // we match on headline meaning, not just link or exact title.
  const dedupCutoff = now.getTime() - DEDUP_WINDOW_H * 60 * 60 * 1000;
  const publishedTitles: string[] = [];
  const publishedLinks = new Set<string>();
  for (const d of drafts) {
    if (d.status !== 'published') continue;
    const t = new Date(d.publishedAt ?? d.publishDate).getTime();
    if (!Number.isFinite(t) || t < dedupCutoff) continue;
    publishedTitles.push(d.title ?? '');
    if (d.link) publishedLinks.add(d.link);
  }

  const eligible = drafts
    .filter(d => d.status === 'pending')
    .filter(d => {
      const t = new Date(d.publishDate).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .filter(d => validateContentSafety(`${d.title} ${d.text}`).length === 0)
    .filter(d => !publishedLinks.has(d.link))
    .filter(d => !isDuplicateStory(d.title ?? '', publishedTitles))
    .sort((a, b) =>
      (b.scoreTotal ?? 0) - (a.scoreTotal ?? 0) ||
      (b.publishDate ?? '').localeCompare(a.publishDate ?? ''),
    );
  const exchange = eligible.find(d => isExchangeStory(`${d.title} ${d.text}`));
  return exchange ?? eligible[0] ?? null;
}

/** Telegram photo-caption limit. */
const CAPTION_LIMIT = 1024;

/** Build the channel caption: post body + source attribution + CBW funnel footer. */
export function buildNewsCaption(rec: DraftRecord): string {
  const funnel = `\n\n${buildFunnelFooter(`${rec.title} ${rec.text}`)}`;
  const attribution = `\n\n📰 ${rec.source}\n${rec.link}`;
  const maxBody = CAPTION_LIMIT - attribution.length - funnel.length;
  const body = rec.text.length > maxBody ? rec.text.slice(0, maxBody - 2).trimEnd() + ' …' : rec.text;
  return `${body}${attribution}${funnel}`;
}

// ── Tick ────────────────────────────────────────────────────────────────────

export interface NewsTickContext {
  drafts: DraftStore;
  autopublish: AutopublishStore;
  bot: SenderBot;
  channelId: string;
  now?: Date;
  /** Where rendered cards are written (tests override). */
  cardDir?: string;
  notify?: (text: string) => Promise<void>;
  /**
   * Use the source article's own og:image (in CBW gold framing) for exchange
   * stories instead of the AI card. Opt-in (the bot enables it); tests and
   * offline runs keep the deterministic card path.
   */
  banner?: boolean;
}

export type NewsTickAction =
  | 'disabled'
  | 'not_time_yet'
  | 'already_published_this_slot'
  | 'no_eligible_news'
  | 'published'
  | 'publish_failed';

export interface NewsTickResult {
  action: NewsTickAction;
  draftId?: string;
  slotKey?: string;
  error?: string;
}

/**
 * The news lane tick — called every 60s. Publishes at most one news post per
 * slot. Safe to call repeatedly (idempotent via the persisted slot key).
 */
export async function newsAutopublishTick(ctx: NewsTickContext): Promise<NewsTickResult> {
  const now = ctx.now ?? new Date();
  const state = ctx.autopublish.get();

  ctx.autopublish.updateTick({ lastTickAt: now.toISOString() });

  if (!state.enabled) return { action: 'disabled' };

  const slot = currentNewsSlot(now);
  if (slot === null) return { action: 'not_time_yet' };

  const key = newsSlotKey(now, slot);
  if (state.lastNewsSlot === key) return { action: 'already_published_this_slot', slotKey: key };

  const rec = selectTopNewsDraft(ctx.drafts.all(), now);
  if (!rec) return { action: 'no_eligible_news', slotKey: key };

  try {
    // Exchange stories: prefer the source article's own image in CBW gold
    // framing (the source is credited in the caption); fail-open to our card.
    let imagePath: string | null = null;
    if (ctx.banner === true && isExchangeStory(`${rec.title} ${rec.text}`)) {
      imagePath = await renderBrandedBanner(`news-${rec.id}`, rec.link, {
        outDir: ctx.cardDir,
        label: 'EXCHANGE NEWS',
      });
    }
    if (!imagePath) {
      const card = await renderNewsCard(rec.id, {
        title: rec.title,
        category: rec.category,
        source: rec.source,
        publishDate: rec.publishDate,
        country: detectCountry(`${rec.title} ${rec.text}`),
      }, { outDir: ctx.cardDir });
      imagePath = card.filePath;
    }

    const caption = buildNewsCaption(rec);
    const msg = await ctx.bot.sendPhoto(ctx.channelId, imagePath, { caption });

    const at = now.toISOString();
    ctx.drafts.update(rec.id, {
      status: 'published',
      decidedAt: at,
      publishedAt: at,
      channelMessageId: msg.message_id,
    });
    ctx.autopublish.updateTick({
      lastPublishAt: at,
      lastNewsSlot: key,
      lastError: null,
      consecutiveFailures: 0,
    });

    logger.audit('autopublish_news', `Published news ${rec.id} → msg ${msg.message_id}`, { slot: key, score: rec.scoreTotal });
    void ctx.notify?.(`✅ News autopublished — "${rec.title}" (msg ${msg.message_id}, slot ${key})`);
    return { action: 'published', draftId: rec.id, slotKey: key };
  } catch (err) {
    const error = (err as Error).message;
    ctx.autopublish.updateTick({
      lastError: error,
      consecutiveFailures: state.consecutiveFailures + 1,
    });
    logger.error('autopublish_news', `Publish failed for ${rec.id}: ${error}`);
    void ctx.notify?.(`⚠️ News autopublish failed: ${error}`);
    return { action: 'publish_failed', draftId: rec.id, slotKey: key, error };
  }
}

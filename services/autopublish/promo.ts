import fs from 'fs';
import path from 'path';
import { SenderBot, validateContentSafety } from '../content-center';
import { renderNewsCard } from '../news-card';
import { funnelUrl, SITE_BASE, UTM } from '../funnel';
import { collectPromos, selectPromo, PromoItem } from '../promo-radar';
import { renderBrandedBanner, renderBrandFallback } from '../promo-radar/banner';
import { AutopublishStore } from './index';
import { logger } from '../../src/logger';

/**
 * Bonus Alert autopublish lane (EPIC 024).
 *
 * Once a day, between the 13:00 and 18:00 news slots, posts one live
 * exchange promotion collected by the promo radar. Same operational
 * guarantees as the news lane: toggle-gated, idempotent per slot,
 * safety-validated, failures reported and counted toward auto-disable.
 *
 * Funnel: the footer always links to the promo exchange's CBW page — the
 * warmest click in the whole channel (reader is already interested in this
 * exchange's promo).
 */

// ── Slot ────────────────────────────────────────────────────────────────────

export const PROMO_SLOT_UTC = { hour: 15, minute: 30 };
export const PROMO_WINDOW_MIN = 5;

/** Cap on the posted-URL dedup list persisted in state. */
export const POSTED_URLS_CAP = 200;

export function isPromoSlot(now: Date): boolean {
  const target = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    PROMO_SLOT_UTC.hour, PROMO_SLOT_UTC.minute, 0, 0,
  );
  return Math.abs(now.getTime() - target) <= PROMO_WINDOW_MIN * 60 * 1000;
}

/** Idempotency key for the daily promo slot, e.g. "2026-06-12#promo". */
export function promoSlotKey(now: Date): string {
  return `${now.toISOString().slice(0, 10)}#promo`;
}

// ── Sunday site spotlight ───────────────────────────────────────────────────

/**
 * Once a week (Sunday's promo slot) the lane posts the site itself instead
 * of an exchange promo — the channel's own ad. Uses the pre-rendered brand
 * creative; honest copy, no concrete amounts.
 */
export const SPOTLIGHT_CREATIVE = path.join('assets', 'ad-creatives', 'creative_bonus.png');

export function isSpotlightDay(now: Date): boolean {
  return now.getUTCDay() === 0; // Sunday
}

export function buildSpotlightCaption(): string {
  return [
    '🌍 One site. Every exchange bonus.',
    '',
    'CryptoBonusWorld.com tracks signup bonuses, deposit rewards and promo codes across 12+ crypto exchanges — verified and kept up to date.',
    '',
    'Stop trading without a bonus.',
    '',
    '🎁 Browse all bonuses',
    `${SITE_BASE}/bonuses/?${UTM}`,
  ].join('\n');
}

// ── Caption ─────────────────────────────────────────────────────────────────

const CAPTION_LIMIT = 1024;

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Caption = the exchange's own announcement title (no invented numbers),
 * deadline when known, official source link, CBW funnel footer.
 */
export function buildPromoCaption(p: PromoItem, now: Date = new Date()): string {
  const header = `🎁 Bonus Alert — ${p.exchangeName}`;
  const deadline = p.endsAt && p.endsAt > now.getTime() ? `\n\n⏳ Ends ${fmtDate(p.endsAt)} (UTC)` : '';
  const source = `\n\n📰 Official announcement\n${p.url}`;
  const footer = `\n\n🎁 All ${p.exchangeName} bonuses & promo codes\n${funnelUrl({ slug: p.exchangeSlug, name: p.exchangeName })}`;
  const fixed = `${header}\n\n` + `${deadline}${source}${footer}`;
  const maxTitle = CAPTION_LIMIT - fixed.length;
  const title = p.title.length > maxTitle ? p.title.slice(0, maxTitle - 2).trimEnd() + ' …' : p.title;
  return `${header}\n\n${title}${deadline}${source}${footer}`;
}

// ── Tick ────────────────────────────────────────────────────────────────────

export interface PromoTickContext {
  autopublish: AutopublishStore;
  bot: SenderBot;
  channelId: string;
  now?: Date;
  cardDir?: string;
  notify?: (text: string) => Promise<void>;
  /** Test seam: overrides live collection. */
  collect?: () => Promise<PromoItem[]>;
  /** Test seam: false disables og:image banner fetching. */
  banner?: boolean;
}

export type PromoTickAction =
  | 'disabled'
  | 'not_time_yet'
  | 'already_published_this_slot'
  | 'no_eligible_promo'
  | 'published'
  | 'publish_failed';

export interface PromoTickResult {
  action: PromoTickAction;
  slotKey?: string;
  promoUrl?: string;
  error?: string;
}

/**
 * Promo lane tick — called every 60s alongside the news lane tick.
 * At most one Bonus Alert per UTC day.
 */
export async function promoAutopublishTick(ctx: PromoTickContext): Promise<PromoTickResult> {
  const now = ctx.now ?? new Date();
  const state = ctx.autopublish.get();

  if (!state.enabled) return { action: 'disabled' };
  if (!isPromoSlot(now)) return { action: 'not_time_yet' };

  const key = promoSlotKey(now);
  if (state.lastPromoSlot === key) return { action: 'already_published_this_slot', slotKey: key };

  // Sunday = site spotlight (the channel's own ad) instead of an exchange promo.
  const creative = path.resolve(process.cwd(), SPOTLIGHT_CREATIVE);
  if (isSpotlightDay(now) && fs.existsSync(creative)) {
    try {
      const msg = await ctx.bot.sendPhoto(ctx.channelId, creative, { caption: buildSpotlightCaption() });
      ctx.autopublish.updateTick({ lastPromoSlot: key, lastError: null, consecutiveFailures: 0 });
      logger.audit('autopublish_promo', `Published site spotlight → msg ${msg.message_id}`, { slot: key });
      void ctx.notify?.(`✅ Site spotlight published (msg ${msg.message_id})`);
      return { action: 'published', slotKey: key, promoUrl: `${SITE_BASE}/bonuses/` };
    } catch (err) {
      const error = (err as Error).message;
      ctx.autopublish.updateTick({ lastError: error, consecutiveFailures: state.consecutiveFailures + 1 });
      logger.error('autopublish_promo', `Spotlight publish failed: ${error}`);
      void ctx.notify?.(`⚠️ Site spotlight publish failed: ${error}`);
      return { action: 'publish_failed', slotKey: key, error };
    }
  }

  let promo: PromoItem | null = null;
  try {
    const promos = await (ctx.collect ?? (() => collectPromos({ now })))();
    const safe = promos.filter(
      (p) => validateContentSafety(`${p.title}`).length === 0,
    );
    promo = selectPromo(safe, state.postedPromoUrls, state.lastPromoExchange);
  } catch (err) {
    logger.warn('autopublish_promo', `Collection failed: ${(err as Error).message}`);
  }
  if (!promo) {
    // Mark the slot so we don't re-poll the APIs every 60s for the window.
    ctx.autopublish.updateTick({ lastPromoSlot: key });
    return { action: 'no_eligible_promo', slotKey: key };
  }

  try {
    // Prefer the exchange's own campaign banner in CBW framing (EPIC 025);
    // fall back to our rendered card when the page yields no usable og:image.
    const cardId = `promo-${now.getTime()}`;
    let imagePath = ctx.banner === false
      ? null
      : await renderBrandedBanner(cardId, promo.url, { outDir: ctx.cardDir });
    // No usable campaign banner → branded brand-card (exchange logo + name in
    // the CBW gold frame), not a bare news card. Final fail-open: news card.
    if (!imagePath) {
      imagePath = await renderBrandFallback(cardId, promo.exchangeSlug, promo.exchangeName, {
        outDir: ctx.cardDir, label: 'BONUS ALERT',
      });
    }
    if (!imagePath) {
      const card = await renderNewsCard(cardId, {
        title: promo.title,
        category: 'Bonus',
        source: promo.exchangeName,
        publishDate: new Date(promo.publishedAt).toISOString(),
        country: null,
      }, { outDir: ctx.cardDir });
      imagePath = card.filePath;
    }

    const caption = buildPromoCaption(promo, now);
    const msg = await ctx.bot.sendPhoto(ctx.channelId, imagePath, { caption });

    ctx.autopublish.updateTick({
      lastPromoSlot: key,
      lastPromoExchange: promo.exchangeSlug,
      postedPromoUrls: [...state.postedPromoUrls, promo.url].slice(-POSTED_URLS_CAP),
      lastError: null,
      consecutiveFailures: 0,
    });

    logger.audit('autopublish_promo', `Published promo → msg ${msg.message_id}`, { slot: key, exchange: promo.exchangeSlug });
    void ctx.notify?.(`✅ Bonus Alert published — ${promo.exchangeName}: "${promo.title}" (msg ${msg.message_id})`);
    return { action: 'published', slotKey: key, promoUrl: promo.url };
  } catch (err) {
    const error = (err as Error).message;
    ctx.autopublish.updateTick({
      lastError: error,
      consecutiveFailures: state.consecutiveFailures + 1,
    });
    logger.error('autopublish_promo', `Publish failed: ${error}`);
    void ctx.notify?.(`⚠️ Bonus Alert publish failed: ${error}`);
    return { action: 'publish_failed', slotKey: key, promoUrl: promo.url, error };
  }
}

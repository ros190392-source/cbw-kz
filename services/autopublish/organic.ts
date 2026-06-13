import { DraftStore } from '../../src/draft-store';
import { DraftRecord } from '../../src/types';
import { SenderBot } from '../content-center';
import { renderNewsCard, detectCountry } from '../news-card';
import { renderBrandedBanner, renderBrandFallback } from '../promo-radar/banner';
import { collectPromos, selectPromo, PromoItem } from '../promo-radar';
import { validateContentSafety } from '../content-center';
import {
  selectTopNewsDraft, buildNewsCaption, isExchangeStory, resolveExchangeBrand,
} from './news';
import { buildPromoCaption, POSTED_URLS_CAP } from './promo';
import { bannerLabel, hashSeed } from './voice';
import { AutopublishStore, AutopublishState, MAX_CONSECUTIVE_FAILURES } from './index';
import {
  buildDailyPlan, nextDueItem, isExpired, DailyPlan, Lane,
} from './schedule';
import { logger } from '../../src/logger';

/**
 * Organic autopublish tick (EPIC 026).
 *
 * Replaces the fixed-slot news + promo lanes with a randomized daily plan
 * (see schedule.ts): a varying number of posts at random times, split across
 * an exchange lane, a global-news lane, and an occasional bonus lane. Each
 * tick publishes at most one due post; if no eligible content exists for a
 * due slot it retries briefly, then skips it (quality over quantity).
 */

export interface OrganicTickContext {
  drafts: DraftStore;
  autopublish: AutopublishStore;
  bot: SenderBot;
  channelId: string;
  now?: Date;
  cardDir?: string;
  notify?: (text: string) => Promise<void>;
  /** Use source og:image banners (default true). Tests pass false. */
  banner?: boolean;
  /** Test seam: overrides live promo collection. */
  collect?: () => Promise<PromoItem[]>;
  /** Schedule salt so plans differ run-to-run if desired (default 0). */
  salt?: number;
}

export type OrganicAction =
  | 'disabled'
  | 'auto_disabled_failures'
  | 'no_due_item'
  | 'published'
  | 'waiting_no_content'
  | 'skipped_no_content'
  | 'publish_failed';

export interface OrganicTickResult {
  action: OrganicAction;
  itemId?: string;
  lane?: Lane;
  draftId?: string;
  promoUrl?: string;
  error?: string;
}

/** Outcome of a lane publish: null = no eligible content; else a state patch. */
type PublishOutcome = { statePatch: Partial<AutopublishState>; draftId?: string; promoUrl?: string } | null;

export async function organicAutopublishTick(ctx: OrganicTickContext): Promise<OrganicTickResult> {
  const now = ctx.now ?? new Date();
  const useBanner = ctx.banner !== false;
  const state = ctx.autopublish.get();

  ctx.autopublish.updateTick({ lastTickAt: now.toISOString() });
  if (!state.enabled) return { action: 'disabled' };

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    ctx.autopublish.disable('system_auto_disable', now);
    void ctx.notify?.(`⚠️ Autopublish auto-disabled after ${MAX_CONSECUTIVE_FAILURES} failures. Last: ${state.lastError}`);
    return { action: 'auto_disabled_failures' };
  }

  // Ensure today's plan exists; rebuild when the UTC day rolls over.
  const today = now.toISOString().slice(0, 10);
  let plan: DailyPlan = state.dailyPlan && state.dailyPlan.date === today
    ? state.dailyPlan
    : buildDailyPlan(now, ctx.salt ?? 0);
  if (state.dailyPlan?.date !== today) {
    ctx.autopublish.updateTick({ dailyPlan: plan });
    const summary = plan.items.map((it) => `${it.at.slice(11, 16)} ${it.lane}`).join(', ');
    logger.audit('autopublish_organic', `New plan ${today}: ${plan.items.length} posts — ${summary}`);
    void ctx.notify?.(`🗓 Plan for ${today} (${plan.items.length} posts): ${summary}`);
  }

  const item = nextDueItem(plan, now);
  if (!item) return { action: 'no_due_item' };

  // Waited too long with nothing eligible → skip this slot.
  if (isExpired(item, now)) {
    markItem(plan, item.id, 'skipped');
    ctx.autopublish.updateTick({ dailyPlan: plan });
    logger.info('autopublish_organic', `Slot ${item.id} (${item.lane}) skipped — no eligible content`);
    return { action: 'skipped_no_content', itemId: item.id, lane: item.lane };
  }

  try {
    const outcome = await publishForLane(item.lane, ctx, now, state, useBanner);
    if (!outcome) {
      bumpAttempts(plan, item.id);
      ctx.autopublish.updateTick({ dailyPlan: plan });
      return { action: 'waiting_no_content', itemId: item.id, lane: item.lane };
    }
    markItem(plan, item.id, 'posted');
    ctx.autopublish.updateTick({
      dailyPlan: plan,
      lastPublishAt: now.toISOString(),
      lastError: null,
      consecutiveFailures: 0,
      ...outcome.statePatch,
    });
    void ctx.notify?.(`✅ Published (${item.lane}, slot ${item.id})`);
    return { action: 'published', itemId: item.id, lane: item.lane, draftId: outcome.draftId, promoUrl: outcome.promoUrl };
  } catch (err) {
    const error = (err as Error).message;
    ctx.autopublish.updateTick({ lastError: error, consecutiveFailures: state.consecutiveFailures + 1 });
    logger.error('autopublish_organic', `Publish failed for ${item.id} (${item.lane}): ${error}`);
    void ctx.notify?.(`⚠️ Publish failed (${item.lane}): ${error}`);
    return { action: 'publish_failed', itemId: item.id, lane: item.lane, error };
  }
}

// ── Lane publishing ──────────────────────────────────────────────────────────

async function publishForLane(
  lane: Lane, ctx: OrganicTickContext, now: Date, state: AutopublishState, useBanner: boolean,
): Promise<PublishOutcome> {
  if (lane === 'bonus') {
    const outcome = await publishBonus(ctx, now, state, useBanner);
    if (outcome) return outcome;
    // No fresh promo → don't waste the slot, fall back to exchange news.
    return publishNews(ctx, now, 'exchange', useBanner);
  }
  return publishNews(ctx, now, lane, useBanner);
}

async function publishNews(
  ctx: OrganicTickContext, now: Date, lane: 'exchange' | 'global', useBanner: boolean,
): Promise<PublishOutcome> {
  const rec = selectTopNewsDraft(ctx.drafts.all(), now, lane);
  if (!rec) return null;

  const label = bannerLabel(lane, `${rec.title} ${rec.text}`, hashSeed(rec.id));
  let imagePath: string | null = null;
  if (useBanner) {
    imagePath = await renderBrandedBanner(`news-${rec.id}`, rec.link, { outDir: ctx.cardDir, label });
    if (!imagePath && lane === 'exchange') {
      const brand = resolveExchangeBrand(`${rec.title} ${rec.text}`);
      if (brand) imagePath = await renderBrandFallback(`news-${rec.id}`, brand.slug, brand.name, { outDir: ctx.cardDir, label });
    }
  }
  if (!imagePath) {
    const card = await renderNewsCard(rec.id, {
      title: rec.title, category: rec.category, source: rec.source,
      publishDate: rec.publishDate, country: detectCountry(`${rec.title} ${rec.text}`),
    }, { outDir: ctx.cardDir });
    imagePath = card.filePath;
  }

  const msg = await ctx.bot.sendPhoto(ctx.channelId, imagePath, { caption: buildNewsCaption(rec) });
  const at = now.toISOString();
  ctx.drafts.update(rec.id, { status: 'published', decidedAt: at, publishedAt: at, channelMessageId: msg.message_id });
  logger.audit('autopublish_organic', `Published ${lane} news ${rec.id} → msg ${msg.message_id}`, { score: rec.scoreTotal });
  return { statePatch: {}, draftId: rec.id };
}

async function publishBonus(
  ctx: OrganicTickContext, now: Date, state: AutopublishState, useBanner: boolean,
): Promise<PublishOutcome> {
  let promo: PromoItem | null = null;
  try {
    const promos = await (ctx.collect ?? (() => collectPromos({ now })))();
    const safe = promos.filter((p) => validateContentSafety(`${p.title}`).length === 0);
    promo = selectPromo(safe, state.postedPromoUrls, state.lastPromoExchange);
  } catch (err) {
    logger.warn('autopublish_organic', `Promo collection failed: ${(err as Error).message}`);
  }
  if (!promo) return null;

  const cardId = `promo-${now.getTime()}`;
  let imagePath = useBanner ? await renderBrandedBanner(cardId, promo.url, { outDir: ctx.cardDir, label: 'BONUS ALERT' }) : null;
  if (!imagePath) imagePath = await renderBrandFallback(cardId, promo.exchangeSlug, promo.exchangeName, { outDir: ctx.cardDir, label: 'BONUS ALERT' });
  if (!imagePath) {
    const card = await renderNewsCard(cardId, {
      title: promo.title, category: 'Bonus', source: promo.exchangeName,
      publishDate: new Date(promo.publishedAt).toISOString(), country: null,
    }, { outDir: ctx.cardDir });
    imagePath = card.filePath;
  }

  const msg = await ctx.bot.sendPhoto(ctx.channelId, imagePath, { caption: buildPromoCaption(promo, now) });
  logger.audit('autopublish_organic', `Published bonus ${promo.exchangeSlug} → msg ${msg.message_id}`);
  return {
    statePatch: {
      postedPromoUrls: [...state.postedPromoUrls, promo.url].slice(-POSTED_URLS_CAP),
      lastPromoExchange: promo.exchangeSlug,
    },
    promoUrl: promo.url,
  };
}

// ── Plan mutation helpers ─────────────────────────────────────────────────────

function markItem(plan: DailyPlan, id: string, status: 'posted' | 'skipped'): void {
  const it = plan.items.find((x) => x.id === id);
  if (it) it.status = status;
}

function bumpAttempts(plan: DailyPlan, id: string): void {
  const it = plan.items.find((x) => x.id === id);
  if (it) it.attempts += 1;
}

// re-export for the bot's status command convenience
export type { DraftRecord };

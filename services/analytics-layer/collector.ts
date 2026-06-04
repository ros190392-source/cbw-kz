import type TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../src/logger';
import { TelegramMetrics } from '../../src/types';

/**
 * Telegram metrics collector (Phase 2).
 *
 * IMPORTANT REALITY: the Telegram **Bot** API does not expose post views,
 * forwards or reaction counts for channel posts — those are only visible to the
 * MTProto/client API or in the channel UI. So this collector is built to
 * degrade gracefully: it tries whatever a bot can legitimately observe, and for
 * everything it cannot, it returns `null` + `available: false` instead of
 * faking numbers. Edits and deletes CAN be observed (the bot receives
 * `edited_channel_post` / can detect deletions), so those are tracked as plain
 * counters by the AnalyticsStore.
 *
 * The collector is intentionally injectable: in tests / future MTProto
 * integration you can pass a `fetcher` that actually returns engagement data.
 */

export type EngagementFetcher = (
  channelId: string,
  messageId: number,
) => Promise<Pick<TelegramMetrics, 'views' | 'forwards' | 'reactions'> | null>;

export interface CollectResult {
  patch: Partial<TelegramMetrics>;
  available: boolean;
  note: string;
}

/**
 * Attempt to collect engagement for one post. Never throws — on any failure it
 * returns an "unavailable" result so the pipeline keeps running.
 */
export async function collectMetrics(
  channelId: string,
  messageId: number,
  fetcher?: EngagementFetcher,
): Promise<CollectResult> {
  if (!fetcher) {
    return {
      patch: {},
      available: false,
      note: 'No engagement fetcher configured (Bot API cannot read views/forwards/reactions).',
    };
  }
  try {
    const data = await fetcher(channelId, messageId);
    if (!data) {
      return { patch: {}, available: false, note: 'Fetcher returned no engagement data.' };
    }
    return {
      patch: { views: data.views, forwards: data.forwards, reactions: data.reactions },
      available: true,
      note: 'Engagement collected.',
    };
  } catch (err) {
    logger.warn('analytics', `Metrics collection failed (graceful): ${(err as Error).message}`);
    return { patch: {}, available: false, note: `Collection error: ${(err as Error).message}` };
  }
}

/**
 * Bot-API fetcher stub. Returns null because the Bot API genuinely cannot read
 * these metrics; kept so the bot can wire a fetcher today and swap the
 * implementation (MTProto / analytics export) later without touching callers.
 */
export const botApiFetcher =
  (_bot: TelegramBot): EngagementFetcher =>
  async () =>
    null;

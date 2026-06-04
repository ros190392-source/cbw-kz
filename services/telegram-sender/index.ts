import TelegramBot from 'node-telegram-bot-api';
import { Draft, DraftRecord } from '../../src/types';
import { logger } from '../../src/logger';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Telegram delivery layer.
 *
 * - `sendDraft` delivers a draft to the private moderation chat with inline
 *   Approve / Reject buttons.
 * - `publishToChannel` publishes an APPROVED post to the public channel.
 *
 * `publishToChannel` is ONLY ever called from the bot's Approve handler, after
 * an explicit manual click. There is no automatic / scheduled posting.
 */
export class TelegramSender {
  constructor(private bot: TelegramBot, private chatId: string) {
    if (!chatId) {
      logger.warn('sender', 'TELEGRAM_MODERATION_CHAT_ID is empty — drafts cannot be delivered.');
    }
  }

  private format(draft: Draft): string {
    const { item, text, category, score } = draft;
    const published = new Date(item.publishDate).toISOString().replace('T', ' ').slice(0, 16);

    const lines: string[] = ['📝 <b>DRAFT — awaiting approval</b>', ''];

    // Scoring metadata block (TASK 002).
    if (score) {
      lines.push(
        `🔥 Priority: <b>${score.priority}</b>`,
        `🌍 Type: ${escapeHtml(score.category)}`,
        `📊 Score: ${score.score_total}/100`,
        `🧠 Why: ${escapeHtml(score.reason)}`,
        '',
      );
    } else {
      lines.push(`🏷 ${category ? `#${category}` : '#news'}`, '');
    }

    lines.push(
      escapeHtml(text),
      ``,
      `———`,
      `🗞 <b>${escapeHtml(item.source)}</b> · ${published} UTC`,
      `🔗 <a href="${escapeHtml(item.link)}">Source</a>`,
    );
    return lines.join('\n');
  }

  async sendDraft(draft: Draft): Promise<void> {
    await this.bot.sendMessage(this.chatId, this.format(draft), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${draft.item.id}` },
            { text: '❌ Reject', callback_data: `reject:${draft.item.id}` },
          ],
        ],
      },
    });
    logger.info('sender', `Draft delivered to moderation chat: «${draft.item.title}»`);
  }

  /** Format the clean post that goes to the public channel (no scoring header). */
  private formatPublished(rec: DraftRecord): string {
    const tag = rec.category ? `#${rec.category.replace(/\s+/g, '')}` : '';
    const lines = [escapeHtml(rec.text), '', `🔗 <a href="${escapeHtml(rec.link)}">${escapeHtml(rec.source)}</a>`];
    if (tag) lines.push(tag);
    return lines.join('\n');
  }

  /**
   * Publish an approved draft to the public channel. Returns the channel
   * message id. Called only from the manual Approve handler.
   */
  async publishToChannel(channelId: string, rec: DraftRecord): Promise<number> {
    if (!channelId) throw new Error('TELEGRAM_CHANNEL_ID is not configured');
    const msg = await this.bot.sendMessage(channelId, this.formatPublished(rec), {
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
    return msg.message_id;
  }
}

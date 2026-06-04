import TelegramBot from 'node-telegram-bot-api';
import { config } from '../../config';
import { buildPipeline } from '../../src/pipeline';
import { TelegramSender } from '../../services/telegram-sender';
import { DraftStore } from '../../src/draft-store';
import { approveDraft, rejectDraft } from '../../src/moderation-actions';
import { logger } from '../../src/logger';

/**
 * Long-running Telegram bot — the main runtime for Phase 01.
 *
 * Responsibilities:
 *  - run the pipeline on an interval (and on demand via /run),
 *  - deliver drafts to the moderation chat,
 *  - on a MANUAL Approve click → publish the post to the configured channel,
 *  - on a MANUAL Reject click → mark the draft rejected.
 *
 * There is NO automatic, scheduled, or AI-initiated publishing. A human admin
 * must click Approve for anything to reach the public channel.
 *
 * Commands (in the moderation chat):
 *   /start  — register the chat and print its id
 *   /status — show config + chat id
 *   /run    — trigger a pipeline run immediately
 */
function requireEnv(): void {
  if (!config.telegram.botToken) {
    logger.error('bot', 'TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
}

async function main() {
  requireEnv();

  const bot = new TelegramBot(config.telegram.botToken, { polling: true });
  const sender = new TelegramSender(bot, config.telegram.moderationChatId);
  const pipeline = buildPipeline(sender);
  const drafts = new DraftStore();
  let running = false;

  // Guard against rapid repeated Approve clicks while a publish is in flight.
  const inFlight = new Set<string>();

  const isModerationChat = (chatId?: number | string) =>
    !!config.telegram.moderationChatId && String(chatId) === String(config.telegram.moderationChatId);
  const isAdmin = (userId?: number) =>
    !!userId && config.telegram.adminIds.includes(userId);

  async function runOnce(notifyChatId?: number | string) {
    if (running) {
      if (notifyChatId) await bot.sendMessage(notifyChatId, '⏳ A run is already in progress.');
      return;
    }
    running = true;
    try {
      const stats = await pipeline.run();
      if (notifyChatId) {
        await bot.sendMessage(notifyChatId, `✅ Run complete\n<pre>${JSON.stringify(stats, null, 2)}</pre>`, {
          parse_mode: 'HTML',
        });
      }
    } catch (err) {
      logger.error('bot', `Pipeline run failed: ${(err as Error).message}`);
      if (notifyChatId) await bot.sendMessage(notifyChatId, `❌ Run failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      [
        '👋 <b>CBW KZ moderation bot</b> is online.',
        `This chat id: <code>${msg.chat.id}</code>`,
        '',
        'Set <code>TELEGRAM_MODERATION_CHAT_ID</code> to this id in your .env to receive drafts here.',
        'Commands: /status, /run',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.onText(/\/status/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      [
        '⚙️ <b>Status</b>',
        `Chat id: <code>${msg.chat.id}</code>`,
        `Moderation chat: <code>${config.telegram.moderationChatId || '(unset)'}</code>`,
        `Publish channel: <code>${config.telegram.channelId || '(unset)'}</code>`,
        `Admins: <code>${config.telegram.adminIds.join(', ') || '(none — approvals blocked)'}</code>`,
        `AI model: <code>${config.ai.model}</code> ${config.ai.apiKey ? '(live)' : '(fallback)'}`,
        `Poll interval: ${config.pipeline.pollIntervalMs} ms`,
        `Min score: ${config.pipeline.minScore} · Max/run: ${config.pipeline.maxPerRun}`,
        `Mode: <b>manual draft-only</b> — no auto/scheduled publishing`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.onText(/\/run/, (msg) => {
    bot.sendMessage(msg.chat.id, '🚀 Triggering a pipeline run…');
    void runOnce(msg.chat.id);
  });

  // Lock a moderation message: append a status stamp and remove the buttons.
  async function lockMessage(chatId: number | string, messageId: number, original: string, stamp: string) {
    try {
      await bot.editMessageText(original + stamp, {
        chat_id: chatId,
        message_id: messageId,
        disable_web_page_preview: true,
      });
    } catch (err) {
      logger.error('bot', `Failed to lock message: ${(err as Error).message}`);
    }
  }

  const utcStamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  // Approve → publish to channel (manual only). Reject → mark rejected.
  // Safety: only the moderation chat, only configured admin ids, no duplicate
  // publishes, repeated clicks ignored, message locked after a decision.
  bot.on('callback_query', async (query) => {
    const data = query.data ?? '';
    const [action, id] = data.split(':');
    if (action !== 'approve' && action !== 'reject') return;

    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const original = query.message?.text ?? '';

    // --- Security gates ------------------------------------------------------
    if (!isModerationChat(chatId)) {
      logger.audit('unauthorized', `Callback from non-moderation chat blocked`, { chatId, userId: query.from.id, action });
      await bot.answerCallbackQuery(query.id, { text: 'Not allowed here.' });
      return;
    }
    if (!isAdmin(query.from.id)) {
      logger.audit('unauthorized', `Non-admin approval attempt blocked`, { userId: query.from.id, action, id });
      await bot.answerCallbackQuery(query.id, { text: '⛔ You are not authorized to moderate.' });
      return;
    }

    try {
      if (action === 'reject') {
        const res = rejectDraft(drafts, id);
        await bot.answerCallbackQuery(query.id, { text: res.message });
        if (res.ok && chatId && messageId) {
          await lockMessage(chatId, messageId, original, `\n\n❌ REJECTED (manual_rejection) at ${utcStamp()}`);
        }
        return;
      }

      // action === 'approve'
      if (inFlight.has(id)) {
        await bot.answerCallbackQuery(query.id, { text: 'Still processing previous click…' });
        return;
      }
      inFlight.add(id);
      try {
        const res = await approveDraft(drafts, id, (rec) =>
          sender.publishToChannel(config.telegram.channelId, rec),
        );
        await bot.answerCallbackQuery(query.id, { text: res.message });
        if (res.ok && chatId && messageId) {
          await lockMessage(
            chatId, messageId, original,
            `\n\n✅ PUBLISHED to channel (msg ${res.channelMessageId}) at ${utcStamp()}`,
          );
        } else if (res.status === 'published' && chatId && messageId) {
          // Was already published — make sure the buttons are gone.
          await lockMessage(chatId, messageId, original, `\n\n✅ Already published — duplicate click ignored.`);
        }
      } finally {
        inFlight.delete(id);
      }
    } catch (err) {
      logger.error('bot', `Failed to handle callback: ${(err as Error).message}`);
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Error handling action.' });
      } catch {
        /* ignore */
      }
    }
  });

  bot.on('polling_error', (err) => logger.error('bot', `Polling error: ${err.message}`));

  logger.info('bot', 'Bot started (polling). Running initial pipeline pass…');
  await runOnce();

  setInterval(() => void runOnce(), config.pipeline.pollIntervalMs);
}

main().catch((err) => {
  logger.error('bot', `Fatal: ${(err as Error).message}`);
  process.exit(1);
});

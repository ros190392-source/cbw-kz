import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { buildPipeline } from './pipeline';
import { TelegramSender } from '../services/telegram-sender';
import { logger } from './logger';

/**
 * Headless pipeline runner (no polling bot).
 *
 *   npm run pipeline:once   → run once and exit (good for cron / testing)
 *   npm run pipeline        → run on an interval
 *
 * If a bot token + moderation chat are configured, drafts are delivered to the
 * moderation chat; otherwise they are printed to the console/log (dry run).
 * For interactive Approve/Reject buttons, run the bot instead: `npm run bot`.
 */
async function main() {
  const once = process.argv.includes('--once');

  let sender: TelegramSender | undefined;
  if (config.telegram.botToken && config.telegram.moderationChatId) {
    const bot = new TelegramBot(config.telegram.botToken, { polling: false });
    sender = new TelegramSender(bot, config.telegram.moderationChatId);
    logger.info('runner', 'Telegram sender enabled (draft delivery).');
  } else {
    logger.warn('runner', 'No Telegram credentials — running in console dry-run mode.');
  }

  const pipeline = buildPipeline(sender);

  await pipeline.run();

  if (once) {
    logger.info('runner', 'Single run finished. Exiting.');
    process.exit(0);
  }

  logger.info('runner', `Polling every ${config.pipeline.pollIntervalMs} ms.`);
  setInterval(() => {
    pipeline.run().catch((err) => logger.error('runner', `Run failed: ${(err as Error).message}`));
  }, config.pipeline.pollIntervalMs);
}

main().catch((err) => {
  logger.error('runner', `Fatal: ${(err as Error).message}`);
  process.exit(1);
});

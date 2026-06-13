import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { renderBrandFallback } from '../services/promo-radar/banner';

/** Quick preview: post a branded brand-card for any exchange.
 *  Usage: tsx scripts/test-brand-send.ts <slug> <Name> <LABEL> */
async function main() {
  const [slug, name, label = 'EXCHANGE NEWS'] = process.argv.slice(2);
  if (!slug || !name) throw new Error('usage: <slug> <Name> [LABEL]');
  const bot = new TelegramBot(config.telegram.botToken, { polling: false });
  const img = await renderBrandFallback(`brandsend-${slug}-${Date.now()}`, slug, name, { label });
  if (!img) throw new Error('no image');
  const msg = await bot.sendPhoto(config.telegram.channelId, img, { caption: `${name} — ${label} (layout preview)` });
  console.log(`posted ${name} → msg ${msg.message_id}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

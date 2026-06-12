import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { DraftStore } from '../src/draft-store';
import { AutopublishStore } from '../services/autopublish';
import { buildNewsCaption, isExchangeStory, MAX_NEWS_AGE_H } from '../services/autopublish/news';
import { buildPromoCaption, promoSlotKey } from '../services/autopublish/promo';
import { renderNewsCard, detectCountry } from '../services/news-card';
import { renderBrandedBanner } from '../services/promo-radar/banner';
import { collectPromos, PromoItem } from '../services/promo-radar';
import { validateContentSafety } from '../services/content-center';

/** One-shot A/B test (owner request 2026-06-12): 3 general news posts +
 *  3 exchange Bonus Alerts so the owner can compare formats in the channel. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bot = new TelegramBot(config.telegram.botToken, { polling: false });
  const channel = config.telegram.channelId;
  const drafts = new DraftStore();
  const autopublish = new AutopublishStore();
  const now = new Date();

  // ── 3 general (non-exchange) news ──
  const cutoff = now.getTime() - MAX_NEWS_AGE_H * 60 * 60 * 1000;
  const news = drafts.all()
    .filter(d => d.status === 'pending')
    .filter(d => new Date(d.publishDate).getTime() >= cutoff)
    .filter(d => validateContentSafety(`${d.title} ${d.text}`).length === 0)
    .filter(d => !isExchangeStory(`${d.title} ${d.text}`))
    .sort((a, b) => (b.scoreTotal ?? 0) - (a.scoreTotal ?? 0))
    .slice(0, 3);

  for (const rec of news) {
    const card = await renderNewsCard(rec.id, {
      title: rec.title, category: rec.category, source: rec.source,
      publishDate: rec.publishDate, country: detectCountry(`${rec.title} ${rec.text}`),
    });
    const msg = await bot.sendPhoto(channel, card.filePath, { caption: buildNewsCaption(rec) });
    drafts.update(rec.id, { status: 'published', decidedAt: now.toISOString(), publishedAt: now.toISOString(), channelMessageId: msg.message_id });
    console.log(`NEWS msg ${msg.message_id}: ${rec.title.slice(0, 70)}`);
    await sleep(3000);
  }

  // ── 3 Bonus Alerts, distinct exchanges ──
  const promos = await collectPromos({ now });
  const picked: PromoItem[] = [];
  for (const p of promos) {
    if (validateContentSafety(p.title).length > 0) continue;
    if (!picked.some(x => x.exchangeSlug === p.exchangeSlug)) picked.push(p);
    if (picked.length === 3) break;
  }

  const postedUrls: string[] = [];
  for (const p of picked) {
    const id = `promo-test-${p.exchangeSlug}-${now.getTime()}`;
    let img = await renderBrandedBanner(id, p.url);
    if (!img) {
      const card = await renderNewsCard(id, {
        title: p.title, category: 'Bonus', source: p.exchangeName,
        publishDate: new Date(p.publishedAt).toISOString(), country: null,
      });
      img = card.filePath;
    }
    const msg = await bot.sendPhoto(channel, img, { caption: buildPromoCaption(p, now) });
    postedUrls.push(p.url);
    console.log(`PROMO msg ${msg.message_id} [${p.exchangeName}]: ${p.title.slice(0, 60)}`);
    await sleep(3000);
  }

  // Mark state so the autopilot never duplicates the test posts.
  const st = autopublish.get();
  autopublish.updateTick({
    postedPromoUrls: [...st.postedPromoUrls, ...postedUrls].slice(-200),
    lastPromoSlot: promoSlotKey(now),
    lastPromoExchange: picked[picked.length - 1]?.exchangeSlug ?? st.lastPromoExchange,
  });
  console.log('state updated: promo slot for today marked, urls deduped');
}

main().catch((e) => { console.error(e); process.exit(1); });

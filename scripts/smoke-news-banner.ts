import { DraftStore } from '../src/draft-store';
import { isExchangeStory } from '../services/autopublish/news';
import { renderBrandedBanner, fetchOgImage } from '../services/promo-radar/banner';

/** Smoke: would exchange-news posts get the original article image? */
async function main() {
  const drafts = new DraftStore();
  const recent = drafts.all()
    .filter(d => isExchangeStory(`${d.title} ${d.text}`))
    .sort((a, b) => (b.publishDate ?? '').localeCompare(a.publishDate ?? ''))
    .slice(0, 5);
  for (const d of recent) {
    const og = await fetchOgImage(d.link);
    const out = og ? await renderBrandedBanner(`smoke-news-${d.id}`, d.link, { outDir: 'data/smoke-banners', label: 'EXCHANGE NEWS' }) : null;
    console.log(`[${d.source}] ${out ? 'BANNER OK' : og ? 'og found but rejected' : 'no og:image'} — ${d.title.slice(0, 60)}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });

import { buildEngagementIndex, fetchRedditHot } from '../services/engagement';
import { RssParser } from '../services/rss-parser';
import { SOURCES } from '../config/sources';
import { config } from '../config';

async function main() {
  const reddit = await fetchRedditHot();
  console.log(`Reddit hot items with heat: ${reddit.length}`);
  for (const r of reddit.slice(0, 5)) console.log(`  [${r.heat}] ${r.title.slice(0, 80)}`);

  const index = await buildEngagementIndex(config.engagement.cryptoPanicKey);
  console.log(`Index size: ${index.size}`);

  const parser = new RssParser(SOURCES.filter((s) => s.enabled));
  const items = await parser.fetchAll();
  const bySource = new Map<string, number>();
  for (const i of items) bySource.set(i.sourceId, (bySource.get(i.sourceId) ?? 0) + 1);
  console.log('RSS per source:', Object.fromEntries(bySource));

  let boosted = 0;
  for (const i of items) {
    const b = index.boostFor(i.title);
    if (b > 0) {
      boosted++;
      if (boosted <= 5) console.log(`  BOOST +${b}: ${i.title.slice(0, 80)}`);
    }
  }
  console.log(`Boosted items: ${boosted}/${items.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

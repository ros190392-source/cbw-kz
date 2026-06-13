import { collectPromos } from '../services/promo-radar';
import { buildPromoCaption } from '../services/autopublish/promo';

/** Live smoke: what would the Bonus Alert lane post right now? */
async function main() {
  const promos = await collectPromos();
  console.log(`eligible promos: ${promos.length}\n`);
  for (const p of promos.slice(0, 10)) {
    const ends = p.endsAt ? ` (ends ${new Date(p.endsAt).toISOString().slice(0, 10)})` : '';
    console.log(`[${p.exchangeName}] ${p.title}${ends}`);
  }
  if (promos.length > 0) {
    console.log('\n--- caption preview (top pick) ---\n');
    console.log(buildPromoCaption(promos[0]));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });

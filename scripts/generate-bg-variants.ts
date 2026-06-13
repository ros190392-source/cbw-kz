/**
 * Generate ADDITIONAL background variants per category (bg_<key>_2.png, _3 …)
 * so two same-category news cards use different base art, not one re-tinted
 * image. Idempotent: skips files that already exist. Same brand style + the
 * left-third-dark rule as generate-news-backgrounds.ts.
 *
 * Run: npx tsx scripts/generate-bg-variants.ts
 */
import fs from 'fs';
import path from 'path';
import { getProvider } from '../services/image-generator';

const OUT_DIR = path.resolve(process.cwd(), 'assets', 'news-bgs');

const STYLE =
  'Premium dark fintech key visual, cinematic studio lighting, glossy 3D render, high detail, rich colour. ' +
  'Deep dark-navy / charcoal background with soft ambient glow and gentle gradients (never a flat black void). ' +
  'Brand accents: polished gold (#E7B53C) and teal (#2BD4C4). ' +
  'Composition: the main subject is placed in the RIGHT 40% of the frame, moderately sized, fully visible, never cropped; ' +
  'the LEFT third of the frame stays dark, clean and empty; keep the bottom edge calm. Landscape 3:2. ' +
  'Absolutely NO text, NO lettering, NO numbers, NO logos, NO watermarks, NO UI, NO charts with labels.';

// Each entry → a distinct SCENE (not just a re-tint of the base image).
const VARIANTS: Record<string, string> = {
  bitcoin_2: 'A leaning stack of polished gold Bitcoin medallions with a few coins mid-tumble, warm gold rim light, soft depth-of-field.',
  bitcoin_3: 'A single hero Bitcoin coin rising from a stylized splash of molten liquid gold, dramatic dark scene, sparks of light.',
  global_2:  'A dark stylized globe wrapped in flowing teal light streams and orbiting gold coin satellites, worldwide network mood.',
  global_3:  'An abstract world map of glowing teal dots connected by light arcs, a few gold coin nodes, calm premium tech mood.',
  ethereum_2:'A glowing Ethereum octahedron gem fracturing into floating blue-violet glass shards, cool inner light.',
  regulation_2:'A polished golden gavel resting on a dark sound block beside a marble edge, calm authoritative mood, teal ambient glow.',
  security_2:'A glowing padlock of brushed dark metal with a gold shackle protecting a small teal coin, calm trustworthy mood, no red.',
  listing_2: 'Three glossy coins rising on illuminated glass pedestals with an upward light sweep, fresh green-teal accent glow.',
  defi_2:    'A cluster of liquid-glass orbs connected by golden light filaments exchanging glowing streams, violet-teal palette.',
  bonus_2:   'A dark premium treasure chest spilling a cascade of polished gold coins with warm light, celebratory but restrained.',
};

(async () => {
  const provider = getProvider();
  if (!provider.isConfigured()) {
    console.error(`Image provider "${provider.name}" not configured.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0, skip = 0, fail = 0;
  for (const [name, subject] of Object.entries(VARIANTS)) {
    const out = path.join(OUT_DIR, `bg_${name}.png`);
    if (fs.existsSync(out)) { console.log('skip (exists)', name); skip++; continue; }
    const prompt = `${subject} ${STYLE}`;
    process.stdout.write(`gen ${name} … `);
    const done = await provider.generate(prompt, out);
    if (done && fs.existsSync(out)) { console.log('OK', fs.statSync(out).size, 'b'); ok++; }
    else { console.log('FAIL'); fail++; }
  }
  console.log(`done. ok=${ok} skip=${skip} fail=${fail}`);
})();

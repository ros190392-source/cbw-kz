/**
 * One-time generator for the news-card category backgrounds (EPIC 021 art).
 *
 * Generates assets/news-bgs/bg_<category>.png via the configured image
 * provider (OpenAI gpt-image-1). Idempotent: skips files that already exist —
 * delete a file to regenerate it. Run: npx tsx scripts/generate-news-backgrounds.ts
 */
import fs from 'fs';
import path from 'path';
import { getProvider } from '../services/image-generator';

const OUT_DIR = path.resolve(process.cwd(), 'assets', 'news-bgs');

/**
 * Brand style base. The art subject sits RIGHT of centre and the LEFT third
 * stays dark and uncluttered — the card overlays the headline there. No text,
 * no logos, no UI anywhere (also enforced by the card's scrim).
 */
const STYLE =
  'Premium dark fintech key visual, cinematic studio lighting, glossy 3D render, high detail, rich colour. ' +
  'Deep dark-navy / charcoal background with soft ambient glow and gentle gradients (never a flat black void). ' +
  'Brand accents: polished gold (#E7B53C) and teal (#2BD4C4). ' +
  'Composition: the main subject is placed in the RIGHT 40% of the frame, moderately sized, fully visible, never cropped; ' +
  'the LEFT third of the frame stays dark, clean and empty (a headline is overlaid there); ' +
  'keep the bottom edge calm and uncluttered. Landscape 3:2. ' +
  'Absolutely NO text, NO lettering, NO numbers, NO logos, NO watermarks, NO app interfaces, NO screenshots, NO charts with axis labels.';

const SUBJECTS: Record<string, string> = {
  bitcoin:
    'One large hero Bitcoin coin — thick polished minted medallion with bevelled rim, deep-relief ₿ emblem, ' +
    'luxurious orange-gold metallic finish, soft rim light, subtle floating coin fragments behind it.',
  ethereum:
    'A levitating crystalline Ethereum octahedron gem in cool blue-violet glass with inner glow, ' +
    'refracting light, small glowing shards orbiting it.',
  regulation:
    'Elegant balanced golden scales of justice beside a classical marble column, calm authoritative mood, ' +
    'teal ambient glow, a faint embossed seal medallion in the background.',
  security:
    'A premium glowing protective shield emblem in brushed dark metal with a gold rim guarding a small teal coin, ' +
    'calm trustworthy security mood, soft amber accent light, no alarmist red.',
  bonus:
    'An opened dark gift box with golden light and a fountain of polished gold coins rising from it, ' +
    'celebratory but premium and restrained, warm gold glow.',
  listing:
    'A sleek upward golden arrow sweeping over a podium of three glossy coins, growth and debut concept, ' +
    'fresh green-teal accent glow.',
  defi:
    'An abstract constellation of interconnected glowing nodes and liquid glass orbs exchanging light streams, ' +
    'futuristic decentralized network concept, violet-teal palette.',
  global:
    'A elegant wireframe globe of glowing teal meridians with small gold coin satellites orbiting it, ' +
    'worldwide crypto news concept, gold-teal palette.',
};

(async () => {
  const provider = getProvider();
  if (!provider.isConfigured()) {
    console.error(`Image provider "${provider.name}" is not configured (set IMAGE_PROVIDER + key).`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let ok = 0, skipped = 0, failed = 0;
  for (const [key, subject] of Object.entries(SUBJECTS)) {
    const out = path.join(OUT_DIR, `bg_${key}.png`);
    if (fs.existsSync(out)) { console.log(`SKIP ${key} (exists)`); skipped++; continue; }
    process.stdout.write(`GEN  ${key} ... `);
    const success = await provider.generate(`${subject} ${STYLE}`, out);
    if (success) { console.log('ok'); ok++; }
    else { console.log('FAILED'); failed++; }
  }
  console.log(`\nDone: ${ok} generated, ${skipped} skipped, ${failed} failed → ${OUT_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
})();

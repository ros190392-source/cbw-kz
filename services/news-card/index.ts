import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { logger } from '../../src/logger';
import { DetectedCountry } from './country';

export { detectCountry, DetectedCountry } from './country';

/**
 * News card generator (EPIC 021 — global news channel).
 *
 * Renders a branded 1280x720 news card fully deterministically with sharp +
 * SVG: premium dark gradient background with a category accent, wrapped
 * headline, category chip, source + date footer, and the site watermark in the
 * bottom-right corner. No AI call per news item — fast, free, and safe (no
 * fake screenshots / UI by construction).
 *
 * `applyWatermark()` is exported separately so ANY channel image can get the
 * same bottom-right watermark.
 */

export const CARD_W = 1280;
export const CARD_H = 720;

/** Watermark shown bottom-right on every card (override with BRAND_WATERMARK). */
export const WATERMARK_TEXT = process.env.BRAND_WATERMARK || 'CryptoBonusWorld.com';

const DEFAULT_OUT_DIR = path.resolve(process.cwd(), 'assets', 'news-cards');
/** One-time AI-generated category backgrounds live here (bg_<key>.png). */
const DEFAULT_BG_DIR = path.resolve(process.cwd(), 'assets', 'news-bgs');

// ── Category accents ────────────────────────────────────────────────────────

interface Accent {
  /** Main accent colour (chip, rule, glow). */
  color: string;
  /** Secondary glow colour. */
  glow: string;
  label: string;
}

const ACCENTS: Record<string, Accent> = {
  Bitcoin:    { color: '#F7931A', glow: '#8a5210', label: 'BITCOIN' },
  Ethereum:   { color: '#7C9CF5', glow: '#3a4f8f', label: 'ETHEREUM' },
  Regulation: { color: '#2BD4C4', glow: '#136e66', label: 'REGULATION' },
  Security:   { color: '#FF9F43', glow: '#8f5318', label: 'SECURITY' },
  Bonus:      { color: '#E7B53C', glow: '#7d5f1a', label: 'BONUS' },
  Listing:    { color: '#5BD98A', glow: '#2a7045', label: 'LISTING' },
  DeFi:       { color: '#B07CF5', glow: '#5a3a8f', label: 'DEFI' },
  Global:     { color: '#2BD4C4', glow: '#136e66', label: 'CRYPTO NEWS' },
};

export function accentFor(category: string | null): Accent {
  return ACCENTS[category ?? 'Global'] ?? ACCENTS.Global;
}

/** Filename key for a category's background, e.g. "bitcoin" → bg_bitcoin.png. */
export function bgKeyFor(category: string | null): string {
  const c = category ?? 'Global';
  return (ACCENTS[c] ? c : 'Global').toLowerCase();
}

/** Resolve the AI background for a category, or null if not generated yet. */
export function bgPathFor(category: string | null, bgDir: string = DEFAULT_BG_DIR): string | null {
  const p = path.join(bgDir, `bg_${bgKeyFor(category)}.png`);
  if (fs.existsSync(p)) return p;
  const fallback = path.join(bgDir, 'bg_global.png');
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * All background variants for a category: bg_<key>.png plus bg_<key>_2.png,
 * bg_<key>_3.png … Lets two same-category cards use *different* base images
 * (rotated per post), not just a re-tint of one. Falls back to global, then [].
 */
export function bgVariantsFor(category: string | null, bgDir: string = DEFAULT_BG_DIR): string[] {
  const collect = (key: string): string[] => {
    const out: string[] = [];
    const base = path.join(bgDir, `bg_${key}.png`);
    if (fs.existsSync(base)) out.push(base);
    for (let i = 2; i <= 9; i++) {
      const v = path.join(bgDir, `bg_${key}_${i}.png`);
      if (fs.existsSync(v)) out.push(v);
    }
    return out;
  };
  const own = collect(bgKeyFor(category));
  if (own.length) return own;
  return collect('global');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const esc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Greedy word-wrap into at most `maxLines` lines of ~`maxChars` chars. */
export function wrapHeadline(title: string, maxChars: number, maxLines: number): string[] {
  const words = (title ?? '').trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines);
    const last = head[maxLines - 1];
    head[maxLines - 1] = last.length > maxChars - 1 ? last.slice(0, maxChars - 1).trimEnd() + '…' : last + ' …';
    return head;
  }
  return lines;
}

/**
 * Deterministic per-card visual variation (seeded by the news id) so two cards
 * in the same category never look the same: different crop, a subtle color
 * grade, and an accent glow in a different corner.
 */
export function cardVariation(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  const rng = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const bgRoll = rng(); // which background variant to use (pulled first → stable)
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
  return {
    bgRoll,
    position: pick(['left', 'centre', 'right', 'top', 'left top', 'right top', 'left bottom', 'right bottom'] as const),
    hue: pick([-26, -14, 0, 12, 22, 34] as const),
    saturation: +(0.95 + rng() * 0.25).toFixed(3),
    brightness: +(0.93 + rng() * 0.12).toFixed(3),
    glowCorner: pick(['tr', 'br', 'tl'] as const),
    glowOpacity: +(0.16 + rng() * 0.16).toFixed(3),
  };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** SVG fragment for the bottom-right watermark (shared style). */
function watermarkSvg(W: number, H: number, text: string): string {
  const fs2 = Math.round(W / 52);
  const pad = Math.round(W * 0.032);
  return `<text x="${W - pad}" y="${H - pad}" text-anchor="end" font-family="Arial, 'Segoe UI', sans-serif" font-size="${fs2}" font-weight="600" letter-spacing="1" fill="#FFFFFF" fill-opacity="0.55">${esc(text)}</text>`;
}

// ── Card renderer ───────────────────────────────────────────────────────────

export interface NewsCardInput {
  title: string;
  category: string | null;
  source: string;
  publishDate: string; // ISO
  /** Country the story is about (flag badge top-right); null/omitted = none. */
  country?: DetectedCountry | null;
}

// ── Flag badge ──────────────────────────────────────────────────────────────

const FLAG_DIR = path.resolve(process.cwd(), 'node_modules', 'flag-icons', 'flags', '4x3');
const FLAG_W = 168;
const FLAG_H = 126;

/** Flag badge geometry on the card (top-right corner). */
function flagRect(W: number): { x: number; y: number; w: number; h: number; r: number } {
  return { x: W - Math.round(W * 0.06) - FLAG_W, y: Math.round(CARD_H * 0.075), w: FLAG_W, h: FLAG_H, r: 16 };
}

/** Render the country flag as a rounded-corner PNG buffer, or null if unknown. */
async function flagBuffer(iso: string): Promise<Buffer | null> {
  const svgPath = path.join(FLAG_DIR, `${iso}.svg`);
  if (!fs.existsSync(svgPath)) return null;
  const { w, h, r } = { ...flagRect(CARD_W) };
  const mask = Buffer.from(
    `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" fill="#fff"/></svg>`,
  );
  return sharp(svgPath)
    .resize(w, h, { fit: 'cover' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

export interface NewsCardResult {
  filePath: string;
  filename: string;
}

/**
 * Render the card PNG to `outDir` (default assets/news-cards). The filename is
 * derived from the news id/hash the caller passes — deterministic + idempotent.
 */
export async function renderNewsCard(
  id: string,
  input: NewsCardInput,
  opts: { outDir?: string; watermark?: string; bgDir?: string } = {},
): Promise<NewsCardResult> {
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filename = `news_${id.replace(/[^a-zA-Z0-9_-]/g, '')}.png`;
  const filePath = path.join(outDir, filename);

  const W = CARD_W;
  const H = CARD_H;
  const accent = accentFor(input.category);
  const x = Math.round(W * 0.06);
  // Per-post visual variation (seeded by id) + pick one of the category's
  // background variants so two same-category cards differ in base image too.
  const vr = cardVariation(id);
  const bgVariants = bgVariantsFor(input.category, opts.bgDir);
  const bgPath = bgVariants.length ? bgVariants[Math.floor(vr.bgRoll * bgVariants.length)] : null;

  // Headline: up to 4 lines, font scales down for long titles.
  const lines = wrapHeadline(input.title, 26, 4);
  const titleSize = lines.length >= 4 ? Math.round(W / 24) : lines.length === 3 ? Math.round(W / 21) : Math.round(W / 18);
  const lineGap = Math.round(titleSize * 1.22);
  const titleY = Math.round(H * 0.36);
  const titleSvg = lines
    .map((ln, i) => `<text x="${x}" y="${titleY + i * lineGap}" font-family="Arial, 'Segoe UI', sans-serif" font-size="${titleSize}" font-weight="800" letter-spacing="0.5" fill="#F4F6FA">${esc(ln)}</text>`)
    .join('');

  // Category chip top-left.
  const chipFs = Math.round(W / 46);
  const chipText = accent.label;
  const chipW = Math.round(chipText.length * chipFs * 0.66) + chipFs * 2;
  const chipH = Math.round(chipFs * 2.1);
  const chipY = Math.round(H * 0.12);

  // Footer: source + date, left; gold rule above.
  const footY = Math.round(H * 0.88);
  const footFs = Math.round(W / 44);

  // Shared text layer: accent edge, chip, headline, footer, watermark.
  const textLayer = `
  <!-- accent edge -->
  <rect x="0" y="0" width="${Math.round(W * 0.006)}" height="${H}" fill="${accent.color}" fill-opacity="0.9"/>

  <!-- category chip -->
  <rect x="${x}" y="${chipY - chipH + Math.round(chipFs * 0.6)}" width="${chipW}" height="${chipH}" rx="${Math.round(chipH / 2)}" fill="${accent.color}" fill-opacity="0.14" stroke="${accent.color}" stroke-opacity="0.75"/>
  <text x="${x + chipFs}" y="${chipY}" font-family="Arial, 'Segoe UI', sans-serif" font-size="${chipFs}" font-weight="700" letter-spacing="2" fill="${accent.color}">${esc(chipText)}</text>

  <!-- headline -->
  ${titleSvg}

  <!-- footer rule + source/date -->
  <rect x="${x}" y="${footY - Math.round(footFs * 1.8)}" width="${Math.round(W * 0.075)}" height="4" rx="2" fill="#E7B53C"/>
  <text x="${x}" y="${footY}" font-family="Arial, 'Segoe UI', sans-serif" font-size="${footFs}" font-weight="600" fill="#C8D0DC">${esc(input.source)}${input.publishDate ? `  ·  ${esc(fmtDate(input.publishDate))}` : ''}</text>

  ${watermarkSvg(W, H, opts.watermark ?? WATERMARK_TEXT)}`;

  // Flag badge layers (optional): soft shadow goes UNDER the flag (into the
  // text layer), the gold frame goes ON TOP of the composited flag PNG.
  const fr = flagRect(W);
  const flagPng = input.country ? await flagBuffer(input.country.iso) : null;
  const flagShadow = flagPng
    ? `<rect x="${fr.x - 4}" y="${fr.y + 6}" width="${fr.w + 8}" height="${fr.h + 8}" rx="${fr.r + 4}" fill="#000000" fill-opacity="0.45"/>`
    : '';
  const flagFrame = flagPng
    ? Buffer.from(
        `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="${fr.x - 2}" y="${fr.y - 2}" width="${fr.w + 4}" height="${fr.h + 4}" rx="${fr.r + 2}" fill="none" stroke="#E7B53C" stroke-width="3" stroke-opacity="0.95"/>` +
        `<rect x="${fr.x}" y="${fr.y}" width="${fr.w}" height="${fr.h}" rx="${fr.r}" fill="none" stroke="#000000" stroke-width="1" stroke-opacity="0.35"/>` +
        `</svg>`,
      )
    : null;
  const flagComposites = flagPng && flagFrame
    ? [
        { input: flagPng, top: fr.y, left: fr.x },
        { input: flagFrame, top: 0, left: 0 },
      ]
    : [];

  if (bgPath) {
    // AI background: photo resized to cover (seeded crop), a per-card accent
    // glow, then a legibility scrim (darker on the left where the headline
    // sits, darker at the bottom for the footer), then the text layer. The
    // seeded crop + color grade + glow corner keep same-category cards distinct.
    const glowXY = { tr: [W, 0], br: [W, H], tl: [0, 0] }[vr.glowCorner];
    const overlay = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="${glowXY[0]}" cy="${glowXY[1]}" r="${Math.round(W * 0.55)}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${accent.color}" stop-opacity="${vr.glowOpacity}"/>
      <stop offset="100%" stop-color="${accent.color}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="scrimL" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#080b11" stop-opacity="0.93"/>
      <stop offset="38%" stop-color="#080b11" stop-opacity="0.82"/>
      <stop offset="65%" stop-color="#080b11" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#080b11" stop-opacity="0.12"/>
    </linearGradient>
    <linearGradient id="scrimB" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#080b11" stop-opacity="0"/>
      <stop offset="78%" stop-color="#080b11" stop-opacity="0"/>
      <stop offset="100%" stop-color="#080b11" stop-opacity="0.75"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#scrimL)"/>
  <rect width="${W}" height="${H}" fill="url(#scrimB)"/>
  ${flagShadow}
  ${textLayer}
</svg>`;
    await sharp(bgPath)
      .resize(W, H, { fit: 'cover', position: vr.position })
      .modulate({ hue: vr.hue, saturation: vr.saturation, brightness: vr.brightness })
      .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }, ...flagComposites])
      .png()
      .toFile(filePath);
    logger.info('news-card', `Rendered card ${filename} (${input.category ?? 'Global'}, AI bg, var ${vr.position}/h${vr.hue}${input.country ? `, flag ${input.country.iso}` : ''})`);
    return { filePath, filename };
  }

  // Fallback: pure-SVG premium gradient (no AI background generated yet).
  const svg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1320"/>
      <stop offset="55%" stop-color="#0a0f19"/>
      <stop offset="100%" stop-color="#121826"/>
    </linearGradient>
    <radialGradient id="glow1" cx="0.85" cy="0.2" r="0.6">
      <stop offset="0%" stop-color="${accent.glow}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${accent.glow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.1" cy="0.95" r="0.5">
      <stop offset="0%" stop-color="#E7B53C" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#E7B53C" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow1)"/>
  <rect width="${W}" height="${H}" fill="url(#glow2)"/>

  <!-- subtle grid texture -->
  ${Array.from({ length: 7 }, (_, i) => `<line x1="${(i + 1) * (W / 8)}" y1="0" x2="${(i + 1) * (W / 8)}" y2="${H}" stroke="#FFFFFF" stroke-opacity="0.022"/>`).join('')}

  ${flagShadow}
  ${textLayer}
</svg>`;

  if (flagComposites.length) {
    await sharp(Buffer.from(svg)).composite(flagComposites).png().toFile(filePath);
  } else {
    await sharp(Buffer.from(svg)).png().toFile(filePath);
  }
  logger.info('news-card', `Rendered card ${filename} (${input.category ?? 'Global'}${input.country ? `, flag ${input.country.iso}` : ''})`);
  return { filePath, filename };
}

// ── Standalone watermark (for any existing image) ───────────────────────────

/**
 * Composite the site watermark onto an existing image's bottom-right corner,
 * in place. Best-effort: throws on unreadable files (callers decide).
 */
export async function applyWatermark(
  filePath: string,
  text: string = WATERMARK_TEXT,
): Promise<void> {
  const meta = await sharp(filePath).metadata();
  const W = meta.width ?? CARD_W;
  const H = meta.height ?? CARD_H;
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${watermarkSvg(W, H, text)}</svg>`;
  const buf = await sharp(filePath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).toBuffer();
  fs.writeFileSync(filePath, buf);
}

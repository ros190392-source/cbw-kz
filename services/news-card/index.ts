import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { logger } from '../../src/logger';

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
  opts: { outDir?: string; watermark?: string } = {},
): Promise<NewsCardResult> {
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filename = `news_${id.replace(/[^a-zA-Z0-9_-]/g, '')}.png`;
  const filePath = path.join(outDir, filename);

  const W = CARD_W;
  const H = CARD_H;
  const accent = accentFor(input.category);
  const x = Math.round(W * 0.06);

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

  ${watermarkSvg(W, H, opts.watermark ?? WATERMARK_TEXT)}
</svg>`;

  await sharp(Buffer.from(svg)).png().toFile(filePath);
  logger.info('news-card', `Rendered card ${filename} (${input.category ?? 'Global'})`);
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

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { logger } from '../../src/logger';

/**
 * Official campaign banners (EPIC 025) — instead of an abstract AI card, the
 * Bonus Alert post uses the exchange's own promo banner (the announcement
 * page's og:image), repackaged in CBW brand framing: gold border + dark
 * bottom bar with the site domain.
 *
 * Everything here fails open (returns null) — the caller falls back to the
 * regular rendered card. Announcement pages behind anti-bot walls simply
 * yield no banner.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 15_000;
const W = 1280;
const H = 720;
const GOLD = '#E7B53C';
const DARK = '#0B1220';

/** Bundled official exchange logos (white rounded tiles), keyed by slug. */
const LOGO_DIR = path.join(process.cwd(), 'assets', 'exchange-logos');

/** Extract the og:image URL from an announcement page, or null. */
export async function fetchOgImage(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const url = m?.[1] ?? null;
    return url && url.startsWith('https://') ? url : null;
  } catch {
    return null;
  }
}

/** Banners that are just a logo/placeholder are worse than our own card. */
const GENERIC_HINTS = [
  'logo', 'default', 'favicon', 'placeholder', 'og-image-default',
  '@kudos/runtime', // KuCoin's site-wide brand og:image, not a campaign banner
];

export function looksGeneric(imageUrl: string): boolean {
  const u = imageUrl.toLowerCase();
  return GENERIC_HINTS.some((h) => u.includes(h));
}

/** CBW brand frame: gold border + bottom bar with chip and domain. */
export function frameOverlaySvg(label = 'BONUS ALERT'): string {
  const chipW = label.length * 22 + 56;
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${DARK}" stop-opacity="0"/>
        <stop offset="100%" stop-color="${DARK}" stop-opacity="0.92"/>
      </linearGradient>
    </defs>
    <rect y="${H - 170}" width="${W}" height="170" fill="url(#bottom)"/>
    <rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="18" fill="none" stroke="${GOLD}" stroke-width="12"/>
    <rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="8" fill="none" stroke="${GOLD}" stroke-opacity="0.35" stroke-width="2"/>
    <rect x="48" y="${H - 118}" rx="26" width="${chipW}" height="52" fill="${GOLD}"/>
    <text x="${48 + 28}" y="${H - 82}" font-family="Arial" font-weight="800" font-size="30" fill="${DARK}" letter-spacing="3">${label}</text>
    <rect x="${W - 48 - 414}" y="${H - 118}" rx="26" width="414" height="52" fill="${DARK}" fill-opacity="0.85"/>
    <text x="${W - 48 - 24}" y="${H - 82}" text-anchor="end" font-family="Arial" font-weight="700" font-size="32" fill="${GOLD}">CryptoBonusWorld.com</text>
  </svg>`;
}

// ── Branded fallback card ─────────────────────────────────────────────────────

/**
 * Per-exchange brand color, used when the announcement page yields no usable
 * banner. Drawn into our own card so the Bonus Alert still looks like a real
 * exchange creative (big name + logo glyph in the CBW gold frame) instead of a
 * bare text post with Telegram's generic link preview.
 */
const BRAND: Record<string, string> = {
  binance: '#F0B90B',
  bybit: '#F7A600',
  kucoin: '#24AE8F',
  okx: '#1A1A1A',
  bitget: '#00CED1',
  mexc: '#00B897',
  gate: '#5C4DFF',
  htx: '#2A5ADA',
  kraken: '#7B5BFF',
  coinbase: '#0052FF',
  bingx: '#2354E6',
  coinex: '#00C087',
  phemex: '#1B5BFF',
  bitunix: '#16C784',
  lbank: '#2B6DEF',
  cryptocom: '#0A2A5E',
  upbit: '#093687',
  bithumb: '#F37321',
  gateio: '#5C4DFF',
};

/** Relative luminance of a #RRGGBB color (0 = black, 1 = white). */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Iconic Binance 5-square diamond; other exchanges get a monogram disc. */
function brandGlyphSvg(slug: string, name: string, cx: number, cy: number, r: number, color: string): string {
  // Brand color on a dark canvas: if the brand is near-black (OKX), draw the
  // glyph light instead so it stays visible.
  const fill = luminance(color) < 0.22 ? '#F4F4F5' : color;
  if (slug === 'binance') {
    const s = r * 0.62;
    const sq = (x: number, y: number) =>
      `<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" rx="${s * 0.12}" fill="${fill}" transform="rotate(45 ${x} ${y})"/>`;
    return sq(cx, cy) + sq(cx, cy - r) + sq(cx, cy + r) + sq(cx - r, cy) + sq(cx + r, cy);
  }
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const ink = luminance(fill) < 0.5 ? '#FFFFFF' : DARK;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>
    <text x="${cx}" y="${cy + r * 0.36}" text-anchor="middle" font-family="Arial" font-weight="900" font-size="${r * 1.05}" fill="${ink}">${initial}</text>`;
}

/**
 * Render a branded brand-card for an exchange (no external image needed):
 * dark canvas + brand-color glow, the exchange logo glyph, the exchange name
 * in large type, all inside the CBW gold frame with the BONUS ALERT chip and
 * domain pill. Always succeeds (returns the PNG path) unless disk I/O fails.
 */
export async function renderBrandFallback(
  id: string,
  slug: string,
  name: string,
  opts: { outDir?: string; label?: string } = {},
): Promise<string | null> {
  try {
    const color = BRAND[slug] ?? GOLD;
    const cx = W / 2;
    const glyphCy = 248;
    const glyphR = 88;
    const nameSize = name.length > 9 ? 84 : 104;
    const haloFill = luminance(color) < 0.22 ? '#FFFFFF' : color;
    // Soft halo behind the logo — layered translucent discs (no SVG filter
    // dependency), gives the logo depth on the dark canvas.
    const halo = [2.6, 1.9, 1.35]
      .map((m, i) => `<circle cx="${cx}" cy="${glyphCy}" r="${glyphR * m}" fill="${haloFill}" fill-opacity="${[0.05, 0.08, 0.12][i]}"/>`)
      .join('');

    // Prefer the exchange's real official logo (bundled tile); fall back to a
    // drawn glyph/monogram only when no logo asset exists for this slug.
    const logoFile = path.join(LOGO_DIR, `${slug}.png`);
    const hasLogo = fs.existsSync(logoFile);

    const base = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#101A2E"/>
          <stop offset="100%" stop-color="${DARK}"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="36%" r="62%">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="${DARK}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg)"/>
      <rect width="${W}" height="${H}" fill="url(#glow)"/>
      ${halo}
      ${hasLogo ? '' : brandGlyphSvg(slug, name, cx, glyphCy, glyphR, color)}
      <text x="${cx}" y="512" text-anchor="middle" font-family="Arial" font-weight="900" font-size="${nameSize}" fill="#FFFFFF" letter-spacing="2">${name}</text>
      <rect x="${cx - 120}" y="544" width="240" height="4" rx="2" fill="${GOLD}" fill-opacity="0.85"/>
    </svg>`;

    const outDir = opts.outDir ?? path.join(process.cwd(), 'data', 'cards');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${id}.png`);

    const layers: sharp.OverlayOptions[] = [];
    if (hasLogo) {
      const TILE = 272;
      const logo = await sharp(logoFile).resize(TILE, TILE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
      layers.push({ input: logo, top: Math.round(glyphCy - TILE / 2), left: Math.round(cx - TILE / 2) });
    }
    layers.push({ input: Buffer.from(frameOverlaySvg(opts.label)) });

    await sharp(Buffer.from(base)).composite(layers).png().toFile(outPath);

    logger.info('promo-banner', `Brand fallback card for ${id} (${slug})`);
    return outPath;
  } catch (err) {
    logger.warn('promo-banner', `Brand fallback failed for ${id}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Download the official banner and wrap it in the CBW frame.
 * Returns the rendered PNG path, or null on any failure.
 */
export async function renderBrandedBanner(
  id: string,
  announcementUrl: string,
  opts: { outDir?: string; label?: string } = {},
): Promise<string | null> {
  try {
    const imageUrl = await fetchOgImage(announcementUrl);
    if (!imageUrl || looksGeneric(imageUrl)) return null;

    const res = await fetch(imageUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 10_000) return null; // tiny image = icon, not a banner

    const outDir = opts.outDir ?? path.join(process.cwd(), 'data', 'cards');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${id}.png`);

    await sharp(buf)
      .resize(W, H, { fit: 'cover', position: 'centre' })
      .composite([{ input: Buffer.from(frameOverlaySvg(opts.label)) }])
      .png()
      .toFile(outPath);

    logger.info('promo-banner', `Branded official banner for ${id} (${imageUrl})`);
    return outPath;
  } catch (err) {
    logger.warn('promo-banner', `Banner failed for ${id}: ${(err as Error).message}`);
    return null;
  }
}

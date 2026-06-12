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
const GENERIC_HINTS = ['logo', 'default', 'favicon', 'placeholder', 'og-image-default'];

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
    <rect x="48" y="${H - 118}" rx="26" width="${chipW}" height="52" fill="${GOLD}"/>
    <text x="${48 + 28}" y="${H - 82}" font-family="Arial" font-weight="800" font-size="30" fill="${DARK}" letter-spacing="3">${label}</text>
    <rect x="${W - 48 - 414}" y="${H - 118}" rx="26" width="414" height="52" fill="${DARK}" fill-opacity="0.85"/>
    <text x="${W - 48 - 24}" y="${H - 82}" text-anchor="end" font-family="Arial" font-weight="700" font-size="32" fill="${GOLD}">CryptoBonusWorld.com</text>
  </svg>`;
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

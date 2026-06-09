import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { config } from '../../config';
import { logger } from '../../src/logger';
import { ASSET_DIR, assetExists } from '../content-center';
import {
  ImageStyle,
  NEGATIVE_CLAUSE,
  PREMIUM_PROMPTS,
  buildSubjectPrompt,
  promptForTopic,
} from './prompts';

export * from './prompts';

/**
 * Premium image generation pipeline (EPIC 017).
 *
 * topic → premium prompt → (provider generates) OR (fallback image) → path.
 * A provider (fal.ai / OpenAI image API) is pluggable via an adapter. If no
 * provider is configured, the pipeline uses the existing fallback image at the
 * topic's deterministic filename. It NEVER fabricates and NEVER publishes —
 * publishing stays behind the human /approve_publish gate.
 *
 * Pure-ish; provider is injectable for testing.
 */

// ── Provider interface + adapters ────────────────────────────────────────────

export interface ImageProvider {
  name: string;
  isConfigured(): boolean;
  /** Write a generated image to outPath. Return true on success. */
  generate(prompt: string, outPath: string): Promise<boolean>;
}

/** fal.ai adapter (placeholder — wire real HTTP when FAL_KEY is set). */
export class FalProvider implements ImageProvider {
  name = 'fal';
  isConfigured(): boolean {
    return !!process.env.FAL_KEY;
  }
  async generate(_prompt: string, _outPath: string): Promise<boolean> {
    // TODO: POST to fal.ai image model, download result to _outPath.
    logger.warn('image-generator', 'FalProvider.generate not implemented yet — falling back.');
    return false;
  }
}

/** OpenAI Images adapter. Calls the Images API and writes a PNG to outPath. */
export class OpenAIImageProvider implements ImageProvider {
  name = 'openai';

  private key(): string {
    return process.env.OPENAI_IMAGE_KEY || process.env.OPENAI_API_KEY || '';
  }

  isConfigured(): boolean {
    return !!this.key();
  }

  async generate(prompt: string, outPath: string): Promise<boolean> {
    const key = this.key();
    if (!key) {
      logger.warn('image-generator', 'OpenAI image key not set — falling back.');
      return false;
    }
    const baseUrl = (process.env.OPENAI_IMAGE_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
    const size = process.env.OPENAI_IMAGE_SIZE || '1536x1024'; // landscape; valid for gpt-image-1
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const body: Record<string, unknown> = { model, prompt, size, n: 1 };
      // dall-e models need response_format; gpt-image-1 always returns b64.
      if (/dall-e/i.test(model)) body.response_format = 'b64_json';

      const res = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        logger.error('image-generator', `OpenAI images API ${res.status}: ${detail.slice(0, 300)}`);
        return false;
      }
      const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
      const item = json.data?.[0];
      if (!item) {
        logger.error('image-generator', 'OpenAI images API returned no data.');
        return false;
      }

      let buf: Buffer | null = null;
      if (item.b64_json) {
        buf = Buffer.from(item.b64_json, 'base64');
      } else if (item.url) {
        const img = await fetch(item.url, { signal: controller.signal });
        if (!img.ok) { logger.error('image-generator', `Failed to download image url (${img.status}).`); return false; }
        buf = Buffer.from(await img.arrayBuffer());
      }
      if (!buf || !buf.length) {
        logger.error('image-generator', 'OpenAI images API returned an empty image.');
        return false;
      }

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf);
      logger.audit('image_generated', `OpenAI image written`, { model, size, bytes: buf.length });
      return true;
    } catch (err) {
      logger.error('image-generator', `OpenAI image generation failed: ${(err as Error).message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** No provider — always falls back. */
export const NullProvider: ImageProvider = {
  name: 'none',
  isConfigured() { return false; },
  async generate() { return false; },
};

/** Choose a provider from IMAGE_PROVIDER env (fal | openai | none). */
export function getProvider(): ImageProvider {
  switch ((process.env.IMAGE_PROVIDER ?? 'none').toLowerCase()) {
    case 'fal': return new FalProvider();
    case 'openai': return new OpenAIImageProvider();
    default: return NullProvider;
  }
}

// ── Image-prompt safety (EPIC 017 §6) ────────────────────────────────────────

const FORBIDDEN_PROMPT: { label: string; re: RegExp }[] = [
  { label: 'screenshot', re: /screenshot|screen capture|скрин/i },
  { label: 'exchange/app UI', re: /\b(exchange|app|trading)\s*(ui|interface|screen)\b|интерфейс\s*биржи/i },
  { label: 'Kaspi/banking screen', re: /\b(kaspi|halyk|bank(ing)?)\s*(app|ui|screen|interface)\b/i },
  { label: 'fake balance', re: /\b(fake|mock|inflated)?\s*(account\s+)?balance(s)?\b|баланс\s*на\s*счет/i },
  { label: 'guaranteed profit', re: /guaranteed\s+(profit|return|income)|гарантированн\w*\s+(доход|прибыл)/i },
  { label: 'casino/gambling', re: /casino|gambling|slot machine|roulette|казино/i },
  { label: 'bonus guarantee', re: /guaranteed\s+bonus|гарантированн\w*\s+бонус/i },
];

/** Validate a POSITIVE image subject. Returns violations (empty = safe). */
export function validateImagePrompt(subject: string): string[] {
  const v: string[] = [];
  for (const { label, re } of FORBIDDEN_PROMPT) {
    if (re.test(subject)) v.push(`Image prompt requests forbidden content: ${label}.`);
  }
  return v;
}

// ── Poster-style overlay (title + subtitle + bottom bar, NO logo) ────────────

/** The site shown in the footer bar (override with BRAND_WATERMARK). */
export const BRAND_WATERMARK = process.env.BRAND_WATERMARK || 'CryptoBonusWorld.com';
/** The channel handle shown in the footer bar. */
export const BRAND_CHANNEL = config.telegram.channelId || '@cbw_kz';

const esc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Greedy word-wrap into at most `maxLines` lines of ~`maxChars` chars. */
function wrapTitle(title: string, maxChars: number, maxLines: number): string[] {
  const words = (title ?? '').trim().split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    head.push(lines.slice(maxLines - 1).join(' '));
    return head;
  }
  return lines;
}

export interface PosterText {
  title: string;
  subtitle?: string;
  /** Category chip text shown top-right, e.g. "P2P · ГАЙД". */
  chip?: string;
}

/** Fixed CBW KZ feature footer (like the hero poster). */
const FEATURE_BAR: { icon: string; label: string; sub: string }[] = [
  { icon: 'shield', label: 'БЕЗОПАСНОСТЬ', sub: 'Защита средств' },
  { icon: 'people', label: 'P2P ГАЙДЫ', sub: 'Простые инструкции' },
  { icon: 'card', label: 'БИРЖИ И ОПЛАТА', sub: 'Актуальные способы' },
  { icon: 'bell', label: 'НОВОСТИ КРИПТЫ', sub: 'Важные обновления' },
];

/** Minimal gold line-icon (stroke only) centred at (cx, cy), half-size s. */
function featureIcon(kind: string, cx: number, cy: number, s: number): string {
  const st = `fill="none" stroke="#E7B53C" stroke-width="${Math.max(2, Math.round(s / 6))}" stroke-linejoin="round" stroke-linecap="round"`;
  switch (kind) {
    case 'shield':
      return `<path d="M ${cx} ${cy - s} L ${cx + s} ${cy - s * 0.45} L ${cx + s} ${cy + s * 0.2} Q ${cx + s} ${cy + s} ${cx} ${cy + s} Q ${cx - s} ${cy + s} ${cx - s} ${cy + s * 0.2} L ${cx - s} ${cy - s * 0.45} Z" ${st}/>`;
    case 'people':
      return `<circle cx="${cx - s * 0.45}" cy="${cy - s * 0.3}" r="${s * 0.32}" ${st}/><circle cx="${cx + s * 0.45}" cy="${cy - s * 0.3}" r="${s * 0.32}" ${st}/>` +
        `<path d="M ${cx - s} ${cy + s * 0.7} Q ${cx - s * 0.45} ${cy + s * 0.1} ${cx} ${cy + s * 0.5} Q ${cx + s * 0.45} ${cy + s * 0.1} ${cx + s} ${cy + s * 0.7}" ${st}/>`;
    case 'card':
      return `<rect x="${cx - s}" y="${cy - s * 0.6}" width="${s * 2}" height="${s * 1.2}" rx="${s * 0.2}" ${st}/><line x1="${cx - s}" y1="${cy - s * 0.15}" x2="${cx + s}" y2="${cy - s * 0.15}" ${st}/>`;
    case 'bell':
      return `<path d="M ${cx - s * 0.7} ${cy + s * 0.35} Q ${cx - s * 0.7} ${cy - s * 0.8} ${cx} ${cy - s * 0.8} Q ${cx + s * 0.7} ${cy - s * 0.8} ${cx + s * 0.7} ${cy + s * 0.35} Z" ${st}/><path d="M ${cx - s * 0.2} ${cy + s * 0.6} Q ${cx} ${cy + s * 0.9} ${cx + s * 0.2} ${cy + s * 0.6}" ${st}/>`;
    default:
      return '';
  }
}

/**
 * Composite the unified CBW KZ poster overlay IN-PLACE (like the hero post):
 * lighter top scrim, channel handle (top-left, text — no round logo), category
 * chip (top-right), sharp wrapped headline + gold rule + subtitle, and a fixed
 * 4-feature footer bar with gold line-icons. Deterministic vector text.
 * Best-effort: callers catch read errors.
 */
export async function applyPosterStyle(filePath: string, text: PosterText): Promise<void> {
  const meta = await sharp(filePath).metadata();
  const W = meta.width ?? 1536;
  const H = meta.height ?? 1024;
  const x = Math.round(W * 0.05);

  // ── Layout that GUARANTEES no overlap ──
  // The AI art is confined to a MIDDLE band: a clean dark header on top (title /
  // chip) and an opaque feature bar at the bottom. The art never reaches either,
  // so the subject can't cross the title or the footer.
  const barH = Math.round(H * 0.135);
  const barY = H - barH;
  const artTop = Math.round(H * 0.34);
  const artBottom = barY - Math.round(H * 0.02);
  const artH = artBottom - artTop;
  // contain (not cover) → the whole subject stays visible, never cropped;
  // letterbox blends into the dark base.
  const artBuf = await sharp(filePath).resize(W, artH, { fit: 'contain', background: { r: 9, g: 12, b: 18, alpha: 1 } }).toBuffer();
  const base = sharp({ create: { width: W, height: H, channels: 4, background: { r: 9, g: 12, b: 18, alpha: 1 } } });

  // (Channel handle / site link intentionally omitted per brand preference.)

  // Title block (sits in the clean top band).
  const lines = wrapTitle(text.title, 16, 2);
  const titleSize = lines.length > 1 ? Math.round(W / 19) : Math.round(W / 14);
  const lineGap = Math.round(titleSize * 1.06);
  const y = Math.round(H * 0.13);
  const titleSvg = lines
    .map((ln, i) => `<text x="${x}" y="${y + i * lineGap}" font-family="Arial, 'Segoe UI', sans-serif" font-size="${titleSize}" font-weight="800" letter-spacing="1" fill="#F4F6FA">${esc(ln)}</text>`)
    .join('');
  const lastY = y + (lines.length - 1) * lineGap;
  const ruleY = lastY + Math.round(titleSize * 0.28);
  const subSize = Math.round(W / 40);
  const subSvg = text.subtitle
    ? `<text x="${x + 2}" y="${ruleY + Math.round(subSize * 1.7)}" font-family="Arial, 'Segoe UI', sans-serif" font-size="${subSize}" font-weight="500" fill="#C8D0DC">${esc(text.subtitle)}</text>`
    : '';

  // Category chip (top-right).
  let chipSvg = '';
  if (text.chip) {
    const chipFs = Math.round(W / 56);
    const chipText = text.chip.toUpperCase();
    const chipW = Math.round(chipText.length * chipFs * 0.64) + Math.round(chipFs * 2);
    const chipH = Math.round(chipFs * 2.2);
    const chipX = W - Math.round(W * 0.05) - chipW;
    const chipY = Math.round(H * 0.055);
    chipSvg =
      `<rect x="${chipX}" y="${chipY}" width="${chipW}" height="${chipH}" rx="${Math.round(chipH / 2)}" fill="#0A0D13" fill-opacity="0.4" stroke="#E7B53C" stroke-width="2"/>` +
      `<text x="${chipX + chipW / 2}" y="${chipY + Math.round(chipH * 0.68)}" text-anchor="middle" font-family="Arial, 'Segoe UI', sans-serif" font-size="${chipFs}" font-weight="700" letter-spacing="2" fill="#E7B53C">${esc(chipText)}</text>`;
  }

  // Feature footer bar (barH/barY computed above).
  const colW = W / FEATURE_BAR.length;
  const labelFs = Math.round(W / 64);
  const subFs = Math.round(W / 82);
  const iconS = Math.round(W / 64);
  let barItems = '';
  FEATURE_BAR.forEach((f, i) => {
    const colX = Math.round(i * colW + W * 0.03);
    const icx = colX + iconS;
    const icy = barY + Math.round(barH * 0.5);
    const tx = colX + iconS * 2 + Math.round(W * 0.012);
    barItems +=
      featureIcon(f.icon, icx, icy, iconS) +
      `<text x="${tx}" y="${barY + Math.round(barH * 0.45)}" font-family="Arial, 'Segoe UI', sans-serif" font-size="${labelFs}" font-weight="800" letter-spacing="1" fill="#F4F6FA">${esc(f.label)}</text>` +
      `<text x="${tx}" y="${barY + Math.round(barH * 0.72)}" font-family="Arial, 'Segoe UI', sans-serif" font-size="${subFs}" font-weight="500" fill="#9AA4B4">${esc(f.sub)}</text>`;
    if (i > 0) barItems += `<line x1="${Math.round(i * colW)}" y1="${barY + Math.round(barH * 0.25)}" x2="${Math.round(i * colW)}" y2="${barY + Math.round(barH * 0.75)}" stroke="#2A3344" stroke-width="1.5"/>`;
  });

  // Soft feather over the seam where the art meets the dark header band.
  const featherTop = artTop - Math.round(H * 0.06);
  const featherH = Math.round(H * 0.12);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="seam" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#090C12" stop-opacity="0.95"/><stop offset="100%" stop-color="#090C12" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="seamDown" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0A0D13" stop-opacity="0"/><stop offset="100%" stop-color="#0A0D13" stop-opacity="0.95"/>
      </linearGradient>
      <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#F2C75C"/><stop offset="100%" stop-color="#C9952C"/></linearGradient>
      <radialGradient id="glow" cx="32%" cy="34%" r="55%">
        <stop offset="0%" stop-color="#2BD4C4" stop-opacity="0.12"/><stop offset="55%" stop-color="#E7B53C" stop-opacity="0.05"/><stop offset="100%" stop-color="#2BD4C4" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect x="0" y="0" width="${W}" height="${artTop + Math.round(H * 0.08)}" fill="url(#glow)"/>
    <rect x="0" y="${featherTop}" width="${W}" height="${featherH}" fill="url(#seam)"/>
    <rect x="0" y="${artBottom - Math.round(H * 0.08)}" width="${W}" height="${Math.round(H * 0.1)}" fill="url(#seamDown)"/>
    ${titleSvg}
    <rect x="${x + 2}" y="${ruleY}" width="${Math.round(W * 0.16)}" height="${Math.max(5, Math.round(W / 220))}" rx="3" fill="url(#gold)"/>
    ${subSvg}
    ${chipSvg}
    <rect x="0" y="${barY}" width="${W}" height="${barH}" fill="#0A0D13"/>
    <rect x="0" y="${barY}" width="${W}" height="3" fill="url(#gold)" opacity="0.9"/>
    ${barItems}
  </svg>`;

  const out = await base
    .composite([
      { input: artBuf, top: artTop, left: 0 },
      { input: Buffer.from(svg), top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
  fs.writeFileSync(filePath, out);
}

// ── Main entry point ─────────────────────────────────────────────────────────

export interface ImageGenResult {
  imagePath: string | null;     // absolute path to a usable image, or null
  filename: string | null;      // deterministic asset filename for the topic
  prompt: string;               // full prompt (subject + negative clause)
  provider: string | null;      // provider that generated it, or null
  generated: boolean;           // true if a provider produced it
  usedFallback: boolean;        // true if we used the existing fallback image
  safetyViolations: string[];   // non-empty → blocked, nothing produced
}

/**
 * Produce a premium Telegram image for a topic. Tries the configured provider;
 * on failure or no provider, uses the deterministic fallback image. Returns
 * safetyViolations (and produces nothing) if the prompt is unsafe.
 */
export async function generatePremiumTelegramImage(
  topicKey: string,
  caption: string,
  style: ImageStyle = 'premium_dark',
  opts: { provider?: ImageProvider; assetDir?: string } = {},
): Promise<ImageGenResult> {
  const assetDir = opts.assetDir ?? ASSET_DIR;
  const def = promptForTopic(topicKey);
  const filename = def?.filename ?? null;
  const subject = buildSubjectPrompt(topicKey, caption, style);
  const ctx = caption
    ? ` Visual theme to inform the scene (DO NOT render any of this wording as text in the image): "${caption.replace(/\s+/g, ' ').trim().slice(0, 200)}".`
    : '';
  const prompt = `${subject}${ctx} ${NEGATIVE_CLAUSE}`;

  const safetyViolations = validateImagePrompt(subject);
  if (safetyViolations.length) {
    logger.warn('image-generator', `Blocked unsafe image prompt for ${topicKey}: ${safetyViolations.join('; ')}`);
    return { imagePath: null, filename, prompt, provider: null, generated: false, usedFallback: false, safetyViolations };
  }
  if (!filename) {
    return { imagePath: null, filename: null, prompt, provider: null, generated: false, usedFallback: false, safetyViolations: [] };
  }

  // 1) Try the provider.
  const provider = opts.provider ?? getProvider();
  if (provider.isConfigured()) {
    const out = path.join(assetDir, filename);
    try {
      const ok = await provider.generate(prompt, out);
      if (ok && fs.existsSync(out)) {
        // Apply the poster-style text layer (title + subtitle + footer bar, no
        // logo). Best-effort: an overlay failure must not discard a real image.
        try {
          await applyPosterStyle(out, { title: def?.posterTitle ?? caption.slice(0, 24), subtitle: def?.posterSubtitle, chip: def?.chip });
        } catch (err) {
          logger.warn('image-generator', `Poster overlay skipped: ${(err as Error).message}`);
        }
        logger.audit('image_generated', `Premium image generated by ${provider.name}`, { topicKey, filename });
        return { imagePath: out, filename, prompt, provider: provider.name, generated: true, usedFallback: false, safetyViolations: [] };
      }
    } catch (err) {
      logger.error('image-generator', `Provider ${provider.name} failed: ${(err as Error).message}`);
    }
  }

  // 2) Fallback to the existing image at the deterministic filename.
  if (assetExists(filename, assetDir)) {
    return { imagePath: path.join(assetDir, filename), filename, prompt, provider: null, generated: false, usedFallback: true, safetyViolations: [] };
  }

  // 3) Nothing available.
  return { imagePath: null, filename, prompt, provider: null, generated: false, usedFallback: false, safetyViolations: [] };
}

/** All deterministic filenames (one per topic) — used by reports/tests. */
export function premiumFilenames(): string[] {
  return Object.values(PREMIUM_PROMPTS).map((p) => p.filename);
}

import fs from 'fs';
import path from 'path';
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

/** OpenAI Images adapter (placeholder — wire real HTTP when key is set). */
export class OpenAIImageProvider implements ImageProvider {
  name = 'openai';
  isConfigured(): boolean {
    return !!process.env.OPENAI_IMAGE_KEY || !!process.env.OPENAI_API_KEY;
  }
  async generate(_prompt: string, _outPath: string): Promise<boolean> {
    // TODO: call OpenAI image API, download result to _outPath.
    logger.warn('image-generator', 'OpenAIImageProvider.generate not implemented yet — falling back.');
    return false;
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
  const prompt = `${subject} ${NEGATIVE_CLAUSE}`;

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

import { FIRST_PREMIUM_PACK, PREMIUM_PROMPTS, buildSubjectPrompt, NEGATIVE_CLAUSE } from './prompts';
import { getProvider } from './index';

/**
 * Telegram formatter for the premium image prompts (EPIC 017): /image_prompts.
 * Read-only. Shows the configured provider and the per-topic generation prompts.
 */

const esc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatImagePrompts(): string {
  const provider = getProvider();
  const status = provider.isConfigured() ? `🟢 ${provider.name} (configured)` : `⚪ ${provider.name} — using fallback images`;
  const lines = [
    '🎨 <b>Premium image prompts</b>',
    `Provider: ${esc(status)}`,
    '',
  ];
  for (const key of FIRST_PREMIUM_PACK) {
    const p = PREMIUM_PROMPTS[key];
    lines.push(
      `<b>${esc(p.key)}</b> → <code>${esc(p.filename)}</code>\n` +
      `<blockquote>${esc(buildSubjectPrompt(p.key, ''))}</blockquote>`,
    );
  }
  lines.push('', `<i>Negative clause applied to every prompt:</i>\n${esc(NEGATIVE_CLAUSE)}`);
  return lines.join('\n');
}

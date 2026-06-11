import { NewsItem } from '../../src/types';
import { logger } from '../../src/logger';

interface AiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const SYSTEM_PROMPT = `You are the editor of Crypto Bonus World — a trusted, professional global crypto news Telegram channel in English.

Rewrite the provided news into a single clean Telegram post.

Strict rules:
- Write in English, for a worldwide crypto audience.
- Length: 400 to 700 characters.
- No clickbait, no hype, no "moonboy" tone, no emojis spam, no price predictions.
- Neutral, factual, professional crypto-media voice.
- Concise. Clear structure. Easy to read on mobile (short sentences/lines).
- Remove robotic AI phrasing ("In conclusion", "It's worth noting", etc.).
- Do NOT invent facts. Only use what is in the source title and summary.
- Output ONLY the post body text. No title label, no markdown headers, no links.`;

/**
 * AI rewrite layer (OpenAI-compatible Chat Completions).
 *
 * If no API key is configured, falls back to deterministic formatting so the
 * full pipeline still runs offline and in tests.
 */
export class NewsRewriter {
  constructor(private ai: AiConfig) {}

  async rewrite(item: NewsItem): Promise<string> {
    if (!this.ai.apiKey) {
      return this.fallback(item);
    }
    try {
      return await this.callModel(item);
    } catch (err) {
      logger.warn('rewriter', `AI call failed, using fallback: ${(err as Error).message}`);
      return this.fallback(item);
    }
  }

  private async callModel(item: NewsItem): Promise<string> {
    const userContent = [
      `Source: ${item.source}`,
      `Title: ${item.title}`,
      `Summary: ${item.summary || '(no summary provided)'}`,
    ].join('\n');

    const res = await fetch(`${this.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: this.ai.model,
        temperature: 0.4,
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty completion');
    return this.clamp(text);
  }

  /** Deterministic offline formatting within the 400–700 char target. */
  private fallback(item: NewsItem): string {
    const title = item.title.trim();
    let body = item.summary.trim();
    if (!body) body = title;
    const post = `${title}\n\n${body}`;
    return this.clamp(post);
  }

  /** Keep posts inside the target window; trim long ones on a sentence boundary. */
  private clamp(text: string, max = 700): string {
    const clean = text.replace(/\n{3,}/g, '\n\n').trim();
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
    return (lastStop > 300 ? cut.slice(0, lastStop + 1) : cut).trim() + ' …';
  }
}

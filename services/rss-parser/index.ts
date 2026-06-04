import crypto from 'crypto';
import Parser from 'rss-parser';
import { NewsItem, RssSource } from '../../src/types';
import { logger } from '../../src/logger';

const parser = new Parser({ timeout: 15000 });

function makeId(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * RSS ingestion layer. Polls every enabled feed, extracts a normalized
 * NewsItem per entry, and assigns a stable id for de-duplication.
 * A failing feed is logged and skipped — it never aborts the whole run.
 */
export class RssParser {
  constructor(private sources: RssSource[]) {}

  async fetchAll(): Promise<NewsItem[]> {
    const all: NewsItem[] = [];

    for (const source of this.sources.filter((s) => s.enabled)) {
      try {
        const feed = await parser.parseURL(source.url);
        for (const entry of feed.items) {
          const link = (entry.link ?? '').trim();
          const guid = String(entry.guid ?? link ?? entry.title ?? '');
          const title = (entry.title ?? '').trim();
          if (!guid || !title) continue;

          all.push({
            id: makeId(`${source.id}:${guid}`),
            title,
            link,
            source: source.name,
            sourceId: source.id,
            publishDate: entry.isoDate ?? entry.pubDate ?? new Date().toISOString(),
            summary: stripHtml(
              entry.contentSnippet ?? (entry as any).summary ?? entry.content ?? '',
            ).slice(0, 1000),
          });
        }
        logger.info('rss', `Fetched ${feed.items.length} items from ${source.name}`);
      } catch (err) {
        logger.error('rss', `Failed to fetch ${source.name}: ${(err as Error).message}`);
      }
    }

    return all;
  }
}

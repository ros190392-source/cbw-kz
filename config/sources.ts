import { RssSource } from '../src/types';

/**
 * RSS sources for the ingestion layer.
 *
 * `weight` is a trust/relevance bonus added to the moderation score for every
 * item from this source — exchange announcement feeds are high-signal, general
 * news feeds are noisier. Add new sources here; nothing else needs to change.
 */
export const SOURCES: RssSource[] = [
  {
    id: 'cointelegraph',
    name: 'Cointelegraph',
    url: 'https://cointelegraph.com/rss',
    enabled: true,
    weight: 1,
  },
  // ---------------------------------------------------------------------------
  // Exchange announcement feeds.
  //
  // NOTE: Binance and Bybit currently sit behind anti-bot protection
  // (Cloudflare 202 challenge / redirect to an HTML page) and do NOT serve
  // clean RSS to a plain server-side client. They are kept here per spec —
  // the pipeline already polls them and logs+skips on failure — and will work
  // once fronted by a feed proxy / official API key / RSS-bridge in a later
  // phase. They are disabled by default so dev runs stay clean.
  // ---------------------------------------------------------------------------
  {
    id: 'binance-announcements',
    name: 'Binance Announcements',
    url: 'https://www.binance.com/en/support/announcement/c-48?navId=48&rss=1',
    enabled: false,
    weight: 3,
  },
  {
    id: 'bybit-announcements',
    name: 'Bybit Announcements',
    url: 'https://www.bybit.com/announcement-info/rss/announcement_en-US.xml',
    enabled: false,
    weight: 3,
  },

  // ---------------------------------------------------------------------------
  // Reliable high-signal crypto-media feeds (work server-side today). These
  // give the moderation + rewrite layers real listing/regulation/security
  // content to operate on.
  // ---------------------------------------------------------------------------
  {
    id: 'theblock',
    name: 'The Block',
    url: 'https://www.theblock.co/rss.xml',
    enabled: true,
    weight: 2,
  },
  {
    id: 'decrypt',
    name: 'Decrypt',
    url: 'https://decrypt.co/feed',
    enabled: true,
    weight: 1,
  },

  // ---------------------------------------------------------------------------
  // EPIC 022 — wider net for the global news channel. More independent feeds
  // means the cross-source coverage signal actually fires: a story carried by
  // 3+ of these outlets is genuinely trending, not just one editor's pick.
  // All verified to serve clean XML server-side (2026-06-11).
  // ---------------------------------------------------------------------------
  {
    id: 'coindesk',
    name: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss',
    enabled: true,
    weight: 2,
  },
  {
    id: 'blockworks',
    name: 'Blockworks',
    url: 'https://blockworks.com/feed/',
    enabled: true,
    weight: 2,
  },
  {
    id: 'dlnews',
    name: 'DL News',
    url: 'https://www.dlnews.com/arc/outboundfeeds/rss/',
    enabled: true,
    weight: 1,
  },
  {
    id: 'cryptoslate',
    name: 'CryptoSlate',
    url: 'https://cryptoslate.com/feed/',
    enabled: true,
    weight: 1,
  },
  {
    id: 'thedefiant',
    name: 'The Defiant',
    url: 'https://thedefiant.io/api/feed',
    enabled: true,
    weight: 1,
  },
  {
    id: 'bitcoinmagazine',
    name: 'Bitcoin Magazine',
    url: 'https://bitcoinmagazine.com/feed',
    enabled: true,
    weight: 1,
  },
  {
    id: 'utoday',
    name: 'U.Today',
    url: 'https://u.today/rss',
    enabled: true,
    weight: 0,
  },
];

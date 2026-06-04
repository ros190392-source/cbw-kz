import { NewsItem, ModerationResult } from '../../src/types';

/**
 * Priority categories. Each matched category adds its weight to the score and,
 * if it is the highest-weighted match, becomes the item's category tag.
 * Order roughly mirrors editorial priority for the KZ channel.
 */
interface Category {
  name: string;
  weight: number;
  keywords: string[];
}

const CATEGORIES: Category[] = [
  {
    name: 'kazakhstan',
    weight: 6,
    keywords: ['kazakhstan', 'astana', 'aifc', 'tenge', 'казахстан', 'астана'],
  },
  {
    name: 'security',
    weight: 5,
    keywords: ['hack', 'hacked', 'exploit', 'breach', 'stolen', 'vulnerability', 'security', 'phishing', 'drained'],
  },
  {
    name: 'launchpool',
    weight: 5,
    keywords: ['launchpool', 'launchpad', 'megadrop', 'airdrop', 'token sale', 'ido', 'staking reward'],
  },
  {
    name: 'exchange',
    weight: 4,
    keywords: ['binance', 'bybit', 'okx', 'coinbase', 'kraken', 'exchange', 'spot trading', 'futures', 'trading bot'],
  },
  {
    name: 'listing',
    weight: 4,
    keywords: ['listing', 'will list', 'lists ', 'new listing', 'trading pair', 'delisting'],
  },
  {
    name: 'regulation',
    weight: 4,
    keywords: ['regulation', 'regulator', 'sec ', 'mica', 'ban', 'lawsuit', 'license', 'compliance', 'sanction'],
  },
  {
    name: 'institutional',
    weight: 4,
    keywords: ['etf', 'blackrock', 'institutional', 'fund', 'grayscale', 'custody', 'adoption', 'treasury'],
  },
];

/** Hard-reject markers — meme / shitcoin / pump spam. */
const SPAM_KEYWORDS = [
  'meme coin', 'memecoin', 'shitcoin', '100x', '1000x', 'to the moon',
  'next big', 'presale gem', 'gem alert', 'moonshot', 'pump and dump',
];

/** Clickbait markers — penalize score, do not auto-reject. */
const CLICKBAIT_KEYWORDS = [
  "you won't believe", 'shocking', "here's why", 'this is why', 'insane',
  'mind-blowing', 'skyrocket', 'explodes', 'massive surge', 'jaw-dropping',
];

function countMatches(text: string, words: string[]): { hits: number; matched: string[] } {
  const matched = words.filter((w) => text.includes(w));
  return { hits: matched.length, matched };
}

/**
 * Moderation layer: scores an item and decides accept/reject.
 *
 * Rejects: meme/shitcoin spam, clickbait-heavy low-signal items, and anything
 * below the minimum score. Prioritizes exchange / launchpool / listing /
 * regulation / security / institutional / Kazakhstan-relevant content.
 */
export function moderate(item: NewsItem, sourceWeight: number, minScore: number): ModerationResult {
  const text = `${item.title} ${item.summary}`.toLowerCase();

  if (!item.title.trim()) {
    return { accepted: false, score: 0, category: null, reason: 'empty title' };
  }

  let score = sourceWeight;
  let category: string | null = null;
  let bestWeight = 0;

  for (const cat of CATEGORIES) {
    const { hits } = countMatches(text, cat.keywords);
    if (hits > 0) {
      score += cat.weight;
      if (cat.weight > bestWeight) {
        bestWeight = cat.weight;
        category = cat.name;
      }
    }
  }

  const spam = countMatches(text, SPAM_KEYWORDS);
  const clickbait = countMatches(text, CLICKBAIT_KEYWORDS);
  score -= clickbait.hits;

  // Hard reject: spam with no redeeming priority category.
  if (spam.hits > 0 && category === null) {
    return { accepted: false, score, category: null, reason: `meme/shitcoin spam (${spam.matched.join(', ')})` };
  }

  // Reject low-signal items that matched no priority category at all.
  if (category === null) {
    return { accepted: false, score, category: null, reason: 'low-signal: no priority category' };
  }

  if (score < minScore) {
    return { accepted: false, score, category, reason: `below minimum score (${score} < ${minScore})` };
  }

  return { accepted: true, score, category, reason: null };
}

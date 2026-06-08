/**
 * Premium image prompt registry (EPIC 017).
 *
 * Each post topic maps to a UNIQUE deterministic filename and a premium,
 * brand-safe image prompt. Prompts describe a POSITIVE subject only — the
 * forbidden constraints (no fake UI/screens/balances/scam) are appended as a
 * separate NEGATIVE clause at generation time and are also enforced by the
 * safety validator. Style + brand are layered on top.
 */

export type ImageStyle = 'premium_dark' | 'poster' | 'minimal';

export interface PremiumPrompt {
  key: string;
  filename: string;
  title: string;
  /** Positive subject only (no "no ..." clauses — those are added separately). */
  subject: string;
}

const STYLE_PREFIX: Record<ImageStyle, string> = {
  premium_dark: 'Premium dark fintech key visual, cinematic studio lighting, glossy depth, high detail.',
  poster: 'Bold premium editorial poster, dramatic lighting, strong focal subject.',
  minimal: 'Minimal premium fintech key visual, lots of negative space, refined.',
};

/** Brand styling appended to every prompt. */
export const BRAND_CLAUSE =
  'CBW KZ crypto-media brand, near-black background with gold (#E7B53C) and teal (#2BD4C4) accents, ' +
  'clean geometric composition, Kazakhstan crypto context, mobile-readable, aspect 16:9, 1280x720.';

/** Constraints appended to every prompt (also enforced by the safety validator). */
export const NEGATIVE_CLAUSE =
  'Do NOT render any exchange app UI, app screenshots, banking or Kaspi screens, ' +
  'fake balances or account numbers, candlestick trading charts, casino/gambling style, ' +
  'real company logos, or any misleading guarantee.';

/** key → premium prompt (filenames are the deterministic asset names). */
export const PREMIUM_PROMPTS: Record<string, PremiumPrompt> = {
  usdt_intro: {
    key: 'usdt_intro', filename: 'cbw_kzt_usdt_p2p_1280.png', title: 'Что такое USDT',
    subject:
      'A single glowing USDT (Tether) stablecoin as the hero object, beside a luminous Kazakhstani tenge symbol ₸, ' +
      'concept of a stable digital dollar, premium 3D coins on a dark reflective surface.',
  },
  p2p_explainer: {
    key: 'p2p_explainer', filename: 'cbw_p2p_simple_1280.png', title: 'Что такое P2P',
    subject:
      'Two abstract human silhouettes exchanging a glowing coin directly, peer-to-peer concept with a subtle escrow shield between them, ' +
      'a tenge ₸ coin turning into a USDT coin, clean premium 3D.',
  },
  p2p_scam_safety: {
    key: 'p2p_scam_safety', filename: 'cbw_p2p_scam_safety_1280.png', title: 'Безопасность в P2P',
    subject:
      'A premium protective shield emblem guarding a USDT coin, calm trustworthy security mood, subtle warning accent, ' +
      'no alarmist red, refined dark fintech.',
  },
  p2p_seller_checklist: {
    key: 'p2p_seller_checklist', filename: 'cbw_payment_methods_1280.png', title: 'Как выбрать продавца в P2P',
    subject:
      'A premium checklist emblem with rating stars and a verified trust badge, beside ₸ and USDT coins, ' +
      'concept of choosing a reliable counterparty, clean 3D.',
  },
  exchange_overview_kz: {
    key: 'exchange_overview_kz', filename: 'cbw_exchange_reviews_1280.png', title: 'Биржи с P2P в Казахстане',
    subject:
      'An abstract premium constellation of generic crypto-platform nodes (no real logos, no UI) over a subtle Kazakhstan map silhouette, ' +
      'with ₸ and USDT coins, editorial overview mood.',
  },
};

/** content-machine topic key → premium prompt key. */
export const TOPIC_TO_PROMPT: Record<string, string> = {
  usdt_basics: 'usdt_intro',
  p2p_basics: 'p2p_explainer',
  p2p_scams: 'p2p_scam_safety',
  choose_seller: 'p2p_seller_checklist',
  best_exchanges_kz: 'exchange_overview_kz',
};

/** The first premium pack, in order. */
export const FIRST_PREMIUM_PACK = [
  'usdt_intro', 'p2p_explainer', 'p2p_scam_safety', 'p2p_seller_checklist', 'exchange_overview_kz',
];

export function promptForTopic(topicKey: string): PremiumPrompt | undefined {
  return PREMIUM_PROMPTS[TOPIC_TO_PROMPT[topicKey] ?? topicKey];
}

/** Build the positive subject prompt (style + subject + brand). NEGATIVE added at gen time. */
export function buildSubjectPrompt(topicKey: string, caption: string, style: ImageStyle = 'premium_dark'): string {
  const def = promptForTopic(topicKey);
  const subject = def ? def.subject : `Premium key visual representing: ${(caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}.`;
  return `${STYLE_PREFIX[style]} ${subject} ${BRAND_CLAUSE}`;
}

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
  /** Short headline rendered on the poster (code-controlled text overlay). */
  posterTitle: string;
  /** Sub-line under the poster headline. */
  posterSubtitle: string;
  /** Category chip text (top-right), e.g. "P2P · ГАЙД". */
  chip: string;
  /** Positive subject only (no "no ..." clauses — those are added separately). */
  subject: string;
}

const STYLE_PREFIX: Record<ImageStyle, string> = {
  premium_dark: 'Premium fintech poster key visual, bright cinematic studio lighting, glossy depth, vivid rich colour, high detail, NOT a flat near-black scene.',
  poster: 'Bold premium editorial poster, dramatic bright lighting, strong focal subject.',
  minimal: 'Minimal premium fintech key visual, lots of negative space, refined.',
};

/** Brand styling appended to every prompt. */
export const BRAND_CLAUSE =
  'CBW KZ crypto-media brand. Deep dark-navy / charcoal background with a soft teal-and-gold ambient GLOW and gentle gradients (lighter than pure black, never a flat black void), ' +
  'rich premium colour, polished gold and emerald-green 3D coins, subtle supporting elements for depth. ' +
  'Clean premium composition, Kazakhstan crypto context, mobile-readable, landscape 3:2 layout. ' +
  'No text or lettering anywhere in the image. Compose like a premium poster: the main subject is MODERATELY sized, CENTRED, and FULLY visible ' +
  'with clear empty margins on every side (never cropped, never touching any edge). Surround it with open premium dark space and a soft ambient teal/gold glow (airy, not dry, not a flat black void). ' +
  'Cinematic lighting, rich depth, premium and uncluttered.';

/** Constraints appended to every prompt (also enforced by the safety validator). */
export const NEGATIVE_CLAUSE =
  'Do NOT render any exchange app UI, app screenshots, banking or Kaspi screens, ' +
  'fake balances or account numbers, candlestick trading charts, casino/gambling style, ' +
  'real company logos, or any misleading guarantee.';

/** key → premium prompt (filenames are the deterministic asset names). */
export const PREMIUM_PROMPTS: Record<string, PremiumPrompt> = {
  usdt_intro: {
    key: 'usdt_intro', filename: 'cbw_usdt_intro_1280.png', title: 'Что такое USDT',
    posterTitle: 'Что такое USDT', posterSubtitle: 'Цифровой доллар — простыми словами', chip: 'USDT · ГАЙД',
    subject:
      'One large hero USDT (Tether) coin in the centre — a thick polished minted medallion with a bevelled rim, deep-relief Tether ₮ emblem, soft rim light, luxurious teal-and-silver metallic finish, studio product render. ' +
      'Around it a calm premium atmosphere hinting at a stable digital dollar: faint floating "$" / "USD" light motifs and a subtle golden Kazakhstani tenge ₸ accent coin in the soft background (smaller, secondary). ' +
      'Concept: a stable, dollar-pegged digital currency. Absolutely no P2P "guide" layout, no two-figures exchange scene.',
  },
  p2p_explainer: {
    key: 'p2p_explainer', filename: 'cbw_p2p_simple_1280.png', title: 'Что такое P2P',
    posterTitle: 'Что такое P2P', posterSubtitle: 'Обмен напрямую между людьми', chip: 'P2P · ГАЙД',
    subject:
      'Two sleek 3D human figures (head, shoulders, arms and hands clearly visible) facing each other at the centre of the frame, gently exchanging two beautifully designed premium coins between their hands. ' +
      'The figures have crisp, well-defined contours with bright gold and teal rim lighting along their edges that cleanly separates them from the dark background — sharp readable silhouettes, smooth premium matte surface, not blurry, not blending into the background. ' +
      'Both coins are large, hero-quality: thick minted medallions with a polished bevelled rim, fine reflections, soft rim light and a luxurious metallic finish, crisp deep-relief embossing, studio product-render quality. ' +
      'LEFT coin: rich gold, embossed with the Kazakhstani tenge currency symbol — a capital "T" with TWO short parallel horizontal strokes across the upper stem (₸) — elegant, perfectly centred, clean and legible. ' +
      'RIGHT coin: vivid teal/emerald, embossed with the Tether USDT symbol — a "T" with a SINGLE horizontal stroke (₮) — clearly different from the tenge coin. ' +
      'A soft protective escrow shield glows faintly behind the two coins. Peer-to-peer money-exchange concept.',
  },
  p2p_scam_safety: {
    key: 'p2p_scam_safety', filename: 'cbw_p2p_scam_safety_1280.png', title: 'Безопасность в P2P',
    posterTitle: 'Как не попасть на скам', posterSubtitle: 'Безопасность в P2P', chip: 'P2P · БЕЗОПАСНОСТЬ',
    subject:
      'A premium protective shield emblem guarding a USDT coin, calm trustworthy security mood, subtle warning accent, ' +
      'no alarmist red, refined dark fintech.',
  },
  p2p_seller_checklist: {
    key: 'p2p_seller_checklist', filename: 'cbw_payment_methods_1280.png', title: 'Как выбрать продавца в P2P',
    posterTitle: 'Как выбрать продавца', posterSubtitle: 'Чеклист для P2P', chip: 'P2P · ЧЕКЛИСТ',
    subject:
      'A premium checklist emblem with rating stars and a verified trust badge, beside ₸ and USDT coins, ' +
      'concept of choosing a reliable counterparty, clean 3D.',
  },
  exchange_overview_kz: {
    key: 'exchange_overview_kz', filename: 'cbw_exchange_reviews_1280.png', title: 'Биржи с P2P в Казахстане',
    posterTitle: 'Биржи с P2P', posterSubtitle: 'Популярные в Казахстане', chip: 'БИРЖИ · KZ',
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

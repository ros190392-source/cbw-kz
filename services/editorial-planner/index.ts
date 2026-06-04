import {
  BonusRecord,
  ContentMixItem,
  EditorialPlan,
  EditorialTopic,
  ExchangeRecord,
  LocaleCode,
  PlanBucket,
  PostAnalyticsRecord,
  PriorityBand,
  TopicType,
  VerificationClaim,
} from '../../src/types';
import { aggregateByCategory } from '../analytics-layer';
import { effectiveVerification, isBonusActive } from '../exchange-registry';
import { computeConfidence, staleClaims } from '../verification-engine';
import { localePerformance, preferredLocales } from '../locale-engine';

/**
 * Editorial planner — the "editorial brain" (EPIC 005).
 *
 * Reads the analytics, registry, bonus, verification and locale layers and
 * produces structured editorial RECOMMENDATIONS: what to post today, which
 * exchange/bonus to feature, which stale GEO data to refresh, which categories
 * and locales are undercovered. It PLANS — it never publishes, never approves,
 * and never invents verified bonuses or hype. Every topic carries the
 * verification status that would be required before publishing.
 *
 * All logic is pure + deterministic and exported for testing.
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const CTA = '{{CTA}}';

/** Scoring categories we expect to cover; used for gap detection. */
const KNOWN_CATEGORIES = ['KZ', 'Bonus', 'Listing', 'Regulation', 'Security', 'P2P'];
/** KZ local payment rails worth explainer content. */
const KZ_PAYMENTS = ['Kaspi', 'Halyk', 'Freedom'];

export const DAILY_MIX: Record<PlanBucket, number> = {
  news: 2, bonus: 1, education: 1, verification: 1, evergreen: 1,
};
export const WEEKLY_MIX: Record<PlanBucket, number> = {
  news: 7, bonus: 3, education: 3, verification: 3, evergreen: 2,
};

export function band(priority: number): PriorityBand {
  if (priority >= 70) return 'high';
  if (priority >= 45) return 'medium';
  return 'low';
}

/** Which content-mix bucket a topic type belongs to. */
export function bucketOf(type: TopicType): PlanBucket {
  switch (type) {
    case 'bonus':
    case 'launchpool':
      return 'bonus';
    case 'p2p':
    case 'kyc':
      return 'verification';
    case 'education':
      return 'education';
    case 'evergreen':
      return 'evergreen';
    default: // news, regulation, warning, comparison
      return 'news';
  }
}

function topic(t: Omit<EditorialTopic, 'priorityBand' | 'priority'> & { priority: number }): EditorialTopic {
  const priority = clamp(Math.round(t.priority), 0, 100);
  return { ...t, priority, priorityBand: band(priority) };
}

export interface PlannerInputs {
  posts: PostAnalyticsRecord[];
  exchanges: ExchangeRecord[];
  bonuses: BonusRecord[];
  claims: VerificationClaim[];
  geo?: string;
  now?: Date;
}

// ── Candidate builders (Phase 2-3) ───────────────────────────────────────────

const exName = (exchanges: ExchangeRecord[], slug: string) =>
  exchanges.find((e) => e.slug === slug)?.name ?? slug;
const exTrust = (exchanges: ExchangeRecord[], slug: string) =>
  exchanges.find((e) => e.slug === slug)?.trustLevel ?? 'low';

/** Bonus / launchpool topics. Verified+active rank high; unverified downranked. */
export function bonusTopics(
  bonuses: BonusRecord[],
  exchanges: ExchangeRecord[],
  geo: string,
  now: Date,
): EditorialTopic[] {
  const locale = preferredLocales(geo)[0];
  return bonuses.map((b) => {
    const status = effectiveVerification(b, now);
    const active = isBonusActive(b, now);
    const type: TopicType = b.type === 'launchpool' || b.type === 'launchpad' ? 'launchpool' : 'bonus';
    let priority: number;
    let confidence: number;
    let reason: string;
    if (status === 'verified' && active) {
      priority = 88; confidence = 90; reason = 'Verified & active — strong monetization topic.';
    } else if (status === 'verified') {
      priority = 42; confidence = 70; reason = 'Verified but not currently active.';
    } else if (status === 'outdated') {
      priority = 30; confidence = 45; reason = 'Verification outdated — recheck before featuring.';
    } else {
      priority = 22; confidence = 20; reason = 'Unverified bonus — must be verified before publishing.';
    }
    return topic({
      id: `bonus:${b.id}`,
      title: `${exName(exchanges, b.exchangeSlug)}: ${b.title}`,
      type, exchange: b.exchangeSlug, geo, locale,
      priority, confidence, reason, suggestedCta: CTA, requiredVerification: 'verified',
    });
  });
}

/** Stale-but-important GEO claims → "verify/update" tasks (verification bucket). */
export function verificationUpdateTopics(
  claims: VerificationClaim[],
  exchanges: ExchangeRecord[],
  geo: string,
  now: Date,
): EditorialTopic[] {
  const locale = preferredLocales(geo)[0];
  const typeMap: Record<string, TopicType> = {
    kyc: 'kyc', p2p: 'p2p', fiat: 'p2p', availability: 'regulation', geo_restriction: 'regulation',
  };
  return staleClaims(claims, now)
    .filter((c) => c.country.toUpperCase() === geo.toUpperCase())
    .map((c) => {
      const trust = exTrust(exchanges, c.exchangeSlug);
      const boost = trust === 'high' ? 12 : trust === 'medium' ? 5 : 0;
      const type = typeMap[c.type] ?? 'regulation';
      // Only kyc/p2p land in the verification bucket; route fiat there too.
      const finalType: TopicType = c.type === 'fiat' ? 'p2p' : type;
      return topic({
        id: `verify:${c.id}`,
        title: `Update ${exName(exchanges, c.exchangeSlug)} ${c.type.toUpperCase()} (${geo}) — verify`,
        type: finalType, exchange: c.exchangeSlug, geo, locale,
        priority: 55 + boost,
        confidence: computeConfidence(c, now),
        reason: 'Stale GEO data — recheck & update before this can be published.',
        suggestedCta: CTA, requiredVerification: 'verified',
      });
    });
}

/** Lean into top-performing categories; flag underused ones (gaps). */
export function categoryTopics(posts: PostAnalyticsRecord[], geo: string): EditorialTopic[] {
  const locale = preferredLocales(geo)[0];
  const agg = aggregateByCategory(posts);
  const out: EditorialTopic[] = [];

  const top = agg.find((g) => g.posts > 0 && g.avgEngagement > 0);
  if (top) {
    out.push(topic({
      id: `cat-top:${top.key}`,
      title: `More "${top.key}" coverage (top-performing category)`,
      type: 'news', exchange: null, geo, locale,
      priority: 74, confidence: 75,
      reason: `"${top.key}" has the best engagement (${top.avgEngagement}) — double down.`,
      suggestedCta: CTA, requiredVerification: 'unverified',
    }));
  }

  const present = new Set(agg.map((g) => g.key));
  for (const cat of KNOWN_CATEGORIES.filter((c) => !present.has(c)).slice(0, 2)) {
    out.push(topic({
      id: `cat-gap:${cat}`,
      title: `Start covering "${cat}" (underused category)`,
      type: 'education', exchange: null, geo, locale,
      priority: 56, confidence: 60,
      reason: `"${cat}" has no published coverage yet — content gap.`,
      suggestedCta: CTA, requiredVerification: 'unverified',
    }));
  }
  return out;
}

/** Locales with no published content → multilingual gap topics. */
export function localeGapTopics(posts: PostAnalyticsRecord[], geo: string): EditorialTopic[] {
  const covered = new Set(localePerformance(posts).filter((p) => p.posts > 0).map((p) => p.locale));
  const primary = preferredLocales(geo); // e.g. KZ → [ru-KZ, kk-KZ]
  const expansion: LocaleCode[] = ['de-DE', 'tr-TR', 'hi-IN'];
  const out: EditorialTopic[] = [];

  for (const loc of primary) {
    if (covered.has(loc)) continue;
    out.push(topic({
      id: `locale-gap:${loc}`,
      title: `Create content for ${loc} (no coverage yet)`,
      type: 'education', exchange: null, geo, locale: loc,
      priority: 52, confidence: 65,
      reason: `Primary locale ${loc} has no published posts — multilingual gap.`,
      suggestedCta: CTA, requiredVerification: 'unverified',
    }));
  }
  for (const loc of expansion) {
    if (covered.has(loc)) continue;
    out.push(topic({
      id: `locale-gap:${loc}`,
      title: `Plan expansion content for ${loc}`,
      type: 'education', exchange: null, geo: loc.split('-')[1] ?? geo, locale: loc,
      priority: 34, confidence: 50,
      reason: `Expansion locale ${loc} not yet covered — future market.`,
      suggestedCta: CTA, requiredVerification: 'unverified',
    }));
  }
  return out;
}

/** Undercovered local payment rails → explainer opportunities. */
export function paymentTopics(exchanges: ExchangeRecord[], geo: string): EditorialTopic[] {
  if (geo.toUpperCase() !== 'KZ') return [];
  const locale = preferredLocales(geo)[0];
  const anchor = exchanges.find((e) => e.kazakhstan.available && e.trustLevel === 'high');
  return KZ_PAYMENTS.map((m) =>
    topic({
      id: `pay:${m}`,
      title: `How to deposit with ${m} in Kazakhstan`,
      type: 'p2p', exchange: anchor?.slug ?? null, geo, locale,
      priority: 50, confidence: 55,
      reason: `Local rail "${m}" is an undercovered, high-intent explainer topic.`,
      suggestedCta: CTA, requiredVerification: 'verified',
    }),
  );
}

/** Stable evergreen topics that always have a place in the calendar. */
export function evergreenTopics(geo: string): EditorialTopic[] {
  const locale = preferredLocales(geo)[0];
  const defs: { id: string; title: string }[] = [
    { id: 'p2p-kzt', title: 'How to use P2P with KZT safely' },
    { id: 'kyc', title: 'KYC explained for Kazakhstan users' },
    { id: 'trust', title: 'How to choose a trusted crypto exchange in KZ' },
  ];
  return defs.map((d, i) =>
    topic({
      id: `evergreen:${d.id}`,
      title: d.title, type: 'evergreen', exchange: null, geo, locale,
      priority: 46 - i, confidence: 60,
      reason: 'Evergreen explainer — durable value, low time-pressure.',
      suggestedCta: CTA, requiredVerification: 'unverified',
    }),
  );
}

// ── Aggregation + prioritization ─────────────────────────────────────────────

export function buildCandidates(inputs: PlannerInputs): EditorialTopic[] {
  const geo = inputs.geo ?? 'KZ';
  const now = inputs.now ?? new Date();
  const all = [
    ...bonusTopics(inputs.bonuses, inputs.exchanges, geo, now),
    ...verificationUpdateTopics(inputs.claims, inputs.exchanges, geo, now),
    ...categoryTopics(inputs.posts, geo),
    ...localeGapTopics(inputs.posts, geo),
    ...paymentTopics(inputs.exchanges, geo),
    ...evergreenTopics(geo),
  ];
  return prioritize(all);
}

/** Sort by priority (desc), de-duplicate by id then by normalized title. */
export function prioritize(topics: EditorialTopic[]): EditorialTopic[] {
  const byId = new Map<string, EditorialTopic>();
  for (const t of topics) {
    const prev = byId.get(t.id);
    if (!prev || t.priority > prev.priority) byId.set(t.id, t);
  }
  const seenTitle = new Set<string>();
  return [...byId.values()]
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))
    .filter((t) => {
      const key = t.title.toLowerCase().trim();
      if (seenTitle.has(key)) return false;
      seenTitle.add(key);
      return true;
    });
}

// ── Calendar + content mix (Phase 4) ─────────────────────────────────────────

const BUCKET_ORDER: PlanBucket[] = ['news', 'bonus', 'education', 'verification', 'evergreen'];

export function buildPlan(inputs: PlannerInputs, period: 'daily' | 'weekly'): EditorialPlan {
  const geo = inputs.geo ?? 'KZ';
  const now = inputs.now ?? new Date();
  const mix = period === 'weekly' ? WEEKLY_MIX : DAILY_MIX;
  const candidates = buildCandidates(inputs);

  const used = new Set<string>();
  const selected: EditorialTopic[] = [];
  const contentMix: ContentMixItem[] = [];
  const notes: string[] = [];

  for (const bucket of BUCKET_ORDER) {
    const planned = mix[bucket] ?? 0;
    const picks = candidates
      .filter((t) => bucketOf(t.type) === bucket && !used.has(t.id))
      .slice(0, planned);
    picks.forEach((t) => used.add(t.id));
    selected.push(...picks);
    contentMix.push({ bucket, planned, selected: picks.length });
    if (picks.length < planned) {
      notes.push(`⚠️ ${bucket}: only ${picks.length}/${planned} candidates — source more or rebalance.`);
    }
  }

  selected.sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));

  // Global editorial guidance.
  const staleN = staleClaims(inputs.claims, now).length;
  if (staleN) notes.push(`🕒 ${staleN} verification claims are stale — refresh via /stale + /verify.`);
  const unverifiedBonuses = inputs.bonuses.filter((b) => effectiveVerification(b, now) !== 'verified').length;
  if (unverifiedBonuses) {
    notes.push(`⚠️ ${unverifiedBonuses} bonus(es) are unverified — do NOT publish until verified.`);
  }
  notes.push('ℹ️ Recommendations only — a human must approve and publish. Nothing here is auto-posted.');

  return { period, generatedAt: now.toISOString(), geoFocus: geo, topics: selected, contentMix, notes };
}

/** The full ranked candidate list (topic backlog). */
export function backlog(inputs: PlannerInputs): EditorialTopic[] {
  return buildCandidates(inputs);
}

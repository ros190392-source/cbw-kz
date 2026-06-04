import {
  ExchangeRecord,
  LocaleCode,
  LocaleDefinition,
  LocalePerformance,
  LocalizedContent,
  LocalizedField,
  PostAnalyticsRecord,
  TranslationStatus,
} from '../../src/types';
import { isAvailable } from '../geo-engine';
import { engagementScore } from '../analytics-layer';
import { DEFAULT_LOCALE, GEO_LOCALES, LOCALES } from './data';

export { LOCALES, GEO_LOCALES, DEFAULT_LOCALE } from './data';

/**
 * Locale engine (EPIC 004).
 *
 * Locale definitions, GEO↔language routing, localized content scaffolding, a
 * translation MODERATION flow, and multi-GEO analytics. Foundation only — it
 * never auto-translates, never auto-publishes, and never fabricates
 * localization. Low-confidence machine translation is forced into
 * human_review_required. Pure helpers are exported for testing.
 */

const norm = (c: string) => (c ?? '').trim().toUpperCase();
const round1 = (n: number) => Math.round(n * 10) / 10;

// ── Locale lookup + routing (Phase 1-2) ──────────────────────────────────────

export function getLocale(code: LocaleCode): LocaleDefinition | undefined {
  return LOCALES[code];
}

export function allLocales(): LocaleDefinition[] {
  return Object.values(LOCALES);
}

/** Ordered preferred locales for a country (always non-empty; en-US default). */
export function preferredLocales(country: string): LocaleCode[] {
  return GEO_LOCALES[norm(country)] ?? [DEFAULT_LOCALE];
}

/** The fallback locale for a locale (null when none configured). */
export function fallbackLocale(code: LocaleCode): LocaleCode | null {
  return LOCALES[code]?.fallback ?? null;
}

/**
 * Resolve a locale to a chain of fallbacks, e.g. kk-KZ → [kk-KZ, ru-KZ, en-US].
 * Guards against cycles.
 */
export function resolveLocaleChain(code: LocaleCode): LocaleCode[] {
  const chain: LocaleCode[] = [];
  let cur: LocaleCode | null = code;
  const seen = new Set<LocaleCode>();
  while (cur && LOCALES[cur] && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    cur = LOCALES[cur].fallback;
  }
  return chain;
}

/**
 * Does an exchange "support" a locale? Interpreted as: the exchange operates in
 * the locale's country (per the GEO engine). Conservative — unknown ⇒ false.
 */
export function supportsLocale(exchange: ExchangeRecord, code: LocaleCode): boolean {
  const loc = LOCALES[code];
  if (!loc) return false;
  return isAvailable(exchange, loc.country);
}

// ── Localized content scaffolding (Phase 3) ──────────────────────────────────

export function emptyField(locale: LocaleCode, now = new Date().toISOString()): LocalizedField {
  return { locale, text: '', status: 'untranslated', confidence: null, reviewer: null, updatedAt: now };
}

/** A fresh, fully-untranslated content bundle for one source post + locale. */
export function newLocalizedContent(
  sourceId: string,
  locale: LocaleCode,
  now = new Date().toISOString(),
): LocalizedContent {
  return {
    sourceId,
    locale,
    title: emptyField(locale, now),
    summary: emptyField(locale, now),
    cta: { ...emptyField(locale, now), text: '{{CTA}}' }, // placeholder, never auto-injected
    exchangeNotes: emptyField(locale, now),
    status: 'untranslated',
    createdAt: now,
    updatedAt: now,
  };
}

// ── Translation moderation flow (Phase 4) ────────────────────────────────────

/** Below this MT confidence, output is forced to human_review_required. */
export const MT_REVIEW_THRESHOLD = 70;

const STATUS_RANK: Record<TranslationStatus, number> = {
  rejected: -1,
  untranslated: 0,
  machine_translated: 1,
  human_review_required: 2,
  approved: 3,
};

/**
 * Aggregate a bundle's status: rejected if ANY field rejected, otherwise the
 * LEAST-progressed field. A bundle is only `approved` when every field is
 * approved — partial localization never counts as done.
 */
export function aggregateStatus(content: LocalizedContent): TranslationStatus {
  const fields = [content.title, content.summary, content.cta, content.exchangeNotes];
  if (fields.some((f) => f.status === 'rejected')) return 'rejected';
  let worst: TranslationStatus = 'approved';
  for (const f of fields) {
    if (STATUS_RANK[f.status] < STATUS_RANK[worst]) worst = f.status;
  }
  return worst;
}

function touch(content: LocalizedContent, now: string): LocalizedContent {
  content.status = aggregateStatus(content);
  content.updatedAt = now;
  return content;
}

/**
 * Apply machine translation to one field. Low confidence (or none) routes it to
 * human_review_required instead of machine_translated — never silently trusted.
 */
export function applyMachineTranslation(
  content: LocalizedContent,
  field: 'title' | 'summary' | 'exchangeNotes',
  text: string,
  confidence: number | null,
  now = new Date().toISOString(),
): LocalizedContent {
  const status: TranslationStatus =
    confidence != null && confidence >= MT_REVIEW_THRESHOLD ? 'machine_translated' : 'human_review_required';
  content[field] = { locale: content.locale, text, status, confidence, reviewer: null, updatedAt: now };
  return touch(content, now);
}

export function approveField(
  content: LocalizedContent,
  field: 'title' | 'summary' | 'cta' | 'exchangeNotes',
  reviewer: string,
  now = new Date().toISOString(),
): LocalizedContent {
  content[field] = { ...content[field], status: 'approved', reviewer, updatedAt: now };
  return touch(content, now);
}

export function rejectField(
  content: LocalizedContent,
  field: 'title' | 'summary' | 'cta' | 'exchangeNotes',
  reviewer: string,
  now = new Date().toISOString(),
): LocalizedContent {
  content[field] = { ...content[field], status: 'rejected', reviewer, updatedAt: now };
  return touch(content, now);
}

/** Translation-complete (all fields approved). Publishing is still human-gated. */
export function isTranslationApproved(content: LocalizedContent): boolean {
  return aggregateStatus(content) === 'approved';
}

// ── Multi-GEO analytics (Phase 5) ────────────────────────────────────────────

/** Map a GEO tag on a post to a country code. */
function geoTagToCountry(tag: string): string {
  const t = norm(tag);
  return t === 'GLOBAL' ? 'US' : t;
}

/** The primary locale a post belongs to (from its first GEO tag). */
export function localeForPost(rec: PostAnalyticsRecord): LocaleCode {
  const tag = rec.geoTags[0] ?? 'Global';
  return preferredLocales(geoTagToCountry(tag))[0] ?? DEFAULT_LOCALE;
}

/** Engagement performance grouped by locale (best engagement first). */
export function localePerformance(records: PostAnalyticsRecord[]): LocalePerformance[] {
  const buckets = new Map<LocaleCode, PostAnalyticsRecord[]>();
  for (const r of records) {
    const code = localeForPost(r);
    (buckets.get(code) ?? buckets.set(code, []).get(code)!).push(r);
  }
  const out: LocalePerformance[] = [];
  for (const [code, recs] of buckets) {
    const posts = recs.length;
    const totalEngagement = recs.reduce((a, r) => a + engagementScore(r.metrics), 0);
    const totalScore = recs.reduce((a, r) => a + (r.scoreTotal ?? 0), 0);
    out.push({
      locale: code,
      country: LOCALES[code]?.country ?? 'US',
      posts,
      avgScore: posts ? round1(totalScore / posts) : 0,
      totalEngagement,
      avgEngagement: posts ? round1(totalEngagement / posts) : 0,
      topExchange: bestExchange(recs),
    });
  }
  return out.sort((a, b) => b.avgEngagement - a.avgEngagement || b.posts - a.posts);
}

function bestExchange(records: PostAnalyticsRecord[]): string | null {
  const tally = new Map<string, number>();
  for (const r of records) {
    for (const ex of r.exchangeMentions) {
      tally.set(ex, (tally.get(ex) ?? 0) + engagementScore(r.metrics));
    }
  }
  let best: string | null = null;
  let bestVal = -1;
  for (const [ex, val] of tally) {
    if (val > bestVal) { best = ex; bestVal = val; }
  }
  return best;
}

/** The single best-performing locale, or null when there's no data. */
export function bestLocale(records: PostAnalyticsRecord[]): LocalePerformance | null {
  return localePerformance(records)[0] ?? null;
}

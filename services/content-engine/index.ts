import {
  BonusRecord,
  ContentTone,
  DraftContent,
  DraftType,
  DraftVariant,
  EditorialTopic,
  ExchangeRecord,
  LocaleCode,
  LocalizedDraft,
  ResearchFinding,
  SeoBlock,
  VerificationCitation,
  VerificationClaim,
} from '../../src/types';
import { claimFreshness, computeConfidence, isReliable, needsRecheck } from '../verification-engine';
import { effectiveVerification, isBonusActive } from '../exchange-registry';
import { getLocale } from '../locale-engine';

/**
 * Content generation engine (EPIC 009).
 *
 * Produces structured, verification-AWARE drafts (telegram_post, article_outline,
 * seo_snippet, warning_post, educational_post) from planner topics, research
 * findings, the exchange registry, verification claims and locale data.
 *
 * Deterministic + template-based (no hype, no fabricated certainty). Every draft
 * is machineGenerated + humanReviewRequired, cites the verification behind its
 * claims, flags low-confidence/stale/unverified data, discloses GEO restrictions,
 * and keeps the CTA a placeholder. It NEVER publishes, posts, or auto-approves.
 */

const CTA = '{{CTA}}';
const CONFIDENCE_NOTE =
  'Machine-generated draft — all claims require human verification; no certainty is implied beyond the cited evidence.';

const trunc = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

export interface ContentRequest {
  type: DraftType;
  topic?: EditorialTopic;
  finding?: ResearchFinding;
  exchange?: ExchangeRecord;
  bonus?: BonusRecord;
  claims?: VerificationClaim[];
  locale?: LocaleCode;
  geo?: string;
  now?: Date;
}

// ── Subject resolution ───────────────────────────────────────────────────────

function subjectTitle(req: ContentRequest): string {
  if (req.topic) return req.topic.title;
  if (req.finding) return req.finding.title;
  if (req.exchange) return `${req.exchange.name} in ${req.geo ?? 'Kazakhstan'}`;
  return 'Crypto update for Kazakhstan';
}

function toneFor(type: DraftType, req: ContentRequest): ContentTone {
  if (type === 'warning_post') return 'cautionary';
  if (type === 'educational_post') return 'educational';
  if (type === 'telegram_post' && req.bonus) return 'promotional_safe';
  return 'neutral';
}

// ── Verification-aware layer (Phase 3) ───────────────────────────────────────

function relevantClaims(req: ContentRequest): VerificationClaim[] {
  const claims = req.claims ?? [];
  const slug = req.exchange?.slug ?? req.topic?.exchange ?? req.finding?.exchanges?.[0] ?? null;
  const geo = (req.geo ?? req.topic?.geo ?? req.finding?.geos?.[0] ?? 'KZ').toUpperCase();
  if (!slug) return [];
  return claims.filter((c) => c.exchangeSlug === slug && c.country.toUpperCase() === geo);
}

export function buildCitations(req: ContentRequest): VerificationCitation[] {
  const now = req.now ?? new Date();
  return relevantClaims(req).map((c) => {
    const confidence = computeConfidence(c, now);
    const freshness = claimFreshness(c, now);
    return {
      target: c.id,
      confidence,
      freshness,
      reliable: isReliable(confidence, freshness),
      note: `${c.type} = ${c.assertion}`,
    };
  });
}

/**
 * Build the warning list: low-confidence claims, stale verification, unverified
 * bonuses, and GEO restrictions. The whole point of "verification-aware" — no
 * fake certainty leaks into a draft.
 */
export function buildWarnings(req: ContentRequest): string[] {
  const now = req.now ?? new Date();
  const warnings: string[] = [];

  for (const c of relevantClaims(req)) {
    const conf = computeConfidence(c, now);
    const fresh = claimFreshness(c, now);
    if (conf < 25) warnings.push(`⚠️ Low-confidence claim (${c.id}, ${conf}/100) — treat as unverified.`);
    if (needsRecheck(fresh)) warnings.push(`🕒 Verification ${fresh} for ${c.id} — re-verify before publishing.`);
  }

  if (req.bonus) {
    const status = effectiveVerification(req.bonus, now);
    if (status !== 'verified') {
      warnings.push(`⚠️ Bonus "${req.bonus.title}" is ${status} — do NOT present it as confirmed.`);
    }
    if (!isBonusActive(req.bonus, now)) {
      warnings.push(`🕒 Bonus "${req.bonus.title}" is not currently active.`);
    }
  }

  if (req.exchange?.restrictedGeos?.length) {
    warnings.push(`🚫 Not available in: ${req.exchange.restrictedGeos.join(', ')}.`);
    const geo = (req.geo ?? '').toUpperCase();
    if (geo && req.exchange.restrictedGeos.map((g) => g.toUpperCase()).includes(geo)) {
      warnings.push(`🚫 ${req.exchange.name} is RESTRICTED in ${geo} — do not target this market.`);
    }
  }
  return warnings;
}

// ── SEO (Phase 5) ────────────────────────────────────────────────────────────

const dedupeCap = (xs: string[], cap: number) => [...new Set(xs.map((x) => x.toLowerCase()).filter(Boolean))].slice(0, cap);

export function buildSeo(req: ContentRequest): SeoBlock {
  const subject = subjectTitle(req);
  const geo = req.geo ?? req.topic?.geo ?? 'KZ';
  const exName = req.exchange?.name ?? req.topic?.exchange ?? '';
  const title = trunc(`${subject} — ${geo} guide`, 60);
  const metaDescription = trunc(
    `${subject}: what Kazakhstan users should know — availability, KYC, P2P and fees. Verify details before acting.`,
    160,
  );
  // Clusters are small + deduped — no stuffing.
  const keywordClusters: string[][] = [
    dedupeCap([exName, subject].filter(Boolean), 4),
    dedupeCap(['kazakhstan', 'kzt', 'kaspi', 'p2p'], 5),
    dedupeCap(['how to', 'guide', 'fees', 'kyc'], 5),
  ].filter((c) => c.length);
  const faqIdeas = [
    `Is ${exName || 'this exchange'} available in Kazakhstan?`,
    'Does it support KZT deposits and P2P?',
    'What KYC is required?',
  ];
  return { title, metaDescription, keywordClusters, faqIdeas, ctaPlaceholder: CTA };
}

// ── Body templates (deterministic, no hype) ──────────────────────────────────

function bodyFor(type: DraftType, req: ContentRequest, warnings: string[]): string {
  const subject = subjectTitle(req);
  const geo = req.geo ?? req.topic?.geo ?? 'KZ';
  const reason = req.topic?.reason ?? req.finding?.reason ?? '';
  const warnLine = warnings.length ? `\n\n⚠️ Review notes:\n- ${warnings.join('\n- ')}` : '';

  switch (type) {
    case 'article_outline':
      return [
        `# ${subject}`,
        '',
        '1. Introduction — why this matters for Kazakhstan users',
        '2. Key facts (verify each before publishing)',
        '3. Availability, KYC & P2P in ' + geo,
        '4. Fees & local payment rails (KZT / Kaspi / Halyk)',
        '5. Risks & what to watch',
        '6. Summary + next steps',
        `\nCTA: ${CTA}`,
        warnLine,
      ].join('\n');
    case 'seo_snippet':
      return `${subject}: a concise, verification-checked overview for ${geo}. ${reason}`.trim() + warnLine;
    case 'warning_post':
      return [
        `⚠️ Important notice: ${subject}`,
        '',
        'Please review the following before relying on this information:',
        warnings.length ? `- ${warnings.join('\n- ')}` : '- No specific warnings detected, but verify independently.',
        '',
        'We prioritize accuracy over speed — details may change.',
      ].join('\n');
    case 'educational_post':
      return [
        `${subject}`,
        '',
        `A short explainer for crypto users in ${geo}. ${reason}`.trim(),
        'This is general information, not financial advice. Verify current details with official sources.',
        `\n${CTA}`,
        warnLine,
      ].join('\n');
    case 'telegram_post':
    default:
      return [
        `${subject}`,
        '',
        reason || `An update relevant to crypto users in ${geo}.`,
        `\n🔗 ${CTA}`,
        warnLine,
      ].join('\n');
  }
}

// ── Main generator ───────────────────────────────────────────────────────────

export function generateDraft(req: ContentRequest): DraftContent {
  const now = req.now ?? new Date();
  const locale = req.locale ?? 'ru-KZ';
  const geo = req.geo ?? req.topic?.geo ?? req.finding?.geos?.[0] ?? 'KZ';
  const exchange = req.exchange?.slug ?? req.topic?.exchange ?? req.finding?.exchanges?.[0] ?? null;

  const citations = buildCitations(req);
  const warnings = buildWarnings(req);
  const tone = toneFor(req.type, req);
  const title = trunc(subjectTitle(req), 120);
  const body = bodyFor(req.type, req, warnings);
  const seo = req.type === 'seo_snippet' || req.type === 'article_outline' ? buildSeo(req) : null;

  return {
    id: `draft:${req.type}:${(req.topic?.id ?? req.finding?.id ?? exchange ?? 'generic')}`,
    type: req.type,
    tone,
    title,
    body,
    geo,
    locale,
    exchange,
    citations,
    warnings,
    seo,
    ctaPlaceholder: CTA,
    machineGenerated: true,
    humanReviewRequired: true,
    confidenceNote: CONFIDENCE_NOTE,
    createdAt: now.toISOString(),
  };
}

// ── Multilingual variants (Phase 4) ──────────────────────────────────────────

const DEFAULT_LOCALES: LocaleCode[] = ['ru-KZ', 'kk-KZ', 'en-US', 'de-DE'];

/**
 * Produce localized SCAFFOLDS for a draft. These are NOT auto-translations — each
 * variant carries the base text plus an explicit note that a human translator
 * must localize + review it. machineGenerated + humanReviewRequired are always
 * true (no fake localization).
 */
export function generateLocalizedDraft(
  draft: DraftContent,
  locales: LocaleCode[] = DEFAULT_LOCALES,
): LocalizedDraft {
  const variants: DraftVariant[] = locales.map((loc) => {
    const def = getLocale(loc);
    const langName = def?.languageName ?? loc;
    return {
      locale: loc,
      title: `[${loc}] ${draft.title}`,
      body: draft.body,
      machineGenerated: true,
      humanReviewRequired: true,
      note: `Scaffold for ${langName} (${loc}) — requires human translation & review. Not auto-translated.`,
    };
  });
  return { sourceId: draft.id, baseLocale: draft.locale, variants };
}

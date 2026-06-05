/** A configured RSS feed. */
export interface RssSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** Trust/relevance bonus added to the moderation score for items from this feed. */
  weight?: number;
}

/** A normalized news item extracted from any feed. */
export interface NewsItem {
  /** Stable hash derived from sourceId + guid/link. */
  id: string;
  title: string;
  link: string;
  /** Human-readable source name. */
  source: string;
  /** Source id (matches RssSource.id). */
  sourceId: string;
  /** ISO 8601 publish date. */
  publishDate: string;
  summary: string;
}

export type PipelineStatus =
  | 'duplicate'
  | 'rejected'
  | 'rewritten' // accepted + rewritten, drafted to console (no sender)
  | 'sent'      // draft delivered to moderation chat
  | 'error';

/** Output of the moderation layer. */
export interface ModerationResult {
  accepted: boolean;
  score: number;
  category: string | null;
  reason: string | null;
}

/** Ranking priority assigned by the scoring layer. */
export type Priority = 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT';

/** Full output of the scoring layer for one news item. */
export interface ScoreResult {
  /** 0-25: global crypto importance. */
  importance_score: number;
  /** 0-25: Kazakhstan relevance. */
  kz_relevance_score: number;
  /** 0-20: exchange / bonus / campaign relevance (CBW monetization). */
  exchange_bonus_score: number;
  /** 0-20: actionable value to the reader. */
  user_value_score: number;
  /** 0-10: source trust minus hype penalty. */
  trust_score: number;
  /** 0-100: sum of subscores, clamped. */
  score_total: number;
  /** Human-readable type tag: Global / KZ / Bonus / Listing / Regulation / Security. */
  category: string;
  /** Short explanation of the score. */
  reason: string;
  priority: Priority;
}

/** A rewritten, ready-to-review draft. */
export interface Draft {
  item: NewsItem;
  text: string;
  category: string | null;
  /** Scoring metadata shown in the moderation draft (optional for back-compat). */
  score?: ScoreResult;
}

/** Lifecycle of a moderation draft. */
export type DraftStatus = 'pending' | 'approved' | 'rejected' | 'published';

/**
 * A persisted draft awaiting (or past) a manual moderation decision. Holds the
 * publishable post text so the bot can publish it when the owner clicks Approve.
 */
export interface DraftRecord {
  id: string;
  title: string;
  link: string;
  source: string;
  publishDate: string;
  category: string | null;
  scoreTotal: number | null;
  priority: Priority | null;
  /** The rewritten post body that would be published to the channel. */
  text: string;
  status: DraftStatus;
  createdAt: string;
  decidedAt?: string | null;
  publishedAt?: string | null;
  /** Telegram message id of the published channel post (prevents re-publish). */
  channelMessageId?: number | null;
  rejectionReason?: string | null;
}

/** Persisted record of one processed item (state + audit log). */
export interface ProcessedRecord {
  id: string;
  title: string;
  titleNorm: string;
  source: string;
  publishDate: string;
  status: PipelineStatus;
  category: string | null;
  /** Why this item was rejected, or why it scored as it did. */
  reason: string | null;
  /** 0-100 total score from the scoring layer (null if rejected pre-scoring). */
  scoreTotal: number | null;
  priority: Priority | null;
  sent: boolean;
  processedAt: string;
}

// ───────────────────────────────────────────────────────────────────────────
// ANALYTICS FOUNDATION (EPIC 001)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Engagement metrics for a published channel post. Telegram does not always
 * expose engagement to bots (views/forwards/reactions depend on channel type
 * and API surface), so each numeric field is nullable and `available` records
 * whether real engagement data was ever collected. Counters that the bot can
 * always observe locally (edits / deletes) are plain numbers.
 */
export interface TelegramMetrics {
  views: number | null;
  forwards: number | null;
  reactions: number | null;
  edits: number;
  deletes: number;
  /** True once any real engagement metric (views/forwards/reactions) was set. */
  available: boolean;
  collectedAt: string | null;
}

/**
 * One published post, normalized for analytics. This is the durable record the
 * dashboard, reports and AI-feedback layers all read from.
 */
export interface PostAnalyticsRecord {
  /** Matches the originating NewsItem / DraftRecord id. */
  id: string;
  telegramMessageId: number;
  channelId: string;
  title: string;
  link: string;
  source: string;
  category: string | null;
  priority: Priority | null;
  scoreTotal: number | null;
  /** Exchanges mentioned in the post (lowercased canonical names). */
  exchangeMentions: string[];
  /** GEO tags (e.g. "KZ", "Global"). */
  geoTags: string[];
  publishedAt: string;
  metrics: TelegramMetrics;
  updatedAt: string;
}

/** Aggregated performance for one group (a category, exchange, priority, …). */
export interface GroupStat {
  key: string;
  posts: number;
  avgScore: number;
  totalViews: number;
  totalForwards: number;
  totalReactions: number;
  totalEngagement: number;
  avgEngagement: number;
}

export type ReportPeriod = 'daily' | 'weekly';

/** A compact reference to a post, used inside reports. */
export interface ReportPostRef {
  id: string;
  title: string;
  category: string | null;
  scoreTotal: number | null;
  engagement: number;
  telegramMessageId: number;
}

/** A generated daily / weekly report. */
export interface AnalyticsReport {
  period: ReportPeriod;
  generatedAt: string;
  rangeStart: string;
  rangeEnd: string;
  totalPublished: number;
  approvalCount: number;
  rejectedCount: number;
  /** published / approved, 0..1 (1 when there were no approvals). */
  publishSuccessRate: number;
  averageScore: number;
  topPost: ReportPostRef | null;
  topCategory: string | null;
  topExchange: string | null;
}

/** AI-feedback classification of one published post (foundation only). */
export type FeedbackClass = 'successful' | 'weak' | 'neutral' | 'no_data';

export interface PatternFeedback {
  id: string;
  title: string;
  category: string | null;
  priority: Priority | null;
  scoreTotal: number | null;
  engagement: number;
  classification: FeedbackClass;
  reason: string;
}

/** Foundation summary for future AI learning — NOT a self-learning model. */
export interface FeedbackSummary {
  generatedAt: string;
  patterns: PatternFeedback[];
  categoryPerformance: GroupStat[];
  exchangePerformance: GroupStat[];
  successfulCount: number;
  weakCount: number;
}

/** Historical snapshot of the analytics state, for the future dashboard. */
export interface AnalyticsSnapshot {
  takenAt: string;
  totalPublished: number;
  byCategory: GroupStat[];
  byExchange: GroupStat[];
  byPriority: GroupStat[];
  byScoreRange: GroupStat[];
}

// ───────────────────────────────────────────────────────────────────────────
// MONETIZATION INTELLIGENCE (EPIC 002 — affiliate / bonus engine)
//
// This layer models WHICH exchanges work where, WHAT bonuses exist, and HOW
// trustworthy that information is. It is intelligence + structure only: it never
// injects affiliate links into content and never publishes. Human moderation
// stays mandatory. Accuracy + GEO correctness are the whole point.
// ───────────────────────────────────────────────────────────────────────────

export type TrustLevel = 'high' | 'medium' | 'low';

/** KYC depth required to trade. */
export type KycLevel = 'none' | 'basic' | 'full';

/** Verification state of a bonus/campaign claim. */
export type VerificationStatus = 'verified' | 'outdated' | 'unverified';

export type BonusType =
  | 'signup'
  | 'deposit'
  | 'trading'
  | 'launchpool'
  | 'launchpad'
  | 'campaign'
  | 'competition';

/** Kazakhstan-specific availability (the initial GEO focus). */
export interface KzAvailability {
  available: boolean;
  p2p: boolean;
  kyc: KycLevel;
  /** Supported KZ fiat rails, e.g. KZT, Kaspi, Halyk, Freedom, local-cards. */
  fiat: string[];
  notes: string;
}

/** One exchange in the registry. */
export interface ExchangeRecord {
  name: string;
  slug: string;
  officialUrl: string;
  /** Tracking-ready affiliate URL. Defaults to officialUrl until a code lands. */
  affiliateUrl: string;
  /** ISO country codes the exchange serves; `*` means "global default allow". */
  supportedGeos: string[];
  /** Hard GEO blocks (take priority over supportedGeos). */
  restrictedGeos: string[];
  kyc: KycLevel;
  p2p: boolean;
  /** Global fiat currencies / rails supported. */
  fiat: string[];
  kazakhstan: KzAvailability;
  trustLevel: TrustLevel;
  notes: string;
  /** When a human last reviewed this record (null = needs review). */
  lastReviewedAt: string | null;
}

/** Provenance + freshness of a bonus claim. */
export interface VerificationInfo {
  status: VerificationStatus;
  /** Where the claim was verified (URL / human note). */
  source: string;
  lastCheckedAt: string | null;
}

/** A tracked bonus / campaign / launchpool. */
export interface BonusRecord {
  id: string;
  exchangeSlug: string;
  type: BonusType;
  title: string;
  description: string;
  /** Human-readable value, e.g. "Up to $5,000" (null if not quantified). */
  value: string | null;
  /** GEOs the bonus applies to (`*` = global). */
  geos: string[];
  startDate: string | null;
  expiryDate: string | null;
  sourceUrl: string;
  verification: VerificationInfo;
}

/** Affiliate metadata — tracking-ready, never auto-injected into content. */
export interface AffiliateMeta {
  exchangeSlug: string;
  affiliateUrl: string;
  refCode: string | null;
  campaign: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// VERIFICATION / TRUST LAYER (EPIC 003 — Kazakhstan GEO verification)
//
// Turns the static exchange/GEO/bonus data into VERIFIABLE claims backed by
// evidence, with freshness tracking and a 0-100 confidence score. The guiding
// rule: accuracy over speed, and uncertainty over hallucination. Nothing here
// publishes; a human reviewer attaches evidence and the system scores it.
// ───────────────────────────────────────────────────────────────────────────

/** Where a piece of evidence came from (ordered loosely by authority). */
export type EvidenceType =
  | 'official_docs'
  | 'official_support'
  | 'exchange_ui'
  | 'user_report'
  | 'manual_review';

/** What an evidence-backed claim is about. */
export type ClaimType =
  | 'availability'
  | 'geo_restriction'
  | 'kyc'
  | 'p2p'
  | 'fiat'
  | 'bonus'
  | 'launchpool';

/** Freshness lifecycle of a claim / evidence. */
export type FreshnessStatus = 'fresh' | 'aging' | 'stale' | 'expired';

/** A single piece of evidence supporting (or refuting) a claim. */
export interface Evidence {
  id: string;
  sourceUrl: string;
  type: EvidenceType;
  note: string;
  /** When this evidence was gathered / verified. */
  verifiedAt: string;
  /** When this evidence should no longer be trusted (null = no hard expiry). */
  expiresAt: string | null;
  /** verified = confirms the claim, unverified = unconfirmed, outdated = was true. */
  status: VerificationStatus;
  /** Who recorded it (human reviewer handle or "system"). */
  reviewer: string;
}

/** A verifiable claim about one exchange in one country, with its evidence. */
export interface VerificationClaim {
  /** Stable id, e.g. "bybit:KZ:p2p". */
  id: string;
  exchangeSlug: string;
  country: string;
  type: ClaimType;
  /** The asserted value as a string, e.g. "true" / "basic" / "KZT". */
  assertion: string;
  evidence: Evidence[];
  /** Set true when evidence disagree (forces a confidence penalty). */
  conflicting: boolean;
  /** Days after the last check before the claim is considered stale. */
  staleAfterDays: number;
  /** Last time the claim was reviewed (null = never properly checked). */
  lastCheckedAt: string | null;
}

/** Computed verdict for a claim (never persisted as source of truth). */
export interface ClaimVerdict {
  id: string;
  exchangeSlug: string;
  country: string;
  type: ClaimType;
  assertion: string;
  confidence: number; // 0-100
  freshness: FreshnessStatus;
  /** True only when confidence is high AND data is fresh/aging. */
  reliable: boolean;
  evidenceCount: number;
}

/** A Kazakhstan availability snapshot for one exchange (Phase 5). */
export interface KzGeoSnapshot {
  exchangeSlug: string;
  name: string;
  country: string; // 'KZ'
  kyc: KycLevel;
  p2p: boolean;
  kzt: boolean;
  localBanks: string[];
  notes: string;
  confidence: number; // aggregate 0-100
  freshness: FreshnessStatus; // worst across contributing claims
  reliable: boolean;
  generatedAt: string;
}

// ───────────────────────────────────────────────────────────────────────────
// MULTILINGUAL / MULTI-GEO FOUNDATION (EPIC 004)
//
// Locale architecture for future CBW expansion (KZ, Germany, Turkey, Nigeria,
// India). FOUNDATION ONLY: structures + routing + a translation MODERATION flow.
// No auto-translation, no auto-publishing, no fake localization. Low-confidence
// localization stays flagged for human review.
// ───────────────────────────────────────────────────────────────────────────

/** BCP-47-ish locale tag, e.g. "ru-KZ", "de-DE". */
export type LocaleCode = string;

/** A configured locale (language + country + monetization defaults). */
export interface LocaleDefinition {
  code: LocaleCode;
  language: string;        // ISO 639-1, e.g. "ru"
  languageName: string;    // human-readable, e.g. "Russian"
  country: string;         // ISO 3166-1 alpha-2, e.g. "KZ"
  /** Locale to fall back to when content is missing (null = no fallback). */
  fallback: LocaleCode | null;
  defaultCurrency: string; // e.g. "KZT"
  timezone: string;        // IANA tz, e.g. "Asia/Almaty"
  /** Exchange slugs preferred for this market (ordered). */
  preferredExchanges: string[];
  /** Local payment rails, e.g. ["Kaspi", "Halyk"]. */
  localPaymentMethods: string[];
}

/** Lifecycle of a translation (Phase 4) — human approval is mandatory. */
export type TranslationStatus =
  | 'untranslated'
  | 'machine_translated'
  | 'human_review_required'
  | 'approved'
  | 'rejected';

/** One localized field/string with its moderation state. */
export interface LocalizedField {
  locale: LocaleCode;
  /** The localized text (empty when untranslated). */
  text: string;
  status: TranslationStatus;
  /** Optional confidence 0-100 for machine output (flags low-quality MT). */
  confidence: number | null;
  reviewer: string | null;
  updatedAt: string;
}

/**
 * A localized content bundle for one source post in one locale. Holds title,
 * summary, a CTA placeholder and exchange notes — each individually moderated.
 * Nothing here is published automatically.
 */
export interface LocalizedContent {
  sourceId: string;       // originating NewsItem / DraftRecord id
  locale: LocaleCode;
  title: LocalizedField;
  summary: LocalizedField;
  /** CTA placeholder text (still never auto-injected — see affiliate-layer). */
  cta: LocalizedField;
  exchangeNotes: LocalizedField;
  /** Overall status = lowest common state across fields. */
  status: TranslationStatus;
  createdAt: string;
  updatedAt: string;
}

/** Engagement performance for one locale (multi-GEO analytics, Phase 5). */
export interface LocalePerformance {
  locale: LocaleCode;
  country: string;
  posts: number;
  avgScore: number;
  totalEngagement: number;
  avgEngagement: number;
  topExchange: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// EDITORIAL PLANNING / EDITORIAL BRAIN (EPIC 005)
//
// Generates structured editorial RECOMMENDATIONS from the analytics, registry,
// bonus, verification and locale layers. Planning only: it recommends, it never
// executes. No auto-publish, no auto-approve, no fake/hype content. Every topic
// carries the verification status required before it could be published.
// ───────────────────────────────────────────────────────────────────────────

export type TopicType =
  | 'news'
  | 'bonus'
  | 'launchpool'
  | 'p2p'
  | 'kyc'
  | 'regulation'
  | 'education'
  | 'comparison'
  | 'warning'
  | 'evergreen';

/** Planning buckets used to balance the content mix. */
export type PlanBucket = 'news' | 'bonus' | 'education' | 'verification' | 'evergreen';

export type PriorityBand = 'high' | 'medium' | 'low';

/** A single editorial recommendation. */
export interface EditorialTopic {
  id: string;
  title: string;
  type: TopicType;
  /** Exchange slug this topic is about, or null. */
  exchange: string | null;
  geo: string;          // country code, e.g. "KZ"
  locale: LocaleCode;
  priority: number;     // 0-100
  priorityBand: PriorityBand;
  reason: string;
  confidence: number;   // 0-100 (verification-derived where relevant)
  /** CTA placeholder only — never auto-injected into content. */
  suggestedCta: string;
  /** Verification status required BEFORE this could be published. */
  requiredVerification: VerificationStatus;
}

export interface ContentMixItem {
  bucket: PlanBucket;
  planned: number;
  selected: number;
}

/** A generated editorial plan (daily or weekly) — recommendation only. */
export interface EditorialPlan {
  period: 'daily' | 'weekly';
  generatedAt: string;
  geoFocus: string;
  topics: EditorialTopic[];
  contentMix: ContentMixItem[];
  /** Editorial guidance: gaps, stale warnings, locale gaps, the human-gate note. */
  notes: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// RESEARCH / INTELLIGENCE LAYER (EPIC 006)
//
// Continuously discovers launchpools, listings, bonuses, regulation, KZ
// developments and restrictions from news inputs; surfaces trends; and proposes
// (never adds) registry candidates. Research RECOMMENDATIONS only — no
// auto-publish, no auto-approve, no auto registry writes, no fake confidence.
// Every actionable finding is marked human-verification-required.
// ───────────────────────────────────────────────────────────────────────────

export type ResearchCategory =
  | 'launchpool'
  | 'listing'
  | 'bonus'
  | 'regulation'
  | 'kz'
  | 'restriction'
  | 'news';

export type ResearchPriority = 'HIGH' | 'MEDIUM' | 'LOW';

/** How much to trust the SOURCE a finding came from. */
export type SourceTrust = 'trusted' | 'neutral' | 'weak';

/** One classified research finding extracted from a news item. */
export interface ResearchFinding {
  id: string;
  title: string;
  link: string;
  source: string;
  category: ResearchCategory;
  priority: ResearchPriority;
  /** Exchanges mentioned (lowercased canonical names). */
  exchanges: string[];
  /** GEO tags, e.g. ["KZ"]. */
  geos: string[];
  /** Keywords that triggered the classification (explainability). */
  signals: string[];
  sourceTrust: SourceTrust;
  confidence: number; // 0-100
  reason: string;
  /** Always true — nothing here is publishable without a human. */
  humanVerificationRequired: boolean;
  foundAt: string;
}

/** A detected trend across findings + analytics. */
export interface TrendSignal {
  key: string;
  kind: 'keyword' | 'exchange' | 'geo' | 'category';
  count: number;
  momentum: number; // 0-100
  status: 'emerging' | 'trending' | 'undercovered' | 'steady';
  reason: string;
}

/** A proposed-but-unconfirmed addition to the registry. NEVER auto-added. */
export interface DiscoveryCandidate {
  id: string;
  kind: 'exchange' | 'launchpool' | 'bonus';
  name: string;
  sourceLink: string;
  source: string;
  confidence: number; // 0-100
  /** Scam-likelihood 0-100 (higher = riskier). */
  scamRisk: number;
  /** True when a scam pattern was detected → never suggested. */
  rejected: boolean;
  reason: string;
  suggestedAction: string;
}

export interface ResearchSnapshot {
  generatedAt: string;
  findings: ResearchFinding[];
  trends: TrendSignal[];
  discoveries: DiscoveryCandidate[];
  counts: {
    high: number;
    medium: number;
    low: number;
    discoveries: number;
    rejected: number;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// OPTIMIZATION / LEARNING META-BRAIN (EPIC 007)
//
// Synthesizes analytics + verification + locale + research signals into
// SELF-IMPROVEMENT SUGGESTIONS (scoring weights, source trust, topic priority,
// locale focus, verification refresh, engagement patterns). STRICTLY
// recommendation-only: nothing is auto-applied, no config is changed, no
// autonomous action is taken. Sparse data yields low-confidence "investigate"
// suggestions — uncertainty over overfitting.
// ───────────────────────────────────────────────────────────────────────────

export type SuggestionType =
  | 'scoring_weight'
  | 'source_trust'
  | 'topic_priority'
  | 'locale_focus'
  | 'verification_refresh'
  | 'engagement_pattern';

export type SuggestionDirection = 'increase' | 'decrease' | 'maintain' | 'investigate';

export type OptimizationConfidence = 'high' | 'medium' | 'low';

/** A single, human-reviewable optimization recommendation. */
export interface OptimizationSuggestion {
  id: string;
  type: SuggestionType;
  /** What the suggestion is about (category / source / topic / locale / claim id). */
  target: string;
  direction: SuggestionDirection;
  /** The observed metric that triggered it (context for the human). */
  observation: string;
  /** The recommended change — a human applies it; the system never does. */
  recommendation: string;
  rationale: string;
  confidence: OptimizationConfidence;
  /** Supporting sample size; small samples force low confidence. */
  sampleSize: number;
  /** Always true. */
  humanReviewRequired: boolean;
}

export interface OptimizationSnapshot {
  generatedAt: string;
  suggestions: OptimizationSuggestion[];
  summary: {
    total: number;
    byType: Record<string, number>;
    highConfidence: number;
  };
  notes: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// EDITORIAL WORKFLOW / QUEUE (EPIC 008)
//
// A human-gated queue that connects planner topics, research findings,
// verification warnings, optimization suggestions and manual ideas into one
// lifecycle. The workflow only TRACKS state — it never publishes, never
// approves on its own, and items that require verification cannot advance to
// approved/scheduled/published until a human clears them. Publishing itself
// stays the existing manual Approve → channel flow; this layer touches no
// publisher.
// ───────────────────────────────────────────────────────────────────────────

export type WorkflowStatus =
  | 'idea'
  | 'draft_requested'
  | 'drafted'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'scheduled'
  | 'published';

export type QueueSource = 'planner' | 'research' | 'verification' | 'optimization' | 'manual';

export interface QueueHistoryEntry {
  status: WorkflowStatus;
  at: string;
  by: string | null;
}

/** One item in the editorial workflow queue. */
export interface QueueItem {
  id: string;
  title: string;
  source: QueueSource;
  reason: string;
  priority: number; // 0-100
  status: WorkflowStatus;
  /** A verification target (claim id / "exchange:GEO") that must clear first. */
  requiredVerification: string | null;
  /** Whether the required verification has been cleared by a human. */
  verificationCleared: boolean;
  geo: string | null;
  locale: string | null;
  exchange: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  decidedBy: string | null;
  history: QueueHistoryEntry[];
}

export interface QueueReviewSummary {
  generatedAt: string;
  byStatus: Record<string, number>;
  /** Items awaiting a review decision (in_review / drafted). */
  reviewReady: QueueItem[];
  /** Items blocked by an uncleared verification gate. */
  blockedByVerification: QueueItem[];
  notes: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// CONTENT GENERATION ENGINE (EPIC 009)
//
// Controlled, verification-AWARE draft generation. Produces Telegram drafts,
// article outlines, SEO snippets and multilingual variants — all flagged
// machine-generated + human-review-required. It NEVER publishes, posts, or
// auto-approves; it implies no certainty beyond cited evidence, flags
// unverified/stale claims, discloses GEO restrictions, and never injects real
// affiliate links (CTA stays a placeholder).
// ───────────────────────────────────────────────────────────────────────────

export type DraftType =
  | 'telegram_post'
  | 'article_outline'
  | 'seo_snippet'
  | 'warning_post'
  | 'educational_post';

export type ContentTone = 'neutral' | 'educational' | 'cautionary' | 'promotional_safe';

/** A traceable reference to the verification behind a claim used in a draft. */
export interface VerificationCitation {
  target: string; // claim id / "exchange:GEO"
  confidence: number; // 0-100
  freshness: FreshnessStatus;
  reliable: boolean;
  note: string;
}

/** SEO scaffolding — structures only, no keyword stuffing. */
export interface SeoBlock {
  title: string;
  metaDescription: string; // ≤ 160 chars
  keywordClusters: string[][];
  faqIdeas: string[];
  ctaPlaceholder: string; // "{{CTA}}"
}

/** One localized rendering of a draft (scaffold — needs human translation). */
export interface DraftVariant {
  locale: LocaleCode;
  title: string;
  body: string;
  machineGenerated: boolean; // always true
  humanReviewRequired: boolean; // always true
  note: string;
}

export interface LocalizedDraft {
  sourceId: string;
  baseLocale: LocaleCode;
  variants: DraftVariant[];
}

/** A generated draft — never published, always human-review-required. */
export interface DraftContent {
  id: string;
  type: DraftType;
  tone: ContentTone;
  title: string;
  body: string;
  geo: string | null;
  locale: LocaleCode;
  exchange: string | null;
  citations: VerificationCitation[];
  /** Verification / GEO-restriction / unverified-bonus warnings. */
  warnings: string[];
  seo: SeoBlock | null;
  ctaPlaceholder: string; // "{{CTA}}" — never a real link
  machineGenerated: boolean; // always true
  humanReviewRequired: boolean; // always true
  /** Explicit "no fake certainty" note. */
  confidenceNote: string;
  createdAt: string;
}

// ───────────────────────────────────────────────────────────────────────────
// OPERATOR / ORCHESTRATION LAYER (EPIC 010)
//
// A human-gated command center that orchestrates the daily editorial cycle by
// reading every engine (research, planner, queue, content, verification,
// analytics, optimization) and producing next-best-actions, blocked items, a
// stale-verification queue, draft opportunities and a system-health summary.
// It RECOMMENDS owner actions — it never publishes, approves, or writes to
// production. The human remains the final operator.
// ───────────────────────────────────────────────────────────────────────────

export type OperatorActionType =
  | 'verify'
  | 'review_queue'
  | 'create_draft'
  | 'tune'
  | 'investigate'
  | 'maintain';

export type SystemHealthStatus = 'green' | 'amber' | 'red';

/** A recommended owner action — always executed by a human. */
export interface OperatorAction {
  id: string;
  title: string;
  kind: OperatorActionType;
  priority: number; // 0-100
  reason: string;
  /** Suggested bot command to run next (read-only), or null. */
  command: string | null;
  /** Always true. */
  humanRequired: boolean;
}

export interface SystemHealth {
  status: SystemHealthStatus;
  verificationConfidenceAvg: number;
  staleClaims: number;
  unverifiedBonuses: number;
  queueActive: number;
  queueBlocked: number;
  publishedPosts: number;
  notes: string[];
}

export interface DraftOpportunity {
  id: string;
  title: string;
  priority: number;
  exchange: string | null;
}

/** The daily operator command center — recommendation snapshot only. */
export interface OperatorReport {
  generatedAt: string;
  health: SystemHealth;
  nextActions: OperatorAction[];
  blockedItems: QueueItem[];
  staleVerifications: string[];
  draftOpportunities: DraftOpportunity[];
  queueStatus: Record<string, number>;
  notes: string[];
}

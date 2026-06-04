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

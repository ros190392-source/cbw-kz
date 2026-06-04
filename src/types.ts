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

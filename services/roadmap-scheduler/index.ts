import { ChannelPost, ChannelPostStatus, ContentPostType, EvidenceLevel } from '../../src/types';
import { ChannelPostStore } from '../content-center';
import { TOPICS, generateContentDraft, resolveImage } from '../content-machine';
import { ImageProvider } from '../image-generator';
import { logger } from '../../src/logger';

/**
 * Roadmap selector / scheduler (EPIC 019).
 *
 * Turns CONTENT_ROADMAP.md into an operational Telegram queue for @cbw_kz.
 * Selects the next post from the 60-post roadmap respecting:
 *   - no same pillar back-to-back
 *   - no same topic within 21 days
 *   - visual diversity (no same image theme in last 2)
 *   - education/safety ratio targets over a 14-day window
 *   - weekly pillar rotation (day-of-week → pillar preference)
 *   - high-risk topics (regulation/Kaspi) blocked unless evidence ≥ C
 *
 * NOTHING publishes automatically — the scheduler creates `planned` posts that
 * a human must /approve_publish. Auto-publish is OFF (see canAutoPublish).
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** Asia/Almaty = UTC+5 (no DST). */
export const KZ_OFFSET_H = 5;
const KZ_OFFSET_MS = KZ_OFFSET_H * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Topic dedup window in days. */
export const DEDUP_WINDOW_DAYS = 21;
/** Rolling ratio window in days. */
export const RATIO_WINDOW_DAYS = 14;
/** Max posts per day. */
export const MAX_POSTS_PER_DAY = 1;

const TARGET_EDUCATION_RATIO = 0.55;
const TARGET_SAFETY_RATIO = 0.20;

// ── Roadmap data structures ────────────────────────────────────────────────

export interface RoadmapPillar {
  id: number;
  name: string;
  postType: ContentPostType;
  chip: string;
  defaultEvidence: EvidenceLevel;
  imageTheme: string;
  core: boolean;
}

export interface RoadmapEntry {
  topicKey: string;
  title: string;
  pillarId: number;
  pillarName: string;
  postType: ContentPostType;
  chip: string;
  evidenceLevel: EvidenceLevel;
  imageTheme: string;
  /** 0-based order within the 60-post roadmap. */
  order: number;
  /** Whether a content-machine caption template exists. */
  hasTemplate: boolean;
  /** Regulation/Kaspi/GEO claim — needs evidence. */
  highRisk: boolean;
}

// ── Pillar definitions (CONTENT_ROADMAP §1) ────────────────────────────────

export const PILLARS: RoadmapPillar[] = [
  { id: 1,  name: 'USDT',                 postType: 'education',       chip: 'USDT · ГАЙД',        defaultEvidence: 'C', imageTheme: 'tether_coin',     core: true  },
  { id: 2,  name: 'P2P',                  postType: 'education',       chip: 'P2P · ГАЙД',         defaultEvidence: 'C', imageTheme: 'p2p_exchange',    core: true  },
  { id: 3,  name: 'Безопасность',         postType: 'p2p_safety',      chip: 'P2P · БЕЗОПАСНОСТЬ',  defaultEvidence: 'C', imageTheme: 'shield_coin',     core: true  },
  { id: 4,  name: 'Биржи',                postType: 'exchange_update', chip: 'БИРЖИ · ГАЙД',       defaultEvidence: 'C', imageTheme: 'platform_nodes',  core: true  },
  { id: 5,  name: 'KZT / Kaspi',          postType: 'education',       chip: 'KZT · ОПЛАТА',       defaultEvidence: 'D', imageTheme: 'tenge_coin',      core: true  },
  { id: 6,  name: 'Скам',                 postType: 'p2p_safety',      chip: 'СКАМ · АЛЕРТ',       defaultEvidence: 'C', imageTheme: 'warning_shield',  core: false },
  { id: 7,  name: 'Новости',              postType: 'news',            chip: 'НОВОСТИ',             defaultEvidence: 'C', imageTheme: 'news_glow',       core: false },
  { id: 8,  name: 'Beginner education',   postType: 'education',       chip: 'НОВИЧКАМ',            defaultEvidence: 'C', imageTheme: 'simple_icons',    core: false },
  { id: 9,  name: 'Exchange comparisons', postType: 'exchange_update', chip: 'БИРЖИ · СРАВНЕНИЕ',  defaultEvidence: 'C', imageTheme: 'balanced_scales', core: false },
  { id: 10, name: 'Regulation',           postType: 'news',            chip: 'ЗАКОН · KZ',         defaultEvidence: 'C', imageTheme: 'document_afsa',   core: false },
  { id: 11, name: 'Wallets',              postType: 'education',       chip: 'КОШЕЛЬКИ',            defaultEvidence: 'C', imageTheme: 'wallet_icon',     core: false },
  { id: 12, name: 'Crypto basics',        postType: 'education',       chip: 'ОСНОВЫ',              defaultEvidence: 'C', imageTheme: 'blockchain_blocks', core: false },
];

const pillarById = (id: number): RoadmapPillar | undefined => PILLARS.find(p => p.id === id);

// ── 60-post roadmap (CONTENT_ROADMAP §8) ──────────────────────────────────

function mkEntry(topicKey: string, title: string, pillarId: number, order: number, overrides?: Partial<RoadmapEntry>): RoadmapEntry {
  const p = pillarById(pillarId)!;
  return {
    topicKey, title, pillarId,
    pillarName: p.name,
    postType:      overrides?.postType ?? p.postType,
    chip:          overrides?.chip ?? p.chip,
    evidenceLevel: overrides?.evidenceLevel ?? p.defaultEvidence,
    imageTheme:    overrides?.imageTheme ?? p.imageTheme,
    order,
    hasTemplate: !!TOPICS[topicKey],
    highRisk:    overrides?.highRisk ?? false,
  };
}

export const ROADMAP: RoadmapEntry[] = [
  // Pillar 1 — USDT
  mkEntry('usdt_basics',       'Что такое USDT',                              1, 0),
  mkEntry('usdt_vs_dollar',    'Чем USDT отличается от доллара',              1, 1),
  mkEntry('usdt_networks',     'Сети USDT (TRC20/ERC20/TON) — что выбрать',  1, 2),
  mkEntry('stablecoin_risks',  'Риски стейблкоинов',                          1, 3),
  mkEntry('usdt_safe_storage', 'Как безопасно хранить USDT',                  1, 4),
  // Pillar 2 — P2P
  mkEntry('p2p_basics',        'Что такое P2P простыми словами',              2, 5),
  mkEntry('p2p_step_by_step',  'P2P-сделка по шагам',                        2, 6),
  mkEntry('p2p_escrow',        'Эскроу: как биржа защищает',                  2, 7),
  mkEntry('p2p_vs_exchangers', 'P2P vs обменники',                           2, 8),
  mkEntry('p2p_limits_fees',   'Лимиты и комиссии в P2P',                    2, 9),
  // Pillar 3 — Безопасность
  mkEntry('p2p_scams',          'Как не попасть на скам в P2P',              3, 10),
  mkEntry('setup_2fa',          '2FA: зачем и как включить',                 3, 11),
  mkEntry('antiphishing_code',  'Антифишинг-код',                            3, 12),
  mkEntry('whitelist_addresses','Белый список адресов вывода',                3, 13),
  mkEntry('scam_seller_signs',  'Признаки мошеннического продавца',          3, 14),
  // Pillar 4 — Биржи
  mkEntry('best_exchanges_kz',  'Как выбрать биржу',                         4, 15),
  mkEntry('what_is_kyc',        'Что такое KYC',                             4, 16),
  mkEntry('spot_vs_p2p',        'Спот vs P2P',                               4, 17),
  mkEntry('exchange_fees',      'Комиссии бирж',                             4, 18),
  mkEntry('exchange_reliability','Надёжность и резервы биржи',               4, 19),
  // Pillar 5 — KZT / Kaspi (evidence D, high-risk)
  mkEntry('buy_usdt_kzt',       'Как покупают USDT за тенге',                5, 20, { highRisk: true }),
  mkEntry('kz_payment_methods', 'Способы оплаты в KZ (Kaspi/Halyk/Freedom)',5, 21, { highRisk: true }),
  mkEntry('p2p_rate_explained', 'Почему P2P-курс ≠ биржевой',               5, 22),
  mkEntry('kz_crypto_tax',      'Налоги и крипта в KZ (общее)',              5, 23, { highRisk: true }),
  mkEntry('kzt_payment_mistakes','Частые ошибки при оплате тенге',           5, 24, { highRisk: true }),
  // Pillar 6 — Скам
  mkEntry('top5_scam_schemes',  'Топ-5 схем развода',                        6, 25),
  mkEntry('fake_managers',      'Фейковые «менеджеры» и поддержка',          6, 26),
  mkEntry('too_good_rate',      '«Слишком выгодный курс»',                   6, 27),
  mkEntry('prepayment_scam',    'Скам с предоплатой',                        6, 28),
  mkEntry('verify_project',     'Как проверить продавца/проект',             6, 29),
  // Pillar 7 — Новости
  mkEntry('weekly_digest',       'Дайджест недели (формат)',                 7, 30),
  mkEntry('read_news_critically','Как читать крипто-новости критически',     7, 31),
  mkEntry('fud_and_fomo',        'FUD и FOMO',                               7, 32),
  mkEntry('trust_sources',       'Кому можно доверять',                      7, 33),
  mkEntry('why_factcheck',       'Почему мы проверяем факты',                7, 34),
  // Pillar 8 — Beginner education
  mkEntry('crypto_from_zero',    'Крипта с нуля',                            8, 35),
  mkEntry('wallet_vs_exchange',  'Кошелёк vs биржа',                         8, 36),
  mkEntry('seed_phrase_basics',  'Сид-фраза: что это',                       8, 37),
  mkEntry('gas_fees_simple',     'Газ и комиссии простыми словами',          8, 38),
  mkEntry('beginner_mistakes',   'Частые ошибки новичка',                    8, 39),
  // Pillar 9 — Exchange comparisons
  mkEntry('exchange_overview',   'Bybit/Binance/OKX — обзор (не рейтинг)',  9, 40),
  mkEntry('compare_exchanges',   'Как сравнивать биржи правильно',           9, 41),
  mkEntry('p2p_liquidity',       'P2P-ликвидность',                          9, 42),
  mkEntry('mobile_apps_review',  'Мобильные приложения',                     9, 43),
  mkEntry('support_verification','Поддержка и верификация',                  9, 44),
  // Pillar 10 — Regulation (high-risk)
  mkEntry('kz_regulation',       'Регулирование крипты в KZ (что известно)',10, 45, { highRisk: true }),
  mkEntry('afsa_licenses',       'AFSA и лицензии простыми словами',        10, 46, { highRisk: true }),
  mkEntry('kyc_aml_why',         'Зачем KYC/AML',                           10, 47),
  mkEntry('crypto_legal_kz',     'Легально ли владеть криптой в KZ',        10, 48, { highRisk: true }),
  mkEntry('kz_taxes_general',    'Налоги: общая информация',                10, 49, { highRisk: true }),
  // Pillar 11 — Wallets
  mkEntry('hot_vs_cold',         'Горячие vs холодные кошельки',            11, 50),
  mkEntry('custodial_noncustodial','Custodial vs non-custodial',            11, 51),
  mkEntry('first_wallet',        'Первый кошелёк',                          11, 52),
  mkEntry('seed_safe_storage',   'Безопасное хранение сид-фразы',          11, 53),
  mkEntry('hardware_wallets',    'Аппаратные кошельки',                     11, 54),
  // Pillar 12 — Crypto basics
  mkEntry('what_is_blockchain',  'Что такое блокчейн',                      12, 55),
  mkEntry('token_vs_coin',       'Токен vs монета',                         12, 56),
  mkEntry('gas_network_fee',     'Газ/комиссия сети',                       12, 57),
  mkEntry('volatility_explained','Волатильность',                           12, 58),
  mkEntry('what_is_stablecoin',  'Что такое стейблкоин',                    12, 59),
];

// Lookups
const ROADMAP_BY_KEY = new Map(ROADMAP.map(e => [e.topicKey, e]));
export const roadmapEntry = (key: string): RoadmapEntry | undefined => ROADMAP_BY_KEY.get(key);
export const pillarForTopic = (key: string): number | null => ROADMAP_BY_KEY.get(key)?.pillarId ?? null;

// ── Scheduling (Asia/Almaty UTC+5) ─────────────────────────────────────────

function toKzComponents(utc: Date): { year: number; month: number; day: number; hour: number; dayOfWeek: number } {
  const kz = new Date(utc.getTime() + KZ_OFFSET_MS);
  return { year: kz.getUTCFullYear(), month: kz.getUTCMonth(), day: kz.getUTCDate(), hour: kz.getUTCHours(), dayOfWeek: kz.getUTCDay() };
}

/** Is the date a weekend in KZ? */
export function isWeekendKz(utc: Date): boolean {
  const d = toKzComponents(utc).dayOfWeek;
  return d === 0 || d === 6;
}

/** Is it quiet hours (00:00-07:00 KZ local)? */
export function isQuietHoursKz(utc: Date): boolean {
  return toKzComponents(utc).hour < 7;
}

/**
 * Default publish time (UTC) for a date.
 * Weekday: 19:30 KZ = 14:30 UTC. Weekend: 12:30 KZ = 07:30 UTC.
 */
export function getPublishTimeUtc(date: Date): Date {
  const kz = toKzComponents(date);
  const weekend = kz.dayOfWeek === 0 || kz.dayOfWeek === 6;
  const hour = weekend ? 12 : 19;
  const kzTime = Date.UTC(kz.year, kz.month, kz.day, hour, 30, 0, 0);
  return new Date(kzTime - KZ_OFFSET_MS);
}

/** Next publish slot at or after `from`. Advances to tomorrow if today's passed. */
export function nextPublishSlot(from: Date): Date {
  let slot = getPublishTimeUtc(from);
  if (slot.getTime() <= from.getTime()) {
    slot = getPublishTimeUtc(new Date(from.getTime() + MS_PER_DAY));
  }
  return slot;
}

/** Day-of-week → preferred pillar ids (CONTENT_ROADMAP §2 weekly rotation). */
const WEEKLY_PILLAR_MAP: Record<number, number[]> = {
  1: [8, 12], // Mon → Beginner, Crypto basics
  2: [2],     // Tue → P2P
  3: [3, 6],  // Wed → Safety, Scam
  4: [4, 9],  // Thu → Exchanges, Exchange comparisons
  5: [1, 5],  // Fri → USDT, KZT/Kaspi
  6: [7],     // Sat → News
  0: [11, 8], // Sun → Wallets, Beginner
};

function preferredPillarsForDate(utc: Date): number[] {
  return WEEKLY_PILLAR_MAP[toKzComponents(utc).dayOfWeek] ?? [];
}

// ── Selector ───────────────────────────────────────────────────────────────

export interface SelectionContext {
  allPosts: ChannelPost[];
  forDate?: Date;
}

const EDUCATION_TYPES = new Set<ContentPostType>(['education', 'checklist']);
const SAFETY_TYPES = new Set<ContentPostType>(['p2p_safety']);

export function isEducationType(t: ContentPostType): boolean { return EDUCATION_TYPES.has(t); }
export function isSafetyType(t: ContentPostType): boolean { return SAFETY_TYPES.has(t); }

/**
 * Select the best next post from the roadmap.
 * Enforces: 21-day topic dedup, no back-to-back pillar, visual diversity,
 * high-risk evidence gate, ratio balance, day-of-week preference.
 */
export function selectNext(ctx: SelectionContext): RoadmapEntry | null {
  const now = ctx.forDate ?? new Date();
  const cutoff21d = new Date(now.getTime() - DEDUP_WINDOW_DAYS * MS_PER_DAY);
  const cutoff14d = new Date(now.getTime() - RATIO_WINDOW_DAYS * MS_PER_DAY);

  const active = ctx.allPosts
    .filter(p => p.status !== 'rejected')
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  // 21-day topic dedup
  const usedTopics = new Set(
    active.filter(p => p.createdAt > cutoff21d.toISOString()).map(p => p.topic),
  );

  // Back-to-back pillar
  const lastPillar = active[0] ? pillarForTopic(active[0].topic) : null;

  // Visual diversity: last 2 image themes
  const recentThemes = active.slice(0, 2)
    .map(p => ROADMAP_BY_KEY.get(p.topic)?.imageTheme)
    .filter((t): t is string => !!t);

  // 14-day ratio tracking
  const recent14d = active.filter(p => p.createdAt > cutoff14d.toISOString());
  const total14d = Math.max(recent14d.length, 1);
  const educationRatio = recent14d.filter(p => isEducationType(p.postType)).length / total14d;
  const safetyRatio = recent14d.filter(p => isSafetyType(p.postType)).length / total14d;

  const preferred = preferredPillarsForDate(now);

  type Scored = { entry: RoadmapEntry; score: number };
  const scored: Scored[] = [];

  for (const entry of ROADMAP) {
    if (usedTopics.has(entry.topicKey)) continue;
    if (entry.pillarId === lastPillar) continue;
    if (recentThemes.length >= 2 && recentThemes.slice(0, 2).includes(entry.imageTheme)) continue;
    // High-risk with evidence D → blocked from auto-queue
    if (entry.highRisk && (entry.evidenceLevel === 'D' || entry.evidenceLevel === 'E')) continue;

    let score = 100 - entry.order * (100 / ROADMAP.length);
    if (preferred.includes(entry.pillarId)) score += 25;
    if (pillarById(entry.pillarId)?.core) score += 10;
    if (educationRatio < TARGET_EDUCATION_RATIO && isEducationType(entry.postType)) score += 20;
    if (safetyRatio < TARGET_SAFETY_RATIO && isSafetyType(entry.postType)) score += 15;
    if (entry.hasTemplate) score += 5;

    scored.push({ entry, score });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].entry;
}

/**
 * Project 7 days of posts. Simulates the selector day by day so that each
 * pick informs the next day's constraints. Returns entries with publish times.
 */
export function selectWeek(
  allPosts: ChannelPost[],
  startDate?: Date,
): Array<{ date: Date; publishTime: Date; entry: RoadmapEntry | null }> {
  const start = startDate ?? new Date();
  const result: Array<{ date: Date; publishTime: Date; entry: RoadmapEntry | null }> = [];
  const simulated: ChannelPost[] = [...allPosts];

  for (let i = 0; i < 7; i++) {
    const date = new Date(start.getTime() + i * MS_PER_DAY);
    const publishTime = getPublishTimeUtc(date);
    const entry = selectNext({ allPosts: simulated, forDate: date });

    if (entry) {
      simulated.push({
        id: `sim_${i}`, title: entry.title, caption: '', assetFile: null,
        topic: entry.topicKey, postType: entry.postType, evidenceLevel: entry.evidenceLevel,
        imagePrompt: null, requiresImage: true, status: 'planned',
        createdBy: 'scheduler', createdAt: date.toISOString(), scheduledAt: publishTime.toISOString(),
        approvedBy: null, decidedAt: null, publishedAt: null,
        channelMessageId: null, rejectionReason: null,
      });
    }
    result.push({ date, publishTime, entry });
  }

  return result;
}

// ── Queue generator ────────────────────────────────────────────────────────

export interface QueueResult {
  created: ChannelPost[];
  skipped: string[];
}

/**
 * Generate planned posts for the next N days and persist them.
 * Idempotent: skips dates that already have a scheduled post.
 * Posts are created with status `planned` and `scheduledAt` set.
 */
export function generateQueue(
  store: ChannelPostStore,
  days: number = 7,
  opts: { startDate?: Date; createdBy?: string } = {},
): QueueResult {
  const start = opts.startDate ?? new Date();
  const by = opts.createdBy ?? 'scheduler';
  const result: QueueResult = { created: [], skipped: [] };
  const simulated = [...store.all()];

  for (let i = 0; i < days; i++) {
    const date = new Date(start.getTime() + i * MS_PER_DAY);
    const publishTime = getPublishTimeUtc(date);
    const dateStr = publishTime.toISOString().slice(0, 10);

    // Already have a non-rejected post for this date?
    if (simulated.some(p => p.scheduledAt?.slice(0, 10) === dateStr && p.status !== 'rejected')) {
      result.skipped.push(`existing_${dateStr}`);
      continue;
    }

    const entry = selectNext({ allPosts: simulated, forDate: date });
    if (!entry) continue;

    const post = store.createFull('', by, {
      title: entry.title,
      topic: entry.topicKey,
      postType: entry.postType,
      evidenceLevel: entry.evidenceLevel,
      requiresImage: true,
      scheduledAt: publishTime.toISOString(),
    }, date);
    store.update(post.id, { status: 'planned' as ChannelPostStatus });
    const saved = store.get(post.id)!;
    result.created.push(saved);
    simulated.push(saved);
  }

  logger.audit('roadmap_scheduler', `Queue: ${result.created.length} planned, ${result.skipped.length} skipped`, { days });
  return result;
}

/**
 * Generate the next single post: select topic → generate caption + image
 * (if template exists) → store as ready/planned. Never publishes.
 */
export async function generateNextPost(
  store: ChannelPostStore,
  opts: { provider?: ImageProvider; assetDir?: string; createdBy?: string; forDate?: Date } = {},
): Promise<ChannelPost | null> {
  const now = opts.forDate ?? new Date();
  const entry = selectNext({ allPosts: store.all(), forDate: now });
  if (!entry) return null;

  const by = opts.createdBy ?? 'scheduler';
  const publishTime = getPublishTimeUtc(now);

  // If a content-machine template exists, generate the full post
  if (entry.hasTemplate && TOPICS[entry.topicKey]) {
    const draft = generateContentDraft(entry.topicKey);
    if (draft.safetyViolations.length > 0) {
      logger.warn('roadmap_scheduler', `Safety block for ${entry.topicKey}: ${draft.safetyViolations.join('; ')}`);
      return null;
    }

    const post = store.createFull(draft.caption, by, {
      title: draft.title,
      topic: draft.topic,
      postType: draft.postType,
      evidenceLevel: draft.evidenceLevel,
      requiresImage: true,
      scheduledAt: publishTime.toISOString(),
    });

    const img = await resolveImage(entry.topicKey, draft.title, draft.postType, {
      provider: opts.provider, assetDir: opts.assetDir,
    });
    store.update(post.id, { imagePrompt: img.prompt, assetFile: img.imageFile });
    if (img.imageFile) store.markReady(post.id, opts.assetDir);
    return store.get(post.id)!;
  }

  // No template — create as planned stub (needs caption generation later)
  const post = store.createFull('', by, {
    title: entry.title,
    topic: entry.topicKey,
    postType: entry.postType,
    evidenceLevel: entry.evidenceLevel,
    requiresImage: true,
    scheduledAt: publishTime.toISOString(),
  });
  store.update(post.id, { status: 'planned' as ChannelPostStatus });
  return store.get(post.id)!;
}

// ── Safety ─────────────────────────────────────────────────────────────────

/** High-risk = regulation, Kaspi/KZT, or explicitly marked. */
export function isHighRiskEntry(entry: RoadmapEntry): boolean {
  return entry.highRisk;
}

/**
 * Auto-publish pre-condition check (CONTENT_ROADMAP §10).
 * Returns false unless the autopublish toggle is explicitly enabled.
 * Even when enabled, high-risk topics with weak evidence are blocked.
 */
export function canAutoPublish(entry: RoadmapEntry, autopublishEnabled: boolean = false): boolean {
  if (!autopublishEnabled) return false;
  if (entry.highRisk) return false;
  if (entry.evidenceLevel === 'D' || entry.evidenceLevel === 'E') return false;
  return true;
}

// ── Report ─────────────────────────────────────────────────────────────────

export interface SchedulerReport {
  generatedAt: string;
  nextPost: RoadmapEntry | null;
  nextPublishTime: string;
  queue: Array<{ id: string; title: string; topic: string; status: ChannelPostStatus; scheduledAt: string | null }>;
  ratios: { education: number; safety: number; news: number };
  roadmapProgress: { total: number; used: number; remaining: number };
  highRiskBlocked: number;
}

export function schedulerReport(posts: ChannelPost[], now: Date = new Date()): SchedulerReport {
  const active = posts.filter(p => p.status !== 'rejected');
  const cutoff14d = new Date(now.getTime() - RATIO_WINDOW_DAYS * MS_PER_DAY);
  const recent = active.filter(p => p.createdAt > cutoff14d.toISOString());
  const total = Math.max(recent.length, 1);

  const usedTopics = new Set(active.map(p => p.topic));
  const highRiskBlocked = ROADMAP.filter(e =>
    isHighRiskEntry(e) && (e.evidenceLevel === 'D' || e.evidenceLevel === 'E') && !usedTopics.has(e.topicKey),
  ).length;

  return {
    generatedAt: now.toISOString(),
    nextPost: selectNext({ allPosts: posts, forDate: now }),
    nextPublishTime: nextPublishSlot(now).toISOString(),
    queue: posts
      .filter(p => ['planned', 'draft', 'ready', 'approved'].includes(p.status))
      .sort((a, b) => (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt))
      .map(p => ({ id: p.id, title: p.title, topic: p.topic, status: p.status, scheduledAt: p.scheduledAt })),
    ratios: {
      education: recent.filter(p => isEducationType(p.postType)).length / total,
      safety: recent.filter(p => isSafetyType(p.postType)).length / total,
      news: recent.filter(p => p.postType === 'news').length / total,
    },
    roadmapProgress: {
      total: ROADMAP.length,
      used: ROADMAP.filter(e => usedTopics.has(e.topicKey)).length,
      remaining: ROADMAP.filter(e => !usedTopics.has(e.topicKey)).length,
    },
    highRiskBlocked,
  };
}

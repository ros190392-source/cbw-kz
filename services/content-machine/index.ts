import { logger } from '../../src/logger';
import {
  ChannelPost,
  ContentMachineReport,
  ContentPostType,
  DailyContentPlan,
  EvidenceLevel,
} from '../../src/types';
import { ChannelPostStore, validateContentSafety } from '../content-center';
import { ImageProvider, generatePremiumTelegramImage } from '../image-generator';

/**
 * Autonomous content machine (EPIC 016).
 *
 * Generates Telegram post drafts (caption + image) from a topic plan, runs the
 * safety/honesty validator on every draft, and routes them through the existing
 * human-gated publish flow. NOTHING publishes automatically — the machine only
 * prepares drafts and previews; an admin must /approve_publish.
 *
 * Captions are deterministic, education-first, and carry caveats by design.
 * Pure helpers are exported for testing.
 */

// ── Topic registry (safe, education-first templates) ─────────────────────────

export interface TopicDef {
  key: string;
  title: string;
  postType: ContentPostType;
  evidenceLevel: EvidenceLevel | null;
  caption: string;
}

const DISCLAIMER = 'ℹ️ Это образовательный материал, не финансовая рекомендация. Условия и доступность сервисов могут меняться — всегда проверяйте информацию внутри биржи.';

export const TOPICS: Record<string, TopicDef> = {
  usdt_basics: {
    key: 'usdt_basics', title: 'Что такое USDT', postType: 'education', evidenceLevel: 'C',
    caption:
      '💵 Что такое USDT\n\n' +
      'USDT — это стейблкоин: цифровой токен, курс которого обычно привязан к доллару США (≈1 USDT ≈ 1 USD).\n\n' +
      'Зачем он нужен:\n— хранение средств в «долларовом» эквиваленте\n— переводы между кошельками и биржами\n— расчёты в P2P-сделках\n— снижение влияния волатильности\n\n' +
      DISCLAIMER + '\n\n#USDT #Крипта #Образование',
  },
  p2p_basics: {
    key: 'p2p_basics', title: 'Что такое P2P', postType: 'education', evidenceLevel: 'C',
    caption:
      '🤝 Что такое P2P\n\n' +
      'P2P (peer-to-peer) — это обмен напрямую между людьми через площадку биржи. Биржа выступает гарантом сделки и держит крипту в escrow до подтверждения оплаты.\n\n' +
      'Как обычно выглядит покупка:\n— выбираете объявление и способ оплаты\n— переводите деньги продавцу\n— продавец/биржа отпускает крипту после подтверждения\n\n' +
      DISCLAIMER + '\n\n#P2P #Крипта #Образование',
  },
  p2p_scams: {
    key: 'p2p_scams', title: 'Как не попасть на скам в P2P', postType: 'p2p_safety', evidenceLevel: 'C',
    caption:
      '🛡 Как не попасть на скам в P2P\n\n' +
      'Базовые правила безопасности:\n' +
      '— проводите сделку только внутри биржи, не уходите в личные чаты\n' +
      '— не отпускайте крипту, пока не увидели поступление денег на свой счёт\n' +
      '— проверяйте имя отправителя платежа\n— остерегайтесь «слишком выгодных» курсов\n— не сообщайте коды из SMS и не переходите по сторонним ссылкам\n\n' +
      DISCLAIMER + '\n\n#P2P #Безопасность',
  },
  choose_seller: {
    key: 'choose_seller', title: 'Как выбрать продавца в P2P', postType: 'checklist', evidenceLevel: 'C',
    caption:
      '✅ Как выбрать продавца в P2P\n\n' +
      'На что смотреть:\n— рейтинг и процент успешных сделок\n— количество завершённых ордеров\n— срок регистрации аккаунта\n— чёткие условия и адекватные лимиты\n— скорость ответа в чате\n\n' +
      'Начинайте с небольшой суммы, если торгуете с продавцом впервые.\n\n' +
      DISCLAIMER + '\n\n#P2P #Чеклист',
  },
  best_exchanges_kz: {
    key: 'best_exchanges_kz', title: 'Биржи с P2P, популярные в Казахстане', postType: 'exchange_update', evidenceLevel: 'D',
    caption:
      '🏦 Биржи с P2P, популярные среди пользователей из Казахстана\n\n' +
      'Среди крупных площадок с P2P часто упоминают Bybit, Binance и OKX. Это примеры для ознакомления, а не рейтинг и не рекомендация.\n\n' +
      'Перед использованием обязательно проверяйте: доступность для вашего региона, поддерживаемые способы оплаты (Kaspi/Halyk/Freedom) и текущие лимиты — всё это может меняться.\n\n' +
      DISCLAIMER + '\n\n#Биржи #P2P #Казахстан',
  },
};

export const FIRST_PACK: string[] = ['usdt_basics', 'p2p_basics', 'p2p_scams', 'choose_seller', 'best_exchanges_kz'];

// ── Generator ────────────────────────────────────────────────────────────────

export interface GeneratedDraft {
  title: string;
  caption: string;
  topic: string;
  postType: ContentPostType;
  evidenceLevel: EvidenceLevel | null;
  safetyViolations: string[];
}

/** Build a draft for a topic key. Runs the safety validator (templates are safe). */
export function generateContentDraft(topicKey: string): GeneratedDraft {
  const def = TOPICS[topicKey];
  if (!def) throw new Error(`Unknown topic: ${topicKey}`);
  return {
    title: def.title,
    caption: def.caption,
    topic: def.key,
    postType: def.postType,
    evidenceLevel: def.evidenceLevel,
    safetyViolations: validateContentSafety(`${def.title} ${def.caption}`),
  };
}

// ── Image pipeline (delegates to the premium image-generator, EPIC 017) ──────

export interface ImageResult {
  imageFile: string | null;
  prompt: string;
  generated: boolean;
  usedFallback: boolean;
}

/**
 * Resolve a premium image for a draft via the image-generator service: try the
 * configured provider (fal.ai / OpenAI), else fall back to the deterministic
 * template image. Never fabricates — null means no image is available yet.
 */
export async function resolveImage(
  topicKey: string,
  title: string,
  _postType: ContentPostType,
  opts: { provider?: ImageProvider; assetDir?: string } = {},
): Promise<ImageResult> {
  const r = await generatePremiumTelegramImage(topicKey, title, 'premium_dark', {
    provider: opts.provider,
    assetDir: opts.assetDir,
  });
  const have = r.generated || r.usedFallback;
  return { imageFile: have ? r.filename : null, prompt: r.prompt, generated: r.generated, usedFallback: r.usedFallback };
}

// ── First pack / pack generation ─────────────────────────────────────────────

export interface PackResult {
  created: ChannelPost[];
  skipped: string[]; // topic keys that already had a draft
  missingImages: string[]; // topic keys with no image resolved
}

/**
 * Generate (idempotently) the drafts for the given topic keys. Each draft is
 * created, an image is resolved (generator → fallback), and the draft is marked
 * `ready` if it passes validation. Nothing is published.
 */
export async function generateContentPack(
  store: ChannelPostStore,
  topicKeys: string[] = FIRST_PACK,
  opts: { provider?: ImageProvider; assetDir?: string; createdBy?: string; now?: Date } = {},
): Promise<PackResult> {
  const result: PackResult = { created: [], skipped: [], missingImages: [] };
  for (const key of topicKeys) {
    if (store.byTopic(key)) { result.skipped.push(key); continue; }
    const draft = generateContentDraft(key);
    const post = store.createFull(
      draft.caption,
      opts.createdBy ?? 'machine',
      { title: draft.title, topic: draft.topic, postType: draft.postType, evidenceLevel: draft.evidenceLevel, requiresImage: true },
      opts.now,
    );
    const img = await resolveImage(key, draft.title, draft.postType, { provider: opts.provider, assetDir: opts.assetDir });
    store.update(post.id, { imagePrompt: img.prompt, assetFile: img.imageFile });
    if (!img.imageFile) result.missingImages.push(key);
    else store.markReady(post.id, opts.assetDir); // only succeeds if safe + valid
    result.created.push(store.get(post.id)!);
  }
  logger.audit('content_machine_pack', `Generated ${result.created.length} draft(s)`, {
    skipped: result.skipped.length, missingImages: result.missingImages.length,
  });
  return result;
}

// ── Scheduler + report ───────────────────────────────────────────────────────

/** A simple daily plan covering the five post types from the first pack. */
export function dailyPlan(now: Date = new Date()): DailyContentPlan {
  return {
    date: now.toISOString().slice(0, 10),
    items: FIRST_PACK.map((key) => ({ postType: TOPICS[key].postType, topicKey: key, title: TOPICS[key].title })),
  };
}

const sameUtcDay = (iso: string | null, now: Date) => !!iso && iso.slice(0, 10) === now.toISOString().slice(0, 10);

export function contentMachineReport(posts: ChannelPost[], plan: DailyContentPlan, now: Date = new Date()): ContentMachineReport {
  const counts = { draft: 0, ready: 0, approved: 0, published: 0, rejected: 0 };
  let publishedToday = 0;
  let rejectedToday = 0;
  const pending: ContentMachineReport['pending'] = [];
  const missingImages: ContentMachineReport['missingImages'] = [];

  for (const p of posts) {
    counts[p.status]++;
    if (p.status === 'published' && sameUtcDay(p.publishedAt, now)) publishedToday++;
    if (p.status === 'rejected' && sameUtcDay(p.decidedAt, now)) rejectedToday++;
    if (p.status === 'draft' || p.status === 'ready' || p.status === 'approved') {
      pending.push({ id: p.id, title: p.title || p.topic, status: p.status });
    }
    if (p.requiresImage && !p.assetFile && p.status !== 'rejected' && p.status !== 'published') {
      missingImages.push({ id: p.id, title: p.title || p.topic });
    }
  }

  const presentTypes = new Set(posts.filter((p) => p.status !== 'rejected').map((p) => p.postType));
  const gaps = [...new Set(plan.items.map((i) => i.postType))].filter((t) => !presentTypes.has(t));

  return { generatedAt: now.toISOString(), plan, counts, publishedToday, rejectedToday, pending, missingImages, gaps };
}

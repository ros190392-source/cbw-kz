import TelegramBot from 'node-telegram-bot-api';
import { config } from '../../config';
import { buildPipeline } from '../../src/pipeline';
import { TelegramSender } from '../../services/telegram-sender';
import { DraftStore } from '../../src/draft-store';
import { approveDraft, rejectDraft } from '../../src/moderation-actions';
import { AnalyticsStore } from '../../services/analytics-layer';
import { buildReport, formatReport, formatTop } from '../../services/reporting-engine';
import { ExchangeRegistry, BonusStore } from '../../services/exchange-registry';
import {
  formatExchanges,
  formatBonuses,
  formatLaunchpools,
} from '../../services/exchange-registry/format';
import { GeoEngine } from '../../services/geo-engine';
import { formatLocales, formatGeoExpansion } from '../../services/locale-engine/format';
import { VerificationStore, staleClaims } from '../../services/verification-engine';
import { buildPlan, backlog, PlannerInputs } from '../../services/editorial-planner';
import { formatPlan, formatBacklog } from '../../services/editorial-planner/format';
import {
  formatVerify,
  formatConfidence,
  formatStale,
  formatEvidence,
} from '../../services/verification-engine/format';
import { RssParser } from '../../services/rss-parser';
import { SOURCES } from '../../config/sources';
import { ResearchSnapshot, SuggestionType } from '../../src/types';
import { buildSnapshot } from '../../services/research-engine/snapshot';
import {
  formatResearch,
  formatTrends,
  formatDiscoveries,
  formatSignals,
} from '../../services/research-engine/format';
import { buildOptimization, OptimizationStore } from '../../services/optimization-engine';
import {
  formatInsights,
  formatSuggestions,
  formatLearn,
} from '../../services/optimization-engine/format';
import {
  WorkflowStore,
  fromPlannerTopics,
  fromResearchFindings,
  fromOptimizationSuggestions,
  manualIdea,
  reviewSummary,
} from '../../services/editorial-workflow';
import {
  formatQueue,
  formatReview,
  formatNext,
  formatAdded,
} from '../../services/editorial-workflow/format';
import { generateDraft, generateLocalizedDraft, ContentRequest } from '../../services/content-engine';
import {
  formatDraft,
  formatOutline,
  formatSeo,
  formatLocalized,
} from '../../services/content-engine/format';
import { buildOperatorReport, OperatorInputs } from '../../services/operator-engine';
import {
  formatOperator,
  formatToday,
  formatBlocked,
  formatHealth,
} from '../../services/operator-engine/format';
import { checkRuntimeHealth, healthInputsFromConfig } from '../../services/runtime-health';
import {
  formatHealthReport,
  formatRuntimeStatus,
  formatBackupResult,
} from '../../services/runtime-health/format';
import { AdminAlerts } from '../../services/admin-alerts';
import { BackupEngine } from '../../services/backup-engine';
import { buildSnapshotFromGit, evaluatePr } from '../../services/merge-guardian';
import {
  formatGuardian,
  formatPrRisk,
  formatSafeToMerge,
} from '../../services/merge-guardian/format';
import { ScreenshotRegistry } from '../../services/screenshot-registry';
import { seedManuals, missingEvidenceQueue } from '../../services/evidence-system';
import {
  formatEvidenceLevels,
  formatScreenshots,
  formatMissingEvidence,
  formatManualTrust,
} from '../../services/evidence-system/format';
import {
  buildGeoManual,
  buildGuideMatrix,
  findStep,
  testerTasksForManuals,
  GUIDE_GEOS,
} from '../../services/manual-builder';
import {
  formatManual,
  formatManualStep,
  formatGuideStatus,
  formatTesterTasks,
} from '../../services/manual-builder/format';
import { TesterRegistry, SubmissionStore, assignTasks } from '../../services/local-tester';
import {
  formatTesters,
  formatAssignments,
  formatSubmissionReview,
  formatTesterScore,
} from '../../services/local-tester/format';
import { DraftType, GuideTopic } from '../../src/types';
import { logger } from '../../src/logger';
import http from 'http';

/**
 * Long-running Telegram bot — the main runtime for Phase 01.
 *
 * Responsibilities:
 *  - run the pipeline on an interval (and on demand via /run),
 *  - deliver drafts to the moderation chat,
 *  - on a MANUAL Approve click → publish the post to the configured channel,
 *  - on a MANUAL Reject click → mark the draft rejected.
 *
 * There is NO automatic, scheduled, or AI-initiated publishing. A human admin
 * must click Approve for anything to reach the public channel.
 *
 * Commands (in the moderation chat):
 *   /start  — register the chat and print its id
 *   /status — show config + chat id
 *   /run    — trigger a pipeline run immediately
 */
function requireEnv(): void {
  if (!config.telegram.botToken) {
    logger.error('bot', 'TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
}

async function main() {
  requireEnv();

  const bot = new TelegramBot(config.telegram.botToken, { polling: true });
  const sender = new TelegramSender(bot, config.telegram.moderationChatId);
  const pipeline = buildPipeline(sender);
  const drafts = new DraftStore();
  const analytics = new AnalyticsStore();
  const exchanges = new ExchangeRegistry();
  const bonuses = new BonusStore();
  const geo = new GeoEngine(exchanges.all());
  const verifications = new VerificationStore(exchanges.all());
  const optimization = new OptimizationStore();
  const workflow = new WorkflowStore();
  const researchParser = new RssParser(SOURCES);
  let researchCache: { snap: ResearchSnapshot; at: number } | null = null;
  let running = false;

  // Runtime layer (EPIC 011): alerts (notification-only) + backups + health state.
  const alerts = new AdminAlerts(config.runtime.alertsEnabled, (text) =>
    config.telegram.moderationChatId
      ? bot.sendMessage(config.telegram.moderationChatId, text, { parse_mode: 'HTML' }).then(() => undefined)
      : Promise.resolve(),
  );
  const backupEngine = new BackupEngine();
  const screenshots = new ScreenshotRegistry();
  const testers = new TesterRegistry();
  const submissions = new SubmissionStore();
  testers.seed(); // honest example testers on first run (idempotent)
  let lastPipelineRun: string | null = null;
  let lastError: string | null = null;

  // Build (or reuse, 5-min TTL) a read-only research snapshot from live feeds.
  async function getSnapshot(): Promise<ResearchSnapshot> {
    const TTL = 5 * 60 * 1000;
    if (researchCache && Date.now() - researchCache.at < TTL) return researchCache.snap;
    const items = await researchParser.fetchAll();
    const snap = buildSnapshot(items, analytics.all(), {
      exchanges: exchanges.all(),
      bonuses: bonuses.all(),
    });
    researchCache = { snap, at: Date.now() };
    return snap;
  }

  // Guard against rapid repeated Approve clicks while a publish is in flight.
  const inFlight = new Set<string>();

  const isModerationChat = (chatId?: number | string) =>
    !!config.telegram.moderationChatId && String(chatId) === String(config.telegram.moderationChatId);
  const isAdmin = (userId?: number) =>
    !!userId && config.telegram.adminIds.includes(userId);

  async function runOnce(notifyChatId?: number | string) {
    if (running) {
      if (notifyChatId) await bot.sendMessage(notifyChatId, '⏳ A run is already in progress.');
      return;
    }
    running = true;
    try {
      const stats = await pipeline.run();
      lastPipelineRun = new Date().toISOString();
      if (notifyChatId) {
        await bot.sendMessage(notifyChatId, `✅ Run complete\n<pre>${JSON.stringify(stats, null, 2)}</pre>`, {
          parse_mode: 'HTML',
        });
      }
    } catch (err) {
      lastError = (err as Error).message;
      logger.error('bot', `Pipeline run failed: ${lastError}`);
      // Notification-only alert — does not change pipeline/publish behaviour.
      void alerts.send('pipeline_error', 'Pipeline run failed', { error: lastError });
      if (notifyChatId) await bot.sendMessage(notifyChatId, `❌ Run failed: ${lastError}`);
    } finally {
      running = false;
    }
  }

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      [
        '👋 <b>CBW KZ moderation bot</b> is online.',
        `This chat id: <code>${msg.chat.id}</code>`,
        '',
        'Set <code>TELEGRAM_MODERATION_CHAT_ID</code> to this id in your .env to receive drafts here.',
        'Commands: /status, /run, /report, /weekly, /top, /exchanges, /bonuses, /launchpool, /geo kz, /verify, /confidence, /stale, /evidence, /locales, /plan, /weekplan, /backlog, /research, /trends, /discoveries, /signals, /insights, /suggestions, /learn, /queue, /queue_add, /review, /next, /draft, /outline, /seo, /localized, /operator, /today, /blocked, /health, /health_runtime, /backup, /runtime_status, /merge_guardian, /pr_risk, /safe_to_merge, /evidence_levels, /screenshots, /missing_evidence, /manual_trust',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.onText(/\/status/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      [
        '⚙️ <b>Status</b>',
        `Chat id: <code>${msg.chat.id}</code>`,
        `Moderation chat: <code>${config.telegram.moderationChatId || '(unset)'}</code>`,
        `Publish channel: <code>${config.telegram.channelId || '(unset)'}</code>`,
        `Admins: <code>${config.telegram.adminIds.join(', ') || '(none — approvals blocked)'}</code>`,
        `AI model: <code>${config.ai.model}</code> ${config.ai.apiKey ? '(live)' : '(fallback)'}`,
        `Poll interval: ${config.pipeline.pollIntervalMs} ms`,
        `Min score: ${config.pipeline.minScore} · Max/run: ${config.pipeline.maxPerRun}`,
        `Mode: <b>manual draft-only</b> — no auto/scheduled publishing`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.onText(/\/run/, (msg) => {
    bot.sendMessage(msg.chat.id, '🚀 Triggering a pipeline run…');
    void runOnce(msg.chat.id);
  });

  // Analytics commands — restricted to the moderation chat + admins, read-only.
  const reportGate = (msg: TelegramBot.Message): boolean => {
    if (!isModerationChat(msg.chat.id)) return false;
    if (!isAdmin(msg.from?.id)) {
      void bot.sendMessage(msg.chat.id, '⛔ Reports are restricted to admins.');
      return false;
    }
    return true;
  };

  async function sendReport(chatId: number, period: 'daily' | 'weekly') {
    const report = buildReport({ posts: analytics.all(), drafts: drafts.all(), period });
    await bot.sendMessage(chatId, formatReport(report), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  bot.onText(/\/report\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendReport(msg.chat.id, 'daily');
  });

  bot.onText(/\/weekly\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendReport(msg.chat.id, 'weekly');
  });

  bot.onText(/\/top\b/, (msg) => {
    if (!reportGate(msg)) return;
    void bot.sendMessage(msg.chat.id, formatTop(analytics.all()), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  // Monetization intelligence commands (EPIC 002). Read-only, admin-gated.
  const sendHtml = (chatId: number, text: string) =>
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });

  bot.onText(/\/exchanges\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatExchanges(exchanges.all()));
  });

  bot.onText(/\/bonuses\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatBonuses(bonuses.all(), exchanges.all()));
  });

  bot.onText(/\/launchpool\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatLaunchpools(bonuses.all(), exchanges.all()));
  });

  // /geo <country>, defaults to KZ. e.g. "/geo kz", "/geo de", "/geo tr"
  // Locale-aware (EPIC 004): shows supported locales + payments + exchanges.
  bot.onText(/\/geo(?:\s+(\w+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    const country = (match?.[1] ?? 'KZ').toUpperCase();
    void sendHtml(msg.chat.id, formatGeoExpansion(country, geo.profilesFor(country)));
  });

  bot.onText(/\/locales\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatLocales());
  });

  // Verification / trust commands (EPIC 003). Read-only, admin-gated.
  // /verify <slug> — KZ snapshot + per-claim confidence/freshness
  bot.onText(/\/verify(?:\s+(\S+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    const slug = (match?.[1] ?? '').toLowerCase();
    if (!slug) {
      void sendHtml(msg.chat.id, 'Usage: <code>/verify bybit</code>');
      return;
    }
    void sendHtml(msg.chat.id, formatVerify(exchanges.get(slug), verifications.all()));
  });

  bot.onText(/\/confidence\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatConfidence(exchanges.all(), verifications.all()));
  });

  bot.onText(/\/stale\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatStale(staleClaims(verifications.all())));
  });

  // /evidence <slug>
  bot.onText(/\/evidence(?:\s+(\S+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    const slug = (match?.[1] ?? '').toLowerCase();
    if (!slug) {
      void sendHtml(msg.chat.id, 'Usage: <code>/evidence bybit</code>');
      return;
    }
    void sendHtml(msg.chat.id, formatEvidence(slug, verifications.all()));
  });

  // Editorial planning commands (EPIC 005). Read-only recommendations, admin-gated.
  const plannerInputs = (): PlannerInputs => ({
    posts: analytics.all(),
    exchanges: exchanges.all(),
    bonuses: bonuses.all(),
    claims: verifications.all(),
    geo: 'KZ',
  });

  bot.onText(/\/plan\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatPlan(buildPlan(plannerInputs(), 'daily')));
  });

  bot.onText(/\/weekplan\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatPlan(buildPlan(plannerInputs(), 'weekly')));
  });

  bot.onText(/\/backlog\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatBacklog(backlog(plannerInputs())));
  });

  // Research / intelligence commands (EPIC 006). Read-only, admin-gated.
  // They fetch live feeds (cached 5 min) and never write anything.
  async function researchCommand(
    chatId: number,
    render: (snap: ResearchSnapshot) => string,
  ): Promise<void> {
    try {
      await bot.sendMessage(chatId, '🔬 Researching live feeds…');
      const snap = await getSnapshot();
      await sendHtml(chatId, render(snap));
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Research failed: ${(err as Error).message}`);
    }
  }

  bot.onText(/\/research\b/, (msg) => {
    if (!reportGate(msg)) return;
    void researchCommand(msg.chat.id, (s) => formatResearch(s));
  });
  bot.onText(/\/trends\b/, (msg) => {
    if (!reportGate(msg)) return;
    void researchCommand(msg.chat.id, (s) => formatTrends(s));
  });
  bot.onText(/\/discoveries\b/, (msg) => {
    if (!reportGate(msg)) return;
    void researchCommand(msg.chat.id, (s) => formatDiscoveries(s));
  });
  bot.onText(/\/signals\b/, (msg) => {
    if (!reportGate(msg)) return;
    void researchCommand(msg.chat.id, (s) => formatSignals(s));
  });

  // Optimization / learning meta-brain commands (EPIC 007). Read-only, admin-gated.
  // Suggestions only — applying them is a manual, human decision.
  const optimizationSnapshot = () =>
    buildOptimization({ posts: analytics.all(), claims: verifications.all() });

  bot.onText(/\/insights\b/, (msg) => {
    if (!reportGate(msg)) return;
    const snap = optimizationSnapshot();
    optimization.save(snap); // persist the recommendation snapshot (no config change)
    void sendHtml(msg.chat.id, formatInsights(snap));
  });

  // /suggestions [type]
  bot.onText(/\/suggestions(?:\s+(\S+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    const type = (match?.[1] as SuggestionType | undefined) ?? undefined;
    void sendHtml(msg.chat.id, formatSuggestions(optimizationSnapshot(), type));
  });

  bot.onText(/\/learn\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatLearn(optimizationSnapshot()));
  });

  // Editorial workflow / queue commands (EPIC 008). Read + manual-add only.
  // Idempotently seeds the queue from planner + optimization (+ cached research).
  // It NEVER publishes or auto-advances; status changes are explicit human actions.
  function seedWorkflow(): void {
    const items = [
      ...fromPlannerTopics(backlog(plannerInputs())),
      ...fromOptimizationSuggestions(
        buildOptimization({ posts: analytics.all(), claims: verifications.all() }).suggestions,
      ),
    ];
    if (researchCache) items.push(...fromResearchFindings(researchCache.snap.findings.slice(0, 10)));
    workflow.seed(items);
  }

  bot.onText(/\/queue\b/, (msg) => {
    if (!reportGate(msg)) return;
    seedWorkflow();
    void sendHtml(msg.chat.id, formatQueue(workflow.all()));
  });

  // /queue_add <text>
  bot.onText(/\/queue_add(?:\s+([\s\S]+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    const text = (match?.[1] ?? '').trim();
    if (!text) {
      void sendHtml(msg.chat.id, 'Usage: <code>/queue_add Your topic idea</code>');
      return;
    }
    const by = msg.from?.username ?? String(msg.from?.id ?? 'admin');
    void sendHtml(msg.chat.id, formatAdded(workflow.add(manualIdea(text, { by }))));
  });

  bot.onText(/\/review\b/, (msg) => {
    if (!reportGate(msg)) return;
    seedWorkflow();
    void sendHtml(msg.chat.id, formatReview(reviewSummary(workflow.all())));
  });

  bot.onText(/\/next\b/, (msg) => {
    if (!reportGate(msg)) return;
    seedWorkflow();
    void sendHtml(msg.chat.id, formatNext(workflow.all()));
  });

  // Content generation commands (EPIC 009). Read-only PREVIEWS — machine-generated,
  // human-review-required; never published, posted, or auto-approved.
  function contentRequest(type: DraftType, slug?: string): ContentRequest {
    const topics = backlog(plannerInputs());
    let topic = topics[0];
    let exchange = topic?.exchange ? exchanges.get(topic.exchange) : undefined;
    let bonus = exchange ? bonuses.forExchange(exchange.slug)[0] : undefined;
    if (slug) {
      exchange = exchanges.get(slug);
      topic = topics.find((t) => t.exchange === slug) ?? topic;
      bonus = bonuses.forExchange(slug)[0];
    }
    return { type, topic, exchange, bonus, claims: verifications.all(), locale: 'ru-KZ', geo: 'KZ' };
  }

  bot.onText(/\/draft(?:\s+(\S+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatDraft(generateDraft(contentRequest('telegram_post', match?.[1]?.toLowerCase()))));
  });
  bot.onText(/\/outline(?:\s+(\S+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatOutline(generateDraft(contentRequest('article_outline', match?.[1]?.toLowerCase()))));
  });
  bot.onText(/\/seo(?:\s+(\S+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatSeo(generateDraft(contentRequest('seo_snippet', match?.[1]?.toLowerCase()))));
  });
  bot.onText(/\/localized(?:\s+(\S+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    const draft = generateDraft(contentRequest('telegram_post', match?.[1]?.toLowerCase()));
    void sendHtml(msg.chat.id, formatLocalized(generateLocalizedDraft(draft)));
  });

  // Operator / orchestration commands (EPIC 010). Read-only command center.
  // Assembles a daily picture across all engines; recommends, never acts.
  function operatorReport() {
    seedWorkflow();
    const inputs: OperatorInputs = {
      posts: analytics.all(),
      claims: verifications.all(),
      bonuses: bonuses.all(),
      exchanges: exchanges.all(),
      queue: workflow.all(),
      plannerTopics: backlog(plannerInputs()),
      optimization: buildOptimization({ posts: analytics.all(), claims: verifications.all() }).suggestions,
    };
    return buildOperatorReport(inputs);
  }

  bot.onText(/\/operator\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatOperator(operatorReport()));
  });
  bot.onText(/\/today\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatToday(operatorReport()));
  });
  bot.onText(/\/blocked\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatBlocked(operatorReport()));
  });
  bot.onText(/\/health\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatHealth(operatorReport()));
  });

  // Runtime / deployment commands (EPIC 011). Read-only; backup copies files only.
  const runtimeHealth = () =>
    checkRuntimeHealth(healthInputsFromConfig({ lastPipelineRun, lastError }));

  bot.onText(/\/health_runtime\b/, (msg) => {
    if (!reportGate(msg)) return;
    const report = runtimeHealth();
    if (report.status === 'red') {
      void alerts.send('health_red', 'Runtime health is RED', {
        failing: report.checks.filter((c) => !c.ok && c.level === 'critical').map((c) => c.name).join(', '),
      });
    }
    void sendHtml(msg.chat.id, formatHealthReport(report));
  });

  bot.onText(/\/backup\b/, (msg) => {
    if (!reportGate(msg)) return;
    const result = backupEngine.createBackup();
    const pruned = result.ok ? backupEngine.applyRetention() : [];
    void sendHtml(msg.chat.id, formatBackupResult(result, pruned));
  });

  // Merge Guardian commands (EPIC 012). Evaluation/reporting ONLY — no merging.
  // Usage: /merge_guardian <branch> [base]
  const guardianReport = (arg?: string) => {
    const [branch, base] = (arg ?? '').trim().split(/\s+/);
    if (!branch) return null;
    return evaluatePr(buildSnapshotFromGit(branch, base || 'main'));
  };

  bot.onText(/\/merge_guardian(?:\s+([\s\S]+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    const report = guardianReport(match?.[1]);
    if (!report) { void sendHtml(msg.chat.id, 'Usage: <code>/merge_guardian &lt;branch&gt; [base]</code>'); return; }
    void sendHtml(msg.chat.id, formatGuardian(report));
  });
  bot.onText(/\/pr_risk(?:\s+([\s\S]+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    const report = guardianReport(match?.[1]);
    if (!report) { void sendHtml(msg.chat.id, 'Usage: <code>/pr_risk &lt;branch&gt; [base]</code>'); return; }
    void sendHtml(msg.chat.id, formatPrRisk(report));
  });
  bot.onText(/\/safe_to_merge(?:\s+([\s\S]+))?/, (msg, match) => {
    if (!reportGate(msg)) return;
    const report = guardianReport(match?.[1]);
    if (!report) { void sendHtml(msg.chat.id, 'Usage: <code>/safe_to_merge &lt;branch&gt; [base]</code>'); return; }
    void sendHtml(msg.chat.id, formatSafeToMerge(report));
  });

  // Evidence / screenshot / manual-trust commands (EPIC 013). Read-only.
  // Note: /evidence (verification claims) already exists; the evidence-LEVEL
  // overview is /evidence_levels to avoid a command collision.
  bot.onText(/\/evidence_levels\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatEvidenceLevels(screenshots.all()));
  });
  bot.onText(/\/screenshots\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatScreenshots(screenshots.all()));
  });
  bot.onText(/\/missing_evidence\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatMissingEvidence(missingEvidenceQueue(seedManuals())));
  });
  bot.onText(/\/manual_trust\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatManualTrust(seedManuals()));
  });

  // Manual builder / GEO guide engine (EPIC 014). Read-only previews.
  const VALID_TOPICS: GuideTopic[] = ['p2p', 'kyc', 'deposit', 'withdrawal', 'launchpool', 'bonus', 'account_security'];
  const asTopic = (t?: string): GuideTopic | null =>
    VALID_TOPICS.includes((t ?? '').toLowerCase() as GuideTopic) ? ((t as string).toLowerCase() as GuideTopic) : null;
  const asGeo = (g?: string): string => {
    const up = (g ?? '').toUpperCase();
    return GUIDE_GEOS.includes(up) ? up : 'KZ';
  };

  // /manual <exchange> <topic> [geo]
  bot.onText(/\/manual(?:@\w+)?\s+(\S+)\s+(\S+)(?:\s+(\S+))?\s*$/, (msg, match) => {
    if (!reportGate(msg)) return;
    const ex = exchanges.get((match?.[1] ?? '').toLowerCase());
    const topic = asTopic(match?.[2]);
    if (!ex || !topic) {
      void sendHtml(msg.chat.id, 'Usage: <code>/manual bybit p2p KZ</code>\nTopics: p2p, kyc, deposit, withdrawal, launchpool, bonus, account_security');
      return;
    }
    void sendHtml(msg.chat.id, formatManual(buildGeoManual(ex, topic, asGeo(match?.[3]), { screenshots: screenshots.all() })));
  });

  // /manual_step <exchange> <topic> <stepId> [geo]
  bot.onText(/\/manual_step(?:@\w+)?\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?\s*$/, (msg, match) => {
    if (!reportGate(msg)) return;
    const ex = exchanges.get((match?.[1] ?? '').toLowerCase());
    const topic = asTopic(match?.[2]);
    if (!ex || !topic) {
      void sendHtml(msg.chat.id, 'Usage: <code>/manual_step bybit p2p select-fiat KZ</code>');
      return;
    }
    const manual = buildGeoManual(ex, topic, asGeo(match?.[4]), { screenshots: screenshots.all() });
    void sendHtml(msg.chat.id, formatManualStep(manual, findStep(manual, (match?.[3] ?? '').toLowerCase())));
  });

  bot.onText(/\/guide_status\b/, (msg) => {
    if (!reportGate(msg)) return;
    // Bounded matrix: top exchanges × all topics for KZ (primary market).
    const top = exchanges.all().slice(0, 3);
    const manuals = buildGuideMatrix(top, { geos: ['KZ'], screenshots: screenshots.all() });
    void sendHtml(msg.chat.id, formatGuideStatus(manuals));
  });

  bot.onText(/\/tester_tasks\b/, (msg) => {
    if (!reportGate(msg)) return;
    const top = exchanges.all().slice(0, 3);
    const manuals = buildGuideMatrix(top, { geos: GUIDE_GEOS, screenshots: screenshots.all() });
    void sendHtml(msg.chat.id, formatTesterTasks(testerTasksForManuals(manuals)));
  });

  // Local tester program / evidence-review network (EPIC 015). Read-only views.
  bot.onText(/\/testers\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatTesters(testers.all()));
  });
  // GEO/specialty-routed assignment of the missing-evidence (tester-task) queue.
  bot.onText(/\/assignments\b/, (msg) => {
    if (!reportGate(msg)) return;
    const top = exchanges.all().slice(0, 3);
    const manuals = buildGuideMatrix(top, { geos: GUIDE_GEOS, screenshots: screenshots.all() });
    void sendHtml(msg.chat.id, formatAssignments(assignTasks(testerTasksForManuals(manuals), testers.all())));
  });
  bot.onText(/\/submission_review\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(msg.chat.id, formatSubmissionReview(submissions.all()));
  });
  // /tester_score <testerId>
  bot.onText(/\/tester_score(?:@\w+)?(?:\s+(\S+))?\s*$/, (msg, match) => {
    if (!reportGate(msg)) return;
    const id = (match?.[1] ?? '').trim();
    if (!id) {
      void sendHtml(msg.chat.id, formatTesters(testers.all()));
      return;
    }
    void sendHtml(msg.chat.id, formatTesterScore(testers.get(id)));
  });

  bot.onText(/\/runtime_status\b/, (msg) => {
    if (!reportGate(msg)) return;
    void sendHtml(
      msg.chat.id,
      formatRuntimeStatus({
        nodeEnv: config.runtime.nodeEnv,
        logLevel: config.runtime.logLevel,
        uptimeSec: process.uptime(),
        pid: process.pid,
        nodeVersion: process.version,
        alertsEnabled: alerts.isEnabled(),
        healthcheckPort: config.runtime.healthcheckPort,
        lastPipelineRun,
        lastError,
        backups: backupEngine.listBackups(),
      }),
    );
  });

  // Lock a moderation message: append a status stamp and remove the buttons.
  async function lockMessage(chatId: number | string, messageId: number, original: string, stamp: string) {
    try {
      await bot.editMessageText(original + stamp, {
        chat_id: chatId,
        message_id: messageId,
        disable_web_page_preview: true,
      });
    } catch (err) {
      logger.error('bot', `Failed to lock message: ${(err as Error).message}`);
    }
  }

  const utcStamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  // Approve → publish to channel (manual only). Reject → mark rejected.
  // Safety: only the moderation chat, only configured admin ids, no duplicate
  // publishes, repeated clicks ignored, message locked after a decision.
  bot.on('callback_query', async (query) => {
    const data = query.data ?? '';
    const [action, id] = data.split(':');
    if (action !== 'approve' && action !== 'reject') return;

    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const original = query.message?.text ?? '';

    // --- Security gates ------------------------------------------------------
    if (!isModerationChat(chatId)) {
      logger.audit('unauthorized', `Callback from non-moderation chat blocked`, { chatId, userId: query.from.id, action });
      await bot.answerCallbackQuery(query.id, { text: 'Not allowed here.' });
      return;
    }
    if (!isAdmin(query.from.id)) {
      logger.audit('unauthorized', `Non-admin approval attempt blocked`, { userId: query.from.id, action, id });
      await bot.answerCallbackQuery(query.id, { text: '⛔ You are not authorized to moderate.' });
      return;
    }

    try {
      if (action === 'reject') {
        const res = rejectDraft(drafts, id);
        await bot.answerCallbackQuery(query.id, { text: res.message });
        if (res.ok && chatId && messageId) {
          await lockMessage(chatId, messageId, original, `\n\n❌ REJECTED (manual_rejection) at ${utcStamp()}`);
        }
        return;
      }

      // action === 'approve'
      if (inFlight.has(id)) {
        await bot.answerCallbackQuery(query.id, { text: 'Still processing previous click…' });
        return;
      }
      inFlight.add(id);
      try {
        const res = await approveDraft(drafts, id, (rec) =>
          sender.publishToChannel(config.telegram.channelId, rec),
        );
        await bot.answerCallbackQuery(query.id, { text: res.message });
        if (res.ok && chatId && messageId) {
          // Analytics: track the published post (measurement only, never publishes).
          const published = drafts.get(id);
          if (published && res.channelMessageId != null) {
            try {
              analytics.trackPublished(published, res.channelMessageId, config.telegram.channelId);
            } catch (err) {
              logger.error('bot', `Analytics tracking failed (non-fatal): ${(err as Error).message}`);
            }
          }
          await lockMessage(
            chatId, messageId, original,
            `\n\n✅ PUBLISHED to channel (msg ${res.channelMessageId}) at ${utcStamp()}`,
          );
        } else if (res.status === 'pending') {
          // Publish failed and the draft was reverted to pending (logic in
          // moderation-actions, unchanged). Notification-only alert.
          void alerts.send('publish_failure', 'Publish to channel failed — draft reverted to pending', { id, message: res.message });
        } else if (res.status === 'published' && chatId && messageId) {
          // Was already published — make sure the buttons are gone.
          await lockMessage(chatId, messageId, original, `\n\n✅ Already published — duplicate click ignored.`);
        }
      } finally {
        inFlight.delete(id);
      }
    } catch (err) {
      logger.error('bot', `Failed to handle callback: ${(err as Error).message}`);
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Error handling action.' });
      } catch {
        /* ignore */
      }
    }
  });

  bot.on('polling_error', (err) => logger.error('bot', `Polling error: ${err.message}`));

  // Optional HTTP health endpoint (EPIC 011). Disabled when HEALTHCHECK_PORT=0.
  // Read-only: returns a JSON health report; performs no actions.
  let healthServer: http.Server | null = null;
  if (config.runtime.healthcheckPort > 0) {
    healthServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        const report = checkRuntimeHealth(healthInputsFromConfig({ lastPipelineRun, lastError }));
        res.writeHead(report.status === 'red' ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
      } else {
        res.writeHead(404).end();
      }
    });
    healthServer.listen(config.runtime.healthcheckPort, () =>
      logger.info('bot', `Health endpoint on :${config.runtime.healthcheckPort}/health`),
    );
  }

  // Graceful shutdown alert (notification-only).
  const shutdown = (signal: string) => {
    logger.info('bot', `Received ${signal} — shutting down.`);
    void alerts.send('shutdown', `Bot shutting down (${signal}).`).finally(() => {
      healthServer?.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('bot', 'Bot started (polling). Running initial pipeline pass…');
  await alerts.send('startup', 'CBW KZ bot started', {
    env: config.runtime.nodeEnv,
    channel: config.telegram.channelId || '(unset)',
  });
  await runOnce();

  setInterval(() => void runOnce(), config.pipeline.pollIntervalMs);
}

main().catch((err) => {
  logger.error('bot', `Fatal: ${(err as Error).message}`);
  process.exit(1);
});

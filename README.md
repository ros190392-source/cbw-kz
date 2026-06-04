# CBW KZ — AI Crypto Telegram Media System (MVP, Phase 01)

[![CI](https://github.com/ros190392-source/cbw-kz/actions/workflows/ci.yml/badge.svg)](https://github.com/ros190392-source/cbw-kz/actions/workflows/ci.yml)

A **trusted crypto media pipeline** for Kazakhstan. Not a spam channel — the
whole system is built around **signal over noise**: strict ingestion,
filtering, professional rewriting, and a **manual human-approval gate** before
anything is published.

```
RSS Sources → Ingestion → Scoring/Filtering → AI Rewrite → Telegram Draft → Manual Approval → Channel Publish
```

> **NO auto-posting.** Every item is delivered as a *draft* to a private
> moderation chat with Approve / Reject buttons. A post reaches the public
> channel **only** when a configured admin clicks **Approve** — there is no
> automatic, scheduled, or AI-initiated publishing. See
> [Moderation & approval flow](#9-moderation--approval-flow).

---

## 1. Architecture

The system is a set of small, single-responsibility modules wired together by
one pipeline. Each piece can be replaced without touching the others.

```
cbw-kz/
├── apps/
│   └── telegram-bot/        # Long-running bot: runs pipeline, delivers drafts,
│                            #   handles Approve/Reject, commands (/run /status
│                            #   /report /weekly /top)
├── services/
│   ├── rss-parser/          # Polls feeds → normalized NewsItem[], stable ids
│   ├── scoring-layer/       # Ranks + filters every item 0-100 → priority (the gate)
│   ├── news-rewriter/       # AI rewrite layer (OpenAI-compatible) + fallback
│   ├── moderation-layer/    # Legacy keyword pre-filter (superseded by scoring-layer)
│   ├── telegram-sender/     # Draft delivery + channel publish (manual Approve only)
│   ├── analytics-layer/     # Tracks published posts + engagement → aggregations
│   ├── reporting-engine/    # Daily/weekly reports from analytics + draft lifecycle
│   └── feedback-engine/     # AI-feedback FOUNDATION: labels post patterns (no model)
├── src/
│   ├── pipeline.ts          # Orchestrator: fetch→dedupe→score→rewrite→send→log
│   ├── draft-store.ts       # Draft lifecycle store (data/drafts.json)
│   ├── moderation-actions.ts# Pure approve/reject logic (injectable publisher)
│   ├── storage.ts           # JSON state store (processed ids + dedupe)
│   ├── logger.ts            # Console + JSONL logs (pipeline.log, events.log)
│   ├── types.ts             # Shared types
│   └── index.ts             # Headless runner (cron / dry-run, no polling)
├── config/
│   ├── index.ts             # Typed env config
│   └── sources.ts           # RSS source list (add new sources here)
├── tests/                   # Vitest suites (scoring, analytics, reporting)
├── data/                    # processed.json, drafts.json, post-analytics.json,
│                            #   analytics-snapshots.json, feedback.json
└── logs/                    # pipeline.log, events.log (JSONL)
```

**Data flow per item**

1. **Ingest** — `rss-parser` pulls every enabled feed, extracts
   `title, link, source, publishDate, summary`, assigns a stable hash id.
2. **De-duplicate** — skip ids already in `data/processed.json`; also drop
   near-identical stories by normalized title.
3. **Score & rank** — `scoring-layer` scores every item 0–100 across five
   dimensions, assigns a **priority** (HIGH / MEDIUM / LOW / REJECT), a type
   category and a reason. REJECT items are dropped + logged; survivors are
   ranked by total score (see [Scoring & priorities](#scoring--priorities)).
4. **Rewrite** — `news-rewriter` produces a clean 400–700 char Telegram post
   (professional tone, no hype). Falls back to deterministic formatting with no
   API key.
5. **Deliver** — `telegram-sender` posts the draft to the moderation chat with
   the **scoring header** + Approve / Reject buttons.
6. **Log** — every item is written to `logs/events.log`
   (title, source, total score, category, priority, reason, status, sent).

---

## 2. Setup

Requires **Node.js 18+** (uses the built-in global `fetch`).

```bash
cd C:\projects\cbw-kz
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

Then edit `.env` (see section 5 to get the Telegram values).

---

## 3. Environment (`.env.example`)

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes (for delivery) | Bot token from @BotFather |
| `TELEGRAM_MODERATION_CHAT_ID` | yes (for delivery) | Private chat/group id that receives drafts |
| `TELEGRAM_CHANNEL_ID` | yes (to publish) | Public channel id approved posts publish to (bot must be admin) |
| `TELEGRAM_ADMIN_IDS` | yes (to publish) | Comma-separated numeric user ids allowed to Approve/Reject. Empty = nobody can approve |
| `OPENAI_API_KEY` | optional | OpenAI-compatible key. Empty = offline fallback mode |
| `OPENAI_BASE_URL` | optional | Default `https://api.openai.com/v1` (works with OpenRouter, local LLMs, …) |
| `OPENAI_MODEL` | optional | Default `gpt-4o-mini` |
| `POLL_INTERVAL_MS` | optional | Pipeline interval, default `300000` (5 min) |
| `MODERATION_MIN_SCORE` | optional | Pass threshold, default `3` (higher = stricter) |
| `MAX_ITEMS_PER_RUN` | optional | Max new drafts per run, default `10` |

---

## 4. Running locally

**A. Dry run (no Telegram, no AI key needed)** — see the pipeline work end to
end and print drafts to the console:

```bash
npm run pipeline:once
```

Check the output and `logs/events.log`. State is saved to `data/processed.json`
so re-running won't re-process the same items.

**B. Full bot (recommended)** — long-running, delivers drafts with buttons:

```bash
npm run bot
```

**C. Headless interval runner** (cron-style, no Approve/Reject buttons):

```bash
npm run pipeline
```

**Type-check and test the project:**

```bash
npm run typecheck
npm run test
```

---

## 5. Connecting the Telegram bot

1. Open Telegram, message **@BotFather**, send `/newbot`, follow the prompts.
   Copy the **token** into `TELEGRAM_BOT_TOKEN` in `.env`.
2. Create a **private group** (or use your DM with the bot) for moderation.
   Add the bot to the group.
3. Start the bot: `npm run bot`.
4. In that chat send **`/start`** — the bot replies with the **chat id**.
   Put that value in `TELEGRAM_MODERATION_CHAT_ID` and restart the bot.
5. Send **`/run`** to trigger a pass. Drafts arrive with **Approve / Reject**
   buttons. Use **`/status`** to inspect the live config.
6. Set `TELEGRAM_CHANNEL_ID` (+ make the bot an admin of that channel) and
   `TELEGRAM_ADMIN_IDS` so a manual **Approve** publishes to the channel.
7. Admin-only analytics commands in the moderation chat: **`/report`** (daily),
   **`/weekly`**, **`/top`** (see [Analytics & reporting](#11-analytics--reporting)).

> A manual **Approve** publishes the post to `TELEGRAM_CHANNEL_ID` and the
> analytics layer records it. There is still **no** automatic / scheduled /
> AI-initiated publishing — see [Moderation & approval flow](#9-moderation--approval-flow).

---

## 6. Adding a new RSS source

Edit [`config/sources.ts`](config/sources.ts) and append an entry — no other
changes needed:

```ts
{
  id: 'my-source',          // unique, stable
  name: 'My Source',
  url: 'https://example.com/rss',
  enabled: true,
  weight: 2,                // trust/relevance bonus added to moderation score
}
```

---

## 7. Scoring & priorities

Every item is scored by [`services/scoring-layer`](services/scoring-layer/index.ts)
**before** it can become a draft. Scoring is deterministic and keyword-driven —
fast, fully explainable, and testable (no external API needed).

**`score_total` (0–100) = sum of five subscores:**

| Subscore | Range | Rewards |
|---|---|---|
| `importance_score` | 0–25 | Global crypto importance (BTC/ETH, ETF, SEC, hacks, regulation, institutional) |
| `kz_relevance_score` | 0–25 | Kazakhstan: Kazakhstan/KZ, Astana, Almaty, Tenge/KZT, Kaspi, Halyk, Freedom Bank, AIFC, P2P |
| `exchange_bonus_score` | 0–20 | Exchanges (Bybit, Binance, OKX, Bitget, MEXC, BingX, KuCoin, Gate.io, HTX) + **strong**: launchpool, launchpad, listing, rewards, bonus, campaign, referral, trading competition, airdrop |
| `user_value_score` | 0–20 | Actionable value (guides, availability, listings, rewards, security warnings) |
| `trust_score` | 0–10 | Source trust **minus** a hype penalty |

**Downrank / reject** markers reduce the score and can force a REJECT: meme/
shitcoin noise, price prediction, influencer drama, "Bitcoin up 1%"-type low-
signal market movement, and hype without substance.

**Priority bands** (with two editorial floors that reflect CBW's focus):

| Priority | Rule |
|---|---|
| `REJECT` | meme noise with no KZ/bonus value · hype without substance · `score_total` < 20 |
| `LOW` | 20 ≤ score < 45 |
| `MEDIUM` | 45 ≤ score < 65 |
| `HIGH` | score ≥ 65 · **or** strong KZ relevance (≥14) · **or** strong exchange/bonus (≥16) |

Surviving items are **ranked by `score_total`** and only the top
`MAX_ITEMS_PER_RUN` are drafted, so the strongest signal goes out first.

Each draft carries the scoring header:

```
📝 DRAFT — awaiting approval
🔥 Priority: HIGH
🌍 Type: Bonus
📊 Score: 84/100
🧠 Why: Important Bybit launchpool update, relevant for CBW monetization.

<rewritten post text>
———
🗞 Source · time UTC
🔗 Source link
```

### Why auto-publishing is still disabled

Scoring **ranks and filters** — it does not replace human editorial judgment.
A high score means "worth a human's attention," not "safe to publish." This is
a *trusted* media channel: every post is still delivered as a **draft** to the
private moderation chat with Approve / Reject buttons, and the owner approves by
hand. Approvals are logged and the message is locked; nothing is pushed to a
public channel. Wiring approval → publish is a deliberate later phase, gated and
opt-in.

---

## 8. Testing

The scoring layer is the **editorial brain** of CBW KZ — it decides what is
worth a human's attention. A regression suite ([`tests/scoring-layer.test.ts`](tests/scoring-layer.test.ts),
[Vitest](https://vitest.dev)) pins its behaviour so future tuning can't
silently break editorial quality.

```bash
npm run test         # run once
npm run test:watch   # re-run on change while tuning scoring
```

What the suite protects:

| Area | Guarantee |
|---|---|
| Kazakhstan relevance | KZ items (Kazakhstan, Astana, Tenge, Kaspi, KZT…) reach **HIGH** |
| Exchange / bonus priority | Launchpool / listing / campaign / rewards score high (CBW monetization) |
| Hype / noise rejection | Meme coins, "100x to the moon", "Bitcoin up 1%", price speculation → **REJECT** |
| Priority classification | Bands (HIGH/MEDIUM/LOW/REJECT) and type categories stay stable |
| Subscore invariants | Every subscore stays inside its declared 0–25 / 0–20 / 0–10 range |

**Why this matters:** the scoring weights will be tuned over time. Without
these tests a well-meaning tweak could quietly start rejecting Kazakhstan news
or letting meme-coin hype through — exactly the failures that would erode trust
in the channel. The suite makes any such regression fail loudly in CI.

> Tests are read-only over production logic. TASK 003 added **no** changes to
> scoring behaviour and **no** changes to draft-only mode.

### Continuous integration (CI)

Every **push** and **pull request** runs the quality gate in GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) on `ubuntu-latest` /
Node.js 20 with cached npm installs:

```
npm ci  →  npm run typecheck  →  npm run test
```

This means the **TypeScript types and the scoring regression tests run
automatically on every change**. A PR that breaks type safety, mis-ranks
Kazakhstan/bonus news, or lets meme-coin hype through fails CI before it can be
merged — the editorial quality of the channel is protected by default, not by
memory.

---

## 9. Moderation & approval flow

Every surviving item becomes a **draft** in the moderation chat. Nothing reaches
the public channel without a manual Approve click from an authorized admin.

```
pending ──(✅ Approve by admin)──▶ approved ──(publish ok)──▶ published
   │                                   └──(publish fails)──▶ pending (retry)
   └────────(❌ Reject by admin)──────────────────────────▶ rejected
```

**Statuses** (persisted in `data/drafts.json`): `pending` · `approved` ·
`rejected` · `published`.

**On ✅ Approve** the bot:
1. publishes the rewritten post to `TELEGRAM_CHANNEL_ID`,
2. logs publish time, channel message id, title, score and category,
3. marks the draft `published` and stores the channel message id,
4. locks the moderation message (buttons removed, status stamped).

**On ❌ Reject** the bot marks the draft `rejected` with reason
`manual_rejection`, locks the message, and the item is never resent (the
pipeline de-dupes by id).

**Publish-safety guarantees** (verified by the local simulation):

| Guard | Behaviour |
|---|---|
| Duplicate publish | A `published` draft is never published again; repeat Approve clicks are ignored |
| Concurrent clicks | An in-flight publish blocks further Approve clicks for that draft |
| Reject after publish | Cannot reject an already-published draft |
| Publish failure | Draft reverts to `pending` so the admin can retry; nothing partial is published |
| Chat scope | Only the configured moderation chat can moderate |
| Admin scope | Only user ids in `TELEGRAM_ADMIN_IDS` can Approve/Reject (empty ⇒ nobody) |
| Message lock | The moderation message is stamped + buttons removed after any decision |

All decisions are written to `logs/events.log` (`approval`, `rejection`,
`publish_success`, `publish_failure`, `duplicate_prevented`, `unauthorized`).

The approval logic lives in [`src/moderation-actions.ts`](src/moderation-actions.ts)
(pure and injectable), so it is tested/simulated without Telegram.

### Why auto-publishing still does NOT exist

Approval is **manual by design**. The bot never decides on its own to post:
there is no scheduler, no auto-approve, no AI self-publishing. A human admin
must click Approve for each post. Scoring only *ranks and filters* what's worth
a human's attention — it does not grant permission to publish. This keeps the
channel a *trusted* source: a person is always accountable for every post.

---

## 11. Analytics & reporting

Once a post is **manually approved and published**, the analytics subsystem
starts measuring it. Analytics is **measurement only** — it never publishes and
never influences moderation. Human approval remains the only path to publishing.

### Architecture

```
Approve (manual) → publish → analytics-layer.trackPublished()
                                   │
        ┌──────────────────────────┼───────────────────────────┐
        ▼                          ▼                           ▼
  data/post-analytics.json   reporting-engine            feedback-engine
  (normalized records +      (daily / weekly reports,    (labels post patterns:
   engagement metrics)        /report /weekly /top)       successful / weak / …)
```

- **`analytics-layer`** — tracks every published post into
  `data/post-analytics.json`: Telegram message id, publish time, category,
  score, priority, source, detected **exchange mentions** and **GEO tags**,
  plus an engagement metrics block. Exposes pure aggregations (by category /
  exchange / priority / score range), top-post ranking, and historical
  **snapshots** (`data/analytics-snapshots.json`) for a future dashboard.
- **`reporting-engine`** — pure functions that turn analytics + the draft
  lifecycle into a **daily** or **weekly** report: total published, top post,
  top category, top exchange, average score, approval count, rejected count and
  **publish success rate** (published ÷ approved).
- **`feedback-engine`** — see [AI feedback](#ai-feedback-foundation).

### Analytics schema (per published post)

| Field | Meaning |
|---|---|
| `id` / `telegramMessageId` / `channelId` | Identity + where it was posted |
| `title` / `link` / `source` | Content origin |
| `category` / `priority` / `scoreTotal` | Editorial classification (from scoring) |
| `exchangeMentions` / `geoTags` | Auto-detected (`bybit`, `okx`… / `KZ`, `Global`) |
| `publishedAt` / `updatedAt` | Timestamps |
| `metrics` | `{ views, forwards, reactions, edits, deletes, available, collectedAt }` |

### Telegram metrics (reality check)

The Telegram **Bot** API cannot read channel **views / forwards / reactions** —
those are only exposed to the client/MTProto API. So metric collection
**degrades gracefully**: unknown values stay `null` with `available: false`
(an unmeasured post never looks "successful"), while edits/deletes — which a bot
*can* observe — are tracked as counters. The collector is **injectable**, so a
future MTProto / analytics-export integration can supply real engagement without
changing any callers. `engagementScore = forwards·3 + reactions·2 + views·0.1`.

### Reports (admin commands)

In the moderation chat, an admin (`TELEGRAM_ADMIN_IDS`) can run:

| Command | Output |
|---|---|
| `/report` | Daily report (last 24h) |
| `/weekly` | Weekly report (last 7d) |
| `/top` | Top posts leaderboard by engagement |

Example daily report:

```
📊 Daily report
🗓 2026-06-03 → 2026-06-04

📰 Published: 3
✅ Approved: 4 · ❌ Rejected: 1
🚀 Publish success rate: 80%
📊 Average score: 72/100
🏷 Top category: Bonus
🏦 Top exchange: bybit

🏆 Top post (eng 765, score 86):
   «Bybit Launchpool campaign for Kazakhstan users»
```

### AI feedback (foundation)

`feedback-engine` is a **foundation only — NOT a self-learning model**, and it
never changes scoring or publishing. It labels each published post so a future
learning layer has clean signal:

| Pattern | Rule |
|---|---|
| `successful` | high score **confirmed** by strong engagement (or a modest-score post that over-performed) |
| `weak` | high score but near-zero engagement → the prediction missed |
| `no_data` | no engagement collected yet — cannot judge |
| `neutral` | within the expected range |

It also stores per-**category** and per-**exchange** performance to
`data/feedback.json`. Nothing here feeds back into the live scoring or the
publish decision — that stays a deliberate, human, future step.

### Tests

The analytics subsystem has its own regression suites, run by the same CI gate:

| Suite | Covers |
|---|---|
| [`tests/analytics-layer.test.ts`](tests/analytics-layer.test.ts) | persistence, exchange/GEO detection, engagement, aggregation, feedback classification |
| [`tests/reporting-engine.test.ts`](tests/reporting-engine.test.ts) | report generation, time windows, success-rate math, top selection |

---

## 12. Roadmap (foundation is built for this)

The architecture is deliberately modular to support, without rewrites:

- multi-GEO + GEO filtering
- multiple Telegram channels
- affiliate layer + bonus engine
- AI scoring & ranking
- scheduling
- **analytics dashboard** — a UI over the normalized records + historical
  snapshots already produced by `analytics-layer` (Phase 7 data structure)
- **AI learning layer** — consuming `feedback-engine` patterns to suggest (never
  auto-apply) scoring adjustments, with human review
- real engagement metrics via MTProto / analytics export (collector is ready)
- multilingual expansion

Each future capability slots in as a new service or a config-driven extension
of the existing pipeline stages.

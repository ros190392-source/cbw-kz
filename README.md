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
│   ├── feedback-engine/     # AI-feedback FOUNDATION: labels post patterns (no model)
│   ├── exchange-registry/   # Exchange + bonus registry, trust verification
│   ├── geo-engine/          # GEO compatibility (availability/P2P/KYC/fiat by country)
│   ├── affiliate-layer/     # Affiliate metadata + CTA helpers (NEVER auto-injected)
│   ├── verification-engine/ # Evidence, confidence scoring, freshness, KZ snapshots
│   ├── locale-engine/       # Locales, GEO↔language routing, translation moderation
│   ├── editorial-planner/   # Editorial brain: topics, prioritization, calendar
│   ├── research-engine/     # Classifies news findings + snapshot/formatters
│   ├── trend-engine/        # Momentum, trending/undercovered/emerging topics
│   ├── discovery-engine/    # Proposes registry candidates, rejects scams (no writes)
│   ├── optimization-engine/ # Meta-brain: self-improvement suggestions (recommend-only)
│   ├── editorial-workflow/  # Human-gated queue: idea→…→published (state only, no publish)
│   └── content-engine/      # Verification-aware draft generation (machine-gen, review-required)
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
├── tests/                   # Vitest suites (scoring, analytics, reporting, geo, registry)
├── data/                    # processed.json, drafts.json, post-analytics.json,
│                            #   analytics-snapshots.json, feedback.json,
│                            #   exchanges.json, bonuses.json, verifications.json
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

## 12. Monetization intelligence (exchange registry · GEO · bonuses · affiliate)

The monetization layer is **intelligence + structure only**. It models which
exchanges work where, what bonuses exist, and how trustworthy that information
is — so a moderator can make accurate, GEO-correct decisions. It **never**
injects affiliate links into content and **never** publishes.

> **Monetization philosophy.** This is *not* a spam affiliate engine. Trust,
> accuracy, verified information and GEO correctness come first. Misleading GEO
> info, fake bonuses and unverified campaigns are forbidden. Affiliate links are
> a *suggestion helper* for a human, not an automation.

```
exchange-registry ──┬─▶ geo-engine        (availability / P2P / KYC / fiat by country)
 (data/exchanges.json)│
 (data/bonuses.json)  ├─▶ bonus engine     (signup/deposit/trading/launchpool/… + verification)
                      └─▶ affiliate-layer  (metadata + CTA helpers, NEVER auto-injected)
```

### Exchange registry (`services/exchange-registry`)

Structured records for Bybit, Binance, OKX, Bitget, MEXC, BingX, KuCoin, HTX and
Gate.io, persisted to `data/exchanges.json` (seeded from code on first run).

**Exchange schema:**

| Field | Meaning |
|---|---|
| `name` / `slug` | Display name + stable id |
| `officialUrl` / `affiliateUrl` | Official site + tracking-ready URL (defaults to official until a code lands) |
| `supportedGeos` / `restrictedGeos` | ISO country codes (`*` = global allow); restrictions win |
| `kyc` | `none` / `basic` / `full` |
| `p2p` / `fiat` | Global P2P flag + fiat rails |
| `kazakhstan` | Dedicated KZ block: `{ available, p2p, kyc, fiat[], notes }` |
| `trustLevel` | `high` / `medium` / `low` |
| `notes` / `lastReviewedAt` | Human notes + review timestamp (`null` = needs review) |

> ⚠️ Seed values are a **conservative baseline** — every KZ/KYC/P2P field must be
> human-verified before it is used in published content.

### GEO engine (`services/geo-engine`)

GEO correctness is the priority. Kazakhstan (`KZ`) is resolved from each
exchange's `kazakhstan` block; other countries fall back to supported/restricted
lists. Core functions: `isAvailable`, `supportsP2P`, `kycLevel` / `requiresKYC`,
`supportsFiat` (KZT, Kaspi, Halyk, Freedom, local-cards), plus `profilesFor(country)`.

```
bybit  → KZ: available ✅  P2P ✅  KYC basic  KZT ✅  Kaspi ✅
mexc   → KZ: available ✅  P2P ✅  KYC none   KZT ✅
bybit  → US: available ❌ (restricted)   DE: available ✅
```

### Bonus engine + trust verification

Bonuses (signup / deposit / trading / launchpool / launchpad / campaign /
competition) carry `startDate`, `expiryDate`, `sourceUrl` and a
`verification { status, source, lastCheckedAt }` block. Verification status is
**freshness-aware**:

| State | Rule |
|---|---|
| `unverified` | never checked (the default for all seeds) |
| `verified` | confirmed against a source within the TTL (30 days) |
| `outdated` | was verified, but the check is now stale |

`isPublishableBonus()` is true **only** when a bonus is verified-fresh **and**
active — so unverified/expired claims can never be presented as fact. All seed
bonuses ship `unverified` on purpose.

### Affiliate layer (`services/affiliate-layer`)

Affiliate **metadata** + a tracking-ready `buildAffiliateUrl()` (appends `ref` /
`utm_campaign` only when present — never fabricated) + `buildCta()` which returns
a CTA **suggestion string** for a moderator. The constant `AFFILIATE_AUTO_INJECT
= false` is the single source of truth: **nothing is auto-appended to drafts or
posts.**

### Admin commands (moderation chat, admin-gated)

| Command | Output |
|---|---|
| `/exchanges` | Registry with KZ availability, trust, KYC, P2P, fiat |
| `/bonuses` | Tracked bonuses with verification status + active flag |
| `/launchpool` | Active launchpools / launchpads |
| `/geo kz` | GEO compatibility for a country (defaults to KZ) |

### Analytics integration (Phase 7)

`analytics-layer` already aggregates published-post performance
`byExchange`; EPIC 002 adds `aggregateByGeo`, so reports can surface which
exchanges and which GEO-tagged posts perform best.

### Tests

| Suite | Covers |
|---|---|
| [`tests/geo-engine.test.ts`](tests/geo-engine.test.ts) | availability, restrictions, P2P, KYC, fiat, GeoEngine wrapper |
| [`tests/exchange-registry.test.ts`](tests/exchange-registry.test.ts) | bonus validation, active windows, trust verification, registry/bonus persistence, affiliate helpers |

---

## 13. Trust & verification layer (Kazakhstan)

The monetization data starts out as static baselines. The **verification engine**
(`services/verification-engine`) turns those into **evidence-backed claims** with
a **0-100 confidence score** and a **freshness lifecycle**, so the system knows —
and shows — how much each Kazakhstan claim can be trusted.

> **Guiding rule: accuracy over speed, uncertainty over hallucination.** A claim
> with weak, missing or stale evidence gets a LOW score and is flagged
> **unreliable** rather than presented as fact. Fake verification, fake GEO
> support and fake bonus claims are forbidden. Nothing here publishes.

### Claims & evidence schema (Phase 1-2)

A **claim** is one assertion about an exchange in a country (e.g. `bybit:KZ:p2p`
= `true`). Each claim holds a list of **evidence**:

| Evidence field | Meaning |
|---|---|
| `sourceUrl` | Where it was confirmed (required for `official_*` types) |
| `type` | `official_docs` · `official_support` · `exchange_ui` · `user_report` · `manual_review` |
| `note` | Free-text reviewer note |
| `verifiedAt` / `expiresAt` | When gathered / when it should stop being trusted |
| `status` | `verified` · `outdated` · `unverified` |
| `reviewer` | Human handle (or `system` for baselines) |

Every exchange is **seeded** with `unverified` baseline claims (`lastCheckedAt =
null`) → they score ~5/100, so the system openly says "not really verified yet."

### Confidence scoring (Phase 3)

`computeConfidence(claim)` = strongest evidence (`authority × freshness ×
status`) + diminishing bonus for extra confirmations + bonuses for human/official
verification − penalty for conflicting evidence. Empty evidence → **0**.

| Example | Score |
|---|---|
| official docs + recent manual review (verified) | **≈ 94** (high) |
| single fresh, verified user report | **40** (low) |
| old, unverified user report | **< 10** (very low) |
| no evidence at all | **0** |

Bands: `high ≥ 80` · `medium ≥ 50` · `low ≥ 25` · `very_low < 25`.

### Freshness lifecycle (Phase 4)

Based on age since last check vs a TTL (default 30 days):

```
fresh (≤½ TTL) → aging (≤TTL) → stale (≤2× TTL) → expired (older / never checked)
```

`stale` and `expired` mean **recheck required**. A claim is **reliable** only
when `confidence ≥ 60` **and** freshness is `fresh`/`aging`.

### GEO snapshots (Phase 5)

`buildKzSnapshot(exchange, claims)` produces a per-exchange KZ snapshot — KYC,
P2P, KZT, local banks (Kaspi/Halyk/Freedom), notes — plus an **aggregate
confidence** and the **worst freshness** across its claims. The *values* come
from the registry's best-known data; the verification engine supplies *how sure*
we are. With no evidence the snapshot is confidence 0 / not reliable, and a
single unverified claim (e.g. `fiat`) keeps the whole snapshot unreliable even if
others are strong — uncertainty wins.

### Moderation verification flow (Phase 6)

Admin-gated, read-only commands in the moderation chat:

| Command | Output |
|---|---|
| `/verify <slug>` | KZ snapshot + per-claim confidence & freshness (e.g. `/verify bybit`) |
| `/confidence` | Aggregate KZ confidence per exchange, best first |
| `/stale` | Claims needing a recheck (`stale`/`expired`) |
| `/evidence <slug>` | The evidence behind each claim |

A human raises confidence by attaching real evidence (`addEvidence`), which is
**validated** (official claims must carry a source) and refreshes the timestamp.

### Analytics integration (Phase 7)

`verificationAnalytics(claims, bonuses)` reports total claims, average confidence,
band distribution, stale claim ids, how many were recently checked, and which
bonuses are outdated/unverified — feeding the trust health of the KZ matrix.

### Tests

| Suite | Covers |
|---|---|
| [`tests/verification-engine.test.ts`](tests/verification-engine.test.ts) | confidence scoring, freshness logic, evidence validation, stale detection, GEO snapshots, analytics, store persistence |

---

## 14. Multilingual & multi-GEO foundation

The locale layer (`services/locale-engine`) prepares CBW for expansion beyond
Kazakhstan — Germany, Turkey, Nigeria, India — with locale routing, GEO↔language
mapping, localized content scaffolding, and a translation **moderation** flow.

> **Foundation + philosophy.** This builds *structure*, not content. We do **not**
> auto-translate, **not** auto-publish translations, and **never** fabricate
> localization. Machine translation is a draft input only — low-confidence MT is
> forced to `human_review_required`, and a bundle is `approved` only when a human
> approves every field. Human moderation stays mandatory.

### Locale schema (Phase 1)

Locales: `kk-KZ`, `ru-KZ`, `en-US`, `de-DE`, `tr-TR`, `hi-IN`. Each defines:

| Field | Meaning |
|---|---|
| `code` / `language` / `languageName` / `country` | Identity |
| `fallback` | Locale to fall back to (e.g. `kk-KZ → ru-KZ → en-US`); `en-US` has none |
| `defaultCurrency` / `timezone` | Market defaults (e.g. `KZT` / `Asia/Almaty`) |
| `preferredExchanges` | Registry slugs preferred in this market |
| `localPaymentMethods` | Local rails (Kaspi, SEPA, Papara, UPI, …) |

### GEO ↔ language mapping (Phase 2)

```
KZ → ru-KZ, kk-KZ      DE → de-DE, en-US      TR → tr-TR
IN → hi-IN, en-US      NG → en-US             (unknown) → en-US
```

Functions: `preferredLocales(country)`, `fallbackLocale(locale)`,
`resolveLocaleChain(locale)`, and `supportsLocale(exchange, locale)` (true when
the exchange operates in the locale's country per the GEO engine — e.g. a
US-restricted exchange does **not** support `en-US`).

### Localized content + translation workflow (Phase 3-4)

`newLocalizedContent(sourceId, locale)` scaffolds a bundle with localized
`title`, `summary`, `cta` (a `{{CTA}}` placeholder — still never auto-injected)
and `exchangeNotes`, each individually moderated through:

```
untranslated → machine_translated → human_review_required → approved
                     │                                       └ (rejected blocks the bundle)
                     └ low MT confidence routes straight to human_review_required
```

The bundle's aggregate status is the **least-progressed** field (and `rejected`
if any field is), so partial localization never counts as done.

### Multi-GEO analytics (Phase 5)

`localePerformance(records)` groups published-post engagement by locale
(derived from GEO tags), with `avgScore`, `avgEngagement` and `topExchange` per
locale; `bestLocale(records)` returns the strongest market.

### Telegram commands (Phase 6)

| Command | Output |
|---|---|
| `/locales` | All locales + currency, fallback, preferred exchanges, payments |
| `/geo <country>` | Supported locales, payments/fiat, available exchanges + trust (e.g. `/geo de`, `/geo tr`, `/geo in`, `/geo ng`) |

### Tests

| Suite | Covers |
|---|---|
| [`tests/locale-engine.test.ts`](tests/locale-engine.test.ts) | locale routing, fallback chains, GEO-language mapping, `supportsLocale`, localized structures, translation statuses, multi-GEO analytics |

---

## 15. Editorial planning (editorial brain)

The editorial planner (`services/editorial-planner`) is the layer that turns all
the data — analytics, exchange registry, bonus engine, verification freshness,
locales, scoring categories — into structured editorial **recommendations**:
what to post today, which exchange/bonus to feature, which stale GEO data to
refresh, which categories and locales are undercovered.

> **Human-in-the-loop philosophy.** The planner **recommends, it never
> executes**. No auto-publishing, no auto-approval, no fake/hype content, and no
> "verified" bonus is invented. Every topic states the verification status
> required *before* it could be published; the human still approves and posts.

### Topic schema (Phase 2)

Topic types: `news`, `bonus`, `launchpool`, `p2p`, `kyc`, `regulation`,
`education`, `comparison`, `warning`, `evergreen`. Each topic carries:

| Field | Meaning |
|---|---|
| `title` / `type` | What to write + its kind |
| `exchange` / `geo` / `locale` | Targeting (slug / country / locale) |
| `priority` (0-100) + `priorityBand` | Ranking (`high ≥ 70`, `medium ≥ 45`, `low`) |
| `reason` | Why the planner is recommending it |
| `confidence` (0-100) | Verification-derived where relevant |
| `suggestedCta` | A `{{CTA}}` placeholder — never auto-injected |
| `requiredVerification` | What must be true before publishing (e.g. bonuses need `verified`) |

### Prioritization (Phase 3)

**Up:** verified+active bonuses, stale-but-important GEO data (weighted by
exchange trust), top-performing categories, undercovered local payment rails
(Kaspi/Halyk/Freedom), launchpool opportunities, KZT/P2P topics, multilingual
gaps. **Down:** unverified/outdated bonuses, low-confidence claims (still
surfaced as *verify tasks*, but flagged `requiredVerification: verified`), weak
categories, duplicates (deduped by id + title), and hype (never generated).

### Editorial calendar + content mix (Phase 4)

A balanced mix across five buckets:

| Bucket | Daily | Weekly |
|---|---|---|
| news | 2 | 7 |
| bonus | 1 | 3 |
| education | 1 | 3 |
| verification | 1 | 3 |
| evergreen | 1 | 2 |

Buckets that can't be filled produce an explicit gap note. Example daily plan:

```
📋 Daily editorial plan — GEO: KZ
⚖️ Mix: news 2/2 · bonus 1/1 · education 1/1 · verification 1/1 · evergreen 1/1

1. 🟢 Bybit: Bybit Launchpool        (launchpool · prio 88 · 🔒 needs:verified)
2. 🟢 More "Bonus" coverage           (news · prio 74)
3. 🟡 Update Binance AVAILABILITY (KZ) — verify   (regulation · prio 67 · 🔒 verified)
4. 🟡 Update Binance FIAT (KZ) — verify           (p2p · prio 67 · 🔒 verified)
5. 🟡 Start covering "KZ" (underused category)    (education · prio 56)
6. 🟡 How to use P2P with KZT safely  (evergreen · prio 46)

Notes: 🕒 36 stale claims · ⚠️ 3 unverified bonuses · ℹ️ Recommendations only — human approves.
```

### Commands (Phase 5)

| Command | Output |
|---|---|
| `/plan` | Daily editorial plan + content mix + notes |
| `/weekplan` | 7-day plan (weekly mix) |
| `/backlog` | Full ranked topic backlog |

### Tests

| Suite | Covers |
|---|---|
| [`tests/editorial-planner.test.ts`](tests/editorial-planner.test.ts) | topic prioritization, downranking unverified claims, calendar generation, content-mix balance, locale/GEO gap detection |

---

## 16. Research / intelligence layer

The research layer continuously turns news inputs into **intelligence**:
findings (research-engine), trends (trend-engine), and registry candidates
(discovery-engine). It is the system's "scout" — it discovers and recommends,
and **never** acts.

> **Discovery philosophy + human-moderation guarantees.** No auto-publishing,
> no auto-approval, no auto affiliate insertion, and **no automatic registry
> writes**. Every finding is `humanVerificationRequired`; every discovery is a
> *suggestion for manual review*. Confidence is never fabricated — weak sources
> are downranked and obvious scam patterns are **rejected**, never surfaced as
> candidates.

### Research engine (Phase 2)

Classifies each news item into a `ResearchFinding`:

| Category | Priority |
|---|---|
| `launchpool`, `restriction`, `bonus` | HIGH |
| `listing`, `regulation`, `kz` | MEDIUM |
| `news` | LOW |

A **KZ angle bumps** any non-HIGH finding up one level (so KZ regulation /
restriction / listing become HIGH). Findings carry matched `signals`,
`exchanges`, `geos`, a `SourceTrust` (`trusted`/`neutral`/`weak`) and a
`confidence` (weak sources downranked). Batches are de-duplicated by normalized
title and sorted HIGH-first.

### Trend engine (Phase 3)

Tallies findings (cross-referenced with published-post coverage from analytics)
into `TrendSignal`s with a 0-100 **momentum** and a status:

- `trending` (high momentum), `emerging` (just appeared),
- `undercovered` (research interest but **no published coverage** — an editorial
  gap), `steady`.

### Discovery engine (Phase 4)

Extracts unknown exchange / launchpool / bonus names from text, skips anything
already in the registry, scores **confidence** and **scamRisk**, and **rejects**
scam patterns (`guaranteed`, `100x`, `risk-free`, `connect wallet`, …). Output
is always a `DiscoveryCandidate` with `suggestedAction: "Manual review required
… (never auto-added)"`. **It never writes to the registry.**

### Trust model

| Source | Confidence base |
|---|---|
| trusted (Cointelegraph, The Block, Decrypt, CoinDesk…) | high |
| neutral (unknown outlet) | medium |
| weak (Medium/Substack/Telegram/forum/press release) | low |

### Commands (Phase 5-6)

Admin-gated, **read-only**; they fetch live feeds (cached 5 min) and write
nothing:

| Command | Output |
|---|---|
| `/research` | Classified findings, HIGH-first, with counts |
| `/trends` | Trend signals (momentum + status) |
| `/discoveries` | Registry candidates for manual review + rejected scams |
| `/signals` | Priority shortlist: HIGH findings + undercovered/emerging trends |

### Tests

| Suite | Covers |
|---|---|
| [`tests/research-engine.test.ts`](tests/research-engine.test.ts) | classification, KZ priority boost, weak-source downranking, dedup |
| [`tests/trend-engine.test.ts`](tests/trend-engine.test.ts) | momentum, trending/undercovered/emerging status |
| [`tests/discovery-engine.test.ts`](tests/discovery-engine.test.ts) | unknown detection, known-skip, scam rejection, weak-source confidence |

---

## 17. Optimization / learning meta-brain

The optimization engine (`services/optimization-engine`) is the system's
**meta-brain**: it reads its own outputs — engagement analytics, verification
freshness, locale performance, research findings — and proposes **self-improvement
suggestions**. It is the top of the intelligence stack and, like every layer
below it, **recommends but never acts**.

> **Strictly recommendation-only.** No auto-publishing, **no auto-config changes**,
> no autonomous actions. Nothing here edits scoring weights, source trust, the
> planner, or the registry — it only *suggests*, and a human applies (or ignores)
> each one. Sparse data yields low-confidence `investigate` suggestions —
> uncertainty over overfitting. Every suggestion is `humanReviewRequired`.

### What it suggests

| Suggestion type | Signal | Example |
|---|---|---|
| `scoring_weight` | engagement vs. editorial score per category | "Bonus engages above average but scores low → consider increasing its weight" |
| `source_trust` | engagement by news source | "Decrypt under-performs → consider lowering its weight" |
| `topic_priority` | category engagement ranking (planner loop) | "Prioritize more Bonus topics; de-prioritize Regulation" |
| `locale_focus` | per-locale engagement + coverage gaps | "Keep investing in ru-KZ; seed kk-KZ (uncovered)" |
| `verification_refresh` | stale / low-confidence claims | "Re-verify `bybit:KZ:p2p` before it informs content" |
| `engagement_pattern` | feedback-engine successful/weak patterns | "Lean into successful patterns; investigate weak ones" |

### Confidence model

Confidence is **gated by sample size** (`≥8 high · ≥3 medium · else low`), so a
handful of posts can never produce a "high-confidence" recommendation. Each
suggestion carries its `observation`, `recommendation`, `rationale`,
`sampleSize` and `confidence`. Snapshots are persisted to
`data/optimization-snapshots.json` for trend-over-time review.

### Commands

Admin-gated, **read-only**:

| Command | Output |
|---|---|
| `/insights` | Snapshot summary: counts by type, top suggestions, notes (also persists the snapshot) |
| `/suggestions [type]` | Full suggestion list, optionally filtered by type |
| `/learn` | Engagement-pattern learning (successful vs weak) |

### Tests

| Suite | Covers |
|---|---|
| [`tests/optimization-engine.test.ts`](tests/optimization-engine.test.ts) | scoring/source/topic/locale suggestions, stale warnings, pattern learning, confidence-from-sample, snapshot + persistence |

---

## 18. Editorial workflow / queue

The editorial workflow (`services/editorial-workflow`) is the **connective
tissue**: it pulls planner topics, research findings, verification warnings,
optimization suggestions and manual admin ideas into a single human-gated queue
and tracks each through its lifecycle.

> **Human-gate philosophy.** The workflow only **tracks state**. It never
> publishes, never auto-approves, and imports no publisher. Every advancing
> transition requires an explicit human reviewer (`by`) — there are no
> autonomous moves — and any item carrying a verification requirement is
> **blocked** from `approved`/`scheduled`/`published` until a human clears the
> gate. Publishing itself remains the separate manual Approve → channel flow
> (§9); this layer touches none of it.

### Queue lifecycle

```
idea → draft_requested → drafted → in_review → approved → scheduled → published
  └──────────────── (any active status) ───────────────→ rejected → (reopen) idea
```

`published` is terminal and is only a **record** a human sets after the manual
publish — reaching it from here requires going through `scheduled` and clearing
any verification gate. Each transition is validated against an allowed-moves map
and appended to the item's `history`.

### Queue item

| Field | Meaning |
|---|---|
| `source` | `planner` · `research` · `verification` · `optimization` · `manual` |
| `reason` / `priority` | Why it's queued + 0-100 ranking |
| `status` | Position in the lifecycle |
| `requiredVerification` / `verificationCleared` | The gate (e.g. `bybit:KZ`) + whether a human cleared it |
| `geo` / `locale` / `exchange` / `notes` | Targeting + context |
| `history` / `decidedBy` | Audit trail of who moved it when |

### Ingestion + de-duplication

Builders convert each input into queue **ideas** (planner topics, research
findings — always gated, optimization `verification_refresh` → gated verification
items, plus manual ideas). Ingestion is **idempotent**: duplicates are rejected
by id *and* by normalized title, so re-seeding the queue every command is safe
and never resurrects rejected items.

### Commands

Admin-gated:

| Command | Output |
|---|---|
| `/queue` | Active queue, prioritized, with gate status |
| `/queue_add <text>` | Add a manual idea (dedup-checked) |
| `/review` | Review-ready summary + items blocked by verification |
| `/next` | The single highest-priority actionable item |

### Tests

| Suite | Covers |
|---|---|
| [`tests/editorial-workflow.test.ts`](tests/editorial-workflow.test.ts) | queue creation, duplicate prevention, status transitions, prioritization, verification-gated items, no-auto-publish/autonomy guarantee |

---

## 19. Content generation engine

The content engine (`services/content-engine`) turns a topic / finding / exchange
into a **structured, verification-aware draft** — Telegram posts, article
outlines, SEO snippets, warning posts and educational posts — for a human to
review and (optionally) publish via the normal flow.

> **Human-review guarantees.** Every draft is `machineGenerated: true` +
> `humanReviewRequired: true`. The engine **never publishes, posts to Telegram,
> or auto-approves**. It implies **no certainty** beyond cited evidence, flags
> unverified/low-confidence/stale claims, discloses GEO restrictions explicitly,
> never fabricates a verified bonus, and keeps the CTA a `{{CTA}}` placeholder
> (no real affiliate link is ever injected).

### Draft types

`telegram_post` · `article_outline` · `seo_snippet` · `warning_post` ·
`educational_post`. Tone is chosen automatically (`neutral` / `educational` /
`cautionary` / `promotional_safe`) — there is no hype vocabulary.

### Draft schema (key fields)

| Field | Meaning |
|---|---|
| `type` / `tone` / `title` / `body` | The generated draft |
| `citations` | `VerificationCitation[]` — target, confidence, freshness, reliable |
| `warnings` | Low-confidence / stale / unverified-bonus / GEO-restriction flags |
| `seo` | `SeoBlock` for SEO/outline drafts (title, meta ≤160, keyword clusters, FAQ, CTA) |
| `ctaPlaceholder` | Always `{{CTA}}` — never a real link |
| `machineGenerated` / `humanReviewRequired` | Always `true` |
| `confidenceNote` | Explicit "no certainty beyond cited evidence" note |

### Verification-aware writing

Claims relevant to the draft's exchange + GEO are cited with their live
confidence + freshness. Anything `< 25` confidence is flagged low-confidence;
`stale`/`expired` claims demand a re-verify; unverified/inactive bonuses are
flagged; restricted GEOs are disclosed (and targeting a restricted GEO triggers
an explicit "do not target" warning).

### Multilingual drafts

`generateLocalizedDraft` produces **scaffolds** for `ru-KZ`, `kk-KZ`, `en-US`,
`de-DE` — each carrying `machineGenerated`/`humanReviewRequired` and a note that
it **requires human translation & review (not auto-translated)**. No fake
localization, consistent with the locale engine (§14).

### SEO philosophy

Structures only — titles (≤60), meta descriptions (≤160), small **deduped**
keyword clusters (no stuffing), FAQ ideas, and a placeholder CTA.

### Commands (read-only previews)

| Command | Output |
|---|---|
| `/draft [exchange]` | Telegram-post draft preview |
| `/outline [exchange]` | Article outline + SEO title |
| `/seo [exchange]` | SEO block preview |
| `/localized [exchange]` | Multilingual scaffolds |

### Tests

| Suite | Covers |
|---|---|
| [`tests/content-engine.test.ts`](tests/content-engine.test.ts) | verification warnings, GEO-restriction disclosure, multilingual generation, SEO validity, no-fake-certainty, CTA placeholder rules, citations |

---

## 20. Roadmap (foundation is built for this)

The architecture is deliberately modular to support, without rewrites:

- ✅ multi-GEO foundation + GEO↔language routing (EPIC 004 — locales for KZ/DE/
  TR/NG/IN; extend with real translation providers + per-locale channels next)
- multiple Telegram channels
- ✅ affiliate layer + bonus engine (EPIC 002 — built; affiliate auto-injection
  remains intentionally disabled, pending human-reviewed CTA placement)
- ✅ trust & verification layer (EPIC 003 — evidence, confidence, freshness, KZ
  snapshots; extend evidence sources + multi-country claims next)
- ✅ multilingual foundation (EPIC 004 — locale engine + translation moderation
  flow; wire MT providers + localized publishing under human review next)
- ✅ editorial planning / editorial brain (EPIC 005 — daily/weekly plans, topic
  backlog, content-mix balance; recommend-only, human approves)
- ✅ research / intelligence layer (EPIC 006 — findings, trends, discovery with
  scam rejection; recommend-only, never writes the registry)
- ✅ AI learning / optimization meta-brain (EPIC 007 — scoring/source/topic/locale
  tuning suggestions, stale warnings, pattern learning; recommend-only, nothing
  auto-applied — a human reviews and applies each suggestion)
- ✅ editorial workflow / queue (EPIC 008 — human-gated lifecycle connecting
  planner/research/verification/optimization/manual ideas; state-only, verification
  gates, no auto-publish/approve)
- ✅ content generation engine (EPIC 009 — verification-aware drafts, SEO,
  multilingual scaffolds; machine-generated + human-review-required, no auto-post)
- scheduling (queue feeds a human-reviewed scheduler; still no auto-fire)
- **analytics dashboard** — a UI over the normalized records + historical
  snapshots already produced by `analytics-layer` (Phase 7 data structure)
- **AI learning layer** — consuming `feedback-engine` patterns to suggest (never
  auto-apply) scoring adjustments, with human review
- real engagement metrics via MTProto / analytics export (collector is ready)

Each future capability slots in as a new service or a config-driven extension
of the existing pipeline stages.

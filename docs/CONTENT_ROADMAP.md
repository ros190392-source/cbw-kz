# CBW KZ — Autonomous Content Roadmap (EPIC 018)

Long-term Telegram content strategy + autonomous newsroom design for **@cbw_kz**.
Trust-first, human-gated by default. Nothing here changes the publish gate:
posts still go out only via a human `/approve_publish` (auto-publish is a *future,
opt-in, risk-gated* mode — see §10).

> Honesty principle (carried from the whole project): no fake screenshots, no
> guarantees, no unverified GEO/Kaspi/regulation claims. Education is allowed
> with clear caveats; facts that need proof wait for a local tester / source.

---

## 1. Permanent content pillars (12)

| # | Pillar | postType | Chip | Default evidence | Image theme |
|---|---|---|---|---|---|
| 1 | USDT | education | `USDT · ГАЙД` | C | Tether coin, $/₸ glow |
| 2 | P2P | education | `P2P · ГАЙД` | C | two figures + coins + escrow shield |
| 3 | Безопасность | p2p_safety | `P2P · БЕЗОПАСНОСТЬ` | C | shield + coin |
| 4 | Биржи | exchange_update | `БИРЖИ · ГАЙД` | C/D | platform nodes, abstract |
| 5 | KZT / Kaspi | education | `KZT · ОПЛАТА` | D | tenge notes + coin (no bank UI) |
| 6 | Скам | p2p_safety | `СКАМ · АЛЕРТ` | C | warning shield, calm (no red spam) |
| 7 | Новости | news | `НОВОСТИ` | per-source | abstract news/glow |
| 8 | Beginner education | education | `НОВИЧКАМ` | C | simple iconography |
| 9 | Exchange comparisons | exchange_update | `БИРЖИ · СРАВНЕНИЕ` | C/D | balanced scales, nodes |
| 10 | Regulation | news | `ЗАКОН · KZ` | C | document/AFSA abstract (no fake claims) |
| 11 | Wallets | education | `КОШЕЛЬКИ` | C | hardware/hot-cold wallet |
| 12 | Crypto basics | education | `ОСНОВЫ` | C | blockchain blocks abstract |

Pillars 1–5 are **core/recurring** (highest weight); 6–12 round out trust and
breadth. Existing image prompts already cover USDT, P2P, scam, seller-checklist,
exchanges; the rest get prompt entries when added to the registry.

---

## 2. Content cadence

- **Daily posts:** 1 per day (sustainable + human-reviewable). Optional 2nd post
  only for high-value days. Never more than 2/day (anti-spam).
- **Weekly structure (default rotation):**
  | Day | Pillar focus |
  |---|---|
  | Mon | Beginner / Crypto basics |
  | Tue | P2P |
  | Wed | Безопасность / Скам |
  | Thu | Биржи / comparisons |
  | Fri | USDT / KZT-Kaspi |
  | Sat | Новости digest / engagement |
  | Sun | Wallets / evergreen education |
- **Evergreen : news ratio = 75 : 25.** News is hard to verify fast, so evergreen
  dominates (protects trust). News only when source-backed.
- **Educational ratio ≈ 60%** (education + basics + wallets), **safety ≈ 25%**
  (security + scam), **updates/news ≈ 15%**.
- **Engagement ratio:** ~1 post/week is an engagement format (checklist, “проверь
  себя”, question/poll) to drive replies/forwards.

---

## 3. Automatic queue logic

- **No duplicate topics:** a `topicKey` cannot repeat within a **21-day** window
  (tracked via the post store `topic` + `createdAt`).
- **No duplicate visuals:** consecutive posts must not share the same `image
  theme`; rotate scene types (coin → shield → checklist → nodes → notes). Same
  topic re-runs regenerate a *fresh* image (provider re-roll) rather than reusing
  the exact file.
- **Category rotation:** weighted round-robin over pillars using the §2 ratios;
  never two posts of the same pillar back-to-back.
- **Visual diversity score:** track the last 5 image themes; block a candidate
  whose theme matches any of the last 2.
- **Educational balance:** enforce the §2 ratios over a rolling **14-day** window;
  if education < 55% or safety < 20%, the selector prioritises the deficit pillar.

---

## 4. Autonomous generation flow

```
topic selection            (roadmap queue + dedup + rotation + balance)
   ↓
caption generation         (content-machine: safe template + caveats)
   ↓
premium image generation   (image-generator: gpt-image-1 → poster overlay; fallback if no provider)
   ↓
safety validation          (validateContentSafety on caption + validateImagePrompt on subject)
   ↓
duplicate check            (topic window + visual-theme + caption similarity)
   ↓
queue                      (ChannelPostStore → status `ready`, preview to admin chat)
   ↓
scheduled publish          (HUMAN /approve_publish at the scheduled slot;  auto only in §10 mode)
```

Every step already exists in code except the **scheduler/selector** (the queue
brain) — that's the one new module EPIC 018 specifies (build later, on approval).

---

## 5. Publishing schedule (Kazakhstan, Asia/Almaty = UTC+5)

- **Best posting windows (KZ local):**
  - Morning **08:30–09:30** (commute)
  - Lunch **12:30–13:30**
  - Evening **19:00–21:00** ← prime (highest engagement)
- **Weekday logic:** 1 post at **19:30** (prime). Optional 2nd at 09:00 for big
  topics. Avoid 00:00–07:00.
- **Weekend logic:** lighter; 1 post at **12:30** (midday), evergreen/education,
  no heavy news.
- All schedule times are KZ local; the scheduler converts to UTC for the API.

---

## 6. Quality gates (must all pass before `ready`)

- **Image quality:** 1536×1024; produced by the provider *or* a branded fallback;
  poster overlay applied (title fits, no overlap); `validateImagePrompt` clean
  (no fake UI/screens/balances/casino).
- **Text quality:** caption **300–900 chars**; contains a caveat/disclaimer line;
  no forbidden phrases (§7); evidence-appropriate phrasing (A/B “verified”,
  C “по документации”, D “по сообщениям”, E → not publishable).
- **Blocked phrases (sample):** «гарантированный доход», «без риска», «100% профит»,
  «успей сегодня», «срочно купи», «инсайд», «х10 гарантирован», «официально
  поддерживает Kaspi».
- **Duplicate detection:** topic within 21 days → block; caption cosine/normalized
  similarity > 0.8 vs last 60 posts → block; visual theme repeat (§3) → block.

---

## 7. “Never publish” rules (hard blocks)

| Rule | Example wording blocked |
|---|---|
| Fake urgency | «только сегодня», «срочно», «успей купить», countdown pressure |
| Guaranteed profit | «гарантированный доход», «без риска», «X% в день» |
| Fake regulation claims | «официально разрешено государством», invented AFSA approvals |
| Fake KYC claims | «без KYC и это законно», «верификация не нужна нигде» |
| Fake Kaspi/bank claims | «Kaspi официально поддерживает крипто», fake bank endorsements |
| Fake screenshots / proof | «реальный скриншот вывода», fabricated balance/proof images |

These extend `validateContentSafety` (caption) and `validateImagePrompt` (image).
Any hit → the post is refused, never queued.

---

## 8. First 60-post roadmap (12 pillars × 5)

**USDT** — 1) Что такое USDT · 2) Чем USDT отличается от доллара · 3) Сети USDT (TRC20/ERC20/TON) — что выбрать · 4) Риски стейблкоинов · 5) Как безопасно хранить USDT
**P2P** — 1) Что такое P2P простыми словами · 2) P2P-сделка по шагам · 3) Эскроу: как биржа защищает · 4) P2P vs обменники · 5) Лимиты и комиссии в P2P
**Безопасность** — 1) Как не попасть на скам в P2P · 2) 2FA: зачем и как включить · 3) Антифишинг-код · 4) Белый список адресов вывода · 5) Признаки мошеннического продавца
**Биржи** — 1) Как выбрать биржу · 2) Что такое KYC · 3) Спот vs P2P · 4) Комиссии бирж · 5) Надёжность и резервы биржи
**KZT / Kaspi** — 1) Как покупают USDT за тенге · 2) Способы оплаты в KZ (Kaspi/Halyk/Freedom) · 3) Почему P2P-курс ≠ биржевой · 4) Налоги и крипта в KZ (общее) · 5) Частые ошибки при оплате тенге
**Скам** — 1) Топ-5 схем развода · 2) Фейковые «менеджеры» и поддержка · 3) «Слишком выгодный курс» · 4) Скам с предоплатой · 5) Как проверить продавца/проект
**Новости** — 1) Дайджест недели (формат) · 2) Как читать крипто-новости критически · 3) FUD и FOMO · 4) Кому можно доверять · 5) Почему мы проверяем факты
**Beginner** — 1) Крипта с нуля · 2) Кошелёк vs биржа · 3) Сид-фраза: что это · 4) Газ и комиссии простыми словами · 5) Частые ошибки новичка
**Exchange comparisons** — 1) Bybit/Binance/OKX — обзор (не рейтинг) · 2) Как сравнивать биржи правильно · 3) P2P-ликвидность · 4) Мобильные приложения · 5) Поддержка и верификация
**Regulation** — 1) Регулирование крипты в KZ (что известно) · 2) AFSA и лицензии простыми словами · 3) Зачем KYC/AML · 4) Легально ли владеть криптой в KZ · 5) Налоги: общая информация
**Wallets** — 1) Горячие vs холодные · 2) Custodial vs non-custodial · 3) Первый кошелёк · 4) Безопасное хранение сид-фразы · 5) Аппаратные кошельки
**Crypto basics** — 1) Что такое блокчейн · 2) Токен vs монета · 3) Газ/комиссия сети · 4) Волатильность · 5) Что такое стейблкоин

(All written as honest education with caveats; regulation/KZT/Kaspi items phrased
as “что известно / проверяйте”, evidence D, never asserting fake facts.)

---

## 9. First 14-day posting schedule (KZ local)

| Day | Date type | Time | Pillar | Post |
|---|---|---|---|---|
| 1 (Mon) | weekday | 19:30 | Crypto basics | Что такое блокчейн |
| 2 (Tue) | weekday | 19:30 | P2P | Что такое P2P простыми словами |
| 3 (Wed) | weekday | 19:30 | Безопасность | Как не попасть на скам в P2P |
| 4 (Thu) | weekday | 19:30 | Биржи | Как выбрать биржу |
| 5 (Fri) | weekday | 19:30 | USDT | Что такое USDT |
| 6 (Sat) | weekend | 12:30 | Новости | Как читать крипто-новости критически |
| 7 (Sun) | weekend | 12:30 | Wallets | Горячие vs холодные кошельки |
| 8 (Mon) | weekday | 19:30 | Beginner | Кошелёк vs биржа |
| 9 (Tue) | weekday | 19:30 | P2P | P2P-сделка по шагам |
| 10 (Wed) | weekday | 19:30 | Скам | Топ-5 схем развода |
| 11 (Thu) | weekday | 19:30 | Exchange comp. | Как сравнивать биржи правильно |
| 12 (Fri) | weekday | 19:30 | KZT/Kaspi | Как покупают USDT за тенге |
| 13 (Sat) | weekend | 12:30 | Engagement | Чеклист: безопасная P2P-сделка |
| 14 (Sun) | weekend | 12:30 | USDT | Как безопасно хранить USDT |

Balance over 14 days: education/basics ≈ 8, safety ≈ 3, exchanges ≈ 2, news ≈ 1,
1 engagement. No pillar repeats within 2 days; visual themes alternate.

---

## 10. Future autonomous mode (auto-publish OFF by default)

**Default: manual approval ON.** Auto-publish is a *future* opt-in mode, never the
baseline.

**Pre-conditions to even consider enabling (all required):**
- Topic is **evergreen education** from a whitelist (no news, no regulation, no
  Kaspi/GEO claims).
- All §6 quality gates green + §7 never-publish clean.
- Evidence level **C or better**; anything D/E stays manual.
- A track record: ≥ 30 human-approved posts with < 5% edit/reject rate.
- Daily cap (e.g., 1 auto-post/day), kill-switch, and admin alert on every
  auto-publish.

**Risk analysis:**
| Risk | Impact | Mitigation |
|---|---|---|
| Hallucinated/incorrect fact | Trust loss | Auto only for whitelisted evergreen; facts pre-written templates; D/E stay manual |
| Image flaw (garbled/odd) | Brand damage | Poster overlay + image checks; auto only after N clean human-approved generations |
| Accidental scam-mimicry wording | Reputation/legal | §7 hard blocks; phrase blocklist; refuse on any hit |
| Regulatory/Kaspi misstatement | Legal | Never auto for regulation/Kaspi/GEO pillars |
| Spam perception | Unsubscribes | Daily cap + cadence rules + dedup |
| Runaway loop | Mass bad posts | Daily cap + kill-switch + post-publish audit + delete/rollback |

**Recommendation:** keep human `/approve_publish` as the gate. If/when auto is
enabled, restrict it to whitelisted evergreen education, 1/day, with alerting and
a one-tap kill-switch — and keep everything else manual.

---

*Status: roadmap only. No posts published, nothing committed. Implementation
(the scheduler/selector module + new pillar prompts) is a follow-up EPIC on
approval.*

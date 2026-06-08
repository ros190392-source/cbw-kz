# Post images — premium vs fallback

Per-topic post images for the content machine. The topic → filename mapping
lives in `services/image-generator/prompts.ts` (`PREMIUM_PROMPTS` +
`TOPIC_TO_PROMPT`).

| Topic | Prompt key | Filename |
|---|---|---|
| `usdt_basics` | `usdt_intro` | `cbw_kzt_usdt_p2p_1280.png` |
| `p2p_basics` | `p2p_explainer` | `cbw_p2p_simple_1280.png` |
| `p2p_scams` | `p2p_scam_safety` | `cbw_p2p_scam_safety_1280.png` |
| `choose_seller` | `p2p_seller_checklist` | `cbw_payment_methods_1280.png` |
| `best_exchanges_kz` | `exchange_overview_kz` | `cbw_exchange_reviews_1280.png` |

## Premium vs fallback

- **Premium (preferred):** when an image provider is configured
  (`IMAGE_PROVIDER=fal|openai` + key), `generatePremiumTelegramImage()` writes a
  generated poster to the topic's filename here. You can also drop a hand-made
  **poster-style** image (1280×720 PNG) at the filename above to override.
- **Fallback (placeholder):** the current PNGs were rendered from the brand SVG
  templates (`assets/telegram/template-*.svg`). They are clean but simple —
  **fallback only** until premium images replace them. Backups live in
  [`fallback/`](fallback/).

`cbw_kzt_usdt_p2p_1280.png` is the real designed image used for the first live
post (KZT → USDT), not a placeholder.

## Configure a provider

```
# .env
IMAGE_PROVIDER=fal          # or: openai | none
FAL_KEY=...                 # for fal.ai
OPENAI_IMAGE_KEY=...         # or reuse OPENAI_API_KEY for OpenAI images
```

With no provider (`none`), the pipeline uses the fallback images above.

## Publish workflow (human-gated)

1. `/generate_post <topic>` — caption + image (premium or fallback) + preview.
2. `/preview_post <id>` — review.
3. `/approve_publish <id>` — the human gate; publishes to `@cbw_kz`.

Nothing publishes automatically.

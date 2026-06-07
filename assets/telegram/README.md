# CBW KZ — Telegram brand assets

Production-ready **vector** assets for the `@cbw_kz` channel. SVG is the source
of truth: scalable, crisp on every screen, and editable with a text change.

> ⚠️ **Palette note.** These were authored without the original branding board
> (it was not available to the builder). They use a documented **dark-gold
> fintech** palette (below). If your board differs, edit the few colour values —
> they're plain hex strings in each file.

## Files & specs

| File | Asset | Size | Notes |
|---|---|---|---|
| `avatar.svg` | Profile avatar | 512×512 | Content stays inside Telegram's circular crop |
| `banner.svg` | Header / link-preview banner | 1280×640 | Wordmark + tagline |
| `post-kzt-usdt.svg` | First post thumbnail | 1280×720 | "KZT → USDT" |
| `template-p2p.svg` | Reusable thumbnail | 1280×720 | P2P (blue) |
| `template-scam-warning.svg` | Reusable thumbnail | 1280×720 | Scam warning (red-orange) |
| `template-exchange-reviews.svg` | Reusable thumbnail | 1280×720 | Exchange review (gold) |
| `template-payment-methods.svg` | Reusable thumbnail | 1280×720 | Payments (teal) |
| `template-guides.svg` | Reusable thumbnail | 1280×720 | Guide (violet) |

## Palette (dark fintech, premium)

| Token | Hex | Use |
|---|---|---|
| bg deep | `#0A0D13` | background base |
| bg mid | `#11161F` | background mid |
| bg raised | `#1A212E` | background top |
| gold (brand) | `#E7B53C` → `#C9952C` | logo, primary accent |
| ink | `#F4F6FA` | headline text |
| muted | `#8B95A7` | secondary text |
| P2P | `#3DA9FC` | category accent |
| scam | `#F0623A` | category accent |
| payments | `#2BD4C4` | category accent |
| guides | `#A78BFA` | category accent |

Type: Inter / Segoe UI / Arial fallback. Heavy weights, generous letter-spacing,
large mobile-readable sizes. Minimal text per asset (no overload). No exchange
UI, no candlesticks, no casino/trading aesthetics.

## Export to PNG

SVGs render directly, but Telegram avatars must be raster. Pick one:

```bash
# Option A — Inkscape (best fidelity)
inkscape avatar.svg -w 512 -h 512 -o avatar.png

# Option B — rsvg-convert (librsvg)
rsvg-convert -w 512 -h 512 avatar.svg -o avatar.png

# Option C — Node (sharp); installs a dev dependency
npx -y sharp-cli -i avatar.svg -o avatar.png resize 512 512
```

For the 1280×720 thumbnails, drop the `-w/-h` (or set `1280 720`) to keep size.

## Editing a template

1. Copy a `template-*.svg`.
2. Change the headline `<text>` and the subtitle line.
3. Keep the logo lockup, footer and accent bar untouched for brand consistency.

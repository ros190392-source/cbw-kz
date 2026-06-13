import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

/**
 * Regenerate the bundled exchange-logo tiles under assets/exchange-logos/.
 *
 * Each logo becomes a 320x320 rounded "app-icon" tile:
 *   - logos that carry their OWN background (opaque images, e.g. Binance's
 *     dark card) are filled edge-to-edge (cover) — no white frame;
 *   - transparent logos (e.g. Coinbase, Upbit) are centered on a white tile
 *     so they stay visible on the dark brand card.
 * Opacity is detected from the pixels (sharp stats().isOpaque), not the file
 * type, so it is correct regardless of PNG/JPG.
 *
 * Source: CoinGecko exchange logos (official brand logos). Run once; the
 * resulting PNGs are committed so production has no runtime CDN dependency.
 */

const B = 'https://coin-images.coingecko.com/markets/images/';
const MAP = {
  binance: B + '52/large/binance.jpg',
  bybit: B + '698/large/bybit_spot.png',
  kucoin: B + '61/large/kucoin.png',
  okx: B + '96/large/WeChat_Image_20220117220452.png',
  gate: B + '60/large/Frame_1.png',
  bitget: B + '540/large/2023-07-25_21.47.43.jpg',
  mexc: B + '409/large/164286be-32a5-4b58-978c-d072eea00eb9.jpeg',
  bingx: B + '812/large/YtFwQwJr_400x400.jpg',
  cryptocom: B + '589/large/h2oMjPp6_400x400.jpg',
  upbit: B + '117/large/upbit.png',
  bithumb: B + '6/large/bithumb_BI.png',
  phemex: B + '564/large/phemex-exchange-new-logo.png',
  htx: B + '25/large/htx.png',
  coinex: B + '135/large/coinex.jpg',
  kraken: B + '29/large/kraken.jpg',
  coinbase: B + '23/large/Coinbase_Coin_Primary.png',
  bitunix: B + '1185/large/APP_icon_1024.png',
  lbank: B + '118/large/LBank_200_200.png',
};

const dir = path.join('assets', 'exchange-logos');
const TILE = 320, PAD = 26, RX = 56;
const mask = Buffer.from(`<svg width="${TILE}" height="${TILE}"><rect width="${TILE}" height="${TILE}" rx="${RX}" ry="${RX}"/></svg>`);

fs.mkdirSync(dir, { recursive: true });
for (const [slug, url] of Object.entries(MAP)) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) { console.log(slug, 'HTTP', r.status); continue; }
    const raw = Buffer.from(await r.arrayBuffer());
    let opaque = false;
    try { opaque = (await sharp(raw).stats()).isOpaque; } catch { /* assume transparent */ }
    let tile;
    if (opaque) {
      tile = await sharp(raw).resize(TILE, TILE, { fit: 'cover', position: 'centre' }).png().toBuffer();
    } else {
      const logo = await sharp(raw).resize(TILE - PAD * 2, TILE - PAD * 2, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).toBuffer();
      tile = await sharp({ create: { width: TILE, height: TILE, channels: 4, background: '#FFFFFF' } })
        .composite([{ input: logo, gravity: 'center' }]).png().toBuffer();
    }
    await sharp(tile).composite([{ input: mask, blend: 'dest-in' }]).png().toFile(path.join(dir, `${slug}.png`));
    console.log(slug, opaque ? 'cover(own-bg)' : 'white-tile');
  } catch (e) { console.log(slug, 'ERR', e.message); }
  await new Promise((s) => setTimeout(s, 300));
}

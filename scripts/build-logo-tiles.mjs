import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
const dir = 'assets/exchange-logos';
const TILE = 320, PAD = 26, RX = 56;
const mask = Buffer.from(`<svg width="${TILE}" height="${TILE}"><rect width="${TILE}" height="${TILE}" rx="${RX}" ry="${RX}"/></svg>`);
const raws = fs.readdirSync(dir).filter(f => /\.raw\.(png|jpg|jpeg)$/i.test(f));
for (const f of raws) {
  const slug = f.replace(/\.raw\.(png|jpg|jpeg)$/i, '');
  try {
    const logo = await sharp(path.join(dir, f))
      .resize(TILE - PAD * 2, TILE - PAD * 2, { fit: 'contain', background: '#FFFFFF' })
      .toBuffer();
    const tile = await sharp({ create: { width: TILE, height: TILE, channels: 4, background: '#FFFFFF' } })
      .composite([{ input: logo, gravity: 'center' }])
      .png().toBuffer();
    await sharp(tile).composite([{ input: mask, blend: 'dest-in' }]).png()
      .toFile(path.join(dir, `${slug}.png`));
    console.log('tile', slug);
  } catch (e) { console.log('ERR', slug, e.message); }
}

// Draws the covers' SVGs (scripts/covers/make.py) as 600×800 PNGs with the covers' own fonts (./fonts, OFL).
//   node scripts/covers/render.js <svg dir> <png dir>
'use strict';
const fs = require('fs'), path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const [src, out] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const fontFiles = fs.readdirSync(path.join(__dirname, 'fonts')).filter(f => f.endsWith('.ttf')).map(f => path.join(__dirname, 'fonts', f));
let n = 0;
for (const f of fs.readdirSync(src).filter(f => f.endsWith('.svg'))) {
  const png = new Resvg(fs.readFileSync(path.join(src, f), 'utf8'), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Plus Jakarta Sans' }, fitTo: { mode: 'width', value: 600 } }).render().asPng();
  fs.writeFileSync(path.join(out, f.replace(/\.svg$/, '.png')), png); n++;
}
console.log('rendered', n);

// Verify every pixel-map row in pixelArt.ts is exactly 10 chars (the inner
// body width) and uses only defined palette slots.
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('../../web/src/game/sprites/pixelArt.ts', import.meta.url),
  'utf8',
);

// Pixel rows are single-quoted strings made only of the palette alphabet.
const ALPHABET = /^[.oshEpdtb]+$/;
const literals = [...src.matchAll(/'([^']*)'/g)].map((m) => m[1]);
const rows = literals.filter((s) => s.length > 3 && ALPHABET.test(s));

let bad = 0;
for (const row of rows) {
  if (row.length !== 10) {
    console.error(`BAD  len=${row.length}  "${row}"`);
    bad++;
  }
}

// Palette slots referenced by the maps must all exist in AvatarPalette.
const world = readFileSync(
  new URL('../../web/src/protocol/world.ts', import.meta.url),
  'utf8',
);
const declared = new Set(
  [...world.matchAll(/^\s{2}([osEhpdtb]):\s/gm)].map((m) => m[1]),
);
const used = new Set(rows.join('').split('').filter((c) => c !== '.'));
const missing = [...used].filter((c) => !declared.has(c));

console.log(`checked ${rows.length} pixel rows, ${bad} bad`);
console.log(`palette slots used: ${[...used].sort().join('')}`);
console.log(`missing from AvatarPalette: ${missing.length ? missing.join(',') : 'none'}`);

if (bad || missing.length) process.exit(1);
console.log('PIXEL ART OK');

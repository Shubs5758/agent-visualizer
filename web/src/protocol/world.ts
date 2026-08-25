/**
 * World geometry shared by the Phaser scene, the React overlays and the docs.
 * Changing anything here changes the coordinate space the protocol talks about,
 * so keep `protocol/PROTOCOL.md` §5 in sync.
 */

import type { AvatarType, ZoneId } from './events';

export const TILE = 32;
export const GRID_COLS = 25;
export const GRID_ROWS = 18;
export const WORLD_WIDTH = TILE * GRID_COLS; // 800
export const WORLD_HEIGHT = TILE * GRID_ROWS; // 576

export interface Zone {
  id: ZoneId;
  label: string;
  /** Tile coords of the top-left corner. */
  x: number;
  y: number;
  /** Size in tiles. */
  w: number;
  h: number;
  /** Floor fill. */
  color: number;
  /** Border + label colour. */
  accent: number;
  blurb: string;
}

export const ZONES: Zone[] = [
  {
    id: 'gateway',
    label: 'GATEWAY',
    x: 1,
    y: 1,
    w: 4,
    h: 4,
    color: 0x10283a,
    accent: 0x4ecdf5,
    blurb: 'Spawn / entry',
  },
  {
    id: 'library',
    label: 'LIBRARY · MEMORY',
    x: 1,
    y: 12,
    w: 6,
    h: 5,
    color: 0x241f3d,
    accent: 0xa78bfa,
    blurb: 'Retrieval & memory',
  },
  {
    id: 'tools',
    label: 'TOOL FORGE',
    x: 18,
    y: 1,
    w: 6,
    h: 5,
    color: 0x3a2612,
    accent: 0xffa940,
    blurb: 'Tool execution',
  },
  {
    id: 'council',
    label: 'COUNCIL',
    x: 10,
    y: 6,
    w: 6,
    h: 5,
    color: 0x12301f,
    accent: 0x4ade80,
    blurb: 'Deliberation',
  },
  {
    id: 'vault',
    label: 'VAULT · OUTPUT',
    x: 18,
    y: 12,
    w: 6,
    h: 5,
    color: 0x35142a,
    accent: 0xff5c8a,
    blurb: 'Final artifacts',
  },
];

export const ZONE_BY_ID: Record<string, Zone> = Object.fromEntries(
  ZONES.map((z) => [z.id, z]),
);

/**
 * Impassable tiles. Hand-authored (rather than random) so the map is always
 * fully connected — every zone stays reachable from every other zone.
 */
export const OBSTACLES: ReadonlyArray<[number, number]> = (() => {
  const tiles: [number, number][] = [];
  // Two wall segments with a five-tile gap between them at y = 6..10.
  for (let y = 1; y <= 5; y++) tiles.push([8, y]);
  for (let y = 11; y <= 16; y++) tiles.push([8, y]);
  // Partial wall shielding the vault approach.
  for (let y = 13; y <= 16; y++) tiles.push([16, y]);
  // Scattered crates / rubble.
  const props: [number, number][] = [
    [5, 8],
    [6, 8],
    [20, 9],
    [21, 9],
    [12, 14],
    [13, 14],
    [3, 6],
    [23, 8],
  ];
  return [...tiles, ...props];
})();

const obstacleKeys = new Set(OBSTACLES.map(([x, y]) => `${x},${y}`));

export function isBlocked(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= GRID_COLS || y >= GRID_ROWS) return true;
  return obstacleKeys.has(`${x},${y}`);
}

export function clampToGrid(pos: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(GRID_COLS - 1, Math.round(pos.x))),
    y: Math.max(0, Math.min(GRID_ROWS - 1, Math.round(pos.y))),
  };
}

/** Centre of a tile, in world pixels. */
export function tileToWorld(x: number, y: number): { x: number; y: number } {
  return { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
}

/**
 * Pick a free tile inside a zone, spiralling outwards from the centre so
 * several agents sent to the same zone spread out instead of stacking.
 */
export function tileInZone(
  zone: Zone,
  isOccupied: (x: number, y: number) => boolean = () => false,
): { x: number; y: number } {
  const candidates: { x: number; y: number }[] = [];
  for (let dy = 0; dy < zone.h; dy++) {
    for (let dx = 0; dx < zone.w; dx++) {
      candidates.push({ x: zone.x + dx, y: zone.y + dy });
    }
  }
  const cx = zone.x + (zone.w - 1) / 2;
  const cy = zone.y + (zone.h - 1) / 2;
  candidates.sort(
    (a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2),
  );
  for (const c of candidates) {
    if (!isBlocked(c.x, c.y) && !isOccupied(c.x, c.y)) return c;
  }
  return { x: zone.x, y: zone.y };
}

// ---------------------------------------------------------------------------
// Retro palettes
// ---------------------------------------------------------------------------

export interface AvatarPalette {
  /** Colour slots referenced by the pixel maps in `game/sprites/pixelArt.ts`. */
  o: string; // outline
  s: string; // skin
  E: string; // eye
  h: string; // hair (or hood, when `hooded`)
  p: string; // primary cloth
  d: string; // primary cloth, shaded
  t: string; // trim / accent band
  b: string; // boots + belt
  /** Hooded classes render the head in `p` instead of `h`. */
  hooded: boolean;
  /** Roster swatch / bubble border, as CSS hex. */
  ui: string;
}

/**
 * Agent identity colours.
 *
 * This is a **categorical palette** — the hue carries identity, nothing else —
 * so it is not eyeballed. These are the eight validated dark-mode steps, kept
 * in their published slot order because that order is what clears the
 * colour-vision-deficiency separation check; re-ordering them fails it
 * (blue↔violet drops to ΔE 1.9 for protanopia when made adjacent).
 *
 * Verified against surface #070a10: lightness band, chroma floor, CVD
 * separation (worst adjacent ΔE 8.4), normal-vision floor (19.3) and 3:1
 * contrast all pass. No set of eight hues can clear the *all-pairs* check, so
 * identity is never colour-alone here: every agent carries a name in the
 * roster and a nameplate under its sprite.
 *
 * `p` is the cloth colour and drives the sprite; `ui` is the same hue and is
 * what the roster swatch, bubbles and feed use.
 */
export const AVATAR_PALETTES: Record<AvatarType, AvatarPalette> = {
  // slot 1 — blue
  knight: {
    o: '#05070c', s: '#e8b98a', E: '#05070c', h: '#8fa8c4',
    p: '#3987e5', d: '#2a63ab', t: '#7cb4f2', b: '#2a3446',
    hooded: false, ui: '#3987e5',
  },
  // slot 2 — orange
  artificer: {
    o: '#05070c', s: '#e8b98a', E: '#05070c', h: '#3a3a44',
    p: '#d95926', d: '#a3411c', t: '#f08a5c', b: '#37291f',
    hooded: false, ui: '#d95926',
  },
  // slot 3 — aqua
  rogue: {
    o: '#05070c', s: '#e8b98a', E: '#05070c', h: '#12503c',
    p: '#199e70', d: '#127653', t: '#4fd1a0', b: '#22201c',
    hooded: true, ui: '#199e70',
  },
  // slot 4 — yellow
  cleric: {
    o: '#05070c', s: '#f0cfa8', E: '#05070c', h: '#e8d9a8',
    p: '#c98500', d: '#966300', t: '#f0b73d', b: '#4a3a22',
    hooded: false, ui: '#c98500',
  },
  // slot 5 — magenta
  bard: {
    o: '#05070c', s: '#e8b98a', E: '#05070c', h: '#8f3355',
    p: '#d55181', d: '#a03c61', t: '#ef88ab', b: '#3d2030',
    hooded: false, ui: '#d55181',
  },
  // slot 6 — green
  ranger: {
    o: '#05070c', s: '#dba875', E: '#05070c', h: '#3f3320',
    p: '#008300', d: '#005c00', t: '#3fbb3f', b: '#33281a',
    hooded: true, ui: '#008300',
  },
  // slot 7 — violet
  mage: {
    o: '#05070c', s: '#f0cfa8', E: '#05070c', h: '#5f57a8',
    p: '#9085e9', d: '#6b62b0', t: '#b9b2f4', b: '#241f38',
    hooded: true, ui: '#9085e9',
  },
  // slot 8 — red
  druid: {
    o: '#05070c', s: '#d9a878', E: '#05070c', h: '#4a3a2a',
    p: '#e66767', d: '#ad4d4d', t: '#f59a9a', b: '#332a1c',
    hooded: true, ui: '#e66767',
  },
};

/**
 * Interaction colours are a *status* palette, not a categorical one — they
 * encode the kind of message, and are deliberately kept out of the agent hues
 * above so a bubble border never reads as an agent identity.
 */
export const INTERACTION_COLORS: Record<string, string> = {
  dialogue: '#38bdf8',
  handoff: '#ffa940',
  request: '#a78bfa',
  response: '#4ade80',
  broadcast: '#ff5c8a',
};

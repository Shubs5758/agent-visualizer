/**
 * Procedural 16x16 pixel-art avatars.
 *
 * Everything is drawn at runtime into a canvas texture, so the project ships
 * with zero image assets: no sprite sheets to load, nothing to keep in sync,
 * and a new avatar archetype is just a palette entry.
 *
 * Each avatar becomes one 96x16 texture holding six 16x16 frames:
 *   f0 idle-front   f1 walk-front-A   f2 walk-front-B
 *   f3 idle-back    f4 walk-back-A    f5 walk-back-B
 */

import Phaser from 'phaser';
import { AVATAR_PALETTES, type AvatarPalette } from '../../protocol/world';
import type { AvatarType } from '../../protocol/events';

export const FRAME_SIZE = 16;
export const FRAME_COUNT = 6;

/** Left/right padding so the 10-wide body sits centred in a 16-wide frame. */
const PAD = '...';

/** Rows 7..13: torso, arms, belt. Shared by every frame. */
const TORSO = [
  '.oppppppo.',
  'oppppppppo',
  'oppttttppo',
  'oppddddppo',
  '.oppppppo.',
  '.obbbbbbo.',
  '.oddddddo.',
];

/** Rows 14..15, one entry per walk phase. */
const LEGS: Record<'idle' | 'a' | 'b', [string, string]> = {
  idle: ['.odd..ddo.', '.obb..bbo.'],
  a: ['.oddd.ddo.', '.obb...oo.'],
  b: ['.odd.dddo.', '.oo...bbo.'],
};

function headRows(hooded: boolean, facing: 'front' | 'back'): string[] {
  const crown = hooded ? '.ohhhhhho.' : '.otttttto.';
  if (facing === 'back') {
    return [
      '..........',
      '..oooooo..',
      crown,
      '.ohhhhhho.',
      '.ohhhhhho.',
      '.ohhhhhho.',
      '.ohhhhhho.',
    ];
  }
  return [
    '..........',
    '..oooooo..',
    crown,
    '.ohhhhhho.',
    '.ohssssho.',
    '.osEssEso.',
    '.osssssso.',
  ];
}

function buildFrame(hooded: boolean, facing: 'front' | 'back', legs: 'idle' | 'a' | 'b'): string[] {
  const inner = [...headRows(hooded, facing), ...TORSO, ...LEGS[legs]];
  const rows = inner.map((row) => PAD + row + PAD);
  if (import.meta.env.DEV) {
    rows.forEach((row, i) => {
      if (row.length !== FRAME_SIZE) {
        console.error(`pixelArt: row ${i} is ${row.length}px, expected ${FRAME_SIZE}`, row);
      }
    });
    if (rows.length !== FRAME_SIZE) {
      console.error(`pixelArt: frame has ${rows.length} rows, expected ${FRAME_SIZE}`);
    }
  }
  return rows;
}

/** Frame order must match the anim definitions in `registerAvatarAnims`. */
function buildFrames(hooded: boolean): string[][] {
  return [
    buildFrame(hooded, 'front', 'idle'),
    buildFrame(hooded, 'front', 'a'),
    buildFrame(hooded, 'front', 'b'),
    buildFrame(hooded, 'back', 'idle'),
    buildFrame(hooded, 'back', 'a'),
    buildFrame(hooded, 'back', 'b'),
  ];
}

// ---------------------------------------------------------------------------

function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 0xff) * amount);
  const g = clamp(((n >> 8) & 0xff) * amount);
  const b = clamp((n & 0xff) * amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** A caller-supplied `color` overrides the cloth slots but keeps the archetype's silhouette. */
function applyColorOverride(base: AvatarPalette, color?: string): AvatarPalette {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return base;
  return {
    ...base,
    p: color,
    d: shade(color, 0.7),
    t: shade(color, 1.35),
    h: base.hooded ? shade(color, 0.75) : base.h,
    ui: color,
  };
}

export function avatarTextureKey(type: AvatarType, color?: string): string {
  return `avatar:${type}:${color ?? 'default'}`;
}

/**
 * Create (or reuse) the texture for an archetype, and register its animations.
 * Safe to call for every agent — repeat calls hit the cache.
 */
export function ensureAvatarTexture(
  scene: Phaser.Scene,
  type: AvatarType,
  color?: string,
): string {
  const key = avatarTextureKey(type, color);
  if (scene.textures.exists(key)) {
    registerAvatarAnims(scene, key);
    return key;
  }

  const palette = applyColorOverride(AVATAR_PALETTES[type], color);
  const frames = buildFrames(palette.hooded);

  const texture = scene.textures.createCanvas(key, FRAME_SIZE * FRAME_COUNT, FRAME_SIZE);
  if (!texture) return key;
  const ctx = texture.getContext();
  ctx.imageSmoothingEnabled = false;

  frames.forEach((rows, frameIndex) => {
    const originX = frameIndex * FRAME_SIZE;
    const slots = palette as unknown as Record<string, string | boolean>;
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.') continue;
        const fill = slots[ch];
        if (typeof fill !== 'string') continue;
        ctx.fillStyle = fill;
        ctx.fillRect(originX + x, y, 1, 1);
      }
    });
    texture.add(`f${frameIndex}`, 0, originX, 0, FRAME_SIZE, FRAME_SIZE);
  });

  texture.refresh();
  registerAvatarAnims(scene, key);
  return key;
}

/** Animation keys derived from a texture key. */
export const anims = {
  idleFront: (key: string) => `${key}:idle-front`,
  walkFront: (key: string) => `${key}:walk-front`,
  idleBack: (key: string) => `${key}:idle-back`,
  walkBack: (key: string) => `${key}:walk-back`,
};

function registerAvatarAnims(scene: Phaser.Scene, key: string): void {
  const manager = scene.anims;
  if (manager.exists(anims.walkFront(key))) return;

  manager.create({
    key: anims.idleFront(key),
    frames: [{ key, frame: 'f0' }],
    frameRate: 1,
    repeat: -1,
  });
  manager.create({
    key: anims.walkFront(key),
    // f0 between steps gives the classic 4-frame retro walk cadence.
    frames: [
      { key, frame: 'f1' },
      { key, frame: 'f0' },
      { key, frame: 'f2' },
      { key, frame: 'f0' },
    ],
    frameRate: 8,
    repeat: -1,
  });
  manager.create({
    key: anims.idleBack(key),
    frames: [{ key, frame: 'f3' }],
    frameRate: 1,
    repeat: -1,
  });
  manager.create({
    key: anims.walkBack(key),
    frames: [
      { key, frame: 'f4' },
      { key, frame: 'f3' },
      { key, frame: 'f5' },
      { key, frame: 'f3' },
    ],
    frameRate: 8,
    repeat: -1,
  });
}

/** CSS colour used for this agent in the React panels. */
export function avatarUiColor(type: AvatarType, color?: string): string {
  return applyColorOverride(AVATAR_PALETTES[type], color).ui;
}

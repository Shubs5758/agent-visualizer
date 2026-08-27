/**
 * The world — now runtime state rather than a hardcoded map.
 *
 * Rooms are declared by the producer with `zone` events and placed by the
 * floorplan engine, so the grid dimensions, the walls and the walkable space
 * all change as rooms come and go. Everything that used to read a `GRID_COLS`
 * constant now reads `world.cols` at call time.
 *
 * `TILE` is the only fixed quantity left.
 */

import type { AvatarType } from './events';
import { computeFloorplan, type Floorplan } from '../game/grid/floorplan';
import { DEFAULT_ZONES, type PlacedZone, type ZoneSpec } from './zones';

export const TILE = 32;

/** Fired whenever the floorplan changes, so the scene can redraw and resize. */
export type WorldListener = (world: WorldModel) => void;

class WorldModel {
  private plan: Floorplan = computeFloorplan(DEFAULT_ZONES);
  private specs: ZoneSpec[] = [...DEFAULT_ZONES];
  private listeners = new Set<WorldListener>();
  /** True until a producer declares a room of its own. */
  private usingDefaults = true;

  get cols(): number {
    return this.plan.cols;
  }
  get rows(): number {
    return this.plan.rows;
  }
  get width(): number {
    return this.plan.cols * TILE;
  }
  get height(): number {
    return this.plan.rows * TILE;
  }
  get zones(): PlacedZone[] {
    return this.plan.zones;
  }
  get isDefault(): boolean {
    return this.usingDefaults;
  }

  zone(id: string): PlacedZone | undefined {
    return this.plan.zones.find((z) => z.id === id);
  }

  isBlocked(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.plan.cols || y >= this.plan.rows) return true;
    return this.plan.blocked.has(`${x},${y}`);
  }

  subscribe(listener: WorldListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(): void {
    this.plan = computeFloorplan(this.specs);
    for (const listener of this.listeners) listener(this);
  }

  /**
   * Declare (or update) a room. The first producer-declared room clears the
   * built-in default world — a backend that describes itself should not end up
   * with someone else's Tool Forge sitting in the corner.
   */
  declareZone(spec: ZoneSpec): void {
    if (this.usingDefaults) {
      this.specs = [];
      this.usingDefaults = false;
    }
    const at = this.specs.findIndex((s) => s.id === spec.id);
    if (at >= 0) this.specs[at] = spec;
    else this.specs.push(spec);
    this.commit();
  }

  removeZone(id: string): void {
    const before = this.specs.length;
    this.specs = this.specs.filter((s) => s.id !== id);
    if (this.specs.length !== before) this.commit();
  }

  /** Back to the built-in world. Used by `reset`. */
  restoreDefaults(): void {
    this.specs = [...DEFAULT_ZONES];
    this.usingDefaults = true;
    this.commit();
  }
}

export const world = new WorldModel();

// ---------------------------------------------------------------------------
// Geometry helpers — all read the live world
// ---------------------------------------------------------------------------

export function isBlocked(x: number, y: number): boolean {
  return world.isBlocked(x, y);
}

export function clampToGrid(pos: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(world.cols - 1, Math.round(pos.x))),
    y: Math.max(0, Math.min(world.rows - 1, Math.round(pos.y))),
  };
}

/** Centre of a tile, in world pixels. */
export function tileToWorld(x: number, y: number): { x: number; y: number } {
  return { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
}

/**
 * Where an agent should stand when sent to a room.
 *
 * Rooms have numbered workstations, so agents take the first free desk rather
 * than crowding the nearest free tile. Once the desks are full, arrivals wait
 * on the corridor side of the door instead of stacking on top of each other —
 * which is what makes a busy room readable.
 */
export function seatInZone(
  zone: PlacedZone,
  isOccupied: (x: number, y: number) => boolean = () => false,
): { x: number; y: number; seated: boolean } {
  for (const desk of zone.desks) {
    if (!isOccupied(desk.x, desk.y)) return { ...desk, seated: true };
  }
  // Overflow: queue outward from the door, along the corridor.
  const step: Record<PlacedZone['doorSide'], [number, number]> = {
    north: [0, -1],
    south: [0, 1],
    west: [-1, 0],
    east: [1, 0],
  };
  const [dx, dy] = step[zone.doorSide];
  for (let n = 1; n <= 8; n++) {
    for (const lateral of [0, -1, 1, -2, 2]) {
      const x = zone.door.x + dx * n + (dx === 0 ? lateral : 0);
      const y = zone.door.y + dy * n + (dy === 0 ? lateral : 0);
      if (!world.isBlocked(x, y) && !isOccupied(x, y)) return { x, y, seated: false };
    }
  }
  return { ...zone.door, seated: false };
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

/**
 * A* over the tile grid.
 *
 * Only static obstacles block movement — agents deliberately do *not* block each
 * other. Treating them as obstacles produces deadlocks the moment two agents
 * are told to swap zones, and a brief sprite overlap reads far better than a
 * stuck agent.
 */

import { isBlocked, world } from '../../protocol/world';

export interface GridPos {
  x: number;
  y: number;
}

type Blocked = (x: number, y: number) => boolean;

const NEIGHBOURS: ReadonlyArray<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Grid dimensions are runtime state now — read them per call, not at import. */
const idx = (x: number, y: number, cols: number) => y * cols + x;

function manhattan(a: GridPos, b: GridPos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function samePos(a: GridPos | null, b: GridPos | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

/**
 * @returns tiles from the first step up to and including `goal`.
 *          Empty when already there, or when no route exists.
 */
export function findPath(
  start: GridPos,
  goal: GridPos,
  blocked: Blocked = isBlocked,
): GridPos[] {
  if (samePos(start, goal)) return [];
  if (blocked(goal.x, goal.y)) return [];

  const cols = world.cols;
  const rows = world.rows;
  const total = cols * rows;
  const cameFrom = new Int32Array(total).fill(-1);
  const gScore = new Float64Array(total).fill(Number.POSITIVE_INFINITY);
  const closed = new Uint8Array(total);

  const startIdx = idx(start.x, start.y, cols);
  gScore[startIdx] = 0;

  // Grids stay small (a few thousand tiles even for a large floorplan), so a
  // sorted-insert open list beats a heap's overhead and keeps this readable.
  const open: { i: number; f: number }[] = [{ i: startIdx, f: manhattan(start, goal) }];

  while (open.length) {
    const current = open.shift()!;
    if (closed[current.i]) continue;
    closed[current.i] = 1;

    const cx = current.i % cols;
    const cy = Math.floor(current.i / cols);

    if (cx === goal.x && cy === goal.y) {
      const path: GridPos[] = [];
      let node = current.i;
      while (node !== startIdx && node !== -1) {
        path.push({ x: node % cols, y: Math.floor(node / cols) });
        node = cameFrom[node];
      }
      return path.reverse();
    }

    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (blocked(nx, ny)) continue;
      const ni = idx(nx, ny, cols);
      if (closed[ni]) continue;

      const tentative = gScore[current.i] + 1;
      if (tentative >= gScore[ni]) continue;

      cameFrom[ni] = current.i;
      gScore[ni] = tentative;
      const f = tentative + manhattan({ x: nx, y: ny }, goal);

      let lo = 0;
      let hi = open.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (open[mid].f < f) lo = mid + 1;
        else hi = mid;
      }
      open.splice(lo, 0, { i: ni, f });
    }
  }

  return [];
}

/** Breadth-first search outwards for the closest tile that is not blocked. */
export function nearestFree(
  goal: GridPos,
  blocked: Blocked = isBlocked,
  isTaken: (x: number, y: number) => boolean = () => false,
): GridPos {
  if (!blocked(goal.x, goal.y) && !isTaken(goal.x, goal.y)) return goal;

  const cols = world.cols;
  const rows = world.rows;
  const seen = new Set<number>([idx(goal.x, goal.y, cols)]);
  const frontier: GridPos[] = [goal];

  while (frontier.length) {
    const node = frontier.shift()!;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = node.x + dx;
      const ny = node.y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = idx(nx, ny, cols);
      if (seen.has(ni)) continue;
      seen.add(ni);
      if (!blocked(nx, ny) && !isTaken(nx, ny)) return { x: nx, y: ny };
      frontier.push({ x: nx, y: ny });
    }
  }
  return goal;
}

/**
 * A free tile beside `target`, preferring the side `from` is approaching from
 * so agents meet face to face instead of walking around each other.
 */
export function adjacentTo(
  target: GridPos,
  from: GridPos,
  blocked: Blocked = isBlocked,
  isTaken: (x: number, y: number) => boolean = () => false,
): GridPos {
  const options = NEIGHBOURS.map(([dx, dy]) => ({ x: target.x + dx, y: target.y + dy }))
    .filter((p) => p.x >= 0 && p.y >= 0 && p.x < world.cols && p.y < world.rows)
    .filter((p) => !blocked(p.x, p.y) && !isTaken(p.x, p.y))
    .sort((a, b) => manhattan(a, from) - manhattan(b, from));

  return options[0] ?? nearestFree(target, blocked, isTaken);
}

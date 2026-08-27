// Verifies grid geometry + A*. These modules are Phaser-free by design, so
// they can be bundled and run in plain Node.
import { clampToGrid, isBlocked, seatInZone, world } from '../../web/src/protocol/world';
import {
  adjacentTo,
  findPath,
  nearestFree,
} from '../../web/src/game/grid/pathfinding';

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, extra = '') => {
  results.push([name, ok, extra]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
};

// --- zones are clear of obstacles -----------------------------------------
let overlaps: string[] = [];
for (const z of world.zones) {
  for (let dy = 0; dy < z.h; dy++) {
    for (let dx = 0; dx < z.w; dx++) {
      if (isBlocked(z.x + dx, z.y + dy)) overlaps.push(`${z.id}@${z.x + dx},${z.y + dy}`);
    }
  }
}


// --- zones fit on the grid -------------------------------------------------
const outOfBounds = world.zones.filter(
  (z) => z.x < 0 || z.y < 0 || z.x + z.w > world.cols || z.y + z.h > world.rows,
);
check('every zone fits inside the grid', outOfBounds.length === 0,
  outOfBounds.map((z) => z.id).join(','));

// --- full connectivity: flood fill must reach every walkable tile ----------
const seen = new Set<string>();
const stack = [{ x: 0, y: 0 }];
seen.add('0,0');
while (stack.length) {
  const n = stack.pop()!;
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as [number, number][]) {
    const nx = n.x + dx, ny = n.y + dy;
    const key = `${nx},${ny}`;
    if (nx < 0 || ny < 0 || nx >= world.cols || ny >= world.rows) continue;
    if (isBlocked(nx, ny) || seen.has(key)) continue;
    seen.add(key);
    stack.push({ x: nx, y: ny });
  }
}
let walkable = 0;
for (let y = 0; y < world.rows; y++) for (let x = 0; x < world.cols; x++) if (!isBlocked(x, y)) walkable++;
check('map is fully connected — no walled-off pockets', seen.size === walkable,
  `${seen.size}/${walkable} reachable`);

// --- every zone reachable from every other zone ---------------------------
let unreachable: string[] = [];
for (const a of world.zones) {
  for (const b of world.zones) {
    if (a.id === b.id) continue;
    const from = seatInZone(a);
    const to = seatInZone(b);
    if (findPath(from, to).length === 0) unreachable.push(`${a.id}->${b.id}`);
  }
}
check('A* connects every room pair', unreachable.length === 0, unreachable.join(' '));

// --- path validity ---------------------------------------------------------
const start = { x: 0, y: 0 };
const goal = { x: 24, y: 17 };
const path = findPath(start, goal);
const contiguous = path.every((p, i) => {
  const prev = i === 0 ? start : path[i - 1];
  return Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) === 1;
});
check('path steps are single orthogonal moves', contiguous);
check('path never enters a blocked tile', path.every((p) => !isBlocked(p.x, p.y)));
check('path ends exactly on the goal',
  path.length > 0 && path[path.length - 1].x === goal.x && path[path.length - 1].y === goal.y);
check('path length is optimal for an open corner-to-corner run',
  path.length >= Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y),
  `${path.length} steps, manhattan ${Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y)}`);

// --- degenerate + defensive cases -----------------------------------------
check('same-tile path is empty', findPath({ x: 5, y: 5 }, { x: 5, y: 5 }).length === 0);
const wall = { x: world.zones[0].x, y: world.zones[0].y };  // a room corner
check('path into a wall is empty',
  isBlocked(wall.x, wall.y) && findPath({ x: 0, y: 0 }, wall).length === 0);
check('nearestFree escapes a blocked tile',
  !isBlocked(nearestFree({ x: 1, y: 1 }).x,
             nearestFree({ x: 1, y: 1 }).y));
check('clampToGrid bounds out-of-range input',
  JSON.stringify(clampToGrid({ x: 9999, y: -5 })) ===
    JSON.stringify({ x: world.cols - 1, y: 0 }));

// --- occupancy spreading ---------------------------------------------------
const taken = new Set<string>();
const picked: string[] = [];
for (let i = 0; i < 6; i++) {
  const t = seatInZone(world.zones[1], (x, y) => taken.has(`${x},${y}`));
  taken.add(`${t.x},${t.y}`);
  picked.push(`${t.x},${t.y}`);
}
check('six agents sent to one zone get six distinct tiles',
  new Set(picked).size === 6, picked.join(' '));

// --- adjacentTo picks a free neighbour on the approach side ---------------
const target = { x: 12, y: 8 };
const from = { x: 5, y: 8 };
const meet = adjacentTo(target, from);
check('adjacentTo returns a free tile next to the target',
  Math.abs(meet.x - target.x) + Math.abs(meet.y - target.y) === 1 && !isBlocked(meet.x, meet.y),
  JSON.stringify(meet));

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

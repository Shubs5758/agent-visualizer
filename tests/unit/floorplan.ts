// Floorplan engine: overlap, reachability, desk spacing, and scaling.
import {
  computeFloorplan,
  roomSize,
  CORRIDOR,
  DESK_PITCH,
} from '../../web/src/game/grid/floorplan';
import type { ZoneSpec } from '../../web/src/protocol/zones';
import { DEFAULT_ZONES } from '../../web/src/protocol/zones';

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, extra = '') => {
  results.push([name, ok, extra]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
};

function spec(id: string, capacity: number, kind = 'custom'): ZoneSpec {
  return { id, label: id.toUpperCase(), kind: kind as ZoneSpec['kind'], capacity };
}

/** Flood fill the corridor+interior space and report which doors were reached. */
function reachability(plan: ReturnType<typeof computeFloorplan>) {
  const { cols, rows, blocked } = plan;
  const walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < cols && y < rows && !blocked.has(`${x},${y}`);
  const seen = new Set<string>();
  const start = { x: 0, y: 0 };
  if (!walkable(start.x, start.y)) return { seen, walkableCount: 0 };
  const stack = [start];
  seen.add('0,0');
  while (stack.length) {
    const n = stack.pop()!;
    for (const [dx, dy] of [[0,-1],[1,0],[0,1],[-1,0]] as [number,number][]) {
      const nx = n.x + dx, ny = n.y + dy, key = `${nx},${ny}`;
      if (!walkable(nx, ny) || seen.has(key)) continue;
      seen.add(key);
      stack.push({ x: nx, y: ny });
    }
  }
  let walkableCount = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (walkable(x, y)) walkableCount++;
  return { seen, walkableCount };
}

// --- the default world -----------------------------------------------------
const plan = computeFloorplan(DEFAULT_ZONES);
console.log(`default world: ${plan.zones.length} rooms on a ${plan.cols}x${plan.rows} grid`);

let overlaps: string[] = [];
for (let i = 0; i < plan.zones.length; i++) {
  for (let j = i + 1; j < plan.zones.length; j++) {
    const a = plan.zones[i], b = plan.zones[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
      overlaps.push(`${a.id}/${b.id}`);
    }
  }
}
check('no two rooms overlap', overlaps.length === 0, overlaps.join(' '));

check('every room fits inside the grid',
  plan.zones.every((z) => z.x >= 0 && z.y >= 0 && z.x + z.w <= plan.cols && z.y + z.h <= plan.rows));

const { seen, walkableCount } = reachability(plan);
check('all walkable tiles form one connected space', seen.size === walkableCount,
  `${seen.size}/${walkableCount} reachable from (0,0)`);

check('every door is reachable from the corridor',
  plan.zones.every((z) => seen.has(`${z.door.x},${z.door.y}`)),
  plan.zones.filter((z) => !seen.has(`${z.door.x},${z.door.y}`)).map((z) => z.id).join(' '));

check('every desk is reachable',
  plan.zones.every((z) => z.desks.every((d) => seen.has(`${d.x},${d.y}`))));

check('every room seats EXACTLY its declared capacity',
  plan.zones.every((z) => z.desks.length === Math.max(1, z.capacity)),
  plan.zones.map((z) => `${z.id}:${z.desks.length}/${z.capacity}`).join(' '));

check(`desks are >= ${DESK_PITCH} tiles apart`,
  plan.zones.every((z) => z.desks.every((a, i) =>
    z.desks.every((b, j) => i === j || Math.abs(a.x-b.x) + Math.abs(a.y-b.y) >= DESK_PITCH))));

check('doors sit in a wall, not a corner',
  plan.zones.every((z) => {
    const onV = z.door.x === z.x || z.door.x === z.x + z.w - 1;
    const onH = z.door.y === z.y || z.door.y === z.y + z.h - 1;
    return (onV || onH) && !(onV && onH);
  }));

// --- a realistic modern agentic system -------------------------------------
const modern: ZoneSpec[] = [
  spec('gateway', 4, 'gateway'), spec('registry', 4, 'registry'),
  spec('vectors', 8, 'memory'), spec('mcp_github', 6, 'mcp'),
  spec('mcp_slack', 4, 'mcp'), spec('evals', 9, 'eval'),
  spec('guardrails', 3, 'guardrail'), spec('llm', 6, 'llm'),
  spec('tools', 6, 'tools'), spec('output', 4, 'output'),
];
const big = computeFloorplan(modern);
const bigReach = reachability(big);
console.log(`\nmodern world: ${big.zones.length} rooms on a ${big.cols}x${big.rows} grid`);
check('10-room floorplan is fully connected', bigReach.seen.size === bigReach.walkableCount,
  `${bigReach.seen.size}/${bigReach.walkableCount}`);
check('10-room: all doors reachable',
  big.zones.every((z) => bigReach.seen.has(`${z.door.x},${z.door.y}`)));
check('10-room: no overlaps', big.zones.every((a, i) => big.zones.every((b, j) =>
  i === j || !(a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h))));
check('10-room: seats == declared capacity in every room',
  big.zones.every((z) => z.desks.length === Math.max(1, z.capacity)),
  `${big.zones.reduce((s, z) => s + z.desks.length, 0)} desks`);

// --- stress: does it survive silly inputs? ---------------------------------
for (const n of [1, 2, 3, 7, 25, 40]) {
  const many = Array.from({ length: n }, (_, i) => spec(`z${i}`, 1 + (i % 9)));
  const p = computeFloorplan(many);
  const r = reachability(p);
  const ok = r.seen.size === r.walkableCount &&
    p.zones.every((z) => r.seen.has(`${z.door.x},${z.door.y}`)) &&
    p.zones.every((a, i) => p.zones.every((b, j) => i === j ||
      !(a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h)));
  check(`${String(n).padStart(2)} rooms: connected, no overlap`, ok, `${p.cols}x${p.rows} grid`);
}

check('zero rooms does not crash', computeFloorplan([]).zones.length === 0);
check('capacity 0 still gets a desk', computeFloorplan([spec('z', 0)]).zones[0].desks.length >= 1);

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

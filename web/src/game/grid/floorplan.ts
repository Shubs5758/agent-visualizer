/**
 * Floorplan engine — turns a list of declared rooms into an office floor.
 *
 * Pure and Phaser-free so it can be unit-tested in plain Node. Given N rooms of
 * any capacities it produces non-overlapping rooms, a corridor network that
 * reaches every door, workstation tiles inside each room, and the grid size
 * needed to hold it all.
 *
 * The layout is a grid of cells with a corridor ring around the whole floor and
 * corridor gaps between cells. That ring is what makes connectivity trivially
 * true: every room is surrounded by corridor on all four sides, so no room can
 * ever be walled off no matter how many are declared.
 */

import type { PlacedZone, ZoneSpec } from '../../protocol/zones';
import { ZONE_STYLES } from '../../protocol/zones';

/** Corridor width, in tiles — also the margin around the whole floor. */
export const CORRIDOR = 2;
/**
 * Tiles between adjacent workstations. Sprites render 48px wide on 32px tiles,
 * so desks one tile apart would still overlap; two is the minimum that keeps
 * neighbouring agents visually separate.
 */
export const DESK_PITCH = 2;

const MIN_INTERIOR = 3;

export interface Floorplan {
  zones: PlacedZone[];
  cols: number;
  rows: number;
  /** "x,y" of every tile an agent cannot walk through. */
  blocked: Set<string>;
}

/** Room footprint big enough to seat `capacity` agents at spaced desks. */
export function roomSize(capacity: number): { w: number; h: number; deskCols: number; deskRows: number } {
  const seats = Math.max(1, Math.floor(capacity) || 1);
  const deskCols = Math.ceil(Math.sqrt(seats));
  const deskRows = Math.ceil(seats / deskCols);
  const interiorW = Math.max(MIN_INTERIOR, deskCols * DESK_PITCH + 1);
  const interiorH = Math.max(MIN_INTERIOR, deskRows * DESK_PITCH + 1);
  return { w: interiorW + 2, h: interiorH + 2, deskCols, deskRows };
}

/** Which wall to cut the door into: the one facing the middle of the floor. */
function pickDoorSide(
  x: number,
  y: number,
  w: number,
  h: number,
  cols: number,
  rows: number,
): PlacedZone['doorSide'] {
  const dx = cols / 2 - (x + w / 2);
  const dy = rows / 2 - (y + h / 2);
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? 'south' : 'north';
  return dx >= 0 ? 'east' : 'west';
}

function doorTile(
  zone: { x: number; y: number; w: number; h: number },
  side: PlacedZone['doorSide'],
): { x: number; y: number } {
  const midX = zone.x + Math.floor(zone.w / 2);
  const midY = zone.y + Math.floor(zone.h / 2);
  switch (side) {
    case 'north':
      return { x: midX, y: zone.y };
    case 'south':
      return { x: midX, y: zone.y + zone.h - 1 };
    case 'west':
      return { x: zone.x, y: midY };
    case 'east':
      return { x: zone.x + zone.w - 1, y: midY };
  }
}

/**
 * Lay out the given rooms.
 *
 * Rooms are placed into a uniform grid of cells sized to the largest room, then
 * centred within their cell — leftover cell space simply becomes more corridor,
 * which is harmless and keeps the arithmetic simple.
 */
export function computeFloorplan(specs: ZoneSpec[]): Floorplan {
  if (specs.length === 0) {
    return { zones: [], cols: 12, rows: 9, blocked: new Set() };
  }

  const sized = specs.map((spec) => ({ spec, size: roomSize(spec.capacity) }));
  const gridCols = Math.ceil(Math.sqrt(sized.length));
  const gridRows = Math.ceil(sized.length / gridCols);
  const cellW = Math.max(...sized.map((s) => s.size.w));
  const cellH = Math.max(...sized.map((s) => s.size.h));

  const cols = CORRIDOR * 2 + gridCols * cellW + (gridCols - 1) * CORRIDOR;
  const rows = CORRIDOR * 2 + gridRows * cellH + (gridRows - 1) * CORRIDOR;

  const zones: PlacedZone[] = [];
  const blocked = new Set<string>();

  sized.forEach(({ spec, size }, index) => {
    const gc = index % gridCols;
    const gr = Math.floor(index / gridCols);
    const cellX = CORRIDOR + gc * (cellW + CORRIDOR);
    const cellY = CORRIDOR + gr * (cellH + CORRIDOR);
    // Centre the room in its cell so smaller rooms don't hug one corner.
    const x = cellX + Math.floor((cellW - size.w) / 2);
    const y = cellY + Math.floor((cellH - size.h) / 2);

    const doorSide = pickDoorSide(x, y, size.w, size.h, cols, rows);
    const door = doorTile({ x, y, w: size.w, h: size.h }, doorSide);

    // Walls are the room's outline; every wall tile blocks except the door.
    for (let ix = x; ix < x + size.w; ix++) {
      for (let iy = y; iy < y + size.h; iy++) {
        const onEdge = ix === x || iy === y || ix === x + size.w - 1 || iy === y + size.h - 1;
        if (onEdge && !(ix === door.x && iy === door.y)) blocked.add(`${ix},${iy}`);
      }
    }

    // Workstations on the desk pitch inside the walls. Desks are positions,
    // not obstacles, and agents never block each other's pathfinding — so a
    // desk beside the door costs nothing, and skipping those tiles would leave
    // the room seating fewer agents than it declared.
    const seats = Math.max(1, Math.floor(spec.capacity) || 1);
    const desks: { x: number; y: number }[] = [];
    for (let dr = 0; dr < size.deskRows && desks.length < seats; dr++) {
      for (let dc = 0; dc < size.deskCols && desks.length < seats; dc++) {
        const dx = x + 1 + dc * DESK_PITCH;
        const dy = y + 1 + dr * DESK_PITCH;
        if (dx >= x + size.w - 1 || dy >= y + size.h - 1) continue;
        desks.push({ x: dx, y: dy });
      }
    }

    zones.push({
      ...spec,
      x,
      y,
      w: size.w,
      h: size.h,
      door,
      doorSide,
      desks,
      style: ZONE_STYLES[spec.kind],
    });
  });

  return { zones, cols, rows, blocked };
}

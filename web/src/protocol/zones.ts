/**
 * Rooms — the runtime-declared parts of the world.
 *
 * The world used to be five hardcoded rectangles (Gateway, Library, Tool Forge,
 * Council, Vault). That was invented furniture: a real agentic system has MCP
 * servers, eval harnesses, an agent registry, vector stores and guardrails, and
 * none of those could be expressed.
 *
 * Now the backend declares its own rooms with `zone` events and the floorplan
 * is laid out automatically. The five originals survive only as a *default*
 * world for producers that declare nothing.
 */

/**
 * What a room is for. Drives its colour, floor material and furniture — so a
 * producer never has to think about pixels, only about what the room *is*.
 */
export const ZONE_KINDS = [
  'gateway',
  'registry',
  'memory',
  'tools',
  'mcp',
  'llm',
  'eval',
  'guardrail',
  'council',
  'output',
  'custom',
] as const;

export type ZoneKind = (typeof ZONE_KINDS)[number];

export interface ZoneStyle {
  /** Room floor. */
  floor: number;
  /** Walls, door frame, plaque text. */
  accent: number;
  /** Furniture drawn inside the room. */
  furniture: 'desks' | 'racks' | 'shelves' | 'benches' | 'table' | 'crates' | 'none';
  /** Shown in the roster legend. */
  blurb: string;
}

/**
 * One style per kind. Accents are spaced around the hue circle so adjacent
 * rooms on the floorplan stay tellable apart; they are *place* colours and are
 * deliberately distinct from the agent identity palette in `world.ts`.
 */
export const ZONE_STYLES: Record<ZoneKind, ZoneStyle> = {
  gateway: { floor: 0x11283a, accent: 0x4ecdf5, furniture: 'benches', blurb: 'Entry / spawn' },
  registry: { floor: 0x14293b, accent: 0x63b3ed, furniture: 'shelves', blurb: 'Agent registry' },
  memory: { floor: 0x241f3d, accent: 0xa78bfa, furniture: 'shelves', blurb: 'Memory / vector store' },
  tools: { floor: 0x3a2612, accent: 0xffa940, furniture: 'benches', blurb: 'Tool execution' },
  mcp: { floor: 0x122d33, accent: 0x2dd4bf, furniture: 'racks', blurb: 'MCP server' },
  llm: { floor: 0x2a1f3a, accent: 0xc084fc, furniture: 'desks', blurb: 'Model calls' },
  eval: { floor: 0x14301f, accent: 0x4ade80, furniture: 'desks', blurb: 'Evaluation / QA' },
  guardrail: { floor: 0x3a2018, accent: 0xfb7185, furniture: 'benches', blurb: 'Guardrails / safety' },
  council: { floor: 0x1b2c40, accent: 0x93c5fd, furniture: 'table', blurb: 'Deliberation' },
  output: { floor: 0x35142a, accent: 0xff5c8a, furniture: 'crates', blurb: 'Artifacts / output' },
  custom: { floor: 0x1e2636, accent: 0x94a3b8, furniture: 'desks', blurb: 'Custom' },
};

/** A room as declared by a producer, before layout. */
export interface ZoneSpec {
  id: string;
  label: string;
  kind: ZoneKind;
  /** How many agents work here at once. Drives room size and desk count. */
  capacity: number;
  /** Optional `#rrggbb` accent override. */
  color?: string;
}

/** A room after the floorplan engine has placed it. Tile coordinates. */
export interface PlacedZone extends ZoneSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Tile just inside the room, on the corridor wall. */
  door: { x: number; y: number };
  /** Which wall the door sits in. */
  doorSide: 'north' | 'south' | 'east' | 'west';
  /** Workstation tiles inside the room, in assignment order. */
  desks: { x: number; y: number }[];
  style: ZoneStyle;
}

export function normaliseKind(value: string | undefined): ZoneKind {
  if (value && (ZONE_KINDS as readonly string[]).includes(value)) return value as ZoneKind;
  return 'custom';
}

/**
 * The world used when a producer declares no rooms of its own. Same ids as the
 * original hardcoded zones, so existing `target_zone` values keep working.
 */
export const DEFAULT_ZONES: ZoneSpec[] = [
  { id: 'gateway', label: 'GATEWAY', kind: 'gateway', capacity: 4 },
  { id: 'library', label: 'LIBRARY · MEMORY', kind: 'memory', capacity: 6 },
  { id: 'tools', label: 'TOOL FORGE', kind: 'tools', capacity: 6 },
  { id: 'council', label: 'COUNCIL', kind: 'council', capacity: 6 },
  { id: 'vault', label: 'VAULT · OUTPUT', kind: 'output', capacity: 4 },
];

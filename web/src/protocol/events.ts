/**
 * Agent Visualizer Event Protocol v1 — TypeScript definitions.
 *
 * The canonical spec lives in `protocol/PROTOCOL.md` and
 * `protocol/agent-events.schema.json`. Keep all three in sync.
 */

export const PROTOCOL_VERSION = '1.0.0';

export interface GridPos {
  x: number;
  y: number;
}

export type ZoneId = 'gateway' | 'library' | 'tools' | 'council' | 'vault';

/**
 * Order matters: it is the validated categorical slot order of the agent
 * palette in `world.ts`, and unknown avatar names hash onto this list, so
 * agents auto-assigned in sequence get maximally distinguishable colours.
 */
export const AVATAR_TYPES = [
  'knight',
  'artificer',
  'rogue',
  'cleric',
  'bard',
  'ranger',
  'mage',
  'druid',
] as const;

export type AvatarType = (typeof AVATAR_TYPES)[number];

export type InteractionType =
  | 'dialogue'
  | 'handoff'
  | 'request'
  | 'response'
  | 'broadcast';

/** Fields shared by every event on the wire. */
export interface Envelope {
  ts?: number;
  run_id?: string;
  seq?: number;
}

export interface RegisterAgentEvent extends Envelope {
  event: 'register';
  agent_id: string;
  name?: string;
  role?: string;
  avatar_type?: AvatarType | string;
  initial_pos?: GridPos;
  color?: string;
}

export interface AgentMoveEvent extends Envelope {
  event: 'move';
  agent_id: string;
  target_pos?: GridPos;
  target_zone?: ZoneId | string;
  speed?: number;
}

export interface AgentCommunicateEvent extends Envelope {
  event: 'communicate';
  source_agent_id: string;
  target_agent_id?: string | null;
  message: string;
  interaction_type?: InteractionType | string;
}

export interface AgentMetrics {
  tokens?: number;
  latency_ms?: number;
  cost_usd?: number;
  [key: string]: number | undefined;
}

export interface AgentStateUpdateEvent extends Envelope {
  event: 'state_update';
  agent_id: string;
  status: string;
  detail?: string;
  metrics?: AgentMetrics;
}

export interface GraphUpdateEvent extends Envelope {
  event: 'graph_edge';
  source: string;
  target: string;
  weight?: number;
  label?: string;
}

export interface UnregisterEvent extends Envelope {
  event: 'unregister';
  agent_id: string;
}

export interface ResetEvent extends Envelope {
  event: 'reset';
}

/** Declares (or updates) a room. See `protocol/zones.ts` for the kinds. */
export interface ZoneEvent extends Envelope {
  event: 'zone';
  zone_id: string;
  label?: string;
  kind?: string;
  capacity?: number;
  color?: string;
}

export interface ZoneRemoveEvent extends Envelope {
  event: 'zone_remove';
  zone_id: string;
}

/** Server → viewer only. */
export interface SnapshotEvent extends Envelope {
  event: 'snapshot';
  agents: RegisterAgentEvent[];
  edges: GraphUpdateEvent[];
  recent: AgentEvent[];
  /** Rooms the producer declared, so a late viewer rebuilds the same floor. */
  zones?: ZoneEvent[];
}

/** Server → viewer only. */
export interface ServerInfoEvent extends Envelope {
  event: 'server_info';
  clients: number;
  buffered: number;
  version: string;
}

/** Events a producer may send. */
export type AgentEvent =
  | RegisterAgentEvent
  | AgentMoveEvent
  | AgentCommunicateEvent
  | AgentStateUpdateEvent
  | GraphUpdateEvent
  | UnregisterEvent
  | ResetEvent
  | ZoneEvent
  | ZoneRemoveEvent;

/** Everything a viewer may receive. */
export type IncomingEvent = AgentEvent | SnapshotEvent | ServerInfoEvent;

export const PRODUCER_EVENT_TYPES = [
  'register',
  'move',
  'communicate',
  'state_update',
  'graph_edge',
  'unregister',
  'reset',
  'zone',
  'zone_remove',
] as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isGridPos(v: unknown): v is GridPos {
  return isObject(v) && typeof v.x === 'number' && typeof v.y === 'number';
}

/**
 * Structural validation of a raw wire payload.
 *
 * Deliberately permissive about extra fields — forwards-compatibility matters
 * more than strictness here — but strict about the fields the scene relies on,
 * so a malformed payload can never crash the renderer.
 *
 * @returns the event when valid, otherwise a reason string.
 */
export function parseEvent(raw: unknown): IncomingEvent | { error: string } {
  if (!isObject(raw)) return { error: 'payload is not an object' };
  const type = raw.event;
  if (!isNonEmptyString(type)) return { error: 'missing "event" field' };

  switch (type) {
    case 'register':
      if (!isNonEmptyString(raw.agent_id)) return { error: 'register: missing agent_id' };
      if (raw.initial_pos !== undefined && !isGridPos(raw.initial_pos)) {
        return { error: 'register: initial_pos must be {x,y}' };
      }
      return raw as unknown as RegisterAgentEvent;

    case 'move':
      if (!isNonEmptyString(raw.agent_id)) return { error: 'move: missing agent_id' };
      if (raw.target_pos !== undefined && !isGridPos(raw.target_pos)) {
        return { error: 'move: target_pos must be {x,y}' };
      }
      if (raw.target_pos === undefined && !isNonEmptyString(raw.target_zone)) {
        return { error: 'move: needs target_pos or target_zone' };
      }
      return raw as unknown as AgentMoveEvent;

    case 'communicate':
      if (!isNonEmptyString(raw.source_agent_id)) {
        return { error: 'communicate: missing source_agent_id' };
      }
      if (typeof raw.message !== 'string') {
        return { error: 'communicate: missing message' };
      }
      return raw as unknown as AgentCommunicateEvent;

    case 'state_update':
      if (!isNonEmptyString(raw.agent_id)) return { error: 'state_update: missing agent_id' };
      if (typeof raw.status !== 'string') return { error: 'state_update: missing status' };
      return raw as unknown as AgentStateUpdateEvent;

    case 'graph_edge':
      if (!isNonEmptyString(raw.source) || !isNonEmptyString(raw.target)) {
        return { error: 'graph_edge: needs source and target' };
      }
      return raw as unknown as GraphUpdateEvent;

    case 'unregister':
      if (!isNonEmptyString(raw.agent_id)) return { error: 'unregister: missing agent_id' };
      return raw as unknown as UnregisterEvent;

    case 'reset':
      return raw as unknown as ResetEvent;

    case 'zone':
      if (!isNonEmptyString(raw.zone_id)) return { error: 'zone: missing zone_id' };
      return raw as unknown as ZoneEvent;

    case 'zone_remove':
      if (!isNonEmptyString(raw.zone_id)) return { error: 'zone_remove: missing zone_id' };
      return raw as unknown as ZoneRemoveEvent;

    case 'snapshot':
      return {
        ...(raw as object),
        agents: Array.isArray(raw.agents) ? raw.agents : [],
        edges: Array.isArray(raw.edges) ? raw.edges : [],
        recent: Array.isArray(raw.recent) ? raw.recent : [],
        zones: Array.isArray(raw.zones) ? raw.zones : [],
      } as SnapshotEvent;

    case 'server_info':
      return raw as unknown as ServerInfoEvent;

    default:
      return { error: `unknown event type "${type}"` };
  }
}

export function isParseError(v: unknown): v is { error: string } {
  return isObject(v) && typeof v.error === 'string';
}

/** Deterministically map any string onto one of the built-in avatar archetypes. */
export function resolveAvatarType(value: string | undefined): AvatarType {
  if (value && (AVATAR_TYPES as readonly string[]).includes(value)) {
    return value as AvatarType;
  }
  const seed = value ?? '';
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TYPES[hash % AVATAR_TYPES.length];
}

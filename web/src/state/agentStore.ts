/**
 * The dashboard's single source of truth.
 *
 * Implemented as a plain external store consumed through `useSyncExternalStore`
 * rather than Context: protocol events can arrive dozens of times per second,
 * and this keeps re-renders scoped to components that actually read the slice
 * that changed — no provider re-render cascade, no extra dependency.
 */

import { useSyncExternalStore } from 'react';
import type {
  AgentEvent,
  AgentMetrics,
  AvatarType,
  IncomingEvent,
  SnapshotEvent,
} from '../protocol/events';
import { resolveAvatarType } from '../protocol/events';
import { AVATAR_PALETTES } from '../protocol/world';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  avatarType: AvatarType;
  color: string;
  status: string;
  detail?: string;
  metrics: AgentMetrics;
  online: boolean;
  lastSeen: number;
  /** Counters shown in the roster. */
  messages: number;
  updates: number;
}

export type FeedKind =
  | 'register'
  | 'move'
  | 'communicate'
  | 'state'
  | 'edge'
  | 'system'
  | 'error';

export interface FeedEntry {
  id: string;
  ts: number;
  kind: FeedKind;
  agentId?: string;
  agentName?: string;
  color: string;
  title: string;
  body?: string;
  metrics?: AgentMetrics;
}

export interface ZoneRecord {
  id: string;
  label: string;
  kind: string;
  capacity: number;
  color?: string;
}

export interface EdgeRecord {
  source: string;
  target: string;
  weight: number;
}

export interface Totals {
  events: number;
  messages: number;
  tokens: number;
  toolCalls: number;
  /** Rolling mean of every `latency_ms` we have seen. */
  avgLatencyMs: number;
}

export interface VisualizerState {
  agents: AgentRecord[];
  feed: FeedEntry[];
  edges: EdgeRecord[];
  zones: ZoneRecord[];
  totals: Totals;
  connection: ConnectionStatus;
  connectionDetail: string;
  paused: boolean;
}

const FEED_LIMIT = 400;

const SYSTEM_COLOR = '#7d8da1';

function metricsColor(status: string): FeedKind {
  return /^error/i.test(status) ? 'error' : 'state';
}

class AgentStore {
  private listeners = new Set<() => void>();
  private agents = new Map<string, AgentRecord>();
  private edges = new Map<string, EdgeRecord>();
  private zoneMap = new Map<string, ZoneRecord>();
  private feed: FeedEntry[] = [];
  private latencySum = 0;
  private latencyCount = 0;
  private seq = 0;

  private totals: Totals = {
    events: 0,
    messages: 0,
    tokens: 0,
    toolCalls: 0,
    avgLatencyMs: 0,
  };

  private connection: ConnectionStatus = 'idle';
  private connectionDetail = 'not connected';
  private paused = false;

  private state: VisualizerState = this.buildState();

  // -- external store contract -------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): VisualizerState => this.state;

  private buildState(): VisualizerState {
    return {
      agents: [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
      feed: this.feed,
      edges: [...this.edges.values()],
      zones: [...this.zoneMap.values()],
      totals: { ...this.totals },
      connection: this.connection,
      connectionDetail: this.connectionDetail,
      paused: this.paused,
    };
  }

  private commit(): void {
    this.state = this.buildState();
    for (const listener of this.listeners) listener();
  }

  // -- mutations ---------------------------------------------------------

  setConnection(status: ConnectionStatus, detail: string): void {
    this.connection = status;
    this.connectionDetail = detail;
    this.pushFeed({
      kind: 'system',
      title: `Bridge ${status}`,
      body: detail,
      color: SYSTEM_COLOR,
    });
    this.commit();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.commit();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  clear(): void {
    this.agents.clear();
    this.edges.clear();
    this.zoneMap.clear();
    this.feed = [];
    this.latencySum = 0;
    this.latencyCount = 0;
    this.totals = { events: 0, messages: 0, tokens: 0, toolCalls: 0, avgLatencyMs: 0 };
    this.commit();
  }

  private pushFeed(entry: Omit<FeedEntry, 'id' | 'ts'> & { ts?: number }): void {
    const full: FeedEntry = {
      id: `f${++this.seq}`,
      ts: entry.ts ?? Date.now(),
      ...entry,
    };
    // Newest first: the feed renders top-down and auto-scrolls to the top.
    this.feed = [full, ...this.feed].slice(0, FEED_LIMIT);
  }

  private ensureAgent(id: string, seed?: Partial<AgentRecord>): AgentRecord {
    let record = this.agents.get(id);
    if (!record) {
      const avatarType = seed?.avatarType ?? resolveAvatarType(id);
      record = {
        id,
        name: seed?.name ?? id,
        role: seed?.role ?? 'agent',
        avatarType,
        color: seed?.color ?? AVATAR_PALETTES[avatarType].ui,
        status: 'Idle',
        metrics: {},
        online: true,
        lastSeen: Date.now(),
        messages: 0,
        updates: 0,
      };
      this.agents.set(id, record);
    }
    return record;
  }

  private nameOf(id: string): string {
    return this.agents.get(id)?.name ?? id;
  }

  private colorOf(id: string): string {
    return this.agents.get(id)?.color ?? SYSTEM_COLOR;
  }

  /** Fold one protocol event into the dashboard state. */
  apply(event: IncomingEvent): void {
    if (event.event === 'snapshot') {
      this.applySnapshot(event);
      return;
    }
    if (event.event === 'server_info') {
      this.connectionDetail = `${event.clients} client(s) · ${event.buffered} buffered`;
      this.commit();
      return;
    }

    this.totals.events += 1;
    const ts = event.ts ?? Date.now();

    switch (event.event) {
      case 'register': {
        const avatarType = resolveAvatarType(event.avatar_type);
        const existing = this.agents.get(event.agent_id);
        const record: AgentRecord = {
          ...(existing ?? this.ensureAgent(event.agent_id)),
          name: event.name ?? event.agent_id,
          role: event.role ?? 'agent',
          avatarType,
          color: event.color ?? AVATAR_PALETTES[avatarType].ui,
          online: true,
          lastSeen: ts,
        };
        this.agents.set(event.agent_id, record);
        this.pushFeed({
          ts,
          kind: 'register',
          agentId: record.id,
          agentName: record.name,
          color: record.color,
          title: `${record.name} joined`,
          body: `role: ${record.role} · avatar: ${avatarType}`,
        });
        break;
      }

      case 'move': {
        const record = this.ensureAgent(event.agent_id);
        record.lastSeen = ts;
        const where = event.target_pos
          ? `(${event.target_pos.x}, ${event.target_pos.y})`
          : String(event.target_zone);
        this.pushFeed({
          ts,
          kind: 'move',
          agentId: record.id,
          agentName: record.name,
          color: record.color,
          title: `${record.name} → ${where}`,
        });
        break;
      }

      case 'communicate': {
        const record = this.ensureAgent(event.source_agent_id);
        record.messages += 1;
        record.lastSeen = ts;
        this.totals.messages += 1;
        const to = event.target_agent_id ? this.nameOf(event.target_agent_id) : 'everyone';
        this.pushFeed({
          ts,
          kind: 'communicate',
          agentId: record.id,
          agentName: record.name,
          color: record.color,
          title: `${record.name} → ${to}`,
          body: event.message,
        });
        if (event.target_agent_id) {
          this.bumpEdge(event.source_agent_id, event.target_agent_id, 1);
        }
        break;
      }

      case 'state_update': {
        const record = this.ensureAgent(event.agent_id);
        record.status = event.status;
        record.detail = event.detail;
        record.updates += 1;
        record.lastSeen = ts;
        record.metrics = { ...record.metrics, ...(event.metrics ?? {}) };

        if (/^executing tool/i.test(event.status)) this.totals.toolCalls += 1;
        const tokens = event.metrics?.tokens;
        if (typeof tokens === 'number') {
          // `tokens` is reported as a running total per agent, so recompute
          // the global sum rather than accumulating deltas twice.
          this.totals.tokens = [...this.agents.values()].reduce(
            (sum, a) => sum + (a.metrics.tokens ?? 0),
            0,
          );
        }
        const latency = event.metrics?.latency_ms;
        if (typeof latency === 'number') {
          this.latencySum += latency;
          this.latencyCount += 1;
          this.totals.avgLatencyMs = Math.round(this.latencySum / this.latencyCount);
        }

        this.pushFeed({
          ts,
          kind: metricsColor(event.status),
          agentId: record.id,
          agentName: record.name,
          color: record.color,
          title: `${record.name}: ${event.status}`,
          body: event.detail,
          metrics: event.metrics,
        });
        break;
      }

      case 'graph_edge': {
        this.bumpEdge(event.source, event.target, event.weight ?? 1);
        this.pushFeed({
          ts,
          kind: 'edge',
          color: this.colorOf(event.source),
          title: `${this.nameOf(event.source)} ⇄ ${this.nameOf(event.target)}`,
          body: event.label,
        });
        break;
      }

      case 'unregister': {
        const record = this.agents.get(event.agent_id);
        if (record) {
          record.online = false;
          record.status = 'Offline';
          this.pushFeed({
            ts,
            kind: 'system',
            agentId: record.id,
            color: SYSTEM_COLOR,
            title: `${record.name} left`,
          });
        }
        break;
      }

      case 'zone': {
        const record: ZoneRecord = {
          id: event.zone_id,
          label: event.label ?? event.zone_id.toUpperCase(),
          kind: event.kind ?? 'custom',
          capacity: Math.max(1, Math.floor(event.capacity ?? 4)),
          color: event.color,
        };
        const isNew = !this.zoneMap.has(record.id);
        this.zoneMap.set(record.id, record);
        if (isNew) {
          this.pushFeed({
            ts, kind: 'system', color: SYSTEM_COLOR,
            title: `Room opened: ${record.label}`,
            body: `${record.kind} · seats ${record.capacity}`,
          });
        }
        break;
      }

      case 'zone_remove': {
        const gone = this.zoneMap.get(event.zone_id);
        this.zoneMap.delete(event.zone_id);
        if (gone) {
          this.pushFeed({ ts, kind: 'system', color: SYSTEM_COLOR, title: `Room closed: ${gone.label}` });
        }
        break;
      }

      case 'reset': {
        this.agents.clear();
        this.edges.clear();
        this.zoneMap.clear();
        this.latencySum = 0;
        this.latencyCount = 0;
        this.totals = { events: 0, messages: 0, tokens: 0, toolCalls: 0, avgLatencyMs: 0 };
        this.pushFeed({ ts, kind: 'system', color: SYSTEM_COLOR, title: 'World reset' });
        break;
      }
    }

    this.commit();
  }

  private applySnapshot(snapshot: SnapshotEvent): void {
    for (const agent of snapshot.agents) {
      this.apply(agent);
      const status = (agent as unknown as { status?: string }).status;
      if (status) {
        const record = this.agents.get(agent.agent_id);
        if (record) record.status = status;
      }
    }
    for (const edge of snapshot.edges) this.bumpEdge(edge.source, edge.target, edge.weight ?? 1);
    this.pushFeed({
      kind: 'system',
      color: SYSTEM_COLOR,
      title: 'Snapshot restored',
      body: `${snapshot.agents.length} agent(s), ${snapshot.edges.length} edge(s)`,
    });
    this.commit();
  }

  private bumpEdge(source: string, target: string, weight: number): void {
    const key = `${source}->${target}`;
    const prev = this.edges.get(key);
    this.edges.set(key, {
      source,
      target,
      weight: (prev?.weight ?? 0) + weight,
    });
  }

  /**
   * Surface a malformed payload in the feed. Someone wiring up a new backend
   * needs to see *why* their event was ignored, not just that nothing moved.
   */
  reportProtocolError(reason: string, raw: unknown): void {
    let preview = '';
    try {
      preview = JSON.stringify(raw).slice(0, 200);
    } catch {
      preview = String(raw);
    }
    this.pushFeed({
      kind: 'error',
      color: '#f05f7c',
      title: `Rejected event · ${reason}`,
      body: preview,
    });
    this.commit();
  }

  /** Convenience for components that need one agent without subscribing to all. */
  getAgent(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }
}

export const agentStore = new AgentStore();

export function useVisualizerState(): VisualizerState {
  return useSyncExternalStore(agentStore.subscribe, agentStore.getSnapshot, agentStore.getSnapshot);
}

/** Broadcast an already-validated event into the UI store. */
export function applyToStore(event: AgentEvent | IncomingEvent): void {
  agentStore.apply(event);
}

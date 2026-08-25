import Phaser from 'phaser';
import {
  GRID_COLS,
  GRID_ROWS,
  INTERACTION_COLORS,
  OBSTACLES,
  TILE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  ZONES,
  ZONE_BY_ID,
  clampToGrid,
  isBlocked,
  tileInZone,
  tileToWorld,
} from '../../protocol/world';
import {
  resolveAvatarType,
  type AgentCommunicateEvent,
  type AgentMoveEvent,
  type AgentStateUpdateEvent,
  type GraphUpdateEvent,
  type RegisterAgentEvent,
  type UnregisterEvent,
} from '../../protocol/events';
import { EventBus, GameEvents, type SpriteScreenPos } from '../EventBus';
import { AgentSprite } from '../sprites/AgentSprite';
import { adjacentTo, findPath, nearestFree, samePos, type GridPos } from '../grid/pathfinding';

interface Edge {
  source: string;
  target: string;
  weight: number;
  /** Timestamp of the last traffic on this edge, for the glow decay. */
  lastActive: number;
}

const BUBBLE_TTL_MS = 4200;
const BEAM_MS = 900;

/**
 * The world. Owns every sprite and translates protocol events into motion.
 *
 * It never talks to the network directly — everything arrives on the EventBus,
 * so the WebSocket feed and the built-in mock simulator are indistinguishable
 * from in here.
 */
export class WorldScene extends Phaser.Scene {
  private agents = new Map<string, AgentSprite>();
  private edges = new Map<string, Edge>();

  private floor!: Phaser.GameObjects.Graphics;
  private edgeLayer!: Phaser.GameObjects.Graphics;
  private beamLayer!: Phaser.GameObjects.Graphics;
  private beams: { from: string; to: string; color: number; until: number }[] = [];

  private bubbleCounter = 0;
  private handlers: [string, (...args: never[]) => void][] = [];

  constructor() {
    super('WorldScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#070a10');
    this.drawWorld();

    this.edgeLayer = this.add.graphics().setDepth(5);
    this.beamLayer = this.add.graphics().setDepth(40);

    this.bindEventBus();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());

    EventBus.emit(GameEvents.sceneReady, this);
  }

  // -- world rendering ---------------------------------------------------

  private drawWorld(): void {
    this.floor = this.add.graphics().setDepth(0);

    // Checkerboard floor.
    for (let y = 0; y < GRID_ROWS; y++) {
      for (let x = 0; x < GRID_COLS; x++) {
        this.floor.fillStyle((x + y) % 2 === 0 ? 0x1a2438 : 0x151d2e, 1);
        this.floor.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }

    // Interaction zones.
    for (const zone of ZONES) {
      const px = zone.x * TILE;
      const py = zone.y * TILE;
      const pw = zone.w * TILE;
      const ph = zone.h * TILE;

      this.floor.fillStyle(zone.color, 1);
      this.floor.fillRect(px, py, pw, ph);

      // Diagonal hatch — gives the floor a material instead of a flat fill.
      this.floor.lineStyle(1, zone.accent, 0.07);
      for (let d = -ph; d < pw; d += 8) {
        const x1 = Math.max(px, px + d);
        const y1 = py + Math.max(0, -d);
        const x2 = Math.min(px + pw, px + d + ph);
        const y2 = py + Math.min(ph, pw - d);
        this.floor.lineBetween(x1, y1, x2, y2);
      }

      this.floor.lineStyle(2, zone.accent, 0.9);
      this.floor.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
      this.floor.lineStyle(1, zone.accent, 0.22);
      this.floor.strokeRect(px + 5, py + 5, pw - 10, ph - 10);

      // Corner ticks — cheap way to make a flat rect read as a "designated area".
      this.floor.lineStyle(2, zone.accent, 1);
      const t = 7;
      const corners: [number, number, number, number][] = [
        [px + 1, py + 1, t, 0],
        [px + 1, py + 1, 0, t],
        [px + pw - 1, py + 1, -t, 0],
        [px + pw - 1, py + 1, 0, t],
        [px + 1, py + ph - 1, t, 0],
        [px + 1, py + ph - 1, 0, -t],
        [px + pw - 1, py + ph - 1, -t, 0],
        [px + pw - 1, py + ph - 1, 0, -t],
      ];
      for (const [cx, cy, dx, dy] of corners) {
        this.floor.lineBetween(cx, cy, cx + dx, cy + dy);
      }

      const label = this.add
        .text(px + pw / 2, py + 6, zone.label, {
          fontFamily: 'monospace',
          fontSize: '11px',
          fontStyle: 'bold',
          color: Phaser.Display.Color.IntegerToColor(zone.accent).rgba,
        })
        .setOrigin(0.5, 0)
        .setResolution(3)
        .setDepth(2);
      this.floor.fillStyle(0x000000, 0.45);
      this.floor.fillRect(label.x - label.width / 2 - 5, py + 3, label.width + 10, 17);
    }

    // Grid lines on top of the floor, under everything else.
    const grid = this.add.graphics().setDepth(2);
    grid.lineStyle(1, 0x2a3a52, 0.55);
    for (let x = 0; x <= GRID_COLS; x++) {
      grid.lineBetween(x * TILE, 0, x * TILE, WORLD_HEIGHT);
    }
    for (let y = 0; y <= GRID_ROWS; y++) {
      grid.lineBetween(0, y * TILE, WORLD_WIDTH, y * TILE);
    }

    // Obstacles: chunky pixel crates.
    const props = this.add.graphics().setDepth(3);
    for (const [x, y] of OBSTACLES) {
      const px = x * TILE;
      const py = y * TILE;
      props.fillStyle(0x000000, 0.45);
      props.fillRect(px + 5, py + 9, TILE - 8, TILE - 10);
      props.fillStyle(0x27324a, 1);
      props.fillRect(px + 4, py + 6, TILE - 8, TILE - 10);
      props.fillStyle(0x35435f, 1);
      props.fillRect(px + 6, py + 8, TILE - 12, 4);
      props.lineStyle(1, 0x0a0f18, 1);
      props.strokeRect(px + 4, py + 6, TILE - 8, TILE - 10);
    }
  }

  // -- event wiring ------------------------------------------------------

  private bindEventBus(): void {
    const on = <T>(key: string, fn: (payload: T) => void) => {
      const wrapped = (payload: T) => {
        try {
          fn(payload);
        } catch (err) {
          // A malformed event must never take the renderer down.
          console.error(`WorldScene: handler for "${key}" failed`, err, payload);
        }
      };
      EventBus.on(key, wrapped);
      this.handlers.push([key, wrapped as (...args: never[]) => void]);
    };

    on<RegisterAgentEvent>(GameEvents.register, (e) => this.onRegister(e));
    on<AgentMoveEvent>(GameEvents.move, (e) => this.onMove(e));
    on<AgentCommunicateEvent>(GameEvents.communicate, (e) => this.onCommunicate(e));
    on<AgentStateUpdateEvent>(GameEvents.state, (e) => this.onStateUpdate(e));
    on<GraphUpdateEvent>(GameEvents.edge, (e) => this.onEdge(e));
    on<UnregisterEvent>(GameEvents.unregister, (e) => this.onUnregister(e));
    on<void>(GameEvents.reset, () => this.onReset());
  }

  private teardown(): void {
    for (const [key, fn] of this.handlers) EventBus.off(key, fn);
    this.handlers = [];
    this.agents.clear();
    this.edges.clear();
    this.beams = [];
  }

  // -- occupancy helpers -------------------------------------------------

  /** Tiles claimed by other agents — used for placement, never for pathing. */
  private occupiedBy(exceptId?: string): (x: number, y: number) => boolean {
    return (x, y) => {
      for (const [id, agent] of this.agents) {
        if (id === exceptId) continue;
        if (agent.tile.x === x && agent.tile.y === y) return true;
      }
      return false;
    };
  }

  /** Resolve a `move` destination into a tile that is actually reachable. */
  private resolveDestination(from: GridPos, wanted: GridPos, exceptId: string): GridPos {
    const taken = this.occupiedBy(exceptId);
    const first = nearestFree(wanted, isBlocked, taken);
    if (samePos(first, from) || findPath(from, first).length) return first;

    // Rare: the tile is free but walled off. Widen the search, ignoring occupancy.
    const fallback = nearestFree(wanted, isBlocked);
    if (findPath(from, fallback).length) return fallback;
    return from;
  }

  // -- protocol handlers -------------------------------------------------

  private onRegister(e: RegisterAgentEvent): void {
    const avatarType = resolveAvatarType(e.avatar_type);
    const displayName = e.name ?? e.agent_id;
    const existing = this.agents.get(e.agent_id);

    if (existing) {
      existing.setDisplayName(displayName);
      existing.setAvatar(avatarType, e.color);
      if (e.initial_pos) existing.teleport(clampToGrid(e.initial_pos));
      existing.pulse(0x5fd18c);
      return;
    }

    const taken = this.occupiedBy();
    const tile = e.initial_pos
      ? nearestFree(clampToGrid(e.initial_pos), isBlocked, taken)
      : tileInZone(ZONE_BY_ID.gateway, taken);

    const sprite = new AgentSprite(this, {
      agentId: e.agent_id,
      displayName,
      avatarType,
      color: e.color,
      tile,
    });
    this.agents.set(e.agent_id, sprite);
  }

  private onMove(e: AgentMoveEvent): void {
    const agent = this.agents.get(e.agent_id);
    if (!agent) return;

    let wanted: GridPos;
    if (e.target_pos) {
      wanted = clampToGrid(e.target_pos);
    } else {
      const zone = ZONE_BY_ID[String(e.target_zone)];
      if (!zone) return;
      wanted = tileInZone(zone, this.occupiedBy(e.agent_id));
    }

    const dest = this.resolveDestination(agent.tile, wanted, e.agent_id);
    const path = findPath(agent.tile, dest);
    agent.walkPath(path, e.speed ?? 1, () => {
      EventBus.emit(GameEvents.arrived, { agent_id: e.agent_id, tile: agent.tile });
    });
  }

  private onCommunicate(e: AgentCommunicateEvent): void {
    const source = this.agents.get(e.source_agent_id);
    if (!source) return;

    const type = e.interaction_type ?? 'dialogue';
    const target = e.target_agent_id ? this.agents.get(e.target_agent_id) : undefined;

    const show = () => {
      this.emitBubble(e.source_agent_id, e.message, type);
      if (target) {
        this.beams.push({
          from: e.source_agent_id,
          to: target.agentId,
          color: this.interactionColor(type),
          until: this.time.now + BEAM_MS,
        });
        this.registerEdge(e.source_agent_id, target.agentId, 1);
      }
    };

    if (!target || target.agentId === source.agentId) {
      show();
      return;
    }

    // Walk over so the conversation is physically legible.
    const meetingTile = adjacentTo(
      target.tile,
      source.tile,
      isBlocked,
      this.occupiedBy(source.agentId),
    );
    const path = samePos(source.tile, meetingTile)
      ? []
      : findPath(source.tile, meetingTile);

    source.walkPath(path, 1.35, show);
  }

  private onStateUpdate(e: AgentStateUpdateEvent): void {
    const agent = this.agents.get(e.agent_id);
    if (!agent) return;
    agent.pulse(/^executing tool/i.test(e.status) ? 0xffa940 : 0x38bdf8);
  }

  private onEdge(e: GraphUpdateEvent): void {
    this.registerEdge(e.source, e.target, e.weight ?? 1);
  }

  private onUnregister(e: UnregisterEvent): void {
    const agent = this.agents.get(e.agent_id);
    if (!agent) return;
    this.agents.delete(e.agent_id);
    for (const [key, edge] of this.edges) {
      if (edge.source === e.agent_id || edge.target === e.agent_id) this.edges.delete(key);
    }
    agent.fadeOutAndDestroy();
  }

  private onReset(): void {
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
    this.edges.clear();
    this.beams = [];
    this.edgeLayer.clear();
    this.beamLayer.clear();
  }

  // -- helpers -----------------------------------------------------------

  private interactionColor(type: string): number {
    const css = INTERACTION_COLORS[type] ?? INTERACTION_COLORS.dialogue;
    return Number.parseInt(css.replace('#', ''), 16);
  }

  private registerEdge(source: string, target: string, weight: number): void {
    const key = `${source}->${target}`;
    const prev = this.edges.get(key);
    this.edges.set(key, {
      source,
      target,
      weight: (prev?.weight ?? 0) + weight,
      lastActive: this.time.now,
    });
  }

  private emitBubble(agentId: string, message: string, interactionType: string): void {
    EventBus.emit(GameEvents.bubble, {
      agent_id: agentId,
      message,
      interaction_type: interactionType,
      ttl: BUBBLE_TTL_MS,
      id: `b${++this.bubbleCounter}`,
    });
  }

  // -- frame loop --------------------------------------------------------

  update(time: number): void {
    this.drawEdges(time);
    this.drawBeams(time);
    this.publishPositions();
  }

  private drawEdges(time: number): void {
    this.edgeLayer.clear();
    if (!this.edges.size) return;

    for (const edge of this.edges.values()) {
      const a = this.agents.get(edge.source);
      const b = this.agents.get(edge.target);
      if (!a || !b) continue;

      const recency = Phaser.Math.Clamp(1 - (time - edge.lastActive) / 6000, 0, 1);
      const alpha = 0.2 + recency * 0.55;
      const width = Math.min(1.5 + edge.weight * 0.45, 5);

      this.edgeLayer.lineStyle(width, 0x38bdf8, alpha);
      this.edgeLayer.lineBetween(a.x, a.y + 6, b.x, b.y + 6);
    }
  }

  private drawBeams(time: number): void {
    this.beamLayer.clear();
    if (!this.beams.length) return;
    this.beams = this.beams.filter((beam) => beam.until > time);

    for (const beam of this.beams) {
      const a = this.agents.get(beam.from);
      const b = this.agents.get(beam.to);
      if (!a || !b) continue;
      const life = Phaser.Math.Clamp((beam.until - time) / BEAM_MS, 0, 1);

      this.beamLayer.lineStyle(3, beam.color, life * 0.85);
      this.beamLayer.lineBetween(a.x, a.y - 4, b.x, b.y - 4);

      // A travelling pulse along the beam sells the direction of the message.
      const t = 1 - life;
      const px = Phaser.Math.Linear(a.x, b.x, t);
      const py = Phaser.Math.Linear(a.y - 4, b.y - 4, t);
      this.beamLayer.fillStyle(beam.color, life);
      this.beamLayer.fillCircle(px, py, 3);
    }
  }

  /**
   * Publish sprite positions in CSS pixels so React can pin DOM overlays to
   * them. `displayScale` converts game pixels to on-screen pixels under
   * Phaser's FIT scaling.
   */
  private publishPositions(): void {
    if (!this.agents.size) {
      EventBus.emit(GameEvents.positions, [] as SpriteScreenPos[]);
      return;
    }
    const scaleX = this.scale.displayScale.x || 1;
    const scaleY = this.scale.displayScale.y || 1;

    const payload: SpriteScreenPos[] = [];
    for (const [id, agent] of this.agents) {
      payload.push({
        agent_id: id,
        x: agent.x / scaleX,
        y: agent.anchorY / scaleY,
        offsetY: (TILE / 2) / scaleY,
        footY: agent.footOffset / scaleY,
        visible: agent.alpha > 0.5,
      });
    }
    EventBus.emit(GameEvents.positions, payload);
  }

  /** Used by the "centre on agent" action in the roster. */
  focusAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.pulse(0xf0dc8c);
    this.cameras.main.flash(140, 56, 189, 248, false);
  }

  /** Grid coordinate helper exposed for debugging from the console. */
  tileCenter(x: number, y: number) {
    return tileToWorld(x, y);
  }
}

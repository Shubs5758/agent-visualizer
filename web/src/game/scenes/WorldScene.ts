import Phaser from 'phaser';
import {
  INTERACTION_COLORS,
  TILE,
  clampToGrid,
  isBlocked,
  seatInZone,
  tileToWorld,
  world,
} from '../../protocol/world';
import { normaliseKind, type PlacedZone } from '../../protocol/zones';
import {
  resolveAvatarType,
  type AgentCommunicateEvent,
  type AgentMoveEvent,
  type AgentStateUpdateEvent,
  type GraphUpdateEvent,
  type RegisterAgentEvent,
  type UnregisterEvent,
  type ZoneEvent,
  type ZoneRemoveEvent,
} from '../../protocol/events';
import { EventBus, GameEvents, type RoomScreenInfo, type SpriteScreenPos } from '../EventBus';
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
  /** agent id -> room id, so a relayout can re-seat everyone. */
  private agentZone = new Map<string, string>();
  private edges = new Map<string, Edge>();

  private floorLayer?: Phaser.GameObjects.Graphics;
  private roomLabels: Phaser.GameObjects.Text[] = [];
  private unsubscribeWorld?: () => void;
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
    this.applyWorldSize();
    this.drawWorld();

    // Rooms can be declared at any time; the floor is rebuilt when they are.
    this.unsubscribeWorld = world.subscribe(() => {
      this.applyWorldSize();
      this.drawWorld();
      this.reseatAgents();
    });

    this.edgeLayer = this.add.graphics().setDepth(5);
    this.beamLayer = this.add.graphics().setDepth(40);

    this.installCameraControls();
    this.bindEventBus();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());

    EventBus.emit(GameEvents.sceneReady, this);
  }

  // -- world rendering ---------------------------------------------------

  /** Redraw the entire floor. Cheap enough to just rebuild on any world change. */
  private drawWorld(): void {
    this.floorLayer?.destroy();
    this.roomLabels.forEach((t) => t.destroy());
    this.roomLabels = [];

    const g = this.add.graphics().setDepth(0);
    this.floorLayer = g;

    // Corridor floor across the whole plate, with a subtle tile grid.
    for (let y = 0; y < world.rows; y++) {
      for (let x = 0; x < world.cols; x++) {
        g.fillStyle((x + y) % 2 === 0 ? 0x141b28 : 0x111825, 1);
        g.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    g.lineStyle(1, 0x1d2738, 0.5);
    for (let x = 0; x <= world.cols; x++) g.lineBetween(x * TILE, 0, x * TILE, world.height);
    for (let y = 0; y <= world.rows; y++) g.lineBetween(0, y * TILE, world.width, y * TILE);

    for (const zone of world.zones) this.drawRoom(g, zone);
  }

  private drawRoom(g: Phaser.GameObjects.Graphics, zone: PlacedZone): void {
    const px = zone.x * TILE;
    const py = zone.y * TILE;
    const pw = zone.w * TILE;
    const ph = zone.h * TILE;
    const accent = zone.color
      ? Number.parseInt(zone.color.replace('#', ''), 16)
      : zone.style.accent;

    // Interior floor.
    g.fillStyle(zone.style.floor, 1);
    g.fillRect(px + TILE, py + TILE, pw - TILE * 2, ph - TILE * 2);

    // Floor hatch, so the room reads as a material rather than a flat fill.
    g.lineStyle(1, accent, 0.06);
    for (let d = -ph; d < pw; d += 10) {
      g.lineBetween(
        px + Math.max(TILE, d), py + TILE,
        px + Math.min(pw - TILE, d + ph), py + ph - TILE,
      );
    }

    // Walls: solid blocks on every edge tile except the door.
    for (let ix = zone.x; ix < zone.x + zone.w; ix++) {
      for (let iy = zone.y; iy < zone.y + zone.h; iy++) {
        const edge =
          ix === zone.x || iy === zone.y ||
          ix === zone.x + zone.w - 1 || iy === zone.y + zone.h - 1;
        if (!edge) continue;
        const isDoor = ix === zone.door.x && iy === zone.door.y;
        const wx = ix * TILE;
        const wy = iy * TILE;
        if (isDoor) {
          // Threshold: lit floor plus jambs, so the opening reads as a door.
          g.fillStyle(accent, 0.22);
          g.fillRect(wx, wy, TILE, TILE);
          g.fillStyle(accent, 0.9);
          const vertical = zone.doorSide === 'east' || zone.doorSide === 'west';
          if (vertical) {
            g.fillRect(wx + TILE / 2 - 1, wy, 2, 5);
            g.fillRect(wx + TILE / 2 - 1, wy + TILE - 5, 2, 5);
          } else {
            g.fillRect(wx, wy + TILE / 2 - 1, 5, 2);
            g.fillRect(wx + TILE - 5, wy + TILE / 2 - 1, 5, 2);
          }
          continue;
        }
        g.fillStyle(0x2b3548, 1);
        g.fillRect(wx, wy, TILE, TILE);
        g.fillStyle(0x3c4a63, 1);
        g.fillRect(wx, wy, TILE, 4);
      }
    }

    // Accent line along the inside of the wall.
    g.lineStyle(2, accent, 0.75);
    g.strokeRect(px + TILE, py + TILE, pw - TILE * 2, ph - TILE * 2);

    // Furniture at each workstation.
    for (const desk of zone.desks) this.drawFurniture(g, desk.x, desk.y, zone.style.furniture, accent);

    // Door plaque.
    const label = this.add
      .text(px + pw / 2, py + TILE + 4, zone.label, {
        fontFamily: 'monospace',
        fontSize: '11px',
        fontStyle: 'bold',
        color: Phaser.Display.Color.IntegerToColor(accent).rgba,
      })
      .setOrigin(0.5, 0)
      .setResolution(3)
      .setDepth(2);
    g.fillStyle(0x000000, 0.5);
    g.fillRect(label.x - label.width / 2 - 6, py + TILE + 2, label.width + 12, 16);
    this.roomLabels.push(label);
  }

  /** A few pixels of furniture so a room looks used rather than empty. */
  private drawFurniture(
    g: Phaser.GameObjects.Graphics,
    tx: number,
    ty: number,
    kind: PlacedZone['style']['furniture'],
    accent: number,
  ): void {
    const x = tx * TILE;
    const y = ty * TILE;
    g.fillStyle(0x000000, 0.35);
    g.fillRect(x + 4, y + 20, TILE - 8, 8);

    switch (kind) {
      case 'racks':
        g.fillStyle(0x232f42, 1);
        g.fillRect(x + 4, y + 4, TILE - 8, TILE - 10);
        for (let i = 0; i < 4; i++) {
          g.fillStyle(accent, i % 2 ? 0.75 : 0.35);
          g.fillRect(x + 7, y + 7 + i * 5, TILE - 14, 2);
        }
        break;
      case 'shelves':
        g.fillStyle(0x2c2440, 1);
        g.fillRect(x + 3, y + 5, TILE - 6, TILE - 12);
        g.fillStyle(accent, 0.55);
        g.fillRect(x + 5, y + 8, TILE - 10, 2);
        g.fillRect(x + 5, y + 14, TILE - 10, 2);
        break;
      case 'benches':
        g.fillStyle(0x3a2c1c, 1);
        g.fillRect(x + 3, y + 12, TILE - 6, 9);
        g.fillStyle(accent, 0.5);
        g.fillRect(x + 6, y + 9, TILE - 12, 3);
        break;
      case 'table':
        g.fillStyle(0x2a3446, 1);
        g.fillRect(x + 2, y + 10, TILE - 4, 12);
        g.fillStyle(accent, 0.4);
        g.fillRect(x + 5, y + 13, TILE - 10, 2);
        break;
      case 'crates':
        g.fillStyle(0x27324a, 1);
        g.fillRect(x + 5, y + 8, TILE - 10, TILE - 14);
        g.lineStyle(1, accent, 0.5);
        g.strokeRect(x + 5, y + 8, TILE - 10, TILE - 14);
        break;
      case 'desks':
      default:
        g.fillStyle(0x27334a, 1);
        g.fillRect(x + 3, y + 13, TILE - 6, 9);
        g.fillStyle(accent, 0.65);
        g.fillRect(x + 8, y + 6, TILE - 16, 6);
        break;
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
    on<ZoneEvent>(GameEvents.zone, (e) => this.onZone(e));
    on<ZoneRemoveEvent>(GameEvents.zoneRemove, (e) => world.removeZone(e.zone_id));
  }

  /**
   * Fit the camera to the current floorplan.
   *
   * The canvas fills its container and the *camera* frames the world, rather
   * than the canvas being the world size and CSS scaling it. That is what lets
   * a 40-room floor stay navigable: the view zooms and pans instead of
   * shrinking every agent to a speck.
   */
  private applyWorldSize(): void {
    const cam = this.cameras.main;
    cam.setBounds(0, 0, world.width, world.height);
    this.fitZoom = Math.min(
      this.scale.width / world.width,
      this.scale.height / world.height,
    );
    // Never magnify past 1:1 — pixel art upscaled by a fraction shimmers.
    cam.setZoom(Math.min(1, this.fitZoom));
    cam.centerOn(world.width / 2, world.height / 2);
  }

  private fitZoom = 1;

  /** Drag to pan, wheel to zoom, clamped between fit-the-floor and 1:1. */
  private installCameraControls(): void {
    const cam = this.cameras.main;

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) return;
      cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
      cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
    });

    this.input.on(
      'wheel',
      (_p: unknown, _o: unknown, _dx: number, dy: number) => {
        const min = Math.min(1, this.fitZoom);
        const next = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), min, 1.6);
        cam.setZoom(next);
      },
    );

    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.applyWorldSize());
  }

  /** After a relayout, tiles moved — put everyone back on a valid seat. */
  private reseatAgents(): void {
    for (const [id, agent] of this.agents) {
      const zoneId = this.agentZone.get(id);
      const zone = zoneId ? world.zone(zoneId) : undefined;
      if (zone) {
        const seat = seatInZone(zone, this.occupiedBy(id));
        agent.teleport({ x: seat.x, y: seat.y });
      } else {
        agent.teleport(nearestFree(clampToGrid(agent.tile), isBlocked, this.occupiedBy(id)));
      }
    }
  }

  private teardown(): void {
    this.unsubscribeWorld?.();
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
    const entry = world.zone('gateway') ?? world.zones[0];
    const tile = e.initial_pos
      ? nearestFree(clampToGrid(e.initial_pos), isBlocked, taken)
      : entry
        ? seatInZone(entry, taken)
        : nearestFree({ x: 1, y: 1 }, isBlocked, taken);

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
      this.agentZone.delete(e.agent_id);
    } else {
      const zone = world.zone(String(e.target_zone));
      if (!zone) return;
      // Take a numbered workstation; overflow queues outside the door.
      wanted = seatInZone(zone, this.occupiedBy(e.agent_id));
      this.agentZone.set(e.agent_id, zone.id);
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

  private onZone(e: ZoneEvent): void {
    world.declareZone({
      id: e.zone_id,
      label: e.label ?? e.zone_id.toUpperCase(),
      kind: normaliseKind(e.kind),
      capacity: Math.max(1, Math.floor(e.capacity ?? 4)),
      color: e.color,
    });
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
    this.agentZone.delete(e.agent_id);
    for (const [key, edge] of this.edges) {
      if (edge.source === e.agent_id || edge.target === e.agent_id) this.edges.delete(key);
    }
    agent.fadeOutAndDestroy();
  }

  private onReset(): void {
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
    this.agentZone.clear();
    world.restoreDefaults();
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
    const cam = this.cameras.main;
    const view = cam.worldView;
    const zoom = cam.zoom;
    // displayScale converts game pixels to on-screen CSS pixels; the camera
    // converts world pixels to game pixels. Both apply.
    const dsx = this.scale.displayScale.x || 1;
    const dsy = this.scale.displayScale.y || 1;
    const toScreenX = (wx: number) => ((wx - view.x) * zoom) / dsx;
    const toScreenY = (wy: number) => ((wy - view.y) * zoom) / dsy;

    const payload: SpriteScreenPos[] = [];
    for (const [id, agent] of this.agents) {
      payload.push({
        agent_id: id,
        x: toScreenX(agent.x),
        y: toScreenY(agent.anchorY),
        offsetY: ((TILE / 2) * zoom) / dsy,
        footY: (agent.footOffset * zoom) / dsy,
        // Cull anything off-screen so the DOM does not carry hidden overlays.
        visible: agent.alpha > 0.5 && view.contains(agent.x, agent.y),
      });
    }
    EventBus.emit(GameEvents.positions, payload);

    const occupancy = new Map<string, number>();
    for (const zoneId of this.agentZone.values()) {
      occupancy.set(zoneId, (occupancy.get(zoneId) ?? 0) + 1);
    }
    const rooms: RoomScreenInfo[] = world.zones.map((zone) => ({
      id: zone.id,
      label: zone.label,
      x: toScreenX((zone.x + zone.w / 2) * TILE),
      y: toScreenY((zone.y + zone.h) * TILE),
      occupied: occupancy.get(zone.id) ?? 0,
      capacity: zone.capacity,
      accent: Phaser.Display.Color.IntegerToColor(
        zone.color ? Number.parseInt(zone.color.replace('#', ''), 16) : zone.style.accent,
      ).rgba,
    }));
    EventBus.emit(GameEvents.rooms, rooms);
  }

  /** Used by the "centre on agent" action in the roster. */
  focusAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.pulse(0xf0dc8c);
    // With a pannable camera, "focus" means go and look at them.
    this.cameras.main.pan(agent.x, agent.y, 380, 'Cubic.easeOut');
  }

  /** Grid coordinate helper exposed for debugging from the console. */
  tileCenter(x: number, y: number) {
    return tileToWorld(x, y);
  }

  /** Rooms currently on the floor — used by the roster legend. */
  get rooms() {
    return world.zones;
  }
}

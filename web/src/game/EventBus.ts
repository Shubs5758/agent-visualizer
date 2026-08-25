import Phaser from 'phaser';
import type {
  AgentCommunicateEvent,
  AgentMoveEvent,
  AgentStateUpdateEvent,
  GraphUpdateEvent,
  RegisterAgentEvent,
  UnregisterEvent,
} from '../protocol/events';

/**
 * The single bridge between the React DOM and the Phaser canvas.
 *
 * React → Phaser carries protocol events (from the WebSocket *or* from the mock
 * simulator — the scene cannot tell the difference, which is the point).
 * Phaser → React carries render-derived data the DOM overlays need, chiefly
 * live sprite screen positions for the floating HUD.
 */
export const EventBus = new Phaser.Events.EventEmitter();

/** Screen-space position of one sprite, in CSS pixels relative to the canvas. */
export interface SpriteScreenPos {
  agent_id: string;
  x: number;
  y: number;
  /** Sprite half-height in CSS px, so the DOM can sit a bubble just above it. */
  offsetY: number;
  /** Anchor-to-feet distance in CSS px, for placing the nameplate below. */
  footY: number;
  visible: boolean;
}

export interface BubblePayload {
  agent_id: string;
  message: string;
  interaction_type: string;
  /** Milliseconds the bubble should remain on screen. */
  ttl: number;
  id: string;
}

export const GameEvents = {
  /** React → Phaser */
  register: 'agent:register',
  move: 'agent:move',
  communicate: 'agent:communicate',
  state: 'agent:state',
  edge: 'graph:edge',
  unregister: 'agent:unregister',
  reset: 'world:reset',

  /** Phaser → React */
  sceneReady: 'current-scene-ready',
  positions: 'phaser:positions',
  bubble: 'phaser:bubble',
  arrived: 'phaser:arrived',
} as const;

/** Typed emit helpers — keeps payload shapes honest at both ends. */
export const emitToGame = {
  register: (e: RegisterAgentEvent) => EventBus.emit(GameEvents.register, e),
  move: (e: AgentMoveEvent) => EventBus.emit(GameEvents.move, e),
  communicate: (e: AgentCommunicateEvent) => EventBus.emit(GameEvents.communicate, e),
  state: (e: AgentStateUpdateEvent) => EventBus.emit(GameEvents.state, e),
  edge: (e: GraphUpdateEvent) => EventBus.emit(GameEvents.edge, e),
  unregister: (e: UnregisterEvent) => EventBus.emit(GameEvents.unregister, e),
  reset: () => EventBus.emit(GameEvents.reset),
};

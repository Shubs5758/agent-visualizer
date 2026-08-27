/**
 * The one place a protocol event enters the application.
 *
 * Both the WebSocket feed and the built-in mock simulator call `dispatch`, so
 * "Test UI" exercises exactly the same code path a real backend does — if the
 * mock looks right, the real thing will too.
 */

import { emitToGame } from '../game/EventBus';
import { isParseError, parseEvent, type IncomingEvent } from '../protocol/events';
import { agentStore, applyToStore } from '../state/agentStore';

/** Send a decoded event to the Phaser scene. */
function routeToGame(event: IncomingEvent): void {
  switch (event.event) {
    case 'register':
      emitToGame.register(event);
      break;
    case 'move':
      emitToGame.move(event);
      break;
    case 'communicate':
      emitToGame.communicate(event);
      break;
    case 'state_update':
      emitToGame.state(event);
      break;
    case 'graph_edge':
      emitToGame.edge(event);
      break;
    case 'unregister':
      emitToGame.unregister(event);
      break;
    case 'reset':
      emitToGame.reset();
      break;
    case 'zone':
      emitToGame.zone(event);
      break;
    case 'zone_remove':
      emitToGame.zoneRemove(event);
      break;
    case 'snapshot':
      // Rebuild the world from the server's retained state. `recent` is
      // deliberately not replayed: the agents/edges already encode its outcome,
      // and replaying would double-count metrics.
      emitToGame.reset();
      // Rooms first: agents are placed relative to the floorplan.
      for (const zone of event.zones ?? []) emitToGame.zone(zone);
      for (const agent of event.agents) emitToGame.register(agent);
      for (const edge of event.edges) emitToGame.edge(edge);
      break;
    default:
      break;
  }
}

/**
 * Validate and fan out one raw payload.
 * @returns true when the event was accepted.
 */
export function dispatch(raw: unknown): boolean {
  const event = parseEvent(raw);
  if (isParseError(event)) {
    agentStore.reportProtocolError(event.error, raw);
    return false;
  }

  // Pausing freezes the world but must not hide connection bookkeeping.
  if (agentStore.isPaused && event.event !== 'server_info') return false;

  applyToStore(event);
  routeToGame(event);
  return true;
}

/** Accepts a single event or a batch. */
export function dispatchPayload(raw: unknown): number {
  const list = Array.isArray(raw) ? raw : [raw];
  let accepted = 0;
  for (const item of list) {
    if (dispatch(item)) accepted++;
  }
  return accepted;
}

import { useEffect, useRef, useState } from 'react';
import { Wrench } from 'lucide-react';
import {
  EventBus,
  GameEvents,
  type BubblePayload,
  type RoomScreenInfo,
  type SpriteScreenPos,
} from '../game/EventBus';
import { INTERACTION_COLORS } from '../protocol/world';
import { useVisualizerState } from '../state/agentStore';

interface Bubble extends BubblePayload {
  expiresAt: number;
}

/** Only ever show the newest few bubbles per agent, so a chatty run stays readable. */
const MAX_BUBBLES_PER_AGENT = 1;
/** Screen-space box a nameplate needs before it counts as colliding, in px. */
const NAME_MIN_X = 90;
const NAME_MIN_Y = 15;

/**
 * DOM overlays pinned to Phaser sprites.
 *
 * Positions arrive on the EventBus every frame and are written straight to
 * `style.transform` through refs — deliberately *not* through React state.
 * Re-rendering the tree 60 times a second would drop frames as soon as a few
 * agents are on screen; React here only owns which overlays exist, not where
 * they are.
 */
export function HudLayer({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const { agents } = useVisualizerState();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [rooms, setRooms] = useState<RoomScreenInfo[]>([]);

  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const canvasOffset = useRef({ left: 0, top: 0 });

  // Track where the canvas sits inside the container. Phaser's FIT scaling
  // letterboxes the canvas, so this offset is not constant.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const canvas = container.querySelector('canvas');
      if (!canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const hostRect = container.getBoundingClientRect();
      canvasOffset.current = {
        left: canvasRect.left - hostRect.left,
        top: canvasRect.top - hostRect.top,
      };
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    window.addEventListener('resize', measure);
    // The canvas appears a tick after Phaser boots.
    const settle = window.setTimeout(measure, 250);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.clearTimeout(settle);
    };
  }, [containerRef]);

  useEffect(() => {
    const onPositions = (positions: SpriteScreenPos[]) => {
      const { left, top } = canvasOffset.current;

      // Nameplate de-collision. Agents standing close together used to print
      // their labels on top of one another (the "T:Scoutch" problem). Walk them
      // in screen order and push each plate down a row when it would land on
      // one already placed — cheap, stable, and keeps every name readable.
      const placed: { x: number; y: number; lift: number }[] = [];
      const ordered = [...positions].sort((a, b) => a.y - b.y || a.x - b.x);
      const lifts = new Map<string, number>();
      for (const pos of ordered) {
        let lift = 0;
        for (let guard = 0; guard < 6; guard++) {
          const y = pos.y + pos.footY + lift;
          const clash = placed.some(
            (p) => Math.abs(p.x - pos.x) < NAME_MIN_X && Math.abs(p.y - y) < NAME_MIN_Y,
          );
          if (!clash) break;
          lift += NAME_MIN_Y;
        }
        placed.push({ x: pos.x, y: pos.y + pos.footY + lift, lift });
        lifts.set(pos.agent_id, lift);
      }

      for (const pos of positions) {
        const node = nodeRefs.current.get(pos.agent_id);
        if (!node) continue;
        node.style.transform = `translate3d(${left + pos.x}px, ${top + pos.y}px, 0)`;
        node.style.opacity = pos.visible ? '1' : '0';
        node.style.setProperty('--foot', `${pos.footY + (lifts.get(pos.agent_id) ?? 0)}px`);
      }
    };

    const onBubble = (payload: BubblePayload) => {
      const bubble: Bubble = { ...payload, expiresAt: Date.now() + payload.ttl };
      setBubbles((prev) => {
        const forOthers = prev.filter((b) => b.agent_id !== payload.agent_id);
        const forThis = prev
          .filter((b) => b.agent_id === payload.agent_id)
          .slice(-(MAX_BUBBLES_PER_AGENT - 1));
        return [...forOthers, ...forThis, bubble];
      });
      window.setTimeout(
        () => setBubbles((prev) => prev.filter((b) => b.id !== payload.id)),
        payload.ttl,
      );
    };

    // Occupancy changes rarely, so unlike positions it can go through state.
    let lastRooms = '';
    const onRooms = (next: RoomScreenInfo[]) => {
      const key = next.map((r) => `${r.id}:${r.occupied}:${Math.round(r.x)}:${Math.round(r.y)}`).join('|');
      if (key === lastRooms) return;
      lastRooms = key;
      setRooms(next);
    };

    EventBus.on(GameEvents.positions, onPositions);
    EventBus.on(GameEvents.bubble, onBubble);
    EventBus.on(GameEvents.rooms, onRooms);
    return () => {
      EventBus.off(GameEvents.positions, onPositions);
      EventBus.off(GameEvents.bubble, onBubble);
      EventBus.off(GameEvents.rooms, onRooms);
    };
  }, []);

  const bubblesByAgent = new Map<string, Bubble[]>();
  for (const bubble of bubbles) {
    const list = bubblesByAgent.get(bubble.agent_id) ?? [];
    list.push(bubble);
    bubblesByAgent.set(bubble.agent_id, list);
  }

  const { left, top } = canvasOffset.current;

  return (
    <div className="hud-layer" aria-live="polite">
      {/* Room occupancy. Makes a full room legible without counting sprites. */}
      {rooms
        .filter((room) => room.occupied > 0)
        .map((room) => (
          <div
            key={room.id}
            className={`hud-room${room.occupied >= room.capacity ? ' is-full' : ''}`}
            style={{
              transform: `translate3d(${left + room.x}px, ${top + room.y}px, 0)`,
              borderColor: room.accent,
              color: room.accent,
            }}
            title={`${room.label}: ${room.occupied} of ${room.capacity} seats`}
          >
            {room.occupied}/{room.capacity}
            {room.occupied > room.capacity && <span className="hud-room-wait">+queue</span>}
          </div>
        ))}

      {agents
        .filter((agent) => agent.online)
        .map((agent) => {
          const agentBubbles = bubblesByAgent.get(agent.id) ?? [];
          const isTool = /^executing tool/i.test(agent.status);
          const showStatus = agent.status && agent.status !== 'Idle';

          return (
            <div
              key={agent.id}
              className="hud-anchor"
              ref={(node) => {
                if (node) nodeRefs.current.set(agent.id, node);
                else nodeRefs.current.delete(agent.id);
              }}
            >
              {agentBubbles.map((bubble) => (
                <div
                  key={bubble.id}
                  className="hud-bubble"
                  style={{
                    borderColor:
                      INTERACTION_COLORS[bubble.interaction_type] ?? INTERACTION_COLORS.dialogue,
                  }}
                >
                  {bubble.message}
                  <span
                    className="hud-bubble-tail"
                    style={{
                      borderTopColor:
                        INTERACTION_COLORS[bubble.interaction_type] ??
                        INTERACTION_COLORS.dialogue,
                    }}
                  />
                </div>
              ))}

              {showStatus && (
                <div
                  className={`hud-status${isTool ? ' is-tool' : ''}`}
                  style={{ borderColor: agent.color, color: agent.color }}
                >
                  {isTool && <Wrench size={9} strokeWidth={2.5} />}
                  <span>{agent.status}</span>
                </div>
              )}

              {/* Nameplate. Lives in the DOM, not on the canvas: at sprite
                  scale the canvas text went through the pixel-art nearest
                  filter and neighbouring agents overprinted each other. */}
              <div className="hud-name" style={{ borderColor: agent.color, color: agent.color }}>
                <span className="hud-name-dot" />
                <span className="hud-name-text">{agent.name}</span>
              </div>
            </div>
          );
        })}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Wrench } from 'lucide-react';
import { EventBus, GameEvents, type BubblePayload, type SpriteScreenPos } from '../game/EventBus';
import { INTERACTION_COLORS } from '../protocol/world';
import { useVisualizerState } from '../state/agentStore';

interface Bubble extends BubblePayload {
  expiresAt: number;
}

/** Only ever show the newest few bubbles per agent, so a chatty run stays readable. */
const MAX_BUBBLES_PER_AGENT = 1;

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
      for (const pos of positions) {
        const node = nodeRefs.current.get(pos.agent_id);
        if (!node) continue;
        node.style.transform = `translate3d(${left + pos.x}px, ${top + pos.y}px, 0)`;
        node.style.opacity = pos.visible ? '1' : '0';
        // Drives where the nameplate sits relative to the anchor; changes only
        // when the canvas is rescaled, but it is free to set here.
        node.style.setProperty('--foot', `${pos.footY}px`);
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

    EventBus.on(GameEvents.positions, onPositions);
    EventBus.on(GameEvents.bubble, onBubble);
    return () => {
      EventBus.off(GameEvents.positions, onPositions);
      EventBus.off(GameEvents.bubble, onBubble);
    };
  }, []);

  const bubblesByAgent = new Map<string, Bubble[]>();
  for (const bubble of bubbles) {
    const list = bubblesByAgent.get(bubble.agent_id) ?? [];
    list.push(bubble);
    bubblesByAgent.set(bubble.agent_id, list);
  }

  return (
    <div className="hud-layer" aria-live="polite">
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

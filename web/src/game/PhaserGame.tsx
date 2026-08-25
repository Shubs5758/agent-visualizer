import Phaser from 'phaser';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { EventBus, GameEvents } from './EventBus';
import { StartGame } from './main';

export interface PhaserGameHandle {
  game: Phaser.Game | null;
  scene: Phaser.Scene | null;
}

interface Props {
  /** Fired once the active scene has finished `create()`. */
  onSceneReady?: (scene: Phaser.Scene) => void;
}

const CONTAINER_ID = 'agent-visualizer-canvas';

/**
 * Mounts the Phaser game into the DOM and hands the live scene back to React.
 *
 * The game instance is created once and destroyed on unmount; React never
 * re-creates it on re-render, which matters under StrictMode double-mounting.
 */
export const PhaserGame = forwardRef<PhaserGameHandle, Props>(function PhaserGame(
  { onSceneReady },
  ref,
) {
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<Phaser.Scene | null>(null);
  const [, forceRender] = useState(0);

  useLayoutEffect(() => {
    if (gameRef.current === null) {
      gameRef.current = StartGame(CONTAINER_ID);
    }
    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handler = (scene: Phaser.Scene) => {
      sceneRef.current = scene;
      onSceneReady?.(scene);
      forceRender((n) => n + 1);
    };
    EventBus.on(GameEvents.sceneReady, handler);
    return () => {
      EventBus.off(GameEvents.sceneReady, handler);
    };
  }, [onSceneReady]);

  useImperativeHandle(ref, () => ({
    get game() {
      return gameRef.current;
    },
    get scene() {
      return sceneRef.current;
    },
  }));

  return <div id={CONTAINER_ID} className="phaser-container" />;
});

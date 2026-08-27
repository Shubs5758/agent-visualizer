import Phaser from 'phaser';
import { world } from '../protocol/world';
import { WorldScene } from './scenes/WorldScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  // Starting size only — the scene resizes the canvas whenever rooms change.
  width: world.width,
  height: world.height,
  backgroundColor: '#070a10',
  // Nearest-neighbour sampling and integer positions — without both, 16x16 art
  // scaled 2x shimmers as sprites move.
  pixelArt: true,
  roundPixels: true,
  scale: {
    // RESIZE, not FIT: the canvas fills its container and the camera frames the
    // world. Under FIT a bigger floorplan shrank every agent; now it pans.
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  scene: [WorldScene],
};

export function StartGame(parent: string): Phaser.Game {
  return new Phaser.Game({ ...config, parent });
}

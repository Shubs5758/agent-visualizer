import Phaser from 'phaser';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../protocol/world';
import { WorldScene } from './scenes/WorldScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  backgroundColor: '#070a10',
  // Nearest-neighbour sampling and integer positions — without both, 16x16 art
  // scaled 2x shimmers as sprites move.
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [WorldScene],
};

export function StartGame(parent: string): Phaser.Game {
  return new Phaser.Game({ ...config, parent });
}

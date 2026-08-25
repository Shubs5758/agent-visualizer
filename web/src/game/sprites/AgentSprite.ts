import Phaser from 'phaser';
import { tileToWorld } from '../../protocol/world';
import type { AvatarType } from '../../protocol/events';
import { anims, avatarUiColor, ensureAvatarTexture } from './pixelArt';
import type { GridPos } from '../grid/pathfinding';

/** Milliseconds to cross one tile at `speed: 1.0`. */
const STEP_MS = 220;
/**
 * Integer only — a fractional scale on 16x16 art under `pixelArt: true`
 * produces unevenly-sized pixels. 3 makes the agent 48px on a 32px tile, which
 * is deliberate: the characters are the subject, not the scenery.
 */
const SPRITE_SCALE = 3;

export interface AgentSpriteConfig {
  agentId: string;
  displayName: string;
  avatarType: AvatarType;
  color?: string;
  tile: GridPos;
}

/**
 * One agent on the grid: identity aura, shadow and animated pixel body.
 *
 * Speech bubbles and status tags are intentionally *not* drawn here — those are
 * React DOM overlays positioned from the coordinates this container reports, so
 * they get real text rendering, wrapping and selection.
 */
export class AgentSprite extends Phaser.GameObjects.Container {
  readonly agentId: string;

  /** Logical tile. Updated as each step completes. */
  tile: GridPos;

  private body_: Phaser.GameObjects.Sprite;
  private shadow: Phaser.GameObjects.Ellipse;
  private aura: Phaser.GameObjects.Arc;
  private ring: Phaser.GameObjects.Arc;
  private textureKey: string;
  private displayName_: string;

  private stepTween?: Phaser.Tweens.Tween;
  private queue: GridPos[] = [];
  private facing: 'front' | 'back' = 'front';
  private onArrive?: () => void;

  constructor(scene: Phaser.Scene, config: AgentSpriteConfig) {
    const world = tileToWorld(config.tile.x, config.tile.y);
    super(scene, world.x, world.y);

    this.agentId = config.agentId;
    this.tile = { ...config.tile };
    this.displayName_ = config.displayName;
    this.textureKey = ensureAvatarTexture(scene, config.avatarType, config.color);

    const identity = Number.parseInt(
      avatarUiColor(config.avatarType, config.color).replace('#', ''),
      16,
    );

    // A pool of the agent's own colour on the floor. Cheap, but it is what
    // separates a character from the scenery and reinforces identity at a
    // glance, without relying on reading a label.
    this.aura = scene.add.circle(0, 18, 22, identity, 0.16);
    this.scene.tweens.add({
      targets: this.aura,
      scale: { from: 0.85, to: 1.12 },
      alpha: { from: 0.2, to: 0.09 },
      duration: 1900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    this.shadow = scene.add.ellipse(0, 20, 26, 9, 0x000000, 0.45).setOrigin(0.5);

    this.ring = scene.add.circle(0, 4, 21, 0x000000, 0).setStrokeStyle(1, 0xffffff, 0.0);

    this.body_ = scene.add
      .sprite(0, 0, this.textureKey, 'f0')
      .setOrigin(0.5, 0.5)
      .setScale(SPRITE_SCALE);
    this.body_.play(anims.idleFront(this.textureKey));

    // The name is deliberately NOT drawn here. Canvas text at this size goes
    // through the nearest-neighbour filter that `pixelArt: true` turns on, and
    // two agents on neighbouring tiles overprint each other into gibberish.
    // It is rendered as a DOM overlay instead — see HudLayer.
    this.add([this.aura, this.shadow, this.ring, this.body_]);
    // Depth-sort by row so agents lower on the screen draw in front.
    this.setDepth(10 + this.y / 1000);
    scene.add.existing(this);

    this.spawnFlourish();
  }

  // -- appearance --------------------------------------------------------

  get displayName(): string {
    return this.displayName_;
  }

  setDisplayName(name: string): void {
    this.displayName_ = name;
  }

  setAvatar(avatarType: AvatarType, color?: string): void {
    const key = ensureAvatarTexture(this.scene, avatarType, color);
    if (key === this.textureKey) return;
    this.textureKey = key;
    this.body_.setTexture(key, 'f0');
    this.playIdle();
  }

  /** Brief flash — used when a state_update arrives so activity is visible. */
  pulse(color = 0x4ec9f0): void {
    this.ring.setStrokeStyle(2, color, 1);
    this.scene.tweens.add({
      targets: this.ring,
      scale: { from: 0.7, to: 1.6 },
      alpha: { from: 1, to: 0 },
      duration: 520,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        this.ring.setScale(1).setAlpha(1).setStrokeStyle(1, 0xffffff, 0);
      },
    });
  }

  private spawnFlourish(): void {
    this.setScale(0.2);
    this.setAlpha(0);
    this.scene.tweens.add({
      targets: this,
      scale: 1,
      alpha: 1,
      duration: 320,
      ease: 'Back.easeOut',
    });
  }

  fadeOutAndDestroy(): void {
    this.stopWalking();
    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      scale: 0.3,
      duration: 260,
      ease: 'Cubic.easeIn',
      onComplete: () => this.destroy(),
    });
  }

  // -- movement ----------------------------------------------------------

  get isWalking(): boolean {
    return this.queue.length > 0 || !!this.stepTween;
  }

  /** Snap without animating (used for `register` on an already-live agent). */
  teleport(tile: GridPos): void {
    this.stopWalking();
    this.tile = { ...tile };
    const world = tileToWorld(tile.x, tile.y);
    this.setPosition(world.x, world.y);
    this.setDepth(10 + this.y / 1000);
    this.playIdle();
  }

  /**
   * Walk the given tile path. Any in-flight walk is abandoned, so a fresh
   * `move` always wins over a stale one.
   */
  walkPath(path: GridPos[], speed = 1, onArrive?: () => void): void {
    this.stopWalking();
    this.onArrive = onArrive;
    if (!path.length) {
      onArrive?.();
      return;
    }
    this.queue = path.map((p) => ({ ...p }));
    this.stepDuration = STEP_MS / Math.max(0.15, speed);
    this.nextStep();
  }

  private stepDuration = STEP_MS;

  private stopWalking(): void {
    this.stepTween?.stop();
    this.stepTween = undefined;
    this.queue = [];
    this.onArrive = undefined;
  }

  private nextStep(): void {
    const next = this.queue.shift();
    if (!next) {
      this.stepTween = undefined;
      this.playIdle();
      const cb = this.onArrive;
      this.onArrive = undefined;
      cb?.();
      return;
    }

    const target = tileToWorld(next.x, next.y);
    const dx = next.x - this.tile.x;
    const dy = next.y - this.tile.y;

    // Face away from the camera when walking up; flip horizontally otherwise.
    if (dy !== 0) this.facing = dy < 0 ? 'back' : 'front';
    if (dx !== 0) this.body_.setFlipX(dx < 0);
    this.playWalk();

    this.tile = next;
    this.stepTween = this.scene.tweens.add({
      targets: this,
      x: target.x,
      y: target.y,
      duration: this.stepDuration,
      ease: 'Linear',
      onUpdate: () => {
        this.setDepth(10 + this.y / 1000);
      },
      onComplete: () => this.nextStep(),
    });
  }

  private playWalk(): void {
    const key = this.facing === 'back' ? anims.walkBack : anims.walkFront;
    this.body_.play(key(this.textureKey), true);
  }

  private playIdle(): void {
    const key = this.facing === 'back' ? anims.idleBack : anims.idleFront;
    this.body_.play(key(this.textureKey), true);
  }

  /** Where a DOM overlay should anchor (just above the head), in world pixels. */
  get anchorY(): number {
    return this.y - 28;
  }

  /** Distance from the anchor down to the feet, in world pixels. */
  get footOffset(): number {
    return 50;
  }
}

export interface RawInputState {
  moveX: number;
  moveY: number;
  fire: boolean;
  skillQ: boolean;
  skillE: boolean;
  skillR: boolean;
  aimNdcX: number;
  aimNdcY: number;
}

const TOUCH_STICK_MAX_DISTANCE = 72;
const TOUCH_STICK_DEADZONE = 6;

export class KeyboardMouseInput {
  private readonly keys = new Set<string>();
  private mouseDown = false;
  private aimNdcX = 0;
  private aimNdcY = 0;

  private touchMovePointerId: number | null = null;
  private touchAimPointerId: number | null = null;
  private touchMoveStartX = 0;
  private touchMoveStartY = 0;
  private touchMoveCurrentX = 0;
  private touchMoveCurrentY = 0;
  private touchMoveX = 0;
  private touchMoveY = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  detach(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);

    this.touchMovePointerId = null;
    this.touchAimPointerId = null;
    this.touchMoveX = 0;
    this.touchMoveY = 0;
  }

  sample(): RawInputState {
    const keyboardMoveX = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    // World forward is -Z in this camera setup, so invert keyboard Y mapping.
    const keyboardMoveY = (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0);

    const useKeyboard = keyboardMoveX !== 0 || keyboardMoveY !== 0;
    const moveX = useKeyboard ? keyboardMoveX : this.touchMoveX;
    const moveY = useKeyboard ? keyboardMoveY : this.touchMoveY;

    return {
      moveX,
      moveY,
      fire: this.mouseDown,
      skillQ: this.keys.has("KeyQ"),
      skillE: this.keys.has("KeyE"),
      skillR: this.keys.has("KeyR"),
      aimNdcX: this.aimNdcX,
      aimNdcY: this.aimNdcY,
    };
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      const rect = this.canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const leftZoneMaxX = rect.width * 0.58;

      if (this.touchMovePointerId === null && localX <= leftZoneMaxX) {
        this.touchMovePointerId = event.pointerId;
        this.touchMoveStartX = event.clientX;
        this.touchMoveStartY = event.clientY;
        this.touchMoveCurrentX = event.clientX;
        this.touchMoveCurrentY = event.clientY;
        this.touchMoveX = 0;
        this.touchMoveY = 0;
      } else if (this.touchAimPointerId === null) {
        this.touchAimPointerId = event.pointerId;
        this.updateAimFromClient(event.clientX, event.clientY);
      }

      return;
    }

    if (event.button === 0) this.mouseDown = true;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      if (event.pointerId === this.touchMovePointerId) {
        this.touchMovePointerId = null;
        this.touchMoveX = 0;
        this.touchMoveY = 0;
      }
      if (event.pointerId === this.touchAimPointerId) {
        this.touchAimPointerId = null;
      }
      return;
    }

    this.mouseDown = false;
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      if (event.pointerId === this.touchMovePointerId) {
        this.touchMoveCurrentX = event.clientX;
        this.touchMoveCurrentY = event.clientY;
        this.updateTouchStickVector();
        this.updateAimFromClient(event.clientX, event.clientY);
        return;
      }

      if (event.pointerId === this.touchAimPointerId) {
        this.updateAimFromClient(event.clientX, event.clientY);
        return;
      }
    }

    this.updateAimFromClient(event.clientX, event.clientY);
  };

  private updateTouchStickVector(): void {
    const dx = this.touchMoveCurrentX - this.touchMoveStartX;
    const dy = this.touchMoveCurrentY - this.touchMoveStartY;
    const distance = Math.hypot(dx, dy);

    if (distance < TOUCH_STICK_DEADZONE) {
      this.touchMoveX = 0;
      this.touchMoveY = 0;
      return;
    }

    const clampedDistance = Math.min(distance, TOUCH_STICK_MAX_DISTANCE);
    const normalized = clampedDistance / TOUCH_STICK_MAX_DISTANCE;
    const invDistance = distance > 0 ? 1 / distance : 0;

    this.touchMoveX = dx * invDistance * normalized;
    this.touchMoveY = dy * invDistance * normalized;
  }

  private updateAimFromClient(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / Math.max(1, rect.width);
    const y = (clientY - rect.top) / Math.max(1, rect.height);

    this.aimNdcX = x * 2 - 1;
    this.aimNdcY = -(y * 2 - 1);
  }
}

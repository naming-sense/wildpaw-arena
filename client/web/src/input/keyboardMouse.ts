export interface RawInputState {
  moveX: number;
  moveY: number;
  fire: boolean;
  skillQ: boolean;
  skillE: boolean;
  skillR: boolean;
  aimNdcX: number;
  aimNdcY: number;
  preferMoveFacing: boolean;
  hasAimControl: boolean;
}

const TOUCH_STICK_MAX_DISTANCE = 72;
const TOUCH_STICK_DEADZONE = 6;
const TOUCH_MOVE_ZONE_RATIO = 0.5;

type SkillSlot = "Q" | "E" | "R";

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

  private touchFire = false;
  private touchFireTapQueued = false;
  private touchFirePointerId: number | null = null;
  private fireButtonEl: HTMLElement | null = null;

  private skillButtonEls: HTMLElement[] = [];
  private touchSkillTapQueued: Record<SkillSlot, boolean> = {
    Q: false,
    E: false,
    R: false,
  };

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    this.bindFireButton();
    this.bindSkillButtons();
  }

  detach(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.unbindFireButton();
    this.unbindSkillButtons();

    this.touchMovePointerId = null;
    this.touchAimPointerId = null;
    this.touchMoveX = 0;
    this.touchMoveY = 0;
    this.touchFire = false;
    this.touchFireTapQueued = false;
    this.touchFirePointerId = null;
    this.touchSkillTapQueued.Q = false;
    this.touchSkillTapQueued.E = false;
    this.touchSkillTapQueued.R = false;
  }

  sample(): RawInputState {
    this.ensureControlButtonBinding();

    const keyboardMoveX = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    // World forward is -Z in this camera setup, so invert keyboard Y mapping.
    const keyboardMoveY = (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0);

    const useKeyboard = keyboardMoveX !== 0 || keyboardMoveY !== 0;
    const moveX = useKeyboard ? keyboardMoveX : this.touchMoveX;
    const moveY = useKeyboard ? keyboardMoveY : this.touchMoveY;

    const fire = this.mouseDown || this.touchFire || this.touchFireTapQueued;
    const skillQ = this.keys.has("KeyQ") || this.touchSkillTapQueued.Q;
    const skillE = this.keys.has("KeyE") || this.touchSkillTapQueued.E;
    const skillR = this.keys.has("KeyR") || this.touchSkillTapQueued.R;

    if (this.touchFireTapQueued) {
      // Ensure short taps are visible for at least one simulation tick.
      this.touchFireTapQueued = false;
    }
    if (this.touchSkillTapQueued.Q) {
      this.touchSkillTapQueued.Q = false;
    }
    if (this.touchSkillTapQueued.E) {
      this.touchSkillTapQueued.E = false;
    }
    if (this.touchSkillTapQueued.R) {
      this.touchSkillTapQueued.R = false;
    }

    const preferMoveFacing =
      !useKeyboard &&
      this.touchMovePointerId !== null &&
      this.touchAimPointerId === null &&
      Math.hypot(this.touchMoveX, this.touchMoveY) > 0.04;

    const hasAimControl = this.touchAimPointerId !== null || this.mouseDown;

    return {
      moveX,
      moveY,
      fire,
      skillQ,
      skillE,
      skillR,
      aimNdcX: this.aimNdcX,
      aimNdcY: this.aimNdcY,
      preferMoveFacing,
      hasAimControl,
    };
  }

  private ensureControlButtonBinding(): void {
    if (typeof document === "undefined") return;

    if (this.fireButtonEl && !this.fireButtonEl.isConnected) {
      this.unbindFireButton();
    }

    if (!this.fireButtonEl) {
      this.bindFireButton();
    }

    if (this.skillButtonEls.length > 0 && this.skillButtonEls.some((button) => !button.isConnected)) {
      this.unbindSkillButtons();
    }

    if (this.skillButtonEls.length === 0) {
      this.bindSkillButtons();
    }
  }

  private bindFireButton(): void {
    if (typeof document === "undefined") return;

    const fireButton = document.querySelector<HTMLElement>("[data-fire-button]");
    if (!fireButton) return;

    this.fireButtonEl = fireButton;
    fireButton.addEventListener("pointerdown", this.onFireButtonDown);
    fireButton.addEventListener("pointerup", this.onFireButtonUp);
    fireButton.addEventListener("pointercancel", this.onFireButtonUp);
    fireButton.addEventListener("pointerleave", this.onFireButtonUp);
  }

  private unbindFireButton(): void {
    if (!this.fireButtonEl) return;

    this.fireButtonEl.removeEventListener("pointerdown", this.onFireButtonDown);
    this.fireButtonEl.removeEventListener("pointerup", this.onFireButtonUp);
    this.fireButtonEl.removeEventListener("pointercancel", this.onFireButtonUp);
    this.fireButtonEl.removeEventListener("pointerleave", this.onFireButtonUp);
    this.fireButtonEl = null;
  }

  private bindSkillButtons(): void {
    if (typeof document === "undefined") return;

    const skillButtons = [...document.querySelectorAll<HTMLElement>("[data-skill-button]")];
    if (skillButtons.length === 0) {
      this.skillButtonEls = [];
      return;
    }

    this.skillButtonEls = skillButtons;
    for (const button of this.skillButtonEls) {
      button.addEventListener("pointerdown", this.onSkillButtonDown);
      button.addEventListener("pointerup", this.onSkillButtonUp);
      button.addEventListener("pointercancel", this.onSkillButtonUp);
      button.addEventListener("pointerleave", this.onSkillButtonUp);
    }
  }

  private unbindSkillButtons(): void {
    if (this.skillButtonEls.length === 0) return;

    for (const button of this.skillButtonEls) {
      button.removeEventListener("pointerdown", this.onSkillButtonDown);
      button.removeEventListener("pointerup", this.onSkillButtonUp);
      button.removeEventListener("pointercancel", this.onSkillButtonUp);
      button.removeEventListener("pointerleave", this.onSkillButtonUp);
    }

    this.skillButtonEls = [];
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
      const leftZoneMaxX = rect.width * TOUCH_MOVE_ZONE_RATIO;

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
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      if (event.pointerId === this.touchMovePointerId) {
        this.touchMovePointerId = null;
        this.touchMoveX = 0;
        this.touchMoveY = 0;
      }
      if (event.pointerId === this.touchAimPointerId) {
        this.touchAimPointerId = null;
      }
      if (event.pointerId === this.touchFirePointerId) {
        this.touchFire = false;
        this.touchFirePointerId = null;
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
        return;
      }

      if (event.pointerId === this.touchAimPointerId) {
        this.updateAimFromClient(event.clientX, event.clientY);
        return;
      }
    }

    this.updateAimFromClient(event.clientX, event.clientY);
  };

  private onFireButtonDown = (event: PointerEvent): void => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen" && event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    this.touchFire = true;
    this.touchFireTapQueued = true;
    this.touchFirePointerId = event.pointerId;

    const target = event.currentTarget as HTMLElement | null;
    if (target && typeof target.setPointerCapture === "function") {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures
      }
    }
  };

  private onFireButtonUp = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();

    if (this.touchFirePointerId === null || event.pointerId === this.touchFirePointerId) {
      this.touchFire = false;
      this.touchFirePointerId = null;
    }

    const target = event.currentTarget as HTMLElement | null;
    if (target && typeof target.hasPointerCapture === "function" && target.hasPointerCapture(event.pointerId)) {
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // ignore release failures
      }
    }
  };

  private onSkillButtonDown = (event: PointerEvent): void => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen" && event.button !== 0) {
      return;
    }

    const slot = this.resolveSkillSlot(event.currentTarget);
    if (!slot) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    this.touchSkillTapQueued[slot] = true;

    const target = event.currentTarget as HTMLElement | null;
    if (target && typeof target.setPointerCapture === "function") {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures
      }
    }
  };

  private onSkillButtonUp = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget as HTMLElement | null;
    if (target && typeof target.hasPointerCapture === "function" && target.hasPointerCapture(event.pointerId)) {
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // ignore release failures
      }
    }
  };

  private resolveSkillSlot(target: EventTarget | null): SkillSlot | null {
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const raw = target.dataset.skillButton?.trim().toUpperCase();
    if (raw === "Q" || raw === "E" || raw === "R") {
      return raw;
    }

    return null;
  }

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

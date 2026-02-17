import * as THREE from "three";

export class CameraRig {
  private readonly target = new THREE.Vector3();
  private shakeIntensity = 0;

  private readonly followDistance = 7.8;
  private readonly focusHeight = 1.05;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly height: number,
    private readonly tiltDeg: number,
  ) {
    this.camera.rotation.order = "YXZ";
  }

  setFollowTarget(x: number, z: number): void {
    this.target.set(x, 0, z);
  }

  addShake(intensity: number): void {
    this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
  }

  update(dtMs: number): void {
    const alpha = 1 - Math.exp(-dtMs / 90);
    this.camera.position.x += (this.target.x - this.camera.position.x) * alpha;
    this.camera.position.z += (this.target.z + this.followDistance - this.camera.position.z) * alpha;
    this.camera.position.y += (this.target.y + this.height - this.camera.position.y) * alpha;

    this.shakeIntensity = Math.max(0, this.shakeIntensity - dtMs * 0.004);
    const shakeX = (Math.random() - 0.5) * this.shakeIntensity;
    const shakeY = (Math.random() - 0.5) * this.shakeIntensity;

    this.camera.lookAt(
      this.target.x + shakeX,
      this.target.y + this.focusHeight + shakeY * 0.25,
      this.target.z,
    );

    // Keep at least the configured downward tilt, but never force the camera flatter.
    const tilt = THREE.MathUtils.degToRad(this.tiltDeg);
    this.camera.rotation.x = Math.min(this.camera.rotation.x, -tilt);
  }
}

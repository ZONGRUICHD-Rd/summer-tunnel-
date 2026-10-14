import * as THREE from 'three';

/**
 * "Stand here and look around" controls: drag to turn the head within limits,
 * wheel / pinch to zoom the lens. Values are damped for a soft, filmic feel.
 */
export class LookControls {
  constructor(dom) {
    this.dom = dom;
    this.enabled = true;
    this.yaw = 0;
    this.pitch = 0;
    this.zoom = 1;
    this.target = { yaw: 0, pitch: 0, zoom: 1 };
    this.limits = { yaw: THREE.MathUtils.degToRad(40), pitch: THREE.MathUtils.degToRad(18), zoomMin: 0.85, zoomMax: 1.8 };
    this.pointers = new Map();
    this.pinchStart = 0;
    this.zoomStart = 1;
    this.sensitivity = 0.0035;
    this.onInteract = null;

    dom.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    dom.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    dom.addEventListener('dblclick', () => this.reset());
  }

  down(e) {
    if (!this.enabled) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      this.zoomStart = this.target.zoom;
    }
    this.onInteract?.();
  }

  move(e) {
    if (!this.enabled || !this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      const s = this.sensitivity / this.target.zoom;
      this.target.yaw = THREE.MathUtils.clamp(this.target.yaw + dx * s, -this.limits.yaw, this.limits.yaw);
      this.target.pitch = THREE.MathUtils.clamp(this.target.pitch + dy * s, -this.limits.pitch, this.limits.pitch);
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.target.zoom = THREE.MathUtils.clamp((this.zoomStart * d) / Math.max(1, this.pinchStart), this.limits.zoomMin, this.limits.zoomMax);
    }
  }

  up(e) {
    this.pointers.delete(e.pointerId);
  }

  wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0012);
    this.target.zoom = THREE.MathUtils.clamp(this.target.zoom * k, this.limits.zoomMin, this.limits.zoomMax);
    this.onInteract?.();
  }

  reset() {
    this.target.yaw = 0;
    this.target.pitch = 0;
    this.target.zoom = 1;
  }

  snap() {
    this.yaw = this.target.yaw;
    this.pitch = this.target.pitch;
    this.zoom = this.target.zoom;
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * 6);
    this.yaw += (this.target.yaw - this.yaw) * k;
    this.pitch += (this.target.pitch - this.pitch) * k;
    this.zoom += (this.target.zoom - this.zoom) * k;
  }
}

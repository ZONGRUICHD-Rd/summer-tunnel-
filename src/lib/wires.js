import * as THREE from 'three';
import { PROJECTOR_GLSL } from './projector.js';

/**
 * Overhead wires rendered as camera-facing ribbons. Close up they keep their
 * real thickness; far away they are clamped to a minimum pixel width and fade
 * by coverage instead of breaking into aliased dashes.
 */
export class WireSet {
  constructor({ color = 0x262a33, minPx = 0.65, opacity = 1, projector = null } = {}) {
    this.segments = [];
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uColor: { value: new THREE.Color(color) },
          uMinPx: { value: minPx },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uOpacity: { value: opacity },
          uHideInPainting: { value: 0 },
        },
      ]),
      defines: projector ? { USE_PROJECTOR: '' } : {},
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec3 aTangent;
        attribute float aSide;
        attribute float aRadius;
        uniform float uMinPx;
        uniform vec2 uResolution;
        varying float vCover;
        varying float vSide;
        varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vec3 t = normalize(mat3(modelViewMatrix) * aTangent);
          vec3 viewDir = normalize(-mvPosition.xyz);
          vec3 s = normalize(cross(t, viewDir));
          float depth = max(-mvPosition.z, 0.01);
          float px = depth * 2.0 / (projectionMatrix[1][1] * uResolution.y);
          float minW = uMinPx * px;
          float w = max(aRadius, minW);
          vCover = clamp(aRadius / minW, 0.0, 1.0);
          vSide = aSide;
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          mvPosition.xyz += s * aSide * w;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uHideInPainting;
        varying float vCover;
        varying float vSide;
        varying vec3 vWorld;
        #include <fog_pars_fragment>
        #ifdef USE_PROJECTOR
        ${PROJECTOR_GLSL}
        #endif
        void main() {
          float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
          float a = mix(edge, 1.0, 0.35) * mix(0.25, 1.0, sqrt(vCover)) * uOpacity;
          #ifdef USE_PROJECTOR
            // the painting already has these wires drawn in
            a *= 1.0 - projectPainting(vec4(vWorld, 1.0)).a * uHideInPainting;
          #endif
          gl_FragColor = vec4(uColor, a);
          #include <fog_fragment>
        }
      `,
    });
    if (projector) Object.assign(this.material.uniforms, projector.uniforms);
  }

  /** Hide wire pixels already present in the projected painting. */
  setHideInPainting(on) {
    this.material.uniforms.uHideInPainting.value = on ? 1 : 0;
  }

  /** Add a polyline (array of Vector3). */
  addPolyline(points, radius = 0.012) {
    this.segments.push({ points, radius });
  }

  /** Catenary-ish sagging wire between successive supports. */
  addSpan(supports, { radius = 0.012, sag = 0.4, samples = 24 } = {}) {
    const pts = [];
    for (let s = 0; s < supports.length - 1; s++) {
      const a = supports[s];
      const b = supports[s + 1];
      const len = a.distanceTo(b);
      const sg = typeof sag === 'function' ? sag(len) : sag;
      const n = Math.max(4, Math.round(samples * Math.min(1, len / 30)) + 4);
      for (let i = s === 0 ? 0 : 1; i <= n; i++) {
        const t = i / n;
        const p = a.clone().lerp(b, t);
        p.y -= 4 * sg * t * (1 - t);
        pts.push(p);
      }
    }
    this.addPolyline(pts, radius);
  }

  build() {
    let quads = 0;
    for (const s of this.segments) quads += s.points.length - 1;
    const pos = new Float32Array(quads * 4 * 3);
    const tan = new Float32Array(quads * 4 * 3);
    const side = new Float32Array(quads * 4);
    const rad = new Float32Array(quads * 4);
    const index = new Uint32Array(quads * 6);
    let q = 0;
    for (const s of this.segments) {
      for (let i = 0; i < s.points.length - 1; i++) {
        const a = s.points[i];
        const b = s.points[i + 1];
        const tx = b.x - a.x;
        const ty = b.y - a.y;
        const tz = b.z - a.z;
        const verts = [a, a, b, b];
        const sides = [-1, 1, -1, 1];
        for (let k = 0; k < 4; k++) {
          const vi = q * 4 + k;
          pos.set([verts[k].x, verts[k].y, verts[k].z], vi * 3);
          tan.set([tx, ty, tz], vi * 3);
          side[vi] = sides[k];
          rad[vi] = s.radius;
        }
        const b0 = q * 4;
        index.set([b0, b0 + 1, b0 + 2, b0 + 2, b0 + 1, b0 + 3], q * 6);
        q++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aTangent', new THREE.BufferAttribute(tan, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aRadius', new THREE.BufferAttribute(rad, 1));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new THREE.Mesh(g, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 50;
    return mesh;
  }

  setResolution(w, h) {
    this.material.uniforms.uResolution.value.set(w, h);
  }
}

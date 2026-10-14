import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, noise2 } from './noise.js';

export { mergeGeometries };

/**
 * Extrude a 2D cross-section (array of [x, y]) along -Z between z0 > z1.
 * Each profile edge gets its own vertices so the result is flat shaded,
 * u runs across the profile (metres / uvScale) and v along the length.
 */
export function profileStrip(profile, z0, z1, { segments = 1, uvScale = 1, closed = false, yNoise = null } = {}) {
  const pos = [];
  const uv = [];
  const idx = [];
  const edges = closed ? profile.length : profile.length - 1;
  let uAcc = 0;
  for (let e = 0; e < edges; e++) {
    const a = profile[e];
    const b = profile[(e + 1) % profile.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const base = pos.length / 3;
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const z = z0 + (z1 - z0) * t;
      for (const [p, u] of [
        [a, uAcc],
        [b, uAcc + len],
      ]) {
        let y = p[1];
        if (yNoise) y += yNoise(p[0], z, p);
        pos.push(p[0], y, z);
        uv.push(u / uvScale, -z / uvScale);
      }
    }
    for (let s = 0; s < segments; s++) {
      const i = base + s * 2;
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    uAcc += len;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Cylinder between two points. */
export function rod(a, b, radius, radialSegments = 8, radiusB = radius) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(radiusB, radius, len, radialSegments, 1, false);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Box positioned by centre with optional Y rotation. */
export function box(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/**
 * Lumpy foliage blob: a displaced icosphere whose vertex colours darken
 * towards the bottom (cheap ambient occlusion for tree crowns and bushes).
 */
export function blobGeometry(seed = 1, { detail = 2, lumps = 0.28, squash = 0.85, dark = 0.45 } = {}) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const rnd = mulberry32(seed);
  const ox = rnd() * 100;
  const oy = rnd() * 100;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n =
      noise2(v.x * 2.2 + ox, v.z * 2.2 + v.y * 1.3 + oy) * 0.65 + noise2(v.x * 5.1 + oy, v.y * 5.1 + v.z * 3.0 + ox) * 0.35;
    const r = 1 + (n - 0.5) * 2 * lumps;
    v.multiplyScalar(r);
    v.y *= squash;
    if (v.y < -0.35) v.y = -0.35 + (v.y + 0.35) * 0.4; // flatter underside
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = THREE.MathUtils.clamp((y + 0.5) / 1.3, 0, 1);
    const k = dark + (1 - dark) * Math.pow(t, 0.8);
    colors[i * 3] = k;
    colors[i * 3 + 1] = k;
    colors[i * 3 + 2] = k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Two crossed quads rooted at y=0 for grass and weeds (normals point up). */
export function grassCard(w = 1, h = 1) {
  const a = new THREE.PlaneGeometry(w, h);
  a.translate(0, h / 2, 0);
  const b = a.clone().rotateY(Math.PI / 2);
  const c = a.clone().rotateY(Math.PI / 4);
  const g = mergeGeometries([a, b, c]);
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

/** Fill an InstancedMesh from an array of {p, s, ry, c} records. */
export function fillInstances(mesh, items) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  items.forEach((it, i) => {
    e.set(it.rx ?? 0, it.ry ?? 0, it.rz ?? 0);
    q.setFromEuler(e);
    if (typeof it.s === 'number') s.setScalar(it.s);
    else s.copy(it.s);
    m.compose(it.p, q, s);
    mesh.setMatrixAt(i, m);
    if (it.c) mesh.setColorAt(i, it.c);
  });
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

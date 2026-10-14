import * as THREE from 'three';
import { toon, shared } from '../lib/materials.js';
import { createSkyDome, createCumulus, bakeClouds } from '../lib/sky.js';
import { NOISE_GLSL } from '../lib/glsl.js';
import { box, rod, grassCard, fillInstances, mergeGeometries } from '../lib/geom.js';
import { mulberry32, lerp, clamp } from '../lib/noise.js';
import * as TX from '../lib/textures.js';

const deg = THREE.MathUtils.degToRad;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

const SEA_Y = -1.45;
const EDGE_Z = -3.0; // promenade edge / sea wall
const SUN_DIR = V(-0.32, 0.88, 0.34).normalize();
const GLITTER_DIR = V(0.0, 0.1, -1).normalize();

// ---------------------------------------------------------------------------
// Sea: stylised water with travelling waves, sky reflection and a glitter path
// ---------------------------------------------------------------------------
function createSea() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uNear: { value: new THREE.Color(0x174d96) },
      uMid: { value: new THREE.Color(0x1f5fae) },
      uFar: { value: new THREE.Color(0x225fb0) },
      uHorizon: { value: new THREE.Color(0x3474c0) },
      uSky: { value: new THREE.Color(0x7fb8e6) },
      uGlitter: { value: GLITTER_DIR.clone() },
      uSun: { value: new THREE.Color(0xfffaf0) },
    },
  ]);
  uniforms.uTime = shared.uTime;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uNear, uMid, uFar, uHorizon, uSky, uGlitter, uSun;
      varying vec3 vWPos;
      ${NOISE_GLSL}

      vec2 waveGrad(vec2 p, float t, float lod) {
        vec2 g = vec2(0.0);
        // a few long swells travelling towards the shore
        const int N = 5;
        vec2 dirs[N];
        dirs[0] = normalize(vec2(0.15, 1.0));
        dirs[1] = normalize(vec2(-0.35, 1.0));
        dirs[2] = normalize(vec2(0.6, 1.0));
        dirs[3] = normalize(vec2(-0.8, 0.6));
        dirs[4] = normalize(vec2(0.9, 0.4));
        float freq = 0.35;
        float amp = 0.12;
        for (int i = 0; i < N; i++) {
          float ph = dot(p, dirs[i]) * freq + t * sqrt(9.8 * freq) * 0.6 + float(i) * 1.7;
          g += dirs[i] * cos(ph) * amp * freq * lod;
          freq *= 1.85;
          amp *= 0.55;
          lod *= 0.7;
        }
        // chop
        float e = 0.15;
        vec2 q = p * 1.6 + vec2(0.0, t * 0.6);
        float n0 = fbm2(q);
        g += vec2(fbm2(q + vec2(e, 0.0)) - n0, fbm2(q + vec2(0.0, e)) - n0) / e * 0.06 * lod;
        return g;
      }

      void main() {
        vec3 toCam = cameraPosition - vWPos;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        float lod = 1.0 / (1.0 + dist * 0.015);
        vec2 g = waveGrad(vWPos.xz, uTime, lod);
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));

        float far = smoothstep(20.0, 700.0, dist);
        vec3 col;
        vec3 base = mix(uNear, uMid, smoothstep(6.0, 60.0, dist));
        base = mix(base, uFar, far);

        float ndv = max(dot(n, V), 0.0);
        float fres = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
        col = mix(base, uSky, fres * mix(0.5, 0.18, far));

        // painted horizontal strokes of lighter water
        vec2 sp = vec2(vWPos.x * 0.03, vWPos.z * 0.45) / (1.0 + dist * 0.004);
        float stroke = smoothstep(0.62, 0.8, fbm2(sp + vec2(uTime * 0.02, 0.0)));
        col = mix(col, col * 1.18 + vec3(0.02, 0.04, 0.06), stroke * 0.55 * (1.0 - far * 0.5));

        // glitter path: a column under the sun, narrow far away, wider up close
        vec3 Rf = reflect(-V, vec3(0.0, 1.0, 0.0));
        float azR = atan(Rf.x, -Rf.z) - atan(uGlitter.x, -uGlitter.z);
        float elR = asin(clamp(Rf.y, -1.0, 1.0));
        float width = mix(0.035, 0.16, smoothstep(0.0, 0.25, elR));
        float band = (1.0 - smoothstep(width * 0.4, width, abs(azR))) * smoothstep(0.0, 0.004, elR);
        vec3 R = reflect(-V, n);
        float s = max(dot(R, uGlitter), 0.0);
        float spec = pow(s, 1200.0) * (0.3 + band);
        vec2 tw = vec2(vWPos.x * 1.4, vWPos.z * 4.0) / (1.0 + dist * 0.05);
        float twinkle = smoothstep(0.7, 0.9, vnoise(tw * 3.0 + vec2(uTime * 1.3, -uTime * 0.7)));
        float twinkle2 = smoothstep(0.86, 0.95, vnoise(tw * 1.7 + vec2(-uTime * 0.9, uTime * 0.5)));
        col += uSun * (spec * 2.0 + band * twinkle * 2.4 + band * 0.1 + twinkle2 * 0.35 * (1.0 - far));

        // haze into the horizon line
        col = mix(col, uHorizon, smoothstep(1500.0, 5800.0, dist) * 0.7);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const g = new THREE.PlaneGeometry(14000, 7000, 1, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(0, SEA_Y, EDGE_Z - 3500);
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Seagull with two-segment wings
// ---------------------------------------------------------------------------
function createGull(mats) {
  const bird = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mats.white);
  body.scale.set(0.09, 0.085, 0.26);
  bird.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.065, 12, 8), mats.white);
  head.position.set(0, 0.04, -0.25);
  bird.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.07, 6), mats.beak);
  beak.rotation.x = -Math.PI / 2;
  beak.position.set(0, 0.03, -0.33);
  bird.add(beak);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 4), mats.white);
  tail.rotation.x = Math.PI / 2;
  tail.scale.set(1, 1, 0.25);
  tail.position.set(0, 0.0, 0.3);
  bird.add(tail);

  const wing = (side) => {
    const inner = new THREE.Group();
    inner.position.set(side * 0.06, 0.03, -0.04);
    const s1 = new THREE.Shape();
    s1.moveTo(0, -0.11);
    s1.lineTo(0.32, -0.08);
    s1.lineTo(0.32, 0.07);
    s1.lineTo(0, 0.1);
    s1.lineTo(0, -0.11);
    const g1 = new THREE.ShapeGeometry(s1);
    g1.rotateX(Math.PI / 2);
    if (side < 0) g1.scale(-1, 1, 1);
    const m1 = new THREE.Mesh(g1, mats.wing);
    inner.add(m1);
    const outer = new THREE.Group();
    outer.position.set(side * 0.32, 0, 0);
    const s2 = new THREE.Shape();
    s2.moveTo(0, -0.08);
    s2.lineTo(0.22, -0.02);
    s2.lineTo(0.38, 0.1);
    s2.lineTo(0.0, 0.07);
    s2.lineTo(0, -0.08);
    const g2 = new THREE.ShapeGeometry(s2);
    g2.rotateX(Math.PI / 2);
    if (side < 0) g2.scale(-1, 1, 1);
    outer.add(new THREE.Mesh(g2, mats.wing));
    const tip = new THREE.Shape();
    tip.moveTo(0.2, -0.015);
    tip.lineTo(0.38, 0.1);
    tip.lineTo(0.24, 0.085);
    tip.lineTo(0.2, -0.015);
    const g3 = new THREE.ShapeGeometry(tip);
    g3.rotateX(Math.PI / 2);
    g3.translate(0, 0.002, 0);
    if (side < 0) g3.scale(-1, 1, 1);
    outer.add(new THREE.Mesh(g3, mats.tip));
    inner.add(outer);
    bird.add(inner);
    return { inner, outer };
  };
  const L = wing(-1);
  const R = wing(1);
  bird.userData.wings = { L, R };
  bird.traverse((o) => {
    if (o.isMesh) o.castShadow = false;
  });
  return bird;
}

export function createSeasideScene({ quality, renderer }) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xbfe0f2, 200, 4000);
  const rnd = mulberry32(77);

  // ------------------------------------------------------------------ light
  const sun = new THREE.DirectionalLight(0xfff4e2, 2.3 * Math.PI);
  sun.position.copy(SUN_DIR).multiplyScalar(30);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  const sm = quality.shadowMap;
  sun.shadow.mapSize.set(sm, sm);
  const sc = sun.shadow.camera;
  sc.left = -7;
  sc.right = 7;
  sc.top = 7;
  sc.bottom = -7;
  sc.near = 5;
  sc.far = 60;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xa8d2ff, 0xd8d4cc, 1.25 * Math.PI));

  // -------------------------------------------------------------------- sky
  scene.add(
    createSkyDome({
      zenith: 0x2a86d4,
      mid: 0x5eb0e6,
      horizon: 0xc9e8f6,
      ground: 0xc9e8f6,
      sunDir: V(0.05, 0.75, -0.66),
      sunColor: 0xffffff,
      sunGlow: 0.18,
      midHeight: 0.42,
      paint: 0.08,
      alto: 0,
      cirrus: 0.55,
      cirrusColor: 0xf2f8ff,
      cirrusDir: V(1, 0, 0.35).normalize(),
    })
  );

  const cl = V(0.25, 0.85, 0.45);
  const cloudDefs = [
    { azimuth: -2, elevation: 11.5, width: 34, aspect: 2.4, seed: 2, count: 52, top: 1.2 },
    { azimuth: 19, elevation: 10.5, width: 30, aspect: 2.6, seed: 5, count: 48, top: 1.0 },
    { azimuth: -22, elevation: 10.0, width: 30, aspect: 2.8, seed: 9, count: 46, top: 0.95 },
    { azimuth: 38, elevation: 12.5, width: 26, aspect: 2.0, seed: 12, count: 40, top: 1.1 },
    { azimuth: -40, elevation: 11.0, width: 28, aspect: 2.4, seed: 14, count: 42, top: 1.0 },
    { azimuth: 8, elevation: 7.6, width: 46, aspect: 5.5, seed: 18, count: 56, top: 0.6, haze: 0.18 },
    { azimuth: -18, elevation: 7.4, width: 40, aspect: 5.0, seed: 22, count: 50, top: 0.55, haze: 0.2 },
    { azimuth: 33, elevation: 7.2, width: 36, aspect: 5.0, seed: 25, count: 46, top: 0.55, haze: 0.22 },
    { azimuth: 58, elevation: 9.5, width: 30, aspect: 2.6, seed: 28, count: 40, top: 1.0 },
    { azimuth: -60, elevation: 9.0, width: 30, aspect: 2.6, seed: 31, count: 40, top: 1.0 },
    { azimuth: 5, elevation: 15.5, width: 12, aspect: 1.8, seed: 35, count: 26, top: 1.0 },
    { azimuth: 48, elevation: 22, width: 14, aspect: 3.0, seed: 38, count: 24, top: 0.5, opacity: 0.85 },
  ];
  cloudDefs.forEach((c, i) =>
    scene.add(
      createCumulus({
        light: cl,
        lit: 0xffffff,
        shade: 0xbfd2ec,
        dark: 0x9db9e0,
        rim: 0xffffff,
        hazeColor: 0xc4e3f5,
        haze: 0.04,
        drift: 0.0006,
        order: i,
        ...c,
      })
    )
  );

  // ------------------------------------------------------------- textures
  const tPaving = TX.pavingTexture(17);
  const tPaint = TX.paintedWoodTexture(19);
  const tConcrete = TX.concreteTexture(21, { stains: 0.25, pits: 900 });
  const tGrass = TX.grassTexture(23);
  const tLeaves = TX.leafCanopyTexture(29);

  const M = {
    paving: toon({ map: tPaving, color: 0xf4f2ee, ramp: [0.46, 0.56], litFloor: 0.86 }),
    concrete: toon({ map: tConcrete, color: 0xeeeeea }),
    block: toon({ map: tConcrete, color: 0xc3cbd6 }),
    slat: toon({ map: tPaint, color: 0xdde8f1 }),
    metal: toon({ color: 0xc5d2de }),
    screw: toon({ color: 0x7c8794 }),
    grass: toon({ map: tGrass, color: 0x7f9c8c, alphaTest: 0.5, side: THREE.DoubleSide, wind: 0.06, ramp: [0.3, 0.6], litFloor: 0.9, lineWeight: 0 }),
    wall: toon({ map: tConcrete, color: 0xb9c4d0 }),
  };

  const add = (geo, mat, { cast = true, receive = true } = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    scene.add(m);
    return m;
  };

  scene.add(createSea());

  // ------------------------------------------------------------ promenade
  {
    const W = 120;
    const D = 30;
    const g = new THREE.PlaneGeometry(W, D, 1, 1);
    g.rotateX(-Math.PI / 2);
    // rotate the UVs so slab joints run diagonally like in the painting
    const uv = g.attributes.uv;
    const pos = g.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      uv.setXY(i, x / 3.2, z / 3.2);
    }
    g.translate(0, 0, EDGE_Z + D / 2);
    add(g, M.paving, { cast: false });

    // slab joints: thin dark lines on the paving
    const joints = [];
    for (let k = -14; k <= 14; k++) {
      const x0 = k * 3.4;
      joints.push(rod(V(x0 - 7, 0.003, 14), V(x0 + 2.2, 0.003, EDGE_Z + 0.05), 0.006, 3));
    }
    for (let z = EDGE_Z + 0.35; z < 14; z += 3.0) joints.push(rod(V(-60, 0.003, z), V(60, 0.003, z), 0.005, 3));
    add(mergeGeometries(joints), new THREE.MeshBasicMaterial({ color: 0x9aa6b4 }), { cast: false, receive: false });

    // sea wall face and its coping
    add(box(W, 1.7, 0.4, 0, SEA_Y + 0.6, EDGE_Z - 0.2), M.wall, { cast: false });
    add(box(W, 0.06, 0.45, 0, 0.03, EDGE_Z + 0.02), M.concrete, { cast: false });

    // row of low blocks along the edge
    const blocks = [];
    for (let x = -60; x <= 60; x += 1.35) {
      const w = 0.6 + rnd() * 0.08;
      blocks.push({ p: V(x + (rnd() - 0.5) * 0.06, 0.08, EDGE_Z + 0.32), s: V(w, 0.16, 0.3), ry: (rnd() - 0.5) * 0.02 });
    }
    const bm = fillInstances(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), M.block, blocks.length), blocks);
    bm.castShadow = true;
    bm.receiveShadow = true;
    scene.add(bm);
  }

  // ---------------------------------------------------------------- bench
  {
    const L = 2.66;
    const legX = 1.06;
    const seatY = 0.43;
    // concrete legs
    for (const sx of [-1, 1]) {
      add(box(0.36, 0.4, 0.5, sx * legX, 0.2, 0.0), M.concrete);
      add(box(0.38, 0.015, 0.52, sx * legX, 0.4, 0.0), M.concrete);
    }
    // seat slats
    const slats = [];
    const screws = [];
    const nSeat = 5;
    const sw = 0.082;
    const gap = 0.014;
    const seatDepth = nSeat * sw + (nSeat - 1) * gap;
    for (let i = 0; i < nSeat; i++) {
      const z = seatDepth / 2 - sw / 2 - i * (sw + gap);
      slats.push(box(L, 0.034, sw, 0, seatY + 0.017, z));
      for (const x of [-legX, 0, legX]) screws.push({ p: V(x, seatY + 0.035, z), s: 1 });
    }
    // backrest slats, leaning back
    const back = new THREE.Group();
    const backGeo = [];
    const nBack = 6;
    const bh = 0.066;
    const bgap = 0.014;
    for (let i = 0; i < nBack; i++) {
      const y = 0.09 + i * (bh + bgap) + bh / 2;
      backGeo.push(box(L, bh, 0.028, 0, y, 0));
      for (const x of [-legX, 0, legX]) screws.push({ p: V(x, seatY + 0.06 + y, -0.28 + y * 0.12 + 0.016), s: 1, rx: Math.PI / 2 });
    }
    const backMesh = new THREE.Mesh(mergeGeometries(backGeo), M.slat);
    backMesh.castShadow = true;
    backMesh.receiveShadow = true;
    back.add(backMesh);
    back.position.set(0, seatY + 0.06, -0.3);
    back.rotation.x = -deg(7);
    scene.add(back);
    add(mergeGeometries(slats), M.slat);

    // metal frame: supports under the seat, posts behind the backrest, centre leg
    const metal = [];
    for (const x of [-legX, 0, legX]) {
      metal.push(box(0.04, 0.035, seatDepth + 0.04, x, seatY - 0.018, 0));
      const p0 = V(x, seatY - 0.02, -0.29);
      const p1 = V(x, seatY + 0.6, -0.36);
      metal.push(rod(p0, p1, 0.018, 8));
    }
    metal.push(box(L - 0.1, 0.03, 0.03, 0, seatY - 0.05, seatDepth / 2 - 0.03));
    metal.push(box(0.04, seatY - 0.05, 0.04, 0, (seatY - 0.05) / 2, 0.0));
    metal.push(box(0.12, 0.012, 0.12, 0, 0.006, 0.0));
    add(mergeGeometries(metal), M.metal);

    const sg = new THREE.CylinderGeometry(0.008, 0.008, 0.004, 8);
    const scr = fillInstances(new THREE.InstancedMesh(sg, M.screw, screws.length), screws);
    scene.add(scr);
  }

  // ---------------------------------------------------------------- grass
  {
    const items = [];
    const tuft = (x, z, s, n = 1) => {
      for (let i = 0; i < n; i++) {
        const k = 0.8 + rnd() * 0.35;
        items.push({ p: V(x + (rnd() - 0.5) * 0.12, 0, z + (rnd() - 0.5) * 0.12), s: V(s * (0.8 + rnd() * 0.5), s * (0.7 + rnd() * 0.6), s), ry: rnd() * 6, c: new THREE.Color(k, k, k) });
      }
    };
    // around the bench legs
    for (const sx of [-1, 1]) {
      tuft(sx * 1.32, 0.1, 0.2, 4);
      tuft(sx * 0.82, 0.25, 0.14, 2);
    }
    tuft(-0.35, 0.3, 0.1, 2);
    tuft(0.5, 0.22, 0.09, 2);
    // along the edge and the cracks
    for (let i = 0; i < 90; i++) tuft(lerp(-14, 14, rnd()), EDGE_Z + 0.15 + rnd() * 0.25, 0.08 + rnd() * 0.12);
    for (let i = 0; i < 26; i++) tuft(lerp(-5, 5, rnd()), lerp(0.6, 4.5, rnd()), 0.06 + rnd() * 0.06);
    tuft(1.9, 1.8, 0.12, 3);
    tuft(-2.6, 1.2, 0.1, 2);
    const g = grassCard(1, 1);
    const m = fillInstances(new THREE.InstancedMesh(g, M.grass, items.length), items);
    m.receiveShadow = true;
    scene.add(m);
  }

  // ------------------------------------------------- dappled leaf shadows
  const canopy = new THREE.Group();
  {
    const mat = new THREE.MeshBasicMaterial({ map: tLeaves, alphaTest: 0.5, side: THREE.DoubleSide, colorWrite: false, depthWrite: false });
    mat.shadowSide = THREE.DoubleSide;
    const layers = [
      [V(-1.4, 4.6, 1.6), 5.5, 0.0],
      [V(-2.6, 5.2, 1.7), 5.5, 0.8],
      [V(-0.4, 5.6, 2.0), 5.0, 1.9],
      [V(-2.0, 6.0, 0.9), 6.0, 2.7],
      [V(-3.6, 4.8, 2.4), 5.0, 3.6],
    ];
    for (const [p, s, r] of layers) {
      const g = new THREE.PlaneGeometry(s, s);
      g.rotateX(-Math.PI / 2);
      g.rotateY(r);
      const m = new THREE.Mesh(g, mat);
      m.position.copy(p);
      m.castShadow = true;
      m.receiveShadow = false;
      m.userData.base = p.clone();
      m.userData.phase = r;
      canopy.add(m);
    }
    scene.add(canopy);
  }

  // ---------------------------------------------------------------- gulls
  const gullMats = {
    white: toon({ color: 0xf6f8fb }),
    wing: toon({ color: 0xc9d2de, side: THREE.DoubleSide }),
    tip: toon({ color: 0x3b4352, side: THREE.DoubleSide }),
    beak: toon({ color: 0xf0c050 }),
  };
  const gulls = [];
  const gullDefs = [
    // centre, radius x/z, height, speed, scale
    { c: V(-6, 8.5, -16), r: V(9, 0, 5), h: 1.2, sp: 0.09, s: 1.0, ph: 0.2 },
    { c: V(5, 9.5, -22), r: V(10, 0, 6), h: 1.5, sp: -0.075, s: 1.0, ph: 2.1 },
    { c: V(-11, 6.0, -12), r: V(5, 0, 4), h: 0.8, sp: 0.12, s: 0.95, ph: 4.0 },
    { c: V(12, 7.5, -14), r: V(6, 0, 5), h: 1.0, sp: -0.1, s: 0.95, ph: 1.0 },
    { c: V(1, 12, -30), r: V(14, 0, 8), h: 2.0, sp: 0.06, s: 1.1, ph: 3.3 },
    { c: V(-20, 10, -40), r: V(12, 0, 6), h: 1.6, sp: -0.05, s: 1.1, ph: 5.2 },
  ];
  for (const d of gullDefs) {
    const g = createGull(gullMats);
    g.scale.setScalar(d.s * 1.8);
    g.userData.def = d;
    scene.add(g);
    gulls.push(g);
  }
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  function updateGulls(t) {
    for (const g of gulls) {
      const d = g.userData.def;
      const a = d.ph + t * d.sp;
      const pos = (ang, out) =>
        out.set(d.c.x + Math.cos(ang) * d.r.x, d.c.y + Math.sin(ang * 2.0 + d.ph) * d.h, d.c.z + Math.sin(ang) * d.r.z);
      pos(a, tmp);
      pos(a + Math.sign(d.sp) * 0.02, tmp2);
      g.position.copy(tmp);
      g.lookAt(tmp2);
      g.rotateY(Math.PI); // model faces -Z
      // bank into the turn
      g.rotateZ(-Math.sign(d.sp) * 0.35);
      // flap in bursts, glide in between
      const cycle = (t * 0.25 + d.ph) % 1;
      const flapping = cycle < 0.4 ? Math.sin((cycle / 0.4) * Math.PI) : 0;
      const f = Math.sin(t * 9.0 + d.ph * 3) * 0.75 * flapping;
      const glide = 0.12 + Math.sin(t * 0.8 + d.ph) * 0.05;
      const { L, R } = g.userData.wings;
      L.inner.rotation.z = -(glide + f);
      R.inner.rotation.z = glide + f;
      L.outer.rotation.z = (glide * 0.5 + f * 0.6) - 0.15;
      R.outer.rotation.z = -(glide * 0.5 + f * 0.6) + 0.15;
    }
  }

  bakeClouds(renderer, scene);

  return {
    id: 'seaside',
    scene,
    wires: [],
    post: {
      outline: 0.7,
      lineColor: new THREE.Color(0.24, 0.3, 0.45),
      lineFar: 60,
      creaseThreshold: 0.3,
      bloom: 0.28,
      bloomThreshold: 1.0,
      exposure: 1.0,
      saturation: 1.08,
      contrast: 1.03,
      lift: new THREE.Color(0.0, 0.015, 0.035),
      gain: new THREE.Color(0.99, 1.0, 1.02),
      vignette: 0.18,
      vignetteColor: new THREE.Color(0.1, 0.2, 0.35),
      paper: 0.025,
    },
    frame(aspect) {
      const t = clamp((aspect - 0.5) / (1.78 - 0.5), 0, 1);
      return {
        position: V(0, lerp(1.25, 1.2, t), lerp(5.8, 3.6, t)),
        yaw: 0,
        pitch: deg(lerp(2.5, -1.0, t)),
        fov: lerp(64, 42, t),
      };
    },
    orbit: { target: V(0, 0.6, 0), min: 2, max: 12, minPolar: Math.PI * 0.36, maxPolar: Math.PI * 0.5, minAzimuth: -1.3, maxAzimuth: 1.3 },
    update(t) {
      updateGulls(t);
      canopy.children.forEach((m, i) => {
        const ph = m.userData.phase;
        m.position.x = m.userData.base.x + Math.sin(t * 0.7 + ph) * 0.12 + Math.sin(t * 1.9 + ph * 2) * 0.03;
        m.position.z = m.userData.base.z + Math.cos(t * 0.5 + ph) * 0.08;
        m.rotation.y = Math.sin(t * 0.4 + i) * 0.03;
      });
    },
  };
}

import * as THREE from 'three';
import { toon } from '../lib/materials.js';
import { createSkyDome } from '../lib/sky.js';
import { SKY_MAP } from './tunnel-skymap.js';
import { WireSet } from '../lib/wires.js';
import { profileStrip, rod, box, grassCard, fillInstances, mergeGeometries } from '../lib/geom.js';
import { mulberry32, fbm2, smoothstep, lerp, clamp } from '../lib/noise.js';
import * as TX from '../lib/textures.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------
// The scene is laid out against the reference painting (1071 × 1469 px).
// Its projection was measured from the rails, the mast and the cantilever:
// focal length 900 px, principal point (556, 1120) — a shifted lens with
// vertical verticals — and an eye only 0.2 m above the rail head.
// Every landmark below is placed by un-projecting its pixel position.
// ---------------------------------------------------------------------------
const REF = { w: 1071, h: 1469 };
const LENS = { F: 900, px: 556, py: 1120 };
const EYE = 0.67;
/** World point seen at reference pixel (x, y) at distance D in front of the eye. */
const P = (x, y, D) => V(((x - LENS.px) * D) / LENS.F, EYE + ((LENS.py - y) * D) / LENS.F, -D);
/** Same, but solve the distance from a known world height. */
const atHeight = (x, y, Y) => P(x, y, ((Y - EYE) * LENS.F) / (LENS.py - y));
/** Same, but solve the distance from a known lateral offset. */
const atX = (x, y, X) => P(x, y, (X * LENS.F) / (x - LENS.px));

const RAIL_HALF = 0.5635; // rail centre offset from track centre
const TRACK_X = -0.4; // eye is 0.16 m left of the right rail
const SLEEPER_TOP = 0.3;
const RAIL_BASE = SLEEPER_TOP + 0.017;
const RAIL_TOP = RAIL_BASE + 0.152;
const PORTAL_D = 98;
const FENCE_X = 2.55;
const SUN_DIR = V(0.8, 0.2, 0.55).normalize(); // low evening sun, behind-right

// Ridge silhouettes traced from the painting: [x, y] in reference pixels.
const RIDGE = [
  [-1600, 1000], [-900, 930], [-500, 880], [-200, 840], [0, 810], [60, 795], [118, 787], [160, 791], [214, 804], [267, 818],
  [321, 834], [374, 846], [428, 853], [481, 861], [520, 871], [580, 880], [640, 886], [695, 891], [749, 900], [802, 911],
  [856, 919], [900, 925], [941, 930], [990, 938], [1070, 951], [1300, 972], [1600, 988], [2000, 1000], [2800, 1012],
];
const FAR_RIDGE = [
  [250, 930], [380, 882], [450, 867], [500, 858], [540, 854], [590, 855], [640, 860], [690, 872], [740, 889], [800, 903], [900, 918], [1000, 930],
];

function interp(arr, x) {
  if (x <= arr[0][0]) return arr[0][1];
  for (let i = 1; i < arr.length; i++) {
    if (x <= arr[i][0]) {
      const [x0, y0] = arr[i - 1];
      const [x1, y1] = arr[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return arr[arr.length - 1][1];
}

/** Ground height next to the railway (the track bed itself is modelled apart). */
function groundHeight(X, d) {
  const xr = X - TRACK_X;
  let h;
  if (xr > 0) {
    h = lerp(0.12, 0.17, smoothstep(1.9, 2.4, xr));
    h = lerp(h, -0.45, smoothstep(FENCE_X - TRACK_X + 0.4, FENCE_X - TRACK_X + 3.5, xr));
  } else {
    h = 0.2; // siding bed
    h = lerp(h, 0.42, smoothstep(-3.1, -4.2, xr)); // the cluttered yard
    h = lerp(h, 1.22, smoothstep(-8.6, -10.4, xr)); // the village plateau
    h += smoothstep(-16, -40, xr) * 1.5;
  }
  // banks of the cutting rising towards the portal
  const cut = smoothstep(42, 97, d);
  const side = smoothstep(2.8, 10, Math.abs(xr));
  h += cut * side * (7 + 3 * fbm2(X * 0.05, d * 0.05, 3, 4));
  h += (fbm2(X * 0.09, d * 0.09, 4, 2) - 0.5) * 0.7 * smoothstep(4, 14, Math.abs(xr));
  return h;
}

export function createTunnelScene({ quality }) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x2f527f, 0.00045);
  const rnd = mulberry32(7);

  // ------------------------------------------------------------------ light
  const sun = new THREE.DirectionalLight(0xffcb9c, 2.3 * Math.PI);
  const target = V(0, 0, -16);
  sun.target.position.copy(target);
  sun.position.copy(SUN_DIR).multiplyScalar(70).add(target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
  const sc = sun.shadow.camera;
  sc.left = -26;
  sc.right = 26;
  sc.top = 26;
  sc.bottom = -26;
  sc.near = 1;
  sc.far = 160;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.015;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0x4f78d0, 0x232a3c, 1.55 * Math.PI));

  // -------------------------------------------------------------------- sky
  // The cloud layout follows a coarse colour map of the painting (see
  // tunnel-skymap.js); all small-scale cloud detail is procedural.
  scene.add(
    createSkyDome({
      zenith: 0x0c3270,
      mid: 0x1150a2,
      horizon: 0x6ab6e8,
      ground: 0x3b6aa0,
      stops: [
        [14, 0x3f78ba],
        [20, 0x5ea8e2],
        [26, 0x5ba6e2],
        [33, 0x3480cc],
        [42, 0x1252a6],
        [52, 0x0c3a82],
      ],
      side: new THREE.Vector4(0.45, -0.9, 0.3, 0.6),
      sunDir: SUN_DIR,
      sunGlow: 0,
      paint: 0.12,
      blotch: 0.32,
      lens: LENS,
      lineWeight: 0.2,
      map: SKY_MAP,
    })
  );

  // ------------------------------------------------------------- textures
  const T = {
    ballast: TX.ballastTexture(4),
    wood: TX.woodTexture(5),
    concrete: TX.concreteTexture(6),
    dirty: TX.concreteTexture(16, { stains: 1.0 }),
    rust: TX.rustTexture(7),
    grass: TX.grassTexture(9),
    dry: TX.grassTexture(10, 'dry'),
    chain: TX.chainLinkTexture(),
    wall: TX.wallTexture(11),
    ground: TX.groundTexture(12),
    window: TX.windowTexture(),
    plate: TX.plateTexture('3'),
    leaf: TX.leafTexture(),
    forest: TX.forestTexture(41, { lightDir: [0.7, -0.5] }),
  };

  // ------------------------------------------------------------ materials
  const M = {
    ballast: toon({ map: T.ballast, color: 0xb09c88, dapple: { xMin: 0.4, xMax: 30, scale: 1.4, amount: 0.55 } }),
    sleeper: toon({ map: T.wood, color: 0xd2ae8c, dapple: { xMin: 0.4, xMax: 30, scale: 1.4, amount: 0.55 } }),
    pcSleeper: toon({ map: T.concrete, color: 0x8c9ab8 }),
    rail: toon({ map: T.rust, color: 0xf0b494 }),
    sidingRail: toon({ map: T.rust, color: 0x8a6a5c, sunScale: 0.4 }),
    railTop: toon({ color: 0x4a6498, emissive: 0x060e1e, sunScale: 0.25 }),
    plate: toon({ color: 0x3c3230 }),
    concrete: toon({ map: T.concrete, color: 0xc8c6c0 }),
    portal: toon({ map: T.dirty, color: 0x56606e, sunScale: 0.0 }),
    steel: toon({ map: T.concrete, color: 0xb6c2d4, sunScale: 0.3 }),
    darkSteel: toon({ color: 0x5c606c }),
    pole: toon({ map: T.concrete, color: 0xd8b49a }),
    mast: toon({ map: T.concrete, color: 0xd6cfc8, shadeBelow: 3.2 }),
    farPole: toon({ map: T.concrete, color: 0xf0ece6 }),
    insulator: toon({ color: 0x8a5a43 }),
    insulatorW: toon({ color: 0xece8de }),
    fence: toon({ map: T.chain, color: 0x4a5c80, alphaTest: 0.35, side: THREE.DoubleSide, lineWeight: 0.6, sunScale: 0.5 }),
    fenceFrame: toon({ color: 0x7486a8 }),
    wall: toon({ map: T.wall, color: 0xffe7c8 }),
    wallDark: toon({ map: T.concrete, color: 0xd0c8b8 }),
    clutter: toon({ map: T.dirty, color: 0x9aa4b0 }),
    retaining: toon({ map: T.dirty, color: 0x7c8892 }),
    roof: toon({ color: 0x3c4458 }),
    ground: toon({ map: T.ground, vertexColors: true, color: 0xffffff, dapple: { xMin: 0.4, xMax: 30, scale: 1.4, amount: 0.55 } }),
    hill: toon({ map: T.forest, vertexColors: true, color: 0x88a8b0, foliage: 0.6, foliageScale: 0.08, sunScale: 0.3, ramp: [0.4, 0.6], lineWeight: 0.15 }),
    farRidge: toon({ color: 0x2c5a86, sunScale: 0.0, lineWeight: 0.3 }),
    grass: toon({ map: T.grass, color: 0x9ab078, sunScale: 0.6, alphaTest: 0.5, side: THREE.DoubleSide, wind: 0.05, ramp: [0.3, 0.6], litFloor: 0.9, lineWeight: 0 }),
    dryGrass: toon({ map: T.dry, color: 0xc8b890, sunScale: 0.6, alphaTest: 0.5, side: THREE.DoubleSide, wind: 0.04, ramp: [0.3, 0.6], litFloor: 0.9, lineWeight: 0 }),
    foliage: toon({ vertexColors: true, foliage: 1.0, foliageScale: 2.4, ramp: [0.44, 0.6], litFloor: 0.8, sunScale: 0.25, lineWeight: 0.35 }),
    foliageLit: toon({ vertexColors: true, foliage: 1.0, foliageScale: 2.2, ramp: [0.44, 0.58], litFloor: 0.8, sunScale: 0.9, lineWeight: 0.35 }),
    leaf: toon({ map: T.leaf, alphaTest: 0.5, side: THREE.DoubleSide, ramp: [0.3, 0.55], litFloor: 0.85, lineWeight: 0.55, dapple: { xMin: 0.4, xMax: 30, scale: 1.4, amount: 0.55 } }),
    trunk: toon({ color: 0x3a3330 }),
    window: new THREE.MeshBasicMaterial({ map: T.window, color: 0x9aa6c0 }),
    tunnelInside: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    black: new THREE.MeshBasicMaterial({ color: 0x040405 }),
  };
  M.fence.alphaToCoverage = true;

  const add = (geo, mat, { cast = true, receive = true } = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    scene.add(m);
    return m;
  };

  // ------------------------------------------------------------ the hill
  // Built in the camera's own polar grid so its crest reproduces the traced
  // silhouette exactly from the painting's viewpoint.
  function hillMesh(ridge, Dr, Dfoot, yFoot, { cols = 260, rows = 46, x0 = -1600, x1 = 2800, back = 1.45, noise = 1 } = {}) {
    const pos = [];
    const col = [];
    const uv = [];
    for (let j = 0; j <= rows; j++) {
      const t = (j / rows) * back;
      for (let i = 0; i <= cols; i++) {
        const x = lerp(x0, x1, i / cols);
        const Hs = EYE + ((LENS.py - interp(ridge, x)) * Dr) / LENS.F;
        const yf = typeof yFoot === 'function' ? yFoot(x) : yFoot;
        let D;
        let Y;
        if (t <= 1) {
          D = lerp(Dfoot, Dr, t);
          Y = yf + (Hs - yf) * Math.pow(t, 1.35);
        } else {
          D = Dr + (t - 1) * Dr * 0.9;
          Y = Hs - (Hs - yf) * 0.55 * smoothstep(1, back, t);
        }
        const X = ((x - LENS.px) * D) / LENS.F;
        // gentle relief, fading out at the crest so the silhouette holds
        Y += (fbm2(X * 0.02, D * 0.02, 4, 9) - 0.5) * 14 * noise * Math.sin(Math.min(t, 1) * Math.PI);
        pos.push(X, Y, -D);
        uv.push(X / 14, -D / 14);
        const lit = 1.45 - 0.95 * smoothstep(100, 700, x); // left slopes catch more light
        const k = lit * (0.6 + 0.8 * fbm2(X * 0.012, D * 0.012, 4, 2));
        col.push(k, k, k);
      }
    }
    const idx = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i;
        idx.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  add(hillMesh(RIDGE, 380, PORTAL_D + 1.4, (x) => (Math.abs(x - 560) < 90 ? 8.6 : 5.5 - 3 * smoothstep(650, 1100, x)), { noise: 1 }), M.hill, { cast: false });
  add(hillMesh(FAR_RIDGE, 1300, 900, 120, { cols: 80, rows: 8, x0: 200, x1: 1060, back: 1.2, noise: 0.2 }), M.farRidge, { cast: false, receive: false });

  // ------------------------------------------------------------- ground
  {
    const NX = 200;
    const ND = 150;
    const pos = [];
    const col = [];
    const uv = [];
    const c = new THREE.Color();
    const cShoulder = new THREE.Color(0x5d5560);
    const cGrass = new THREE.Color(0x3e5a34);
    const cDark = new THREE.Color(0x1f3326);
    const cBank = new THREE.Color(0x24382e);
    const cUpper = new THREE.Color(0x6a6450);
    for (let j = 0; j <= ND; j++) {
      const d = -8 + Math.pow(j / ND, 1.6) * 110;
      for (let i = 0; i <= NX; i++) {
        const u = (i / NX) * 2 - 1;
        const X = TRACK_X + Math.sign(u) * Math.pow(Math.abs(u), 1.8) * 120;
        const h = groundHeight(X, d);
        pos.push(X, h, -d);
        uv.push(X / 3, -d / 3);
        const xr = X - TRACK_X;
        if (xr > 0) c.copy(cShoulder).lerp(cGrass, smoothstep(FENCE_X - TRACK_X, FENCE_X - TRACK_X + 2, xr)).lerp(cDark, smoothstep(6, 14, xr));
        else c.copy(cShoulder).lerp(cUpper, smoothstep(-3.2, -3.4, xr)).lerp(cDark, smoothstep(-9, -18, xr));
        c.lerp(cBank, smoothstep(45, 85, d) * smoothstep(3, 8, Math.abs(xr)));
        c.multiplyScalar(0.85 + 0.3 * fbm2(X * 0.3, d * 0.3, 3, 5));
        col.push(c.r, c.g, c.b);
      }
    }
    const idx = [];
    for (let j = 0; j < ND; j++) {
      for (let i = 0; i < NX; i++) {
        const a = j * (NX + 1) + i;
        idx.push(a, a + 1, a + NX + 1, a + 1, a + NX + 2, a + NX + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    add(g, M.ground, { cast: true });
  }

  // --------------------------------------------------------------- track
  const RAIL_PROFILE = [
    [-0.064, 0], [0.064, 0], [0.064, 0.012], [0.012, 0.028], [0.008, 0.036], [0.008, 0.1], [0.031, 0.112], [0.032, 0.143],
    [0.025, 0.152], [-0.025, 0.152], [-0.032, 0.143], [-0.031, 0.112], [-0.008, 0.1], [-0.008, 0.036], [-0.012, 0.028], [-0.064, 0.012],
  ];
  /** A rail from point a to point b (both on the rail base). */
  function railBetween(a, b, mat = M.rail) {
    const len = a.distanceTo(b);
    const g = profileStrip(RAIL_PROFILE.slice().reverse(), 0, -len, { closed: true, uvScale: 0.6 });
    const top = new THREE.BoxGeometry(0.046, 0.004, len);
    top.translate(0, 0.152, -len / 2);
    const grp = new THREE.Group();
    const m1 = new THREE.Mesh(g, mat);
    const m2 = new THREE.Mesh(top, M.railTop);
    m1.castShadow = true;
    m1.receiveShadow = false; // keep the sunlit flank of the rail whole
    m2.receiveShadow = false;
    grp.add(m1, m2);
    grp.position.copy(a);
    grp.rotation.y = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    scene.add(grp);
  }

  {
    const z0 = 2;
    const z1 = -170;
    // ballast bed with a lumpy top
    const bal = profileStrip(
      [
        [TRACK_X - 2.0, -0.2],
        [TRACK_X - 1.35, 0.255],
        [TRACK_X + 1.35, 0.255],
        [TRACK_X + 2.0, 0.08],
      ],
      z0,
      z1,
      { segments: 260, uvScale: 1.3, yNoise: (x, z, p) => (p[1] > 0.2 ? (fbm2(x * 3, z * 1.2, 2, 3) - 0.5) * 0.05 : 0) }
    );
    add(bal, M.ballast, { cast: false });

    for (const sx of [-1, 1]) railBetween(V(TRACK_X + sx * RAIL_HALF, RAIL_BASE, z0), V(TRACK_X + sx * RAIL_HALF, RAIL_BASE, z1));
    // fishplate on the left rail (visible near the left edge)
    add(box(0.012, 0.05, 0.5, TRACK_X - RAIL_HALF + 0.022, RAIL_BASE + 0.07, -2.3), M.rail);
    add(box(0.012, 0.05, 0.5, TRACK_X - RAIL_HALF - 0.022, RAIL_BASE + 0.07, -2.3), M.rail);

    // sleepers: old timber, a little irregular; one concrete sleeper in front
    const items = [];
    const plates = [];
    const g = new THREE.BoxGeometry(2.1, 0.15, 0.21);
    for (let z = -1.62; z > -97; z -= 0.6 + (rnd() - 0.5) * 0.06) {
      const k = 0.62 + rnd() * 0.5;
      const c = new THREE.Color().setRGB(k, k * (0.9 + rnd() * 0.08), k * (0.82 + rnd() * 0.1));
      const broken = rnd() < 0.18;
      items.push({
        p: V(TRACK_X + (rnd() - 0.5) * 0.12 - (broken ? 0.25 : 0), SLEEPER_TOP - 0.075 - rnd() * 0.02, z),
        s: V(broken ? 0.7 + rnd() * 0.25 : 1, 1, 0.9 + rnd() * 0.2),
        ry: (rnd() - 0.5) * 0.05,
        rz: (rnd() - 0.5) * 0.02,
        c,
      });
      for (const sx of [-1, 1]) plates.push({ p: V(TRACK_X + sx * RAIL_HALF, SLEEPER_TOP + 0.008, z), s: 1 });
    }
    const sl = fillInstances(new THREE.InstancedMesh(g, M.sleeper, items.length), items);
    sl.castShadow = true;
    sl.receiveShadow = true;
    scene.add(sl);
    const pm = fillInstances(new THREE.InstancedMesh(new THREE.BoxGeometry(0.17, 0.018, 0.17), M.plate, plates.length), plates);
    pm.receiveShadow = true;
    scene.add(pm);
    // the pale concrete sleeper right in front of the lens
    const pc = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.16, 0.24), M.pcSleeper);
    pc.position.set(TRACK_X - 0.15, SLEEPER_TOP - 0.065, -1.08);
    pc.rotation.y = 0.04;
    pc.receiveShadow = true;
    pc.castShadow = true;
    scene.add(pc);
  }

  // the converging rail on the left (a diverging road of the yard)
  {
    const a = atHeight(0, 1180, RAIL_TOP); // where it leaves the frame
    const b = atHeight(420, 1152, RAIL_TOP);
    const dir = b.clone().sub(a).setY(0).normalize();
    const start = a.clone().addScaledVector(dir, -5).setY(RAIL_BASE);
    const end = b.clone().addScaledVector(dir, 0.6).setY(RAIL_BASE);
    railBetween(start, end, M.sidingRail);
    const perp = V(-dir.z, 0, dir.x).multiplyScalar(-2 * RAIL_HALF);
    // ballast & timbers under it
    const items = [];
    for (let t = 0; t < 1; t += 0.085) {
      const p = start.clone().lerp(end, t).add(perp.clone().multiplyScalar(0.5));
      items.push({ p: V(p.x, SLEEPER_TOP - 0.08, p.z), ry: Math.atan2(dir.x, dir.z) + Math.PI / 2 + (rnd() - 0.5) * 0.08, s: V(1, 1, 1), c: new THREE.Color(0.7, 0.62, 0.55) });
    }
    const sl = fillInstances(new THREE.InstancedMesh(new THREE.BoxGeometry(0.21, 0.15, 2.1), M.sleeper, items.length), items);
    sl.receiveShadow = true;
    scene.add(sl);
  }

  // ---------------------------------------------------------- yard clutter
  {
    const clutter = [];
    const pipes = [];
    for (let i = 0; i < 34; i++) {
      const z = lerp(-2, -40, rnd());
      const x = TRACK_X - lerp(3.6, 8, rnd());
      const w = 0.2 + rnd() * 0.6;
      const h = 0.1 + rnd() * 0.35;
      clutter.push(box(w, h, 0.3 + rnd() * 0.8, x, groundHeight(x, -z) + h / 2, z, rnd() * 0.6));
    }
    for (let i = 0; i < 8; i++) {
      const z = lerp(-3, -16, rnd());
      const x = TRACK_X - lerp(3.8, 6, rnd());
      const y = groundHeight(x, -z);
      pipes.push(rod(V(x, y + 0.35 + rnd() * 0.2, z), V(x - 0.4, y + 0.35 + rnd() * 0.2, z - 1.4 - rnd()), 0.035, 8));
      pipes.push(rod(V(x, y, z), V(x, y + 0.45, z), 0.022, 6));
    }
    // low bank up to the village
    const bank = profileStrip(
      [
        [TRACK_X - 10.6, 1.22],
        [TRACK_X - 8.4, 1.22],
        [TRACK_X - 8.4, 0.3],
      ],
      6,
      -40,
      { segments: 8, uvScale: 1.2 }
    );
    add(bank, M.retaining);
    add(mergeGeometries(clutter), M.clutter);
    add(mergeGeometries(pipes), M.pcSleeper);
  }

  // ---------------------------------------------------------------- house
  {
    const hx = -14.1; // wall facing the line
    const base = 1.2;
    const eave = 6.5;
    const zN = -15;
    const zF = -28.6;
    const depth = 7;
    add(box(depth, eave - base + 0.4, zN - zF, hx - depth / 2, (eave + base - 0.4) / 2, (zN + zF) / 2), M.wall);
    // gable roof, ridge along the line
    const roof = new THREE.Shape();
    roof.moveTo(0.6, 0);
    roof.lineTo(-depth / 2, 1.9);
    roof.lineTo(-depth - 0.6, 0);
    roof.lineTo(0.6, 0);
    const rg = new THREE.ExtrudeGeometry(roof, { depth: zN - zF + 1.0, bevelEnabled: false });
    rg.translate(0, 0, -(zN - zF + 1.0) / 2);
    rg.translate(hx, eave - 0.05, (zN + zF) / 2);
    add(rg, M.roof);
    add(box(0.15, 0.12, zN - zF, hx + 0.08, 4.0, (zN + zF) / 2), M.wallDark); // floor band
    // windows, vent and door measured from the painting
    const win = [];
    const fit = (x0, x1, y0, y1) => {
      const a = atX(x0, (y0 + y1) / 2, hx);
      const b = atX(x1, (y0 + y1) / 2, hx);
      const D = (-a.z - b.z) / 2;
      const ya = EYE + ((LENS.py - y1) * D) / LENS.F;
      const yb = EYE + ((LENS.py - y0) * D) / LENS.F;
      return { z0: a.z, z1: b.z, y0: ya, y1: yb };
    };
    for (const r of [fit(30, 64, 922, 957), fit(-60, -10, 918, 958)]) {
      const g = new THREE.PlaneGeometry(Math.abs(r.z1 - r.z0), r.y1 - r.y0);
      g.rotateY(Math.PI / 2);
      g.translate(hx + 0.02, (r.y0 + r.y1) / 2, (r.z0 + r.z1) / 2);
      win.push(g);
      add(box(0.12, 0.07, Math.abs(r.z1 - r.z0) + 0.15, hx + 0.06, r.y0 - 0.04, (r.z0 + r.z1) / 2), M.wallDark);
    }
    add(mergeGeometries(win), M.window, { cast: false });
    const ventP = atX(82, 950, hx);
    const vent = new THREE.CylinderGeometry(0.26, 0.26, 0.08, 20);
    vent.rotateZ(Math.PI / 2);
    vent.translate(hx + 0.05, ventP.y, ventP.z);
    add(vent, M.wallDark);
    const door = fit(74, 91, 1035, 1100);
    add(box(0.06, door.y1 - door.y0, Math.abs(door.z1 - door.z0), hx + 0.03, (door.y0 + door.y1) / 2, (door.z0 + door.z1) / 2), M.roof);
    // pale shed and low wall behind the house
    add(box(1.6, 2.1, 5.5, hx - 0.8, 2.35, -31.5), M.wallDark);
    add(box(0.25, 1.4, 6, hx + 0.3, 1.9, -36.5), M.wall);
    // little railing lit by the sun
    const rail = [];
    const ra = P(238, 1088, 42);
    const rb = P(292, 1080, 42);
    for (const p of [ra, rb]) rail.push(rod(V(p.x, 2.0, p.z), V(p.x, 3.0, p.z), 0.04, 6));
    rail.push(rod(V(ra.x, 2.9, ra.z), V(rb.x, 2.9, rb.z), 0.035, 6));
    add(mergeGeometries(rail), M.pole);
  }

  // ------------------------------------------------------------ catenary
  const wires = new WireSet({ color: 0x141a26, minPx: 0.6 });
  const fineWires = new WireSet({ color: 0x1c2230, minPx: 0.45 });
  const steel = [];
  const dark = [];
  const ins = [];
  const insW = [];
  const farSteel = [];
  const mastParts = [];

  function insulatorStack(a, b, discs, r, list = ins) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir.clone().normalize());
    for (let i = 0; i < discs; i++) {
      const p = a.clone().addScaledVector(dir, (i + 0.5) / discs);
      const g = new THREE.CylinderGeometry(r, r, (dir.length() / discs) * 0.55, 12);
      g.applyQuaternion(q);
      g.translate(p.x, p.y, p.z);
      list.push(g);
    }
    dark.push(rod(a, b, r * 0.18, 6));
  }

  // the big mast "3", 5.4 m ahead, 2.1 m right of the eye
  const MD = 5.36;
  const mast = P(915, 600, MD);
  const MX = mast.x;
  const MZ = mast.z;
  const R0 = 0.165;
  const at = (x, y) => P(x, y, MD);
  {
    mastParts.push(rod(V(MX, 0, MZ), V(MX, 11.6, MZ), R0, 28, R0 * 0.93));
    // collars, clamps and step bolts
    for (const y of [65, 110, 165, 210, 245, 310, 345, 410, 465, 520, 545, 600, 640, 690, 760, 840, 870, 905, 960, 1022, 1080]) {
      const Y = at(915, y).y;
      const g = new THREE.CylinderGeometry(R0 * 1.09, R0 * 1.09, 0.035, 28);
      g.translate(MX, Y, MZ);
      mastParts.push(g);
    }
    for (let y = 300; y < 1150; y += 58) {
      const Y = at(915, y).y;
      const dirB = V(0.92, 0, 0.38).normalize();
      dark.push(rod(V(MX, Y, MZ).addScaledVector(dirB, R0 * 0.8), V(MX, Y, MZ).addScaledVector(dirB, R0 + 0.12), 0.012, 6));
      dark.push(rod(V(MX, Y, MZ).addScaledVector(dirB, R0 + 0.12), V(MX, Y + 0.05, MZ).addScaledVector(dirB, R0 + 0.14), 0.012, 6));
    }
    for (const y of [756, 906, 990]) {
      const Y = at(915, y).y;
      const g = new THREE.CylinderGeometry(R0 * 1.14, R0 * 1.14, 0.09, 28);
      g.translate(MX, Y, MZ);
      mastParts.push(g);
      dark.push(box(0.05, 0.08, 0.05, MX + R0 + 0.03, Y, MZ + 0.05));
    }
    dark.push(box(0.1, 0.2, 0.05, MX - 0.04, at(915, 1022).y, MZ + R0 + 0.02));

    // cantilever: horizontal pipe with a hooked end
    const yTop = at(0, 58).y;
    const xHook = at(318, 58).x;
    steel.push(rod(V(MX - R0, yTop, MZ), V(xHook + 0.2, yTop, MZ), 0.032, 10));
    const hook = new THREE.CatmullRomCurve3([V(xHook + 0.2, yTop, MZ), V(xHook + 0.05, yTop - 0.02, MZ), V(xHook, yTop - 0.15, MZ), V(xHook, yTop - 0.4, MZ), V(xHook, at(0, 200).y, MZ)]);
    steel.push(new THREE.TubeGeometry(hook, 16, 0.03, 8, false));
    // twin lower tube and the heavy diagonal stay
    const lowA = at(588, 66);
    const lowB = at(895, 78);
    steel.push(rod(lowA, V(lowB.x - R0 * 0.5, lowB.y, MZ), 0.026, 8));
    const stayA = at(598, 66);
    const stayB = V(MX + 0.05, at(942, 277).y, MZ);
    steel.push(rod(stayA, stayB, 0.04, 10));
    steel.push(rod(stayA.clone().add(V(0.02, -0.07, 0)), stayB.clone().add(V(0, -0.1, 0)), 0.03, 10));
    insulatorStack(V(MX - R0 - 0.02, yTop, MZ), V(MX - R0 - 0.6, yTop, MZ), 6, 0.06);
    insulatorStack(stayB.clone().add(V(-0.12, 0.08, 0)), stayB.clone().add(V(-0.55, 0.38, 0)), 4, 0.055);
    // suspension insulator holding the messenger wire
    const mA = at(515, 58);
    const mB = at(550, 127);
    insulatorStack(mA, mB, 3, 0.05, insW);
    // steady arm from the hook down to the contact wire
    const sA = at(322, 146);
    const sB = at(365, 165);
    insulatorStack(sA, sB, 4, 0.045, insW);
    fineWires.addPolyline([sB, at(457, 219), at(572, 238)], 0.012);
    // feeder crossarm at the top of the mast
    steel.push(rod(V(MX + 0.4, 10.75, MZ), V(MX - 1.65, 10.75, MZ), 0.04, 8));
    for (const dx of [-0.6, -1.05, -1.5]) insulatorStack(V(MX + dx, 10.75, MZ), V(MX + dx, 10.95, MZ), 2, 0.05, insW);
  }

  // number plate
  {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.27), toon({ map: T.plate, color: 0xd8d4cc }));
    const p = at(909, 800);
    const n = V(p.x - MX, 0, p.z - MZ).normalize();
    plate.position.set(MX, p.y, MZ).addScaledVector(n, R0 + 0.012);
    plate.lookAt(plate.position.clone().add(n));
    plate.receiveShadow = true;
    scene.add(plate);
  }

  // catenary structures close to the portal (all measured)
  function farPole(x, yTop, yBase, D, r = 0.13) {
    const t = P(x, yTop, D);
    const b = P(x, yBase, D);
    farSteel.push(rod(V(t.x, b.y - 0.5, t.z), t, r, 10, r * 0.85));
    return { t, b };
  }
  const c1 = farPole(650, 910, 1092, 48, 0.17);
  {
    const D = 48;
    for (const y of [974, 992]) farSteel.push(rod(P(650, y, D), P(548, y, D), 0.05, 8));
    farSteel.push(rod(P(548, 974, D), P(542, 990, D), 0.05, 8));
    farSteel.push(rod(P(542, 990, D), P(542, 1010, D), 0.04, 8));
    for (let x = 560; x < 645; x += 14) farSteel.push(rod(P(x, 974, D), P(x + 7, 992, D), 0.025, 4));
    farSteel.push(rod(P(632, 917, D), P(668, 917, D), 0.05, 6));
  }
  farPole(619, 994, 1105, 60, 0.15);
  farSteel.push(rod(P(619, 998, 60), P(598, 998, 60), 0.05, 6));
  farPole(607, 1035, 1110, 75, 0.14);
  {
    const D = 75;
    for (const y of [1032, 1047]) farSteel.push(rod(P(604, y, D), P(530, y, D), 0.05, 6));
    farSteel.push(rod(P(530, 1032, D), P(526, 1052, D), 0.045, 6));
  }
  // left line of concrete poles with crossarms
  const poleDefs = [
    { x: 328, yTop: 972, D: 48, arms: [[302, 338, 972]] },
    { x: 377, yTop: 928, D: 40, arms: [[350, 387, 930]] },
    { x: 421, yTop: 984, D: 55, arms: [[400, 425, 985], [407, 430, 1022]] },
    { x: 460, yTop: 1012, D: 70, arms: [] },
    { x: 486, yTop: 1043, D: 85, arms: [[478, 494, 1045]] },
    { x: 499, yTop: 1055, D: 92, arms: [] },
    { x: 510, yTop: 1062, D: 97, arms: [] },
  ];
  const woods = [];
  const leftTops = [];
  for (const p of poleDefs) {
    const top = P(p.x, p.yTop, p.D);
    const baseY = groundHeight(top.x, p.D) - 0.3;
    woods.push(rod(V(top.x, baseY, top.z), V(top.x + 0.02, top.y + 0.25, top.z), 0.15 * (p.D / 50) ** 0.2, 8, 0.11));
    for (const [xa, xb, ya] of p.arms) woods.push(rod(P(xa, ya, p.D), P(xb, ya, p.D), 0.055, 6));
    leftTops.push(top);
  }
  // gantry frame beside pole 4
  {
    const D = 70;
    woods.push(rod(P(438, 1010, D), P(516, 1010, D), 0.06, 6));
    woods.push(rod(P(438, 1027, D), P(516, 1027, D), 0.05, 6));
    woods.push(rod(P(438, 1010, D), P(446, 1027, D), 0.04, 6));
    woods.push(rod(P(516, 1010, D), P(508, 1027, D), 0.04, 6));
    const fp = P(516, 1010, D);
    woods.push(rod(V(fp.x, groundHeight(fp.x, D), fp.z), fp, 0.1, 8));
  }

  // ---------------------------------------------------------------- wires
  {
    const portalTop = -PORTAL_D + 0.3;
    // messenger and contact wire above the line
    const mPts = [V(-0.12, 6.75, 45), at(550, 127), V(c1.t.x - 5.4, 7.4, c1.t.z), V(-0.25, 7.0, -75), V(0.25, 5.7, portalTop)];
    wires.addSpan(mPts, { radius: 0.011, sag: (l) => 0.011 * l });
    const cPts = [V(-0.18, 5.95, 45), at(572, 238), V(-0.3, 5.92, c1.t.z), V(0.1, 5.9, -75), V(0.25, 5.25, portalTop)];
    wires.addSpan(cPts, { radius: 0.012, sag: 0 });
    for (let i = 0; i < mPts.length - 1; i++) {
      const L = Math.abs(mPts[i].z - mPts[i + 1].z);
      const n = Math.max(2, Math.round(L / 5));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const top = mPts[i].clone().lerp(mPts[i + 1], t);
        top.y -= 4 * 0.011 * L * t * (1 - t);
        const bot = cPts[i].clone().lerp(cPts[i + 1], t);
        fineWires.addPolyline([top, bot], 0.004);
      }
    }
    // feeders from the crossarm at the top of the big mast to the next mast
    [-0.6, -1.05, -1.5].forEach((dx, k) => {
      const a = V(MX + dx, 10.95, MZ);
      const b = V(c1.t.x - 0.4 + k * 0.4, c1.t.y + 0.1, c1.t.z);
      wires.addSpan([V(MX + dx - 0.1, 11.1, 40), a, b, V(2.5 + k * 0.4, 9.2, -PORTAL_D)], { radius: 0.013, sag: (l) => 0.015 * l });
    });
    // mid-height feeders with small ring fittings
    const rings = [];
    [
      [at(860, 245), 0],
      [at(870, 330), 1],
      [at(820, 360), 2],
    ].forEach(([a, k]) => {
      const b = P(640 + k * 6, 960 + k * 18, 48);
      wires.addSpan([V(a.x + 0.3, a.y + 0.6, 30), a, b], { radius: 0.011, sag: (l) => 0.012 * l });
      const ring = new THREE.TorusGeometry(0.05, 0.012, 6, 14);
      ring.translate(a.x, a.y, a.z);
      rings.push(ring);
    });
    for (const [x, y, D] of [
      [808, 362, 6.4],
      [833, 402, 6.4],
      [786, 552, 8.5],
    ]) {
      const ring = new THREE.TorusGeometry(0.05, 0.012, 6, 14);
      const p = P(x, y, D);
      ring.translate(p.x, p.y, p.z);
      rings.push(ring);
    }
    add(mergeGeometries(rings), M.insulatorW, { cast: false });
    // guy wires dropping from the mast out of the right edge
    for (const [ye, D, yTop] of [
      [480, 4.0, 92],
      [700, 4.3, 120],
    ]) {
      const top = V(MX + 0.15, at(0, yTop).y, MZ);
      const e = P(REF.w, ye, D);
      const dir = e.clone().sub(top);
      const ground = top.clone().addScaledVector(dir, (top.y - 0.2) / -dir.y);
      wires.addPolyline([top, ground], 0.012);
      insulatorStack(top.clone().lerp(e, 0.25), top.clone().lerp(e, 0.32), 2, 0.05, insW);
    }
    // lines of the left poles, running back past the eye
    for (let k = 0; k < 3; k++) {
      const pts = leftTops
        .slice(0, 4)
        .sort((a, b) => b.z - a.z)
        .map((t) => t.clone().add(V(-0.6 + k * 0.6, -0.1, 0)));
      wires.addSpan(pts, { radius: 0.012, sag: (l) => 0.02 * l });
    }
    const runBack = (far, ex, ey, De) => {
      const e = P(ex, ey, De);
      const dir = e.clone().sub(far);
      wires.addSpan([far, e, e.clone().addScaledVector(dir, 0.8)], { radius: 0.012, sag: 0.05 });
    };
    runBack(leftTops[1].clone().add(V(-0.3, 0, 0)), 0, 418, 8.7);
    runBack(leftTops[1].clone().add(V(0.3, 0, 0)), 0, 445, 8.9);
    runBack(leftTops[0].clone().add(V(0.4, 0, 0)), 0, 600, 12);
    // wires into the tunnel from the far masts
    wires.addSpan([c1.t.clone().add(V(-0.5, -1.5, 0)), V(2.2, 7.6, -PORTAL_D + 0.5)], { radius: 0.01, sag: 0.3 });
  }
  scene.add(wires.build());
  scene.add(fineWires.build());

  add(mergeGeometries(mastParts), M.mast);
  add(mergeGeometries(steel), M.steel);
  add(mergeGeometries(dark), M.darkSteel);
  add(mergeGeometries(ins), M.insulator);
  add(mergeGeometries(insW), M.insulatorW);
  add(mergeGeometries(farSteel), M.farPole);
  add(mergeGeometries(woods), M.pole);

  // ---------------------------------------------------------------- fence
  {
    const z0 = 4;
    const z1 = -38;
    const topY = 1.44;
    const parts = [];
    const bars = [];
    for (let z = z0; z >= z1; z -= 2.0) {
      parts.push(rod(V(FENCE_X, -0.2, z), V(FENCE_X, topY + 0.03, z), 0.024, 8));
      bars.push(rod(V(FENCE_X, 0.2, z), V(FENCE_X, topY - 0.05, z - 1.0), 0.008, 4));
    }
    for (let z = z0; z >= z1; z -= 0.25) bars.push(rod(V(FENCE_X, 0.18, z), V(FENCE_X, topY, z), 0.0055, 4));
    parts.push(rod(V(FENCE_X, topY, z0), V(FENCE_X, topY, z1), 0.02, 6));
    parts.push(rod(V(FENCE_X, 0.2, z0), V(FENCE_X, 0.2, z1), 0.015, 6));
    add(mergeGeometries(parts), M.fenceFrame);
    add(mergeGeometries(bars), M.fenceFrame);
    const mg = new THREE.PlaneGeometry(z0 - z1, topY - 0.2);
    const uv = mg.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * (z0 - z1)) / 0.12, (uv.getY(i) * (topY - 0.2)) / 0.12);
    mg.rotateY(Math.PI / 2);
    mg.translate(FENCE_X + 0.01, (topY + 0.2) / 2, (z0 + z1) / 2);
    add(mg, M.fence);
  }

  // ---------------------------------------------------------------- tunnel
  {
    const Z = -PORTAL_D;
    const cx = 0.3;
    const Wd = 2.3;
    const spring = 3.6;
    const shape = new THREE.Shape();
    shape.moveTo(cx - 5.2, -1);
    shape.lineTo(cx + 5.0, -1);
    shape.lineTo(cx + 5.0, 8.9);
    shape.lineTo(cx - 5.2, 8.9);
    shape.lineTo(cx - 5.2, -1);
    const hole = new THREE.Path();
    hole.moveTo(cx - Wd, -0.5);
    hole.lineTo(cx - Wd, spring);
    hole.absarc(cx, spring, Wd, Math.PI, 0, true);
    hole.lineTo(cx + Wd, -0.5);
    hole.lineTo(cx - Wd, -0.5);
    shape.holes.push(hole);
    const face = new THREE.ExtrudeGeometry(shape, { depth: 1.4, bevelEnabled: false, curveSegments: 20 });
    face.translate(0, 0, Z - 1.4);
    add(face, M.portal, { cast: false });
    add(box(10.8, 0.5, 1.8, cx - 0.1, 9.05, Z - 0.6), M.portal, { cast: false });
    // inside: fades to black
    const lin = new THREE.Shape();
    lin.moveTo(cx - Wd, -0.5);
    lin.lineTo(cx - Wd, spring);
    lin.absarc(cx, spring, Wd, Math.PI, 0, true);
    lin.lineTo(cx + Wd, -0.5);
    const pts = lin.getPoints(24).map((p) => [p.x, p.y]);
    const g = profileStrip(pts, Z - 0.2, Z - 60, { segments: 30 });
    const pos = g.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const k = 0.03 * Math.exp(-(Z - pos.getZ(i)) / 4) + 0.003;
      cols.set([k, k, k * 1.2], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    scene.add(new THREE.Mesh(g, M.tunnelInside));
    const cap = new THREE.PlaneGeometry(8, 10);
    cap.translate(cx, 4, Z - 58);
    scene.add(new THREE.Mesh(cap, M.black));
  }

  // --------------------------------------------------------------- trees
  // Distant woodland is painted on crossed cards (fine foliage like the
  // painting); they are placed region by region, always behind the poles and
  // masts that stand in front of them.
  {
    const cardGeo = (() => {
      const a = new THREE.PlaneGeometry(1, 1);
      a.translate(0, 0.5, 0);
      const b = a.clone().rotateY(Math.PI / 2);
      const g = mergeGeometries([a, b]);
      const n = g.attributes.normal;
      const v = V(0, 0.45, 1).normalize();
      for (let i = 0; i < n.count; i++) n.setXYZ(i, v.x, v.y, v.z);
      return g;
    })();
    const texs = [TX.treeCardTexture(51), TX.treeCardTexture(52, { tall: 1.3 }), TX.treeCardTexture(53, { tall: 0.8 })];
    const mats = texs.map((t) => toon({ map: t, color: 0xe0f0e0, alphaTest: 0.5, side: THREE.DoubleSide, sunScale: 0.4, ramp: [0.2, 0.5], litFloor: 0.9, lineWeight: 0.3 }));
    const litMat = toon({ map: texs[0], alphaTest: 0.5, side: THREE.DoubleSide, sunScale: 0.9, ramp: [0.2, 0.5], litFloor: 0.9, lineWeight: 0.3 });
    const lists = [[], [], []];
    const litList = [];
    /** A tree in column x at distance D whose crown top reaches pixel row yTop. */
    const card = (x, yTop, D, wf, list = lists[(rnd() * 3) | 0], tint = 1) => {
      const t = P(x, yTop, D);
      const g = groundHeight(t.x, D) - 0.2;
      const h = (t.y - g) / 0.84;
      if (h < 0.8) return;
      const w = h * wf;
      const k = (0.75 + rnd() * 0.5) * tint;
      list.push({ p: V(t.x, g, t.z), s: V(w, h, w), ry: Math.atan2(-t.x, -t.z) + (rnd() - 0.5) * 0.2, c: new THREE.Color(k * 0.95, k, k * 0.95) });
    };
    const band = (n, x0, x1, D0, D1, top0, top1, w0, w1, jitter = 22) => {
      for (let i = 0; i < n; i++) {
        const x = lerp(x0, x1, rnd());
        const f = (x - x0) / (x1 - x0);
        card(x, lerp(top0, top1, f) + (rnd() - 0.5) * jitter, lerp(D0, D1, rnd()), lerp(w0, w1, rnd()));
      }
    };
    band(150, 262, 508, 62, 100, 935, 1000, 0.5, 0.8); // behind the poles left of the portal
    band(80, 95, 270, 50, 66, 900, 945, 0.45, 0.7); // behind the houses
    band(80, -700, 95, 28, 70, 860, 920, 0.6, 0.9); // the village beyond the frame
    band(60, 606, 760, 80, 100, 1000, 1035, 0.6, 0.9, 18); // right of the portal, behind the masts
    band(100, 760, 1100, 18, 60, 995, 1050, 0.6, 0.95, 25); // beyond the fence
    band(70, 1100, 1700, 10, 45, 975, 1030, 0.6, 0.95, 30); // right, beyond the frame
    // the small sunlit tree at the left edge, in front of the house
    card(10, 915, 15.5, 0.75, litList, 1.6);
    card(-25, 905, 15, 0.7, litList, 1.5);
    lists.forEach((list, i) => {
      const m = fillInstances(new THREE.InstancedMesh(cardGeo, mats[i], list.length), list);
      m.receiveShadow = true;
      scene.add(m);
    });
    const lm = fillInstances(new THREE.InstancedMesh(cardGeo, litMat, litList.length), litList);
    lm.receiveShadow = true;
    scene.add(lm);
  }

  // ------------------------------------------------- grass, leaves, debris
  {
    const green = [];
    const dry = [];
    const tuft = (X, Y, Z, s, isDry) => {
      const k = 0.75 + rnd() * 0.45;
      (isDry ? dry : green).push({ p: V(X, Y, Z), s: V(s * (0.8 + rnd() * 0.6), s, s * (0.8 + rnd() * 0.6)), ry: rnd() * 6.28, c: new THREE.Color(k, k, k) });
    };
    // weeds along the shoulders, getting thicker towards the portal
    for (let i = 0; i < 1600; i++) {
      const d = lerp(1, 97, Math.pow(rnd(), 0.7));
      const side = rnd() < 0.5 ? -1 : 1;
      const xr = side * lerp(1.4, 3.0 + d * 0.04, rnd());
      const X = TRACK_X + xr;
      const near = smoothstep(4, 30, d);
      tuft(X, xr > 0 && xr < 1.9 ? 0.1 : groundHeight(X, d), -d, lerp(0.12, 0.45, rnd()) * (0.35 + 0.65 * near) * (1 + d / 80), rnd() < 0.45);
    }
    // a few between the rails
    for (let i = 0; i < 90; i++) tuft(TRACK_X + (rnd() - 0.5) * 1.6, 0.25, -lerp(2, 90, rnd()), lerp(0.08, 0.2, rnd()), true);
    // around the foot of the mast and along the fence
    for (let i = 0; i < 120; i++) tuft(lerp(1.4, FENCE_X + 0.3, rnd()), 0.14, -lerp(6, 36, rnd()), lerp(0.1, 0.25, rnd()), rnd() < 0.4);
    // the yard on the left
    for (let i = 0; i < 260; i++) {
      if (i > 90) continue;
      const X = TRACK_X - lerp(3.4, 8, rnd());
      const d = lerp(4, 40, rnd());
      tuft(X, groundHeight(X, d), -d, lerp(0.15, 0.45, rnd()), rnd() < 0.5);
    }
    const g = grassCard(1, 1);
    for (const [list, mat] of [
      [green, M.grass],
      [dry, M.dryGrass],
    ]) {
      const m = fillInstances(new THREE.InstancedMesh(g, mat, list.length), list);
      m.receiveShadow = true;
      scene.add(m);
    }

    // fallen leaves littering the track
    const leaves = [];
    const palette = [0xd2803c, 0xb05a2e, 0xe0a94a, 0x8a5a36, 0x7d8a3c, 0x6f8a46, 0x5d7a3a, 0x9a3a28, 0xc89a60].map((c) => new THREE.Color(c));
    const surfaceY = (X, d) => {
      const xr = X - TRACK_X;
      const ax = Math.abs(xr);
      const bal = ax < 1.35 ? 0.255 : xr > 0 ? lerp(0.255, 0.08, (ax - 1.35) / 0.65) : lerp(0.255, -0.2, (ax - 1.35) / 0.65);
      return Math.max(bal, groundHeight(X, d)) + 0.012;
    };
    for (let i = 0; i < quality.leaves; i++) {
      const d = lerp(0.35, 30, Math.pow(rnd(), 2.2));
      const X = lerp(TRACK_X - 2.6, FENCE_X, rnd());
      const xr = X - TRACK_X;
      let Y = surfaceY(X, d);
      if (Math.abs(xr) < 1.05 && rnd() < 0.45) Y = SLEEPER_TOP + 0.004;
      const s = lerp(0.03, 0.075, rnd());
      leaves.push({
        p: V(X, Y, -d),
        s: V(s, s, s),
        rx: -Math.PI / 2 + (rnd() - 0.5) * 0.5,
        ry: rnd() * 6.28,
        rz: (rnd() - 0.5) * 0.5,
        c: palette[(rnd() * palette.length) | 0].clone().multiplyScalar(0.75 + rnd() * 0.4),
      });
    }
    const lg = new THREE.PlaneGeometry(1, 0.5);
    const lm = fillInstances(new THREE.InstancedMesh(lg, M.leaf, leaves.length), leaves);
    lm.receiveShadow = true;
    scene.add(lm);

    // twigs and splinters
    const twigs = [];
    for (let i = 0; i < 160; i++) {
      const d = lerp(0.5, 14, Math.pow(rnd(), 1.4));
      const X = lerp(TRACK_X - 1.4, TRACK_X + 1.2, rnd());
      twigs.push({ p: V(X, 0.28 + rnd() * 0.03, -d), s: V(0.02, 0.02, lerp(0.15, 0.5, rnd())), ry: rnd() * 6.28, c: new THREE.Color(0.5 + rnd() * 0.3, 0.4, 0.32) });
    }
    const tm = fillInstances(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), M.sleeper, twigs.length), twigs);
    tm.receiveShadow = true;
    scene.add(tm);
  }

  return {
    id: 'tunnel',
    scene,
    wires: [wires, fineWires],
    post: {
      outline: 0.9,
      lineColor: new THREE.Color(0.1, 0.1, 0.18),
      lineFar: 120,
      creaseThreshold: 0.35,
      bloom: 0.18,
      bloomThreshold: 1.0,
      exposure: 1.0,
      saturation: 1.05,
      contrast: 1.0,
      lift: new THREE.Color(0.0, 0.01, 0.03),
      gain: new THREE.Color(1.03, 1.0, 0.98),
      vignette: 0.22,
      vignetteColor: new THREE.Color(0.04, 0.06, 0.16),
      paper: 0.025,
      paint: quality.paint,
      colorEdge: 0.9,
      colorEdgeThreshold: 0.055,
    },
    frame(aspect) {
      const refAspect = REF.w / REF.h;
      let W;
      let H;
      let x0;
      let y0;
      if (aspect <= refAspect) {
        H = REF.h;
        W = H * aspect;
        x0 = clamp(660 - W / 2, 0, REF.w - W);
        y0 = 0;
      } else {
        W = REF.w * Math.pow(aspect / refAspect, 0.45);
        H = W / aspect;
        y0 = LENS.py - 0.72 * H;
        x0 = 610 - 0.5 * W;
      }
      return { position: V(0, EYE, 0), yaw: 0, pitch: 0, near: 0.05, fov: 60, lens: LENS, window: { x0, x1: x0 + W, y0, y1: y0 + H } };
    },
    orbit: { target: V(0, 2, -20), min: 2, max: 140 },
    update() {},
  };
}

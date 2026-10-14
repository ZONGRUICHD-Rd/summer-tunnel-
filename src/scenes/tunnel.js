import * as THREE from 'three';
import { toon } from '../lib/materials.js';
import { createSkyDome, createCumulus, bakeClouds } from '../lib/sky.js';
import { WireSet } from '../lib/wires.js';
import { profileStrip, rod, box, blobGeometry, grassCard, fillInstances, mergeGeometries } from '../lib/geom.js';
import { mulberry32, fbm2, ridged2, smoothstep, lerp, clamp } from '../lib/noise.js';
import * as TX from '../lib/textures.js';

const deg = THREE.MathUtils.degToRad;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------
// Layout constants (metres). The track runs along -Z towards the tunnel.
// ---------------------------------------------------------------------------
const GAUGE = 1.067;
const RAIL_X = GAUGE / 2 + 0.03;
const SLEEPER_TOP = 0.3;
const PORTAL_Z = -105;
const TRACK_NEAR = 12;
const TRACK_FAR = -170;
const SIDING_X = -4.1;
const POLE_X = 2.45;
const WOOD_POLE_X = -6.4;
const FENCE_X = 3.55;

const SUN_DIR = V(-0.86, 0.38, 0.3).normalize();

/** Height of the landscape at (x, z). */
function terrainHeight(x, z) {
  const ax = Math.abs(x);
  const d = -z;
  const lateral = 1 - 0.5 * smoothstep(-220, 480, x);
  // the hill the tunnel bores into, rising to a long ridge that is higher on the left
  let h = 14 * smoothstep(58, -PORTAL_Z + 3, d) + 78 * lateral * smoothstep(-PORTAL_Z - 6, 430, d) - 35 * smoothstep(480, 1000, d);
  h *= 0.8 + 0.45 * fbm2(x * 0.007, z * 0.007, 4, 3);
  h += 22 * ridged2(x * 0.005 + 3, z * 0.005, 4, 7) * smoothstep(-PORTAL_Z - 10, 260, d);

  // track cutting in front of the portal; behind it the hill closes over the bore
  if (z > PORTAL_Z - 1.6) h *= smoothstep(5.0, 24, ax);
  else {
    const behind = PORTAL_Z - 1.6 - z;
    h = Math.min(h, 9.3 + behind * 0.55 + smoothstep(10, 26, ax) * 40);
    h = Math.max(h, (9.3 + behind * 0.3) * (1 - smoothstep(10, 16, ax)));
  }

  // left: village flat, then wooded hills
  const left = smoothstep(-35, -170, x) * (60 + 30 * fbm2(x * 0.008, z * 0.008, 3, 11));
  h = Math.max(h, left);

  // right: embankment drops to fields, far hills
  if (x > FENCE_X) {
    h += -2.6 * smoothstep(FENCE_X + 0.3, 10, x) * (1 - smoothstep(70, 100, d));
    h += 50 * smoothstep(200, 560, x) * (0.6 + 0.6 * fbm2(x * 0.006, z * 0.006, 4, 5));
  }

  // gentle undulation away from the railway
  h += (fbm2(x * 0.05, z * 0.05, 4, 2) - 0.5) * 1.6 * smoothstep(4, 22, ax);
  return h;
}

export function createTunnelScene({ quality, renderer }) {
  const scene = new THREE.Scene();
  const hazeColor = new THREE.Color(0x9cb8db);
  scene.fog = new THREE.FogExp2(hazeColor, 0.0013);
  const rnd = mulberry32(2024);

  // ------------------------------------------------------------------ light
  const sun = new THREE.DirectionalLight(0xffc896, 2.1 * Math.PI);
  sun.position.copy(SUN_DIR).multiplyScalar(120).add(V(0, 0, -45));
  sun.target.position.set(0, 0, -45);
  sun.castShadow = true;
  const sm = quality.shadowMap;
  sun.shadow.mapSize.set(sm, sm);
  const sc = sun.shadow.camera;
  sc.left = -62;
  sc.right = 62;
  sc.top = 62;
  sc.bottom = -62;
  sc.near = 1;
  sc.far = 280;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0x8fb0ff, 0x6a5a4c, 0.95 * Math.PI);
  scene.add(hemi);

  // -------------------------------------------------------------------- sky
  scene.add(
    createSkyDome({
      zenith: 0x14378a,
      mid: 0x2e6cc4,
      horizon: 0x93bbe4,
      ground: 0x7a9cc4,
      sunDir: SUN_DIR,
      sunColor: 0xffc69a,
      sunGlow: 0.35,
      midHeight: 0.34,
      paint: 0.16,
      alto: 1,
      altoScale: 4.6,
      altoCover: 0.56,
      altoSeed: 4.2,
      altoLit: 0xfdf3ee,
      altoWarm: 0xf2a6b4,
      altoShade: 0x6d83c7,
      altoMaskDir: V(-0.6, 0, -0.8).normalize(),
      altoMaskSpread: 1.0,
      wind: new THREE.Vector2(0.0035, 0.0012),
      cirrus: 0.22,
      cirrusColor: 0xe9eefc,
    })
  );

  const cloudLight = V(-0.62, 0.72, 0.28);
  const clouds = [
    // big cumulus behind the mast, right of the vanishing point
    { azimuth: 30, elevation: 12, width: 58, aspect: 1.9, seed: 3, count: 46, top: 1.35, lit: 0xffffff, shade: 0xa8b9dd, dark: 0x6f86bd, warm: 0xffd2c4, warmAmount: 0.18, haze: 0.08, order: 2 },
    // towers above the ridge
    { azimuth: -2, elevation: 11.5, width: 40, aspect: 2.3, seed: 8, count: 34, top: 1.1, lit: 0xfff6f2, shade: 0xb1b9e0, dark: 0x7a88c4, warm: 0xffbcc0, warmAmount: 0.35, haze: 0.15, order: 1 },
    // low pink bank on the left
    { azimuth: -42, elevation: 9.5, width: 46, aspect: 2.8, seed: 15, count: 36, top: 0.9, lit: 0xfff0ea, shade: 0xb5a9d8, dark: 0x8079bb, warm: 0xffa8b4, warmAmount: 0.5, haze: 0.18, order: 1 },
    // distant dark band on the right horizon
    { azimuth: 52, elevation: 3.2, width: 70, aspect: 6.5, seed: 21, count: 40, top: 0.6, lit: 0x5875b2, shade: 0x2c4583, dark: 0x22386f, rim: 0x8fa8db, haze: 0.05, order: 0, base: -0.7 },
    // small puffs
    { azimuth: 12, elevation: 23, width: 18, aspect: 2.0, seed: 33, count: 18, top: 0.9, lit: 0xfff7f2, shade: 0x9fb0dc, dark: 0x7686c0, warm: 0xffb3b8, warmAmount: 0.4, haze: 0.0, order: 3 },
    { azimuth: -24, elevation: 21, width: 16, aspect: 2.4, seed: 41, count: 16, top: 0.8, lit: 0xfff7f2, shade: 0xa7aedc, dark: 0x7d84c0, warm: 0xffacb6, warmAmount: 0.5, haze: 0.0, order: 3 },
  ];
  for (const c of clouds) scene.add(createCumulus({ light: cloudLight, drift: 0.0004, ...c }));

  // ------------------------------------------------------------- textures
  const tBallast = TX.ballastTexture(4);
  const tWood = TX.woodTexture(5);
  const tConcrete = TX.concreteTexture(6);
  const tConcreteDark = TX.concreteTexture(16, { stains: 1.0 });
  const tRust = TX.rustTexture(7);
  const tGrass = TX.grassTexture(9);
  const tDryGrass = TX.grassTexture(10, 'dry');
  const tChain = TX.chainLinkTexture();
  const tWall = TX.wallTexture(11);
  const tGround = TX.groundTexture(12);
  const tWindow = TX.windowTexture();
  const tPlate = TX.plateTexture('3');

  // ------------------------------------------------------------ materials
  const M = {
    ballast: toon({ map: tBallast, color: 0xf2ece4 }),
    sleeper: toon({ map: tWood, color: 0xb0aaa6 }),
    rail: toon({ map: tRust, color: 0x7c6a62 }),
    railTop: toon({ color: 0x8e9cb2, emissive: 0x1e2a40 }),
    plate: toon({ color: 0x4a4038 }),
    concrete: toon({ map: tConcrete, color: 0xdedbd2 }),
    portal: toon({ map: tConcreteDark, color: 0xc4c2ba }),
    steel: toon({ map: tConcrete, color: 0xbab8b6 }),
    darkSteel: toon({ color: 0x5b5d63 }),
    woodPole: toon({ map: tConcrete, color: 0xa29684 }),
    insulator: toon({ color: 0x8a5a43 }),
    insulatorW: toon({ color: 0xece8de }),
    fence: toon({ map: tChain, color: 0xb5bdc6, alphaTest: 0.45, side: THREE.DoubleSide }),
    fenceFrame: toon({ color: 0xa3abb3 }),
    wall: toon({ map: tWall, color: 0xf6f2e8 }),
    wallDark: toon({ map: tConcrete, color: 0xc8c4b8 }),
    roof: toon({ color: 0x55607a }),
    ground: toon({ map: tGround, vertexColors: true, color: 0xffffff }),
    grass: toon({ map: tGrass, color: 0xe8f4c0, alphaTest: 0.5, side: THREE.DoubleSide, wind: 0.05, ramp: [0.3, 0.6], litFloor: 0.9, lineWeight: 0 }),
    dryGrass: toon({ map: tDryGrass, color: 0xfff6d8, alphaTest: 0.5, side: THREE.DoubleSide, wind: 0.04, ramp: [0.3, 0.6], litFloor: 0.9, lineWeight: 0 }),
    foliage: toon({ vertexColors: true, foliage: 1.0, foliageScale: 1.6, ramp: [0.44, 0.58], litFloor: 0.8, lineWeight: 0.3 }),
    foliageFar: toon({ vertexColors: true, foliage: 0.8, foliageScale: 0.35, ramp: [0.45, 0.62], litFloor: 0.75, lineWeight: 0.2 }),
    trunk: toon({ color: 0x5d4c3f }),
    window: new THREE.MeshBasicMaterial({ map: tWindow }),
    tunnelInside: new THREE.MeshBasicMaterial({ vertexColors: true }),
    black: new THREE.MeshBasicMaterial({ color: 0x050608 }),
  };
  M.fence.alphaToCoverage = true;

  const add = (geo, mat, { cast = true, receive = true } = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    scene.add(m);
    return m;
  };

  // -------------------------------------------------------------- terrain
  {
    const NX = quality.terrain;
    const NZ = quality.terrain;
    const mapAxis = (t, neg, pos, p) => {
      const a = Math.sign(t) * Math.pow(Math.abs(t), p);
      return a < 0 ? a * neg : a * pos;
    };
    const pos = [];
    const col = [];
    const uv = [];
    const cTrack = new THREE.Color(0x8d8458);
    const cGrass = new THREE.Color(0x76a04a);
    const cForest = new THREE.Color(0x2c4f26);
    const cField = new THREE.Color(0x8fb455);
    const c = new THREE.Color();
    for (let j = 0; j <= NZ; j++) {
      const v = (j / NZ) * 2 - 1;
      const z = PORTAL_Z + mapAxis(v, 1500, 300, 1.9);
      for (let i = 0; i <= NX; i++) {
        const u = (i / NX) * 2 - 1;
        const x = mapAxis(u, 1300, 1600, 1.9);
        const h = terrainHeight(x, z);
        pos.push(x, h, z);
        uv.push(x / 7, z / 7);
        const ax = Math.abs(x);
        const forest = smoothstep(2, 9, h);
        c.copy(cGrass).lerp(cForest, forest);
        if (x > 9 && h < 3) c.lerp(cField, 0.6);
        c.lerp(cTrack, 1 - smoothstep(2.2, 5.5, ax));
        const n = fbm2(x * 0.08, z * 0.08, 3, 99);
        c.multiplyScalar(0.85 + n * 0.3);
        col.push(c.r, c.g, c.b);
      }
    }
    const idx = [];
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const a = j * (NX + 1) + i;
        const b = a + 1;
        const cc = a + NX + 1;
        const d = cc + 1;
        idx.push(a, cc, b, b, cc, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    add(g, M.ground, { cast: false });
  }

  // far mountain range (pure silhouette, fog does the rest)
  {
    const pts = [];
    const idx = [];
    const N = 200;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = lerp(-3500, 4500, t);
      const h = 120 + 330 * ridged2(t * 6, 1.3, 5, 31) + 200 * smoothstep(0.5, 0.95, t);
      const z = -2300 - 400 * Math.sin(t * 5.0);
      pts.push(x, -40, z + 300, x, h, z);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const far = new THREE.Mesh(g, toon({ color: 0x41618e, side: THREE.DoubleSide }));
    scene.add(far);
  }

  // ---------------------------------------------------------------- track
  function buildTrack(x0, z0, z1, { overgrown = 0 } = {}) {
    // ballast bed
    const bal = profileStrip(
      [
        [x0 - 1.95, -0.25],
        [x0 - 1.3, 0.255],
        [x0 + 1.3, 0.255],
        [x0 + 1.95, -0.25],
      ],
      z0,
      z1,
      { segments: Math.ceil((z0 - z1) / 1.5), uvScale: 1.7, yNoise: (x, z, p) => (p[1] > 0 ? (fbm2(x * 2, z * 0.7, 2, 3) - 0.5) * 0.06 : 0) }
    );
    add(bal, M.ballast, { cast: false });

    // sleepers
    const items = [];
    const plates = [];
    const sGeo = new THREE.BoxGeometry(2.0, 0.14, 0.2);
    for (let z = z0 - 0.4; z > z1; z -= 0.62) {
      const k = 0.75 + rnd() * 0.35;
      const tint = new THREE.Color().setRGB(k, k * (0.95 + rnd() * 0.05), k * (0.9 + rnd() * 0.08));
      if (rnd() < 0.15) tint.setRGB(0.92, 0.92, 0.9);
      const zz = z + (rnd() - 0.5) * 0.05;
      items.push({ p: V(x0 + (rnd() - 0.5) * 0.05, SLEEPER_TOP - 0.07 - rnd() * 0.02, zz), ry: (rnd() - 0.5) * 0.03, s: 1, c: tint });
      for (const sx of [-1, 1]) plates.push({ p: V(x0 + sx * RAIL_X, SLEEPER_TOP + 0.008, zz), s: 1 });
    }
    const sleepers = fillInstances(new THREE.InstancedMesh(sGeo, M.sleeper, items.length), items);
    sleepers.castShadow = true;
    sleepers.receiveShadow = true;
    scene.add(sleepers);
    const plateMesh = fillInstances(new THREE.InstancedMesh(new THREE.BoxGeometry(0.17, 0.018, 0.16), M.plate, plates.length), plates);
    plateMesh.receiveShadow = true;
    scene.add(plateMesh);

    // rails (JIS-like profile)
    const prof = [
      [-0.064, 0],
      [0.064, 0],
      [0.064, 0.012],
      [0.012, 0.028],
      [0.008, 0.036],
      [0.008, 0.1],
      [0.031, 0.112],
      [0.032, 0.143],
      [0.025, 0.152],
      [-0.025, 0.152],
      [-0.032, 0.143],
      [-0.031, 0.112],
      [-0.008, 0.1],
      [-0.008, 0.036],
      [-0.012, 0.028],
      [-0.064, 0.012],
    ];
    for (const sx of [-1, 1]) {
      const p = prof.map(([x, y]) => [x0 + sx * RAIL_X + x, SLEEPER_TOP + 0.017 + y]);
      const g = profileStrip(p.slice().reverse(), z0, z1, { closed: true, uvScale: 0.6 });
      add(g, M.rail);
      const top = new THREE.BoxGeometry(0.048, 0.004, z0 - z1);
      top.translate(x0 + sx * RAIL_X, SLEEPER_TOP + 0.017 + 0.152, (z0 + z1) / 2);
      add(top, M.railTop, { cast: false });
    }

    if (overgrown > 0) scatterGrass({ x0: x0 - 1.4, x1: x0 + 1.4, z0, z1, count: overgrown, y: 0.2, scale: [0.35, 0.8], dry: 0.5 });
  }

  // ---------------------------------------------------------------- grass
  const grassItems = { green: [], dry: [] };
  function scatterGrass({ x0, x1, z0, z1, count, y = null, scale = [0.4, 0.9], dry = 0.3, avoid = null }) {
    for (let i = 0; i < count; i++) {
      const x = lerp(x0, x1, rnd());
      const z = lerp(z0, z1, rnd());
      if (avoid && avoid(x, z)) continue;
      const s = lerp(scale[0], scale[1], rnd());
      const yy = y ?? terrainHeight(x, z);
      const k = 0.85 + rnd() * 0.3;
      const rec = { p: V(x, yy - 0.02, z), s: V(s * (0.8 + rnd() * 0.5), s, s * (0.8 + rnd() * 0.5)), ry: rnd() * Math.PI, c: new THREE.Color(k, k, k) };
      (rnd() < dry ? grassItems.dry : grassItems.green).push(rec);
    }
  }

  buildTrack(0, TRACK_NEAR, TRACK_FAR);
  buildTrack(SIDING_X, TRACK_NEAR, -62, { overgrown: 1100 });

  // buffer stop at the end of the siding
  add(box(2.2, 0.9, 0.6, SIDING_X, 0.45, -62.3), M.concrete);

  // drainage trough between the tracks (the pale concrete strip in front)
  {
    const z0 = TRACK_NEAR;
    const z1 = -62;
    const trough = profileStrip(
      [
        [-2.75, -0.1],
        [-2.75, 0.32],
        [-2.05, 0.32],
        [-2.05, -0.1],
      ],
      z0,
      z1,
      { segments: 40, uvScale: 1.2 }
    );
    add(trough, M.concrete);
    // lid joints
    const joints = [];
    for (let z = z0; z > z1; z -= 0.6) joints.push({ p: V(-2.4, 0.322, z), s: 1 });
    const jm = fillInstances(new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.004, 0.012), M.darkSteel, joints.length), joints);
    scene.add(jm);
  }

  // weeds along the line
  scatterGrass({ x0: 1.45, x1: 2.4, z0: 10, z1: -104, count: 900, y: 0.1, scale: [0.18, 0.45], dry: 0.6 });
  scatterGrass({ x0: -1.95, x1: -1.4, z0: 10, z1: -104, count: 400, y: 0.1, scale: [0.15, 0.4], dry: 0.6 });
  scatterGrass({ x0: -0.9, x1: 0.9, z0: 6, z1: -104, count: 160, y: 0.24, scale: [0.1, 0.25], dry: 0.7 });
  scatterGrass({ x0: 2.4, x1: 9, z0: 12, z1: -104, count: 2600, scale: [0.3, 0.75], dry: 0.35 });
  scatterGrass({ x0: -12, x1: -6.2, z0: 12, z1: -104, count: 1300, scale: [0.3, 0.75], dry: 0.35, avoid: (x, z) => x < -8 && z < -3 && z > -34 });
  scatterGrass({ x0: -22, x1: 22, z0: -88, z1: -104.5, count: 900, scale: [0.4, 1.0], dry: 0.25, avoid: (x) => Math.abs(x) < 2.2 });

  // ------------------------------------------------------- catenary masts
  const wires = new WireSet({ color: 0x232733, minPx: 0.6 });
  const wiresLight = new WireSet({ color: 0x3a3f4c, minPx: 0.5 });
  const steelParts = [];
  const darkParts = [];
  const insParts = [];
  const insWParts = [];

  function insulatorStack(a, b, discs = 5, r = 0.075) {
    const dir = new THREE.Vector3().subVectors(b, a);
    for (let i = 0; i < discs; i++) {
      const t = (i + 0.5) / discs;
      const p = a.clone().addScaledVector(dir, t);
      const g = new THREE.CylinderGeometry(r, r, dir.length() / discs * 0.55, 12);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir.clone().normalize()));
      g.translate(p.x, p.y, p.z);
      insParts.push(g);
    }
    darkParts.push(rod(a, b, 0.012, 6));
  }

  /** Steel mast with cantilever. Returns wire attachment points. */
  function mast(z, { big = false } = {}) {
    const x = POLE_X;
    const H = big ? 11.2 : 10.4;
    const r0 = big ? 0.19 : 0.15;
    steelParts.push(rod(V(x, 0, z), V(x, H, z), r0, 24, r0 * 0.88));
    add(box(0.9, 0.35, 0.9, x, 0.1, z), M.concrete);
    // collars & step bolts
    for (let y = 1.2; y < H - 0.5; y += 2.0) {
      const g = new THREE.CylinderGeometry(r0 * 1.12, r0 * 1.12, 0.07, 24);
      g.translate(x, y, z);
      steelParts.push(g);
    }
    if (big) {
      for (let y = 2.2, s = 1; y < H - 0.6; y += 0.42, s = -s) {
        const a = V(x, y, z);
        const dir = V(-0.55 * s + 0.2, 0, 0.8).normalize();
        darkParts.push(rod(a.clone().addScaledVector(dir, r0 * 0.8), a.clone().addScaledVector(dir, r0 + 0.16), 0.014, 6));
      }
      // brackets on the column
      for (const y of [4.6, 8.9]) darkParts.push(box(0.12, 0.42, 0.42, x - r0 - 0.02, y, z));
    }
    // cantilever: horizontal tube, stay, hook end
    const yArm = big ? 7.25 : 6.95;
    const xEnd = -0.55;
    steelParts.push(rod(V(x - r0, yArm, z), V(xEnd, yArm, z), 0.045, 10));
    steelParts.push(rod(V(x - r0, yArm + 1.7, z), V(0.35, yArm + 0.02, z), 0.035, 8));
    const hook = new THREE.CatmullRomCurve3([V(xEnd, yArm, z), V(xEnd - 0.22, yArm - 0.05, z), V(xEnd - 0.3, yArm - 0.35, z), V(xEnd - 0.2, yArm - 0.62, z)]);
    steelParts.push(new THREE.TubeGeometry(hook, 12, 0.04, 8, false));
    insulatorStack(V(x - r0 - 0.05, yArm, z), V(x - r0 - 0.75, yArm, z), 6, 0.08);
    insulatorStack(V(x - r0 - 0.05, yArm + 1.65, z), V(x - r0 - 0.55, yArm + 1.25, z), 4, 0.065);
    // registration arm for the contact wire
    const yReg = 5.85;
    steelParts.push(rod(V(x - r0, yReg, z), V(0.25, yReg - 0.3, z), 0.03, 8));
    insulatorStack(V(x - r0 - 0.05, yReg, z), V(x - r0 - 0.6, yReg - 0.08, z), 4, 0.065);
    darkParts.push(rod(V(0.25, yReg - 0.3, z), V(0.05, 5.42, z), 0.018, 6));
    // feeder crossarm at the top
    steelParts.push(rod(V(x - 0.9, H - 0.4, z), V(x + 1.0, H - 0.4, z), 0.04, 8));
    for (const dx of [-0.75, 0.85]) {
      const g = new THREE.CylinderGeometry(0.06, 0.07, 0.32, 10);
      g.translate(x + dx, H - 0.2, z);
      insWParts.push(g);
    }
    return {
      messenger: V(0.0, yArm - 0.15, z),
      contact: V(0.05, 5.42, z),
      feeders: [V(x - 0.75, H - 0.04, z), V(x + 0.85, H - 0.04, z)],
      top: V(x, H, z),
    };
  }

  const masts = [mast(-3.6, { big: true }), mast(-28), mast(-53), mast(-78)];

  // portal frame just before the tunnel
  {
    const z = PORTAL_Z + 6;
    for (const x of [-3.2, 3.2]) {
      steelParts.push(rod(V(x, 0, z), V(x, 8.2, z), 0.14, 16, 0.12));
      add(box(0.7, 0.3, 0.7, x, 0.1, z), M.concrete);
    }
    steelParts.push(box(7.2, 0.28, 0.28, 0, 7.9, z));
    steelParts.push(box(7.2, 0.18, 0.18, 0, 7.35, z));
    for (let x = -3.0; x <= 3.0; x += 0.6) steelParts.push(rod(V(x, 7.35, z), V(x + 0.3, 7.9, z), 0.02, 4));
    insulatorStack(V(0.0, 7.2, z), V(0.0, 6.6, z), 4, 0.07);
    masts.push({ messenger: V(0.0, 6.55, z), contact: V(-0.1, 5.42, z), feeders: [V(3.2 - 0.75, 8.2, z), V(3.2 + 0.3, 8.2, z)], top: V(3.2, 8.2, z) });
  }

  // number plate "3" on the big mast
  {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.3), toon({ map: tPlate }));
    const dir = V(-0.45, 0, 0.9).normalize();
    plate.position.set(POLE_X, 2.85, -3.6).addScaledVector(dir, 0.205);
    plate.lookAt(plate.position.clone().add(dir));
    plate.castShadow = false;
    plate.receiveShadow = true;
    scene.add(plate);
    darkParts.push(box(0.03, 0.34, 0.02, POLE_X - 0.09, 2.85, -3.42, 0.45));
  }

  // concrete utility poles on the left with crossarms
  const woodParts = [];
  const leftPoles = [];
  for (const z of [-7, -22, -37, -52, -67, -82, -97]) {
    const lean = (rnd() - 0.5) * 0.08;
    const H = 9.2 + rnd() * 0.8;
    const base = V(WOOD_POLE_X, 0, z);
    const top = V(WOOD_POLE_X + lean, H, z);
    woodParts.push(rod(base, top, 0.16, 12, 0.11));
    woodParts.push(box(1.9, 0.11, 0.11, top.x, H - 0.45, z));
    woodParts.push(box(1.2, 0.09, 0.09, top.x, H - 1.25, z));
    const att = [];
    for (const dx of [-0.8, -0.3, 0.3, 0.8]) {
      const g = new THREE.CylinderGeometry(0.035, 0.045, 0.16, 8);
      g.translate(top.x + dx, H - 0.32, z);
      insWParts.push(g);
      att.push(V(top.x + dx, H - 0.24, z));
    }
    // transformer on one of them
    if (z === -22) {
      const g = new THREE.CylinderGeometry(0.28, 0.28, 0.85, 14);
      g.translate(WOOD_POLE_X - 0.35, H - 2.6, z);
      darkParts.push(g);
    }
    leftPoles.push({ att, top, low: [V(top.x - 0.5, H - 1.15, z), V(top.x + 0.5, H - 1.15, z)] });
  }
  // the line climbs over the tunnel to a pole on the hillside
  const hillPole = (() => {
    const x = -8.5;
    const z = PORTAL_Z - 22;
    const y0 = terrainHeight(x, z) - 0.5;
    const H = 9.5;
    woodParts.push(rod(V(x, y0, z), V(x, y0 + H, z), 0.16, 10, 0.11));
    woodParts.push(box(1.9, 0.11, 0.11, x, y0 + H - 0.45, z));
    return [-0.8, -0.3, 0.3, 0.8].map((dx) => V(x + dx, y0 + H - 0.24, z));
  })();

  add(mergeGeometries(steelParts), M.steel);
  add(mergeGeometries(darkParts), M.darkSteel);
  add(mergeGeometries(insParts), M.insulator);
  add(mergeGeometries(insWParts), M.insulatorW);
  add(mergeGeometries(woodParts), M.woodPole);

  // ---------------------------------------------------------------- wires
  {
    const portalTop = PORTAL_Z + 0.2;
    // messenger + contact
    const mPts = [V(0.0, 7.0, 32), ...masts.map((m) => m.messenger), V(0, 6.05, portalTop)];
    wires.addSpan(mPts, { radius: 0.011, sag: (l) => 0.012 * l });
    const cPts = [V(-0.15, 5.42, 32), ...masts.map((m) => m.contact), V(0.0, 5.3, portalTop)];
    wires.addSpan(cPts, { radius: 0.012, sag: 0.0 });
    // droppers
    for (let i = 0; i < mPts.length - 1; i++) {
      const a = mPts[i];
      const b = mPts[i + 1];
      const ca = cPts[i];
      const cb = cPts[i + 1];
      const L = a.z - b.z;
      const n = Math.max(2, Math.round(L / 5));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const top = a.clone().lerp(b, t);
        top.y -= 4 * 0.012 * L * t * (1 - t);
        const bot = ca.clone().lerp(cb, t);
        wiresLight.addPolyline([top, bot.clone().setY(bot.y + 0.02)], 0.004);
      }
    }
    // feeders on the masts
    for (let f = 0; f < 2; f++) {
      const pts = [V(POLE_X + (f ? 0.85 : -0.75), 10.9, 40), ...masts.map((m) => m.feeders[f]), V(f ? 4.5 : 3.0, 9.6, PORTAL_Z - 0.4)];
      wires.addSpan(pts, { radius: 0.014, sag: (l) => 0.018 * l });
    }
    // lines on the utility poles, running on past the tunnel up the hillside
    for (let k = 0; k < 4; k++) {
      const pts = [V(WOOD_POLE_X + [-0.8, -0.3, 0.3, 0.8][k], 9.6, 40), ...leftPoles.map((p) => p.att[k]), hillPole[k]];
      wires.addSpan(pts, { radius: 0.013, sag: (l) => 0.02 * l });
    }
    for (let k = 0; k < 2; k++) {
      const pts = [V(WOOD_POLE_X - 0.5 + k, 8.6, 40), ...leftPoles.map((p) => p.low[k])];
      wires.addSpan(pts, { radius: 0.01, sag: (l) => 0.025 * l });
    }
    // span wires crossing the sky from the big mast
    const big = masts[0].top;
    wires.addSpan([big.clone().add(V(-0.1, -0.1, 0)), leftPoles[0].top.clone().add(V(0.2, -0.3, 0))], { radius: 0.013, sag: 0.35 });
    wires.addSpan([big.clone().add(V(-0.1, -0.6, 0)), V(-9.5, 8.4, 14)], { radius: 0.013, sag: 0.45 });
    wires.addSpan([V(POLE_X, 6.4, -3.6), V(WOOD_POLE_X, 7.3, 8)], { radius: 0.011, sag: 0.2 });
  }
  scene.add(wires.build());
  scene.add(wiresLight.build());

  // ---------------------------------------------------------------- fence
  {
    const z0 = 12;
    const z1 = PORTAL_Z + 8;
    const parts = [];
    for (let z = z0; z >= z1; z -= 2.4) {
      parts.push(rod(V(FENCE_X, -0.3, z), V(FENCE_X, 1.85, z), 0.032, 8));
    }
    parts.push(rod(V(FENCE_X, 1.82, z0), V(FENCE_X, 1.82, z1), 0.022, 6));
    parts.push(rod(V(FENCE_X, 0.12, z0), V(FENCE_X, 0.12, z1), 0.018, 6));
    add(mergeGeometries(parts), M.fenceFrame);
    const meshG = new THREE.PlaneGeometry(z0 - z1, 1.72);
    const uv = meshG.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * (z0 - z1)) / 0.11, (uv.getY(i) * 1.72) / 0.11);
    meshG.rotateY(Math.PI / 2);
    meshG.translate(FENCE_X, 0.98, (z0 + z1) / 2);
    add(meshG, M.fence, { cast: true });
  }

  // ---------------------------------------------------------------- house
  {
    const hx = -14.5;
    const hz = -13;
    const W = 7;
    const D = 9;
    const H = 6.0;
    add(box(W, H, D, hx, H / 2, hz), M.wall);
    add(box(W + 0.5, 0.25, D + 0.5, hx, H + 0.12, hz), M.roof);
    add(box(W + 0.1, 0.18, D + 0.1, hx, 3.05, hz), M.wallDark);
    const winGeo = [];
    for (const [y, z, w, h] of [
      [4.4, hz - 2.2, 1.6, 1.1],
      [4.4, hz + 1.8, 1.2, 1.1],
      [1.6, hz + 0.5, 1.8, 1.2],
      [1.6, hz - 3.0, 0.9, 1.6],
    ]) {
      const g = new THREE.PlaneGeometry(w, h);
      g.rotateY(Math.PI / 2);
      g.translate(hx + W / 2 + 0.02, y, z);
      winGeo.push(g);
      add(box(0.12, 0.08, w + 0.2, hx + W / 2 + 0.06, y - h / 2 - 0.04, z), M.wallDark);
    }
    add(mergeGeometries(winGeo), M.window, { cast: false });
    // air-conditioner, vent, downpipe
    add(box(0.32, 0.6, 0.85, hx + W / 2 + 0.17, 0.32, hz + 2.8), M.wallDark);
    const vent = new THREE.CylinderGeometry(0.22, 0.22, 0.1, 18);
    vent.rotateZ(Math.PI / 2);
    vent.translate(hx + W / 2 + 0.05, 5.2, hz + 3.3);
    add(vent, M.wallDark);
    add(rod(V(hx + W / 2 + 0.06, 0, hz + D / 2 - 0.1), V(hx + W / 2 + 0.06, H, hz + D / 2 - 0.1), 0.05, 8), M.wallDark);
    // second building further back
    add(box(6, 4.2, 7, -17, 2.1, -27), M.wall);
    add(box(6.6, 0.25, 7.6, -17, 4.3, -27), M.roof);
    // block wall along the line
    const wallG = profileStrip(
      [
        [-8.1, -0.2],
        [-8.1, 1.25],
        [-7.9, 1.25],
        [-7.9, -0.2],
      ],
      2,
      -34,
      { segments: 1, uvScale: 1.0 }
    );
    add(wallG, M.wallDark);
    // shed by the siding
    add(box(1.4, 1.6, 2.2, -6.6, 0.8, -1.5), M.wallDark);
  }

  // -------------------------------------------------------------- tunnel
  {
    const Wd = 2.65;
    const spring = 3.7;
    const outer = new THREE.Shape();
    outer.moveTo(-9, -1);
    outer.lineTo(9, -1);
    outer.lineTo(9, 9.2);
    outer.lineTo(-9, 9.2);
    outer.lineTo(-9, -1);
    const hole = new THREE.Path();
    hole.moveTo(-Wd, -0.5);
    hole.lineTo(-Wd, spring);
    hole.absarc(0, spring, Wd, Math.PI, 0, true);
    hole.lineTo(Wd, -0.5);
    hole.lineTo(-Wd, -0.5);
    outer.holes.push(hole);
    const face = new THREE.ExtrudeGeometry(outer, { depth: 1.4, bevelEnabled: false });
    face.translate(0, 0, PORTAL_Z - 1.4);
    add(face, M.portal);

    // arch ring
    const ring = new THREE.Shape();
    const R = Wd + 0.45;
    ring.moveTo(-R, 0);
    ring.lineTo(-R, spring);
    ring.absarc(0, spring, R, Math.PI, 0, true);
    ring.lineTo(R, 0);
    ring.lineTo(Wd, 0);
    ring.lineTo(Wd, spring);
    ring.absarc(0, spring, Wd, 0, Math.PI, false);
    ring.lineTo(-Wd, 0);
    ring.lineTo(-R, 0);
    const ringG = new THREE.ExtrudeGeometry(ring, { depth: 0.2, bevelEnabled: false, curveSegments: 24 });
    ringG.translate(0, 0, PORTAL_Z);
    add(ringG, M.concrete);

    // cornice and pilasters
    add(box(19, 0.55, 1.9, 0, 9.35, PORTAL_Z - 0.6), M.concrete);
    for (const x of [-8.6, 8.6]) add(box(0.9, 9.6, 1.9, x, 4.3, PORTAL_Z - 0.6), M.concrete);
    // wing walls stepping down
    for (const s of [-1, 1]) {
      const wing = new THREE.Shape();
      wing.moveTo(0, -1);
      wing.lineTo(6.5, -1);
      wing.lineTo(6.5, 1.0);
      wing.lineTo(0, 8.6);
      wing.lineTo(0, -1);
      const g = new THREE.ExtrudeGeometry(wing, { depth: 0.8, bevelEnabled: false });
      g.rotateY(s > 0 ? -Math.PI / 2 + 0.35 : -Math.PI / 2 - 0.35);
      g.translate(s * 9.0, 0, PORTAL_Z - 0.3);
      add(g, M.portal);
    }

    // inside: lining that fades to black
    const lining = new THREE.Shape();
    lining.moveTo(-Wd, -0.5);
    lining.lineTo(-Wd, spring);
    lining.absarc(0, spring, Wd, Math.PI, 0, true);
    lining.lineTo(Wd, -0.5);
    const pts = lining.getPoints(24).map((p) => [p.x, p.y]);
    const inside = profileStrip(pts, PORTAL_Z - 0.2, PORTAL_Z - 60, { segments: 30, uvScale: 2 });
    const pos = inside.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const depth = PORTAL_Z - pos.getZ(i);
      const k = 0.045 * Math.exp(-depth / 5) + 0.004;
      const top = smoothstep(0, 6, pos.getY(i));
      cols[i * 3] = k * (0.9 + top * 0.1);
      cols[i * 3 + 1] = k * (0.95 + top * 0.1);
      cols[i * 3 + 2] = k * 1.15;
    }
    inside.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const insideMesh = new THREE.Mesh(inside, M.tunnelInside);
    insideMesh.material.side = THREE.DoubleSide;
    scene.add(insideMesh);
    const cap = new THREE.PlaneGeometry(8, 10);
    cap.translate(0, 4, PORTAL_Z - 58);
    scene.add(new THREE.Mesh(cap, M.black));
  }

  // --------------------------------------------------------------- forest
  {
    const td = quality.treeDetail;
    const variants = [blobGeometry(1, { detail: td }), blobGeometry(2, { detail: td, lumps: 0.33 }), blobGeometry(3, { detail: td, squash: 1.0 })];
    const farGeo = blobGeometry(4, { detail: 1, lumps: 0.3 });
    const greens = [0x3f7a34, 0x356a2e, 0x4b8a3a, 0x2f5e2a, 0x5a9440, 0x46803a, 0x2a5428].map((c) => new THREE.Color(c));
    const near = [[], [], []];
    const far = [];

    const isBlocked = (x, z) => {
      const ax = Math.abs(x);
      if (z > PORTAL_Z - 1 && ax < 8) return true; // track corridor
      if (x > 2 && x < 12 && z > PORTAL_Z + 6) return true; // meadow behind the fence
      if (x < -6 && x > -24 && z < 4 && z > -36) return true; // houses
      if (z > -12 && ax < 20) return true; // around the viewer
      if (z > PORTAL_Z - 1.2 && z < PORTAL_Z + 1 && ax < 12) return true; // portal face
      return false;
    };

    const place = (x, z, scale, list) => {
      const h = terrainHeight(x, z);
      const c = greens[(rnd() * greens.length) | 0].clone().multiplyScalar(0.85 + rnd() * 0.3);
      const sy = scale * (0.85 + rnd() * 0.5);
      list.push({ p: V(x, h + sy * 0.45, z), s: V(scale * (0.9 + rnd() * 0.3), sy, scale * (0.9 + rnd() * 0.3)), ry: rnd() * Math.PI * 2, c });
    };
    const pick = () => near[(rnd() * 3) | 0];

    // crowns covering the hill and the slopes of the cutting
    let tries = 0;
    let count = 0;
    while (count < quality.trees && tries < quality.trees * 14) {
      tries++;
      const x = lerp(-200, 240, rnd());
      const z = lerp(10, -420, Math.pow(rnd(), 0.75));
      if (isBlocked(x, z)) continue;
      const h = terrainHeight(x, z);
      if (rnd() > 0.1 + smoothstep(1.5, 7, h) * 0.9) continue;
      const dist = Math.hypot(x, z + 10);
      place(x, z, lerp(1.4, 2.6, rnd()) * (1 + dist / 200), pick());
      count++;
    }
    // close the hill over the portal
    for (let i = 0; i < 260; i++) {
      const x = lerp(-34, 34, rnd());
      const z = lerp(PORTAL_Z - 1.8, PORTAL_Z - 40, Math.pow(rnd(), 1.4));
      place(x, z, lerp(1.5, 2.4, rnd()), pick());
    }
    // tree lines behind the fence and the block wall
    for (let z = -10; z > PORTAL_Z + 4; z -= 1.8 + rnd() * 1.8) {
      if (rnd() < 0.75) place(lerp(12, 30, rnd()), z, lerp(1.6, 2.8, rnd()), pick());
      if (z < -36 && rnd() < 0.85) place(lerp(-9.6, -15, rnd()), z, lerp(1.5, 2.5, rnd()), pick());
    }
    // far forest blanket
    tries = 0;
    while (far.length < quality.farTrees && tries < quality.farTrees * 10) {
      tries++;
      const x = lerp(-1100, 1400, rnd());
      const z = lerp(-280, -1300, rnd());
      const h = terrainHeight(x, z);
      if (h < 6) continue;
      place(x, z, lerp(7, 12, rnd()) * (1 + Math.hypot(x, z) / 1500), far);
    }

    // only crowns inside the sun's shadow frustum need to render into it
    const inShadow = (it) => Math.abs(it.p.x) < 48 && it.p.z > PORTAL_Z - 8;
    near.forEach((items, i) => {
      for (const cast of [true, false]) {
        const list = items.filter((it) => inShadow(it) === cast);
        if (!list.length) continue;
        const m = fillInstances(new THREE.InstancedMesh(variants[i], M.foliage, list.length), list);
        m.castShadow = cast;
        m.receiveShadow = true;
        scene.add(m);
      }
    });
    const fm = fillInstances(new THREE.InstancedMesh(farGeo, M.foliageFar, far.length), far);
    scene.add(fm);
  }

  // detailed trees next to the houses (left edge of the frame)
  {
    const trunks = [];
    const geo = blobGeometry(7, { detail: 2, lumps: 0.3 });
    const items = [];
    for (const [x, z, s] of [
      [-9.4, -2.5, 1.0],
      [-9.0, -6.5, 0.8],
      [-10.5, -31, 1.1],
      [-11.5, -40, 1.25],
    ]) {
      trunks.push(rod(V(x, 0, z), V(x + 0.2, 3.2 * s, z), 0.14 * s, 8, 0.08 * s));
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2 + rnd();
        const r = (k === 0 ? 0 : 1.1) * s;
        const y = (k === 0 ? 4.6 : 3.4 + rnd() * 1.8) * s;
        const c = new THREE.Color(0x4f8a3b).multiplyScalar(0.85 + rnd() * 0.35);
        items.push({ p: V(x + Math.cos(a) * r, y, z + Math.sin(a) * r), s: (1.2 + rnd() * 0.5) * s, ry: rnd() * 6, c });
      }
    }
    add(mergeGeometries(trunks), M.trunk);
    const m = fillInstances(new THREE.InstancedMesh(geo, M.foliage, items.length), items);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }

  // bushes along the fence & wall
  {
    const geo = blobGeometry(11, { detail: 1, lumps: 0.35, squash: 0.7 });
    const items = [];
    for (let i = 0; i < 120; i++) {
      const side = rnd() < 0.6;
      const x = side ? lerp(3.9, 11, rnd()) : lerp(-7.7, -6.6, rnd());
      const z = lerp(4, PORTAL_Z + 6, rnd());
      const s = lerp(0.5, 1.2, rnd());
      items.push({ p: V(x, terrainHeight(x, z) + s * 0.25, z), s: V(s * 1.3, s, s * 1.2), ry: rnd() * 6, c: new THREE.Color(0x5a9442).multiplyScalar(0.8 + rnd() * 0.35) });
    }
    const m = fillInstances(new THREE.InstancedMesh(geo, M.foliage, items.length), items);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }

  // grass instances
  {
    const g = grassCard(1, 1);
    for (const [items, mat] of [
      [grassItems.green, M.grass],
      [grassItems.dry, M.dryGrass],
    ]) {
      const m = fillInstances(new THREE.InstancedMesh(g, mat, items.length), items);
      m.receiveShadow = true;
      scene.add(m);
    }
  }

  bakeClouds(renderer, scene);

  return {
    id: 'tunnel',
    scene,
    wires: [wires, wiresLight],
    post: {
      outline: 0.8,
      lineColor: new THREE.Color(0.22, 0.2, 0.33),
      lineFar: 140,
      creaseThreshold: 0.3,
      bloom: 0.22,
      bloomThreshold: 0.9,
      exposure: 1.0,
      saturation: 1.12,
      contrast: 1.06,
      lift: new THREE.Color(0.0, 0.012, 0.035),
      gain: new THREE.Color(1.02, 1.0, 0.98),
      vignette: 0.32,
      vignetteColor: new THREE.Color(0.06, 0.08, 0.22),
      paper: 0.03,
    },
    frame(aspect) {
      const t = clamp((aspect - 0.45) / (1.9 - 0.45), 0, 1);
      const narrow = 1 - clamp((aspect - 0.45) / 0.3, 0, 1);
      return {
        position: V(0.3, lerp(0.92, 1.05, t), 2.2),
        yaw: deg(lerp(-1.2, 0.5, t) - narrow * 3.5),
        pitch: deg(lerp(20, 9.5, t)),
        fov: lerp(84, 50, Math.pow(t, 0.8)),
      };
    },
    orbit: { target: V(0, 3, -20), min: 2, max: 140 },
    update() {},
  };
}

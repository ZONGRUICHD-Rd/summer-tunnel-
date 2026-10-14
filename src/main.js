import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Pipeline } from './lib/pipeline.js';
import { LookControls } from './lib/controls.js';
import { shared } from './lib/materials.js';
import { createTunnelScene } from './scenes/tunnel.js';
import { createSeasideScene } from './scenes/seaside.js';

const META = {
  tunnel: { title: '夏之隧道', sub: 'The Tunnel to Summer', theme: '#1b3f8f' },
  seaside: { title: '海边长椅', sub: 'A Bench by the Sea', theme: '#3a9ad9' },
};
const ORDER = ['tunnel', 'seaside'];

const params = new URLSearchParams(location.search);
const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(screen.width, screen.height) < 700;
const QUALITY = {
  low: { shadowMap: 2048, terrain: 160, trees: 1300, farTrees: 1100, treeDetail: 1, paint: 2, leaves: 6000, pixelRatio: 1.25 },
  medium: { shadowMap: 2048, terrain: 200, trees: 2000, farTrees: 1800, treeDetail: 1, paint: 2, leaves: 9000, pixelRatio: 1.5 },
  high: { shadowMap: 4096, terrain: 240, trees: 2800, farTrees: 2400, treeDetail: 2, paint: 3, leaves: 14000, pixelRatio: 2 },
};
const quality = QUALITY[params.get('q')] ?? (coarse || small ? QUALITY.medium : QUALITY.high);

const $ = (s) => document.querySelector(s);
const canvas = $('#view');
const loader = $('#loader');
const loaderFill = $('#loader-fill');
const loaderText = $('#loader-text');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function fail(msg) {
  const el = document.createElement('p');
  el.className = 'error';
  el.textContent = msg;
  document.body.appendChild(el);
  loader.classList.add('done');
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
} catch (e) {
  fail('抱歉，你的浏览器不支持 WebGL 2，无法显示 3D 场景。');
  throw e;
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x000000, 1);

const camera = new THREE.PerspectiveCamera(50, 1, 0.25, 6000);
camera.rotation.order = 'YXZ';
const pipeline = new Pipeline(renderer);
const look = new LookControls(canvas);
const orbit = new OrbitControls(camera, canvas);
orbit.enabled = false;
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;

const scenes = {};
let current = null;
let base = null;
let freeMode = false;
let returning = null; // animation back from free mode
let transition = 1;
let pixelRatio = Math.min(window.devicePixelRatio || 1, quality.pixelRatio);

// ------------------------------------------------------------------ sizing
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  const pw = Math.floor(w * pixelRatio);
  const ph = Math.floor(h * pixelRatio);
  pipeline.setSize(pw, ph);
  for (const s of Object.values(scenes)) for (const wset of s.wires ?? []) wset.setResolution(pw, ph);
  camera.aspect = w / h;
  if (current) {
    base = current.frame(camera.aspect);
    if (!freeMode && !returning) applyBaseView();
    else applyProjection(1);
  }
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------ scene logic
// Scenes may describe their framing as a real lens: focal length F and
// principal point (px, py) in reference-image pixels, plus the window of that
// image to show. This reproduces shifted (architectural) projections where
// verticals stay vertical and the horizon sits low in the frame.
function applyProjection(zoom = look.zoom) {
  camera.near = base.near ?? 0.25;
  if (base.lens && !freeMode) {
    const { F, px, py } = base.lens;
    const w = base.window;
    const f = F * zoom;
    const n = camera.near;
    camera.projectionMatrix.makePerspective(
      (n * (w.x0 - px)) / f,
      (n * (w.x1 - px)) / f,
      (n * (py - w.y0)) / f,
      (n * (py - w.y1)) / f,
      n,
      camera.far
    );
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  } else {
    camera.fov = (freeMode ? 60 : base.fov) / zoom;
    camera.updateProjectionMatrix();
  }
}

function applyBaseView() {
  camera.position.copy(base.position);
  camera.rotation.set(base.pitch + look.pitch, base.yaw + look.yaw, 0, 'YXZ');
  applyProjection();
}

function updateUI(id) {
  document.querySelectorAll('.scene-tab').forEach((b) => b.setAttribute('aria-current', String(b.dataset.scene === id)));
  $('#scene-title').textContent = META[id].title;
  $('#scene-sub').textContent = META[id].sub;
  document.title = `${META[id].title} · Summer Tunnel`;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', META[id].theme);
}

function switchTo(id, { instant = false } = {}) {
  if (!scenes[id] || current === scenes[id]) return;
  if (current && !instant) {
    // freeze the outgoing frame, then dissolve into the new scene
    pipeline.render(current.scene, camera, { time: shared.uTime.value, toPrev: true });
    transition = 0;
  } else {
    transition = 1;
  }
  pipeline.transition = transition;
  setFree(false, { instant: true });
  current = scenes[id];
  pipeline.applyPost(current.post);
  base = current.frame(camera.aspect);
  look.reset();
  look.snap();
  applyBaseView();
  updateUI(id);
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
}

function setFree(on, { instant = false } = {}) {
  if (on === freeMode) return;
  freeMode = on;
  $('#btn-free').setAttribute('aria-pressed', String(on));
  look.enabled = !on;
  orbit.enabled = on;
  if (on) {
    // stay near eye level: from far away or overhead the scene reads as a toy
    const o = current.orbit;
    orbit.target.copy(o.target);
    orbit.minDistance = o.min;
    orbit.maxDistance = o.max;
    orbit.minPolarAngle = o.minPolar ?? 0;
    orbit.maxPolarAngle = o.maxPolar ?? Math.PI * 0.53;
    orbit.minAzimuthAngle = o.minAzimuth ?? -Infinity;
    orbit.maxAzimuthAngle = o.maxAzimuth ?? Infinity;
    orbit.enablePan = false;
    applyProjection(1);
    orbit.update();
    returning = null;
  } else if (!instant) {
    returning = { t: 0, pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov };
    look.reset();
    look.snap();
  } else {
    returning = null;
  }
}

// --------------------------------------------------------------------- UI
document.querySelectorAll('.scene-tab').forEach((b) => b.addEventListener('click', () => switchTo(b.dataset.scene)));
$('#btn-free').addEventListener('click', () => setFree(!freeMode));
$('#btn-reset').addEventListener('click', () => {
  if (freeMode) setFree(false);
  else look.reset();
});
$('#btn-ui').addEventListener('click', () => document.body.classList.toggle('ui-hidden'));
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (k === '1' || k === '2') switchTo(ORDER[Number(k) - 1]);
  else if (k === 'arrowright' || k === 'arrowleft') {
    const i = ORDER.indexOf(current?.id);
    switchTo(ORDER[(i + (k === 'arrowright' ? 1 : ORDER.length - 1)) % ORDER.length]);
  } else if (k === 'f') setFree(!freeMode);
  else if (k === 'r') freeMode ? setFree(false) : look.reset();
  else if (k === 'h') document.body.classList.toggle('ui-hidden');
});
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (scenes[id]) switchTo(id);
});
const hint = $('#hint');
look.onInteract = () => hint.classList.add('fade');
setTimeout(() => hint.classList.add('fade'), 9000);

// ------------------------------------------------------------------- loop
const clock = new THREE.Clock();
let frames = 0;
let acc = 0;
let lowStreak = 0;

function adaptResolution(dt) {
  frames++;
  acc += dt;
  if (acc < 2) return;
  const fps = frames / acc;
  frames = 0;
  acc = 0;
  if (fps < 38 && pixelRatio > 0.75) {
    lowStreak++;
    if (lowStreak >= 2) {
      pixelRatio = Math.max(0.75, pixelRatio - 0.25);
      lowStreak = 0;
      resize();
    }
  } else lowStreak = 0;
}

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  shared.uTime.value = t;

  if (freeMode) {
    orbit.update();
  } else if (returning) {
    returning.t = Math.min(1, returning.t + dt / 1.2);
    const k = returning.t * returning.t * (3 - 2 * returning.t);
    look.update(dt);
    const target = new THREE.Object3D();
    target.position.copy(base.position);
    target.rotation.set(base.pitch, base.yaw, 0, 'YXZ');
    camera.position.lerpVectors(returning.pos, target.position, k);
    camera.quaternion.slerpQuaternions(returning.quat, target.quaternion, k);
    if (base.lens) applyProjection(1);
    else {
      camera.fov = THREE.MathUtils.lerp(returning.fov, base.fov, k);
      camera.updateProjectionMatrix();
    }
    if (returning.t >= 1) returning = null;
  } else {
    look.update(dt);
    applyBaseView();
    // a slow, barely-there breathing sway
    camera.rotation.x += Math.sin(t * 0.21) * 0.0025;
    camera.rotation.y += Math.sin(t * 0.13 + 1.3) * 0.003;
  }

  current.update(t, dt, camera);
  if (transition < 1) {
    transition = Math.min(1, transition + dt / 1.6);
    pipeline.transition = transition;
  }
  pipeline.render(current.scene, camera, { time: t });
  if (still) return;
  if (!params.has('fixed')) adaptResolution(dt);
  requestAnimationFrame(tick);
}

// ?still renders on demand only (used for automated screenshots)
const still = params.has('still');
function renderStill(t = 12) {
  clock.elapsedTime = t;
  clock.getDelta();
  tick();
}

// ------------------------------------------------------------------ boot
async function boot() {
  const steps = [
    ['tunnel', '搭建铁路与隧道…', createTunnelScene],
    ['seaside', '铺设海岸与长椅…', createSeasideScene],
  ];
  let i = 0;
  for (const [id, label, create] of steps) {
    loaderText.textContent = label;
    loaderFill.style.width = `${(i / (steps.length + 1)) * 100}%`;
    await nextFrame();
    await nextFrame();
    scenes[id] = create({ quality, renderer });
    i++;
  }
  resize();
  loaderText.textContent = '编译着色器…';
  loaderFill.style.width = `${(steps.length / (steps.length + 1)) * 100}%`;
  await nextFrame();
  for (const id of ORDER) {
    const s = scenes[id];
    base = s.frame(camera.aspect);
    applyBaseView();
    try {
      await renderer.compileAsync(s.scene, camera);
    } catch {
      renderer.compile(s.scene, camera);
    }
  }
  const start = ORDER.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'tunnel';
  switchTo(start, { instant: true });
  loaderFill.style.width = '100%';
  clock.start();
  tick();
  await nextFrame();
  loader.classList.add('done');
  window.__app = { switchTo, setFree, scenes, camera, renderer, look, orbit, pipeline, renderStill, get current() { return current; } };
  document.body.dataset.ready = '1';
}

boot().catch((e) => {
  console.error(e);
  fail('场景加载失败：' + (e?.message ?? e));
});

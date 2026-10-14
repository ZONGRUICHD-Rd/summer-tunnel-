import * as THREE from 'three';
import { mulberry32, tileFbm, clamp } from './noise.js';

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(c, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

const hex = (r, g, b) => `rgb(${r | 0},${g | 0},${b | 0})`;

// Draw something at every wrapped position so the texture tiles seamlessly.
function wrapDraw(size, x, y, r, fn) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const px = x + dx * size;
      const py = y + dy * size;
      if (px + r < 0 || px - r > size || py + r < 0 || py - r > size) continue;
      fn(px, py);
    }
  }
}

// Per-pixel fill with a colour function (u, v) -> [r,g,b,a]
function fillPixels(c, fn) {
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const d = img.data;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const col = fn(x / c.width, y / c.height, x, y);
      d[i] = col[0];
      d[i + 1] = col[1];
      d[i + 2] = col[2];
      d[i + 3] = col[3] ?? 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return ctx;
}

/** Railway ballast: packed stones with fallen leaves and dry grass. */
export function ballastTexture(seed = 1) {
  const S = 512;
  const c = canvas(S);
  const rnd = mulberry32(seed);
  const ctx = fillPixels(c, (u, v) => {
    const n = tileFbm(u, v, 8, 4, seed);
    const m = tileFbm(u, v, 3, 3, seed + 9);
    const k = 70 + n * 50;
    return [k + m * 30, k * 0.92 + m * 18, k * 0.82];
  });
  // stones
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 3 + rnd() * 6;
    const base = 95 + rnd() * 95;
    const warm = rnd() * 22;
    const rot = rnd() * Math.PI;
    const ar = 0.6 + rnd() * 0.4;
    wrapDraw(S, x, y, r * 1.5, (px, py) => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.fillStyle = hex(base * 0.45, base * 0.43, base * 0.42);
      ctx.beginPath();
      ctx.ellipse(1.2, 1.4, r, r * ar, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hex(base + warm, base + warm * 0.6, base);
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * ar, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hex(base * 1.2 + warm, base * 1.18 + warm * 0.6, base * 1.15);
      ctx.beginPath();
      ctx.ellipse(-r * 0.25, -r * 0.25 * ar, r * 0.5, r * ar * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }
  // leaves & dry grass
  const leafCols = [
    [150, 92, 40],
    [178, 120, 52],
    [120, 80, 38],
    [110, 118, 52],
    [90, 104, 46],
    [196, 150, 80],
  ];
  for (let i = 0; i < 520; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 4 + rnd() * 7;
    const col = leafCols[(rnd() * leafCols.length) | 0];
    const rot = rnd() * Math.PI;
    wrapDraw(S, x, y, r * 2, (px, py) => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.fillStyle = hex(col[0] * 0.55, col[1] * 0.5, col[2] * 0.5);
      ctx.beginPath();
      ctx.ellipse(1, 1.5, r, r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hex(...col);
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = hex(col[0] * 0.7, col[1] * 0.65, col[2] * 0.6);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.lineTo(r, 0);
      ctx.stroke();
      ctx.restore();
    });
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < 260; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const len = 8 + rnd() * 18;
    const a = rnd() * Math.PI * 2;
    const g = rnd();
    wrapDraw(S, x, y, len, (px, py) => {
      ctx.strokeStyle = g > 0.5 ? hex(150, 140, 80) : hex(96, 120, 50);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + Math.cos(a) * len * 0.5 + 3, py + Math.sin(a) * len * 0.5, px + Math.cos(a) * len, py + Math.sin(a) * len);
      ctx.stroke();
    });
  }
  return toTexture(c);
}

/** Weathered timber for sleepers: grain runs along u. */
export function woodTexture(seed = 3) {
  const S = 256;
  const c = canvas(S);
  const rnd = mulberry32(seed);
  const ctx = fillPixels(c, (u, v) => {
    const grain = tileFbm(u * 0.25, v * 4, 4, 4, seed);
    const fine = tileFbm(u, v, 32, 2, seed + 5);
    const blotch = tileFbm(u, v, 3, 3, seed + 11);
    const k = 0.55 + grain * 0.5 + fine * 0.15 - blotch * 0.25;
    return [120 * k + 25, 92 * k + 18, 70 * k + 14];
  });
  ctx.strokeStyle = 'rgba(40,28,20,0.55)';
  for (let i = 0; i < 18; i++) {
    const y = rnd() * S;
    const x = rnd() * S;
    const l = 20 + rnd() * 90;
    ctx.lineWidth = 0.6 + rnd() * 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + l, y + (rnd() - 0.5) * 4);
    ctx.stroke();
  }
  return toTexture(c);
}

/** Generic concrete with stains; tint is multiplied by material colour. */
export function concreteTexture(seed = 5, { stains = 0.5, pits = 600, size = 512 } = {}) {
  const S = size;
  const c = canvas(S);
  const rnd = mulberry32(seed);
  const ctx = fillPixels(c, (u, v) => {
    const n = tileFbm(u, v, 4, 5, seed);
    const f = tileFbm(u, v, 48, 2, seed + 3);
    const s = tileFbm(u * 0.5, v * 2, 3, 4, seed + 7);
    let k = 205 + (n - 0.5) * 50 + (f - 0.5) * 26;
    k -= Math.max(0, s - 0.55) * 160 * stains;
    return [k, k, k * 0.98];
  });
  for (let i = 0; i < pits; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 0.5 + rnd() * 1.4;
    ctx.fillStyle = `rgba(80,80,80,${0.25 + rnd() * 0.35})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c);
}

/** Rust for the rail sides. */
export function rustTexture(seed = 7) {
  const S = 256;
  const c = canvas(S);
  fillPixels(c, (u, v) => {
    const n = tileFbm(u, v, 3, 4, seed);
    const m = tileFbm(u, v, 12, 3, seed + 2);
    const k = 0.78 + (n - 0.5) * 0.45 + (m - 0.5) * 0.15;
    return [clamp(128 * k, 0, 255), clamp(90 * k, 0, 255), clamp(70 * k, 0, 255)];
  });
  return toTexture(c);
}

/** Grass tuft card with transparent background. */
export function grassTexture(seed = 9, palette = 'summer') {
  const W = 256;
  const H = 256;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed);
  const cols =
    palette === 'dry'
      ? [[120, 128, 60], [150, 146, 78], [96, 112, 48], [170, 160, 92], [80, 98, 40]]
      : [[62, 110, 44], [86, 140, 54], [44, 88, 38], [120, 160, 70], [70, 124, 48]];
  for (let i = 0; i < 70; i++) {
    const x0 = W * (0.15 + rnd() * 0.7);
    const h = H * (0.35 + rnd() * 0.62);
    const lean = (rnd() - 0.5) * W * 0.55;
    const w = 2 + rnd() * 4;
    const col = cols[(rnd() * cols.length) | 0];
    const shade = 0.7 + rnd() * 0.45;
    ctx.fillStyle = hex(col[0] * shade, col[1] * shade, col[2] * shade);
    ctx.beginPath();
    ctx.moveTo(x0 - w, H);
    ctx.quadraticCurveTo(x0 + lean * 0.3, H - h * 0.55, x0 + lean, H - h);
    ctx.quadraticCurveTo(x0 + lean * 0.3 + w * 0.6, H - h * 0.5, x0 + w, H);
    ctx.closePath();
    ctx.fill();
  }
  return toTexture(c, { repeat: false });
}

/** Chain-link fence mesh (alpha). */
export function chainLinkTexture() {
  const S = 128;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = 'rgb(150,160,170)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  const step = S / 2;
  for (let i = -2; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step + S, S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i * step + S, 0);
    ctx.lineTo(i * step, S);
    ctx.stroke();
  }
  return toTexture(c, { aniso: 4 });
}

/** Leaf clusters used only as a shadow caster (dappled light). */
export function leafCanopyTexture(seed = 13) {
  const S = 1024;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed);
  ctx.clearRect(0, 0, S, S);
  // clusters of leaves
  for (let k = 0; k < 70; k++) {
    const cx = rnd() * S;
    const cy = rnd() * S;
    const cr = 40 + rnd() * 80;
    for (let i = 0; i < 55; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * cr;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const lr = 7 + rnd() * 12;
      ctx.fillStyle = '#000';
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rnd() * Math.PI);
      ctx.beginPath();
      ctx.ellipse(0, 0, lr, lr * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  // twigs
  ctx.strokeStyle = '#000';
  for (let i = 0; i < 30; i++) {
    ctx.lineWidth = 3 + rnd() * 5;
    ctx.beginPath();
    const x = rnd() * S;
    const y = rnd() * S;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + (rnd() - 0.5) * 300, y + (rnd() - 0.5) * 300, x + (rnd() - 0.5) * 500, y + (rnd() - 0.5) * 500);
    ctx.stroke();
  }
  return toTexture(c, { srgb: false, repeat: false });
}

/** Promenade paving: pale concrete with faint joints. */
export function pavingTexture(seed = 17) {
  const S = 512;
  const c = canvas(S);
  const rnd = mulberry32(seed);
  const ctx = fillPixels(c, (u, v) => {
    const n = tileFbm(u, v, 5, 5, seed);
    const f = tileFbm(u, v, 64, 2, seed + 1);
    const k = 228 + (n - 0.5) * 30 + (f - 0.5) * 22;
    return [k, k, k - 4];
  });
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(110,110,120,${0.15 + rnd() * 0.3})`;
    ctx.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
  return toTexture(c);
}

/** Painted timber for the bench slats. */
export function paintedWoodTexture(seed = 19) {
  const S = 512;
  const c = canvas(S, 64);
  fillPixels(c, (u, v) => {
    const g = tileFbm(u * 0.2, v * 3, 8, 4, seed);
    const f = tileFbm(u, v, 96, 2, seed + 4);
    const k = 238 + (g - 0.5) * 26 + (f - 0.5) * 14;
    return [k - 4, k, k + 6];
  });
  return toTexture(c);
}

/** House cladding. */
export function wallTexture(seed = 23) {
  const S = 256;
  const c = canvas(S);
  const ctx = fillPixels(c, (u, v) => {
    const n = tileFbm(u, v, 4, 4, seed);
    const streak = tileFbm(u * 4, v * 0.5, 4, 3, seed + 3);
    let k = 226 + (n - 0.5) * 18 - Math.max(0, streak - 0.55) * 70;
    return [k, k - 3, k - 10];
  });
  ctx.strokeStyle = 'rgba(120,115,105,0.35)';
  ctx.lineWidth = 1;
  for (let y = 0; y < S; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(S, y + 0.5);
    ctx.stroke();
  }
  return toTexture(c);
}

/** Ground cover for embankments & hillsides (tinted by material colour). */
export function groundTexture(seed = 29) {
  const S = 512;
  const c = canvas(S);
  const rnd = mulberry32(seed);
  const ctx = fillPixels(c, (u, v) => {
    const n = tileFbm(u, v, 6, 5, seed);
    const m = tileFbm(u, v, 24, 3, seed + 6);
    const k = 0.75 + (n - 0.5) * 0.5 + (m - 0.5) * 0.35;
    return [clamp(200 * k, 0, 255), clamp(215 * k, 0, 255), clamp(170 * k, 0, 255)];
  });
  for (let i = 0; i < 2500; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const s = rnd();
    ctx.strokeStyle = s > 0.5 ? 'rgba(255,255,220,0.35)' : 'rgba(40,60,20,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 4, y - 4 - rnd() * 6);
    ctx.stroke();
  }
  return toTexture(c);
}

/** Small number plate for the catenary mast. */
export function plateTexture(text = '3') {
  const W = 128;
  const H = 192;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f2ec';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, W - 20, H - 20);
  ctx.fillStyle = '#222';
  ctx.font = 'bold 110px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H / 2 + 6);
  return toTexture(c, { repeat: false });
}

/** Window glass with sky reflection streaks. */
export function windowTexture() {
  const W = 128;
  const H = 128;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#7f9cc4');
  g.addColorStop(0.5, '#38506e');
  g.addColorStop(1, '#25344a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(220,235,255,0.35)';
  ctx.beginPath();
  ctx.moveTo(10, 0);
  ctx.lineTo(40, 0);
  ctx.lineTo(0, 60);
  ctx.lineTo(0, 30);
  ctx.fill();
  ctx.strokeStyle = '#d8d8d0';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, W - 6, H - 6);
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  return toTexture(c, { repeat: false });
}

/** Grayscale paper grain for the final composite. */
export function paperTexture(seed = 37) {
  const S = 256;
  const c = canvas(S);
  fillPixels(c, (u, v) => {
    const n = tileFbm(u, v, 16, 3, seed);
    const f = tileFbm(u, v, 128, 1, seed + 1);
    const k = 128 + (n - 0.5) * 120 + (f - 0.5) * 60;
    return [k, k, k];
  });
  const t = toTexture(c, { srgb: false });
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}


/** A single leaf with a midrib (white, alpha) — tinted per instance. */
export function leafTexture() {
  const W = 128;
  const H = 64;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(6, H / 2);
  ctx.quadraticCurveTo(W * 0.45, -4, W - 6, H / 2);
  ctx.quadraticCurveTo(W * 0.45, H + 4, 6, H / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(70,50,40,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(4, H / 2);
  ctx.lineTo(W - 10, H / 2);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  for (let i = 1; i < 5; i++) {
    const x = (W * i) / 5.5;
    ctx.beginPath();
    ctx.moveTo(x, H / 2);
    ctx.lineTo(x + 14, H / 2 - 16);
    ctx.moveTo(x, H / 2);
    ctx.lineTo(x + 14, H / 2 + 16);
    ctx.stroke();
  }
  return toTexture(c, { repeat: false, aniso: 4 });
}

/** Distant forest canopy: packed tree crowns, lit on one side (tileable). */
export function forestTexture(seed = 41, { lightDir = [0.7, -0.5] } = {}) {
  const S = 1024;
  const c = canvas(S);
  const rnd = mulberry32(seed);
  const ctx = fillPixels(c, (u, v) => {
    const n = tileFbm(u, v, 6, 4, seed);
    const k = 0.55 + n * 0.25;
    return [60 * k, 92 * k, 96 * k];
  });
  const [lx, ly] = lightDir;
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 7 + rnd() * 16;
    const tone = 0.7 + rnd() * 0.5;
    const green = rnd();
    wrapDraw(S, x, y, r * 1.5, (px, py) => {
      // dark rim / cast shade
      ctx.fillStyle = `rgba(10,22,26,0.55)`;
      ctx.beginPath();
      ctx.arc(px - lx * r * 0.25, py - ly * r * 0.25, r * 1.05, 0, Math.PI * 2);
      ctx.fill();
      // crown body
      ctx.fillStyle = hex(58 * tone + green * 14, 92 * tone + green * 22, 92 * tone);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      // lit side
      ctx.fillStyle = hex(98 * tone + green * 20, 140 * tone + green * 24, 120 * tone);
      ctx.beginPath();
      ctx.arc(px + lx * r * 0.32, py + ly * r * 0.32, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  return toTexture(c, { aniso: 8 });
}

/**
 * Painted tree crown on a transparent card: hundreds of small leaf clusters,
 * lit from one side, darker inside and underneath (for distant woodland).
 */
export function treeCardTexture(seed = 51, { light = [0.8, -0.35], tall = 1.0 } = {}) {
  const S = 256;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed);
  ctx.clearRect(0, 0, S, S);
  // crown silhouette from a few lobes
  const lobes = [];
  const n = 5 + ((rnd() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r = S * (0.12 + rnd() * 0.12);
    lobes.push([S / 2 + Math.cos(a) * S * 0.16, S * (0.42 + (rnd() - 0.5) * 0.25 * tall) + Math.sin(a) * S * 0.12, r]);
  }
  lobes.push([S / 2, S * 0.48, S * 0.24]);
  const inside = (x, y) => lobes.some(([lx, ly, r]) => (x - lx) ** 2 + (y - ly) ** 2 < r * r);
  // trunk
  ctx.strokeStyle = 'rgb(38,34,32)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(S / 2, S);
  ctx.lineTo(S / 2 + (rnd() - 0.5) * 10, S * 0.55);
  ctx.stroke();
  const [lx, ly] = light;
  for (let i = 0; i < 1400; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    if (!inside(x, y)) continue;
    // facing the light?
    let k = 0;
    let cnt = 0;
    for (const [cx, cy, r] of lobes) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) {
        k += ((x - cx) * lx + (y - cy) * ly) / r;
        cnt++;
      }
    }
    k = cnt ? k / cnt : 0;
    const lit = Math.max(0, Math.min(1, k * 1.3 + 0.15 + (rnd() - 0.5) * 0.5));
    const low = Math.min(1, Math.max(0, (y - S * 0.35) / (S * 0.5)));
    const g = 0.55 + lit * 0.7 - low * 0.25;
    const r = 3 + rnd() * 7;
    ctx.fillStyle = hex(28 * g + lit * 30, 52 * g + lit * 34, 40 * g + lit * 8);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.6 + rnd() * 0.3), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c, { repeat: false, aniso: 4 });
}

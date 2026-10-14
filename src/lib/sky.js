import * as THREE from 'three';
import { NOISE_GLSL } from './glsl.js';
import { shared } from './materials.js';

// Everything in this module is drawn "at infinity": the vertex shader pins
// depth to the far plane, so the sky never occludes or outlines geometry.

const AT_INFINITY = /* glsl */ `
  vec4 skyClip(vec3 dir) {
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * dir * 100.0, 1.0);
    return p.xyww;
  }
`;

const color = (c) => new THREE.Color(c);
const MAX_PATCHES = 20;

/**
 * Gradient sky dome with an optional procedural cloud deck (altocumulus /
 * cirrus) projected onto a plane, shaded in a painted anime style.
 */
export function createSkyDome(o) {
  const uniforms = {
    uTime: shared.uTime,
    uZenith: { value: color(o.zenith) },
    uMid: { value: color(o.mid) },
    uHorizon: { value: color(o.horizon) },
    uGround: { value: color(o.ground ?? o.horizon) },
    uSunDir: { value: o.sunDir.clone().normalize() },
    uSunColor: { value: color(o.sunColor ?? 0xffffff) },
    uSunGlow: { value: o.sunGlow ?? 0.5 },
    uMidHeight: { value: o.midHeight ?? 0.3 },
    uPaint: { value: o.paint ?? 0.1 },
    // altocumulus deck
    uAlto: { value: o.alto ?? 0 },
    uAltoScale: { value: o.altoScale ?? 1.4 },
    uAltoCover: { value: o.altoCover ?? 0.5 },
    uAltoSeed: { value: o.altoSeed ?? 1.7 },
    uAltoLit: { value: color(o.altoLit ?? 0xffffff) },
    uAltoWarm: { value: color(o.altoWarm ?? 0xffc0b0) },
    uAltoShade: { value: color(o.altoShade ?? 0x8090c0) },
    uAltoMaskDir: { value: o.altoMaskDir ?? new THREE.Vector3(0, 0, -1) },
    uAltoMaskSpread: { value: o.altoMaskSpread ?? 1.0 },
    uWind: { value: o.wind ?? new THREE.Vector2(0.004, 0.001) },
    // cirrus wisps
    uCirrus: { value: o.cirrus ?? 0 },
    uCirrusColor: { value: color(o.cirrusColor ?? 0xffffff) },
    uCirrusDir: { value: o.cirrusDir ?? new THREE.Vector3(1, 0, -0.3).normalize() },
    // optional multi-stop gradient: [[elevationDeg, colour], ...] (max 6)
    uStops: { value: 0 },
    uStopE: { value: new Array(6).fill(0) },
    uStopC: { value: Array.from({ length: 6 }, () => new THREE.Color()) },
    uSide: { value: o.side ?? new THREE.Vector4(1, 0, 0, 0) }, // dir.xz, amount, min elevation
    uBlotch: { value: o.blotch ?? 0 },
    uLineWeight: { value: o.lineWeight ?? 1 },
    // optional colour layout map in reference-pixel space (see tunnel-skymap.js)
    uMap: { value: null },
    uMapRect: { value: new THREE.Vector4(0, 1, 0, 1) },
    uMapAmt: { value: 0 },
    uMapDetail: { value: o.mapDetail ?? 1 },
    // painted cloud patches laid out in the pixel space of a reference lens
    uLens: { value: new THREE.Vector3(o.lens?.F ?? 1, o.lens?.px ?? 0, o.lens?.py ?? 0) },
    uPatchCount: { value: 0 },
    uPA: { value: Array.from({ length: MAX_PATCHES }, () => new THREE.Vector4()) },
    uPB: { value: Array.from({ length: MAX_PATCHES }, () => new THREE.Vector4()) },
    uPC: { value: Array.from({ length: MAX_PATCHES }, () => new THREE.Vector4()) },
    uPD: { value: Array.from({ length: MAX_PATCHES }, () => new THREE.Vector4()) },
    uPLit: { value: Array.from({ length: MAX_PATCHES }, () => new THREE.Color()) },
    uPShade: { value: Array.from({ length: MAX_PATCHES }, () => new THREE.Color()) },
    uPWarm: { value: Array.from({ length: MAX_PATCHES }, () => new THREE.Color()) },
  };
  if (o.map) {
    const m = o.map;
    const bytes = Uint8Array.from(atob(m.data), (ch) => ch.charCodeAt(0));
    const tex = new THREE.DataTexture(bytes, m.width, m.height, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    uniforms.uMap.value = tex;
    uniforms.uMapRect.value.set(m.x0, m.x1, m.y0, m.y1);
    uniforms.uMapAmt.value = 1;
  }
  if (o.patches) {
    uniforms.uPatchCount.value = Math.min(MAX_PATCHES, o.patches.length);
    o.patches.slice(0, MAX_PATCHES).forEach((p, i) => {
      uniforms.uPA.value[i].set(p.x, p.y, p.rx, p.ry);
      uniforms.uPB.value[i].set(p.rot ?? 0, p.soft ?? 0.5, p.scale ?? 60, p.stretch ?? 1);
      uniforms.uPC.value[i].set(p.cover ?? 0.5, p.puff ?? 0.5, p.seed ?? i * 7.13, p.edge ?? 0.06);
      const ld = new THREE.Vector2(...(p.light ?? [0.55, 0.65])).normalize();
      uniforms.uPD.value[i].set(p.warmAmount ?? 0.5, p.opacity ?? 1, ld.x, ld.y);
      uniforms.uPLit.value[i].set(p.lit ?? 0xffffff);
      uniforms.uPShade.value[i].set(p.shade ?? 0x8090c0);
      uniforms.uPWarm.value[i].set(p.warm ?? 0xffb0a0);
    });
  }
  if (o.stops) {
    uniforms.uStops.value = Math.min(6, o.stops.length);
    o.stops.slice(0, 6).forEach(([e, c], i) => {
      uniforms.uStopE.value[i] = THREE.MathUtils.degToRad(e);
      uniforms.uStopC.value[i].set(c);
    });
  }

  const mat = new THREE.ShaderMaterial({
    uniforms,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      ${AT_INFINITY}
      void main() {
        vDir = position;
        gl_Position = skyClip(position);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uZenith, uMid, uHorizon, uGround, uSunDir, uSunColor;
      uniform float uSunGlow, uMidHeight, uPaint;
      uniform float uAlto, uAltoScale, uAltoCover, uAltoSeed;
      uniform vec3 uAltoLit, uAltoWarm, uAltoShade, uAltoMaskDir;
      uniform float uAltoMaskSpread;
      uniform vec2 uWind;
      uniform float uCirrus;
      uniform vec3 uCirrusColor, uCirrusDir;
      uniform int uStops;
      uniform float uStopE[6];
      uniform vec3 uStopC[6];
      uniform vec4 uSide;
      uniform float uBlotch;
      uniform float uLineWeight;
      uniform sampler2D uMap;
      uniform vec4 uMapRect;
      uniform float uMapAmt, uMapDetail;
      uniform vec3 uLens;
      uniform int uPatchCount;
      uniform vec4 uPA[${MAX_PATCHES}], uPB[${MAX_PATCHES}], uPC[${MAX_PATCHES}], uPD[${MAX_PATCHES}];
      uniform vec3 uPLit[${MAX_PATCHES}], uPShade[${MAX_PATCHES}], uPWarm[${MAX_PATCHES}];
      varying vec3 vDir;
      ${NOISE_GLSL}

      vec2 hash22(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.xx + p3.yz) * p3.zy);
      }
      // One octave of rounded cloudlets: returns (inside distance, normal).
      // Each cloudlet is shaded like a small dome, which reads as the
      // "fish-scale" altocumulus of anime skies.
      vec4 cloudlets(vec2 p, float cover, float seed) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec4 best = vec4(-1.0, 0.0, 0.0, 1.0);
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 cell = i + g;
            vec2 c = g + 0.15 + 0.7 * hash22(cell + seed) - f;
            float rr = (0.5 + 0.42 * hash12(cell * 1.7 + seed)) * cover;
            float dd = length(c);
            float ins = rr - dd;
            if (rr > 0.16 && ins > best.x) {
              float k = clamp(dd / max(rr, 1e-3), 0.0, 1.0);
              best = vec4(ins, -c / max(rr, 1e-3), sqrt(1.0 - k * k));
            }
          }
        }
        return best;
      }

      float billow(vec2 p) {
        float s = 0.0;
        float a = 0.5;
        mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
        for (int i = 0; i < 5; i++) {
          s += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0));
          p = m * p;
          a *= 0.5;
        }
        return s;
      }
      float cloudField(vec2 np, float puff) {
        vec2 w = vec2(fbm2(np * 0.45), fbm2(np * 0.45 + 5.2)) - 0.5;
        np += w * 1.6;
        return mix(fbm2(np), billow(np * 0.8) * 0.95, puff);
      }
      // one painted cloud patch, composited over col
      vec3 paintPatch(vec3 col, vec2 p, int i) {
        vec4 A = uPA[i];
        vec4 B = uPB[i];
        vec4 C = uPC[i];
        vec4 D = uPD[i];
        vec2 q = p - A.xy;
        float cr = cos(B.x);
        float sr = sin(B.x);
        q = vec2(cr * q.x + sr * q.y, -sr * q.x + cr * q.y);
        float r = length(q / A.zw);
        float edgeN = fbm2(p / (B.z * 2.2) + C.z) - 0.5;
        float mask = smoothstep(1.0, 1.0 - B.y, r + edgeN * 0.7);
        if (mask <= 0.001) return col;
        vec2 np = q / B.z * vec2(1.0, B.w) + C.z * 3.7;
        vec2 w = vec2(fbm2(np * 0.35), fbm2(np * 0.35 + 5.2)) - 0.5;
        np += w * 1.3;
        float cov = mask * clamp(0.85 + 1.1 * (fbm2(np * 0.28 + 2.0) - 0.5), 0.0, 1.3) * C.x;
        vec3 L = normalize(vec3(D.z, D.w, 0.55));
        vec3 mid = mix(uPShade[i], uPLit[i], 0.42);
        if (C.y > 0.5) {
          // soft body of the cloud mass, shaded by its density gradient
          float bn = (fbm2(np * 0.62) - 0.5) * 2.1 + 0.5;
          float bt = 1.0 - cov * 0.78;
          float bodyA = smoothstep(bt - 0.08, bt + 0.22, bn);
          float bn2 = (fbm2(np * 0.62 + D.zw * 0.12) - 0.5) * 2.1 + 0.5;
          float bodyLit = clamp((bn - bn2) * 6.0 + 0.5, 0.0, 1.0);
          vec3 bodyC = mix(uPShade[i], mid, bodyLit) * (0.94 + 0.12 * fbm2(np * 2.7 + 5.0));
          float bodyThin = 1.0 - smoothstep(bt, bt + 0.4, bn);
          bodyC = mix(bodyC, uPWarm[i], bodyThin * 0.5 * D.x);
          col = mix(col, bodyC, bodyA * 0.92 * D.y);
          // rounded puffs: three octaves of cloudlets, shaded as small domes,
          // painted mostly where the light catches them
          vec4 c1 = cloudlets(np, cov, C.z);
          vec4 c2 = cloudlets(np * 2.3 + 7.0, cov * 0.8, C.z + 3.0);
          c2.x /= 2.3;
          vec4 c3 = cloudlets(np * 5.3 + 3.0, cov * 0.62, C.z + 9.0);
          c3.x /= 5.3;
          vec4 cc = c1;
          if (c2.x > cc.x) cc = c2;
          if (c3.x > cc.x) cc = c3;
          float fw = fwidth(cc.x) + 1e-4;
          float pa = smoothstep(0.0, fw * 1.5 + C.w * 0.5 + 0.02, cc.x);
          vec3 n = normalize(vec3(cc.y, cc.z, cc.w * 1.15));
          n.xy += (vec2(vnoise(np * 7.0), vnoise(np * 7.0 + 4.0)) - 0.5) * 0.35;
          n = normalize(n);
          float pl = dot(n, L);
          float lit = smoothstep(0.0, 0.55, pl);
          vec3 pc = mix(mid, uPLit[i], lit);
          float thin = 1.0 - smoothstep(0.0, 0.55, cc.w);
          pc = mix(pc, uPWarm[i], clamp(thin * 0.6 + lit * 0.3, 0.0, 1.0) * D.x);
          float show = pa * mix(0.35, 1.0, smoothstep(-0.2, 0.35, pl));
          return mix(col, pc, show * D.y);
        }
        // wisps and streaks
        float nn = (fbm2(np) - 0.5) * 2.2 + 0.5;
        float th = 1.0 - cov;
        float a = smoothstep(th - C.w, th + C.w * 2.0, nn);
        if (a <= 0.001) return col;
        float n2 = (fbm2(np + D.zw * 0.22) - 0.5) * 2.2 + 0.5;
        float lit = clamp((nn - n2) * 7.0 + 0.5, 0.0, 1.0);
        float thin = 1.0 - smoothstep(th, th + 0.35, nn);
        vec3 cc = mix(uPShade[i], uPLit[i], lit);
        cc *= 0.93 + 0.14 * fbm2(np * 3.1 + 11.0);
        float warm = clamp(thin * 0.75 + lit * 0.4 - 0.1, 0.0, 1.0) * D.x;
        cc = mix(cc, uPWarm[i], warm);
        cc = mix(col, cc, 0.5 + 0.5 * (1.0 - thin * 0.6));
        return mix(col, cc, a * D.y);
      }

      void main() {
        vec3 d = normalize(vDir);
        float e = d.y;

        // base gradient
        vec3 col;
        if (uStops > 0) {
          float el = asin(clamp(e, -1.0, 1.0));
          col = uStopC[0];
          for (int i = 1; i < 6; i++) {
            if (i >= uStops) break;
            float t = smoothstep(uStopE[i - 1], uStopE[i], el);
            col = mix(col, uStopC[i], t);
          }
        } else {
          float tm = smoothstep(0.0, uMidHeight, e);
          float tz = smoothstep(uMidHeight * 0.6, 1.0, e);
          col = mix(uHorizon, uMid, pow(tm, 0.7));
          col = mix(col, uZenith, tz);
        }
        col = mix(col, uGround, smoothstep(0.0, -0.06, e));
        // darker on one side of the sky
        float side = max(dot(normalize(d.xz + 1e-5), uSide.xy), 0.0);
        col *= 1.0 - uSide.z * side * smoothstep(uSide.w, uSide.w + 0.4, e);

        // painted, watercolour-like variation
        vec2 pp = d.xz / (abs(e) + 0.35);
        float pv = fbm2(pp * 1.7 + 4.0);
        float pv2 = fbm2(pp * 6.0 - 2.0);
        col *= 1.0 + uPaint * ((pv - 0.5) * 1.2 + (pv2 - 0.5) * 0.4);
        // watercolour blooms: patches with crisp, bleeding edges
        if (uBlotch > 0.0) {
          vec2 bp = pp * 2.3 + vec2(fbm2(pp * 1.1), fbm2(pp * 1.1 + 7.0)) * 1.4;
          float b1 = fbm2(bp);
          float b2 = fbm2(bp * 2.7 + 3.3);
          float m1 = smoothstep(0.54, 0.565, b1);
          float m2 = smoothstep(0.6, 0.62, b2);
          col *= 1.0 + uBlotch * (m1 * 0.55 - m2 * 0.35 - 0.1);
          // pale speckles like dropped pigment
          float sp = smoothstep(0.83, 0.86, vnoise(pp * 38.0));
          col = mix(col, col * 1.35 + 0.02, sp * uBlotch * 0.6);
        }

        // sun glow
        float sd = max(dot(d, uSunDir), 0.0);
        col += uSunColor * (pow(sd, 6.0) * 0.25 + pow(sd, 48.0) * 0.6) * uSunGlow;

        if (e > 0.0) {
          vec2 base = d.xz / (e + 0.08);
          // altocumulus deck
          if (uAlto > 0.0) {
            vec2 uv = base * uAltoScale + uWind * uTime * 8.0;
            vec2 w = vec2(fbm2(uv * 0.15 + 3.1), fbm2(uv * 0.15 + 7.7)) - 0.5;
            vec2 u2 = uv + w * 2.2;
            float mask = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), uAltoMaskDir) * 0.5 + 0.5, 0.0), uAltoMaskSpread);
            float cov = fbm2(u2 * 0.085 + uAltoSeed);
            float th0 = mix(0.72, 0.3, uAltoCover * mask);
            float c = smoothstep(th0, th0 + 0.22, cov);
            vec2 jit = (vec2(vnoise(u2 * 3.1), vnoise(u2 * 3.1 + 9.0)) - 0.5) * 0.3 + (vec2(vnoise(u2 * 8.0), vnoise(u2 * 8.0 + 5.0)) - 0.5) * 0.08;
            vec4 A = cloudlets(u2 + jit, c, 0.0);
            vec4 B = cloudlets(u2 * 2.3 + jit * 2.0 + 13.0, c * 0.85, 17.0);
            B.x /= 2.3;
            vec4 C = A.x > B.x ? A : B;
            float fw = fwidth(C.x) + 1e-4;
            float a = smoothstep(0.0, fw * 1.5 + 0.035, C.x);
            vec3 n = normalize(vec3(C.yz * 0.75, C.w) + vec3((vnoise(u2 * 9.0) - 0.5) * 0.5, (vnoise(u2 * 9.0 + 4.0) - 0.5) * 0.5, 0.0));
            vec3 L = normalize(vec3(uSunDir.x, uSunDir.z, 0.45));
            float dl = dot(n, L);
            float lit = smoothstep(-0.1, 0.25, dl);
            vec3 cc = mix(uAltoShade, uAltoLit, lit);
            float thin = 1.0 - smoothstep(0.05, 0.55, C.w);
            float low = 1.0 - smoothstep(0.1, 0.55, e);
            float warm = thin * 0.65 * (0.3 + 0.7 * lit) + low * 0.45 + (1.0 - c) * 0.3;
            cc = mix(cc, uAltoWarm, clamp(warm, 0.0, 1.0) * 0.85);
            float fade = smoothstep(0.03, 0.25, e);
            col = mix(col, cc, a * uAlto * fade);
          }
          // cirrus
          if (uCirrus > 0.0) {
            vec3 cd = uCirrusDir;
            vec2 cuv = vec2(dot(base, normalize(cd.xz)), dot(base, vec2(-cd.z, cd.x)));
            cuv = cuv * vec2(0.6, 7.0) + vec2(uTime * 0.01, 0.0);
            float c = fbm2(cuv + fbm2(cuv * 0.5) * 1.5);
            float streak = smoothstep(0.6, 0.9, c) * smoothstep(0.05, 0.3, e);
            col = mix(col, uCirrusColor, streak * uCirrus);
          }
        }
        if (uMapAmt > 0.0 && d.z < -0.05) {
          vec2 p = vec2(uLens.y + uLens.x * d.x / -d.z, uLens.z - uLens.x * d.y / -d.z);
          vec2 span = uMapRect.yw - uMapRect.xz;
          vec2 cell = span / vec2(textureSize(uMap, 0));
          // warp the lookup with noise so the coarse layout breaks into painted shapes
          vec2 wp = p / 34.0;
          vec2 w1 = vec2(fbm2(wp * 0.6 + 1.3), fbm2(wp * 0.6 + 8.1)) - 0.5;
          vec2 w2 = vec2(vnoise(wp * 2.6 + 4.0), vnoise(wp * 2.6 + 9.0)) - 0.5;
          vec2 pw = p + (w1 * 2.4 + w2 * 0.9) * cell * uMapDetail;
          vec2 uv = (pw - uMapRect.xz) / span;
          vec3 B = texture2D(uMap, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
          // clouds are the warm / pale cells; sky is saturated blue
          float cloud = smoothstep(0.1, 0.45, B.r / max(B.b, 0.02));
          float N = fbm2(wp * 1.3 + w1 * 2.0);
          float n2 = fbm2(wp * 1.3 + w1 * 2.0 + vec2(0.18, 0.24));
          float litEdge = clamp((N - n2) * 6.0 + 0.5, 0.0, 1.0);
          float fine = fbm2(wp * 4.2 + w2 * 3.0);
          vec3 mapped = B * mix(1.0 + (N - 0.5) * 0.22 + (fine - 0.5) * 0.1,
                                0.74 + 0.5 * N + 0.3 * (litEdge - 0.5) + (fine - 0.5) * 0.28, cloud * uMapDetail);
          // inside the frame the layout wins; outside it fades to the gradient
          vec2 edge = min(uv, 1.0 - uv);
          float inside = smoothstep(-0.12, 0.04, min(edge.x, edge.y));
          col = mix(col, mapped, inside * uMapAmt);
        }
        if (uPatchCount > 0 && d.z < -0.05) {
          vec2 p = vec2(uLens.y + uLens.x * d.x / -d.z, uLens.z - uLens.x * d.y / -d.z);
          for (int i = 0; i < ${MAX_PATCHES}; i++) {
            if (i >= uPatchCount) break;
            col = paintPatch(col, p, i);
          }
        }
        gl_FragColor = vec4(col, uLineWeight);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/**
 * Cumulus billboard at infinity. The shape is a height field made from the
 * max of many spheres (billows): each billow gets its own rounded shading
 * and creases appear where they meet, which reads as a painted cumulus.
 */
export function createCumulus(o) {
  let dir;
  let w;
  let h;
  if (o.dir) {
    // explicit direction and tangent-plane half size
    dir = o.dir.clone().normalize();
    w = o.size.x;
    h = o.size.y;
    o.aspect = w / h;
    o.width = THREE.MathUtils.radToDeg(Math.atan(w) * 2);
  } else {
    const az = THREE.MathUtils.degToRad(o.azimuth); // 0 = straight ahead (-Z), + = right
    const el = THREE.MathUtils.degToRad(o.elevation); // elevation of billboard centre
    dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    w = Math.tan(THREE.MathUtils.degToRad(o.width / 2));
    h = w / (o.aspect ?? 2);
  }

  const uniforms = {
    uTime: shared.uTime,
    uDir: { value: dir },
    uSize: { value: new THREE.Vector2(w, h) },
    uAspect: { value: o.aspect ?? 2 },
    uSeed: { value: o.seed ?? 1 },
    uCount: { value: o.count ?? 30 },
    uLight: { value: (o.light ?? new THREE.Vector3(-0.4, 0.75, 0.5)).clone().normalize() },
    uLit: { value: color(o.lit ?? 0xffffff) },
    uShade: { value: color(o.shade ?? 0xa9bedf) },
    uDark: { value: color(o.dark ?? 0x7f98c6) },
    uRim: { value: color(o.rim ?? 0xffffff) },
    uWarm: { value: color(o.warm ?? 0xffffff) },
    uWarmAmt: { value: o.warmAmount ?? 0 },
    uHazeColor: { value: color(o.hazeColor ?? 0xbfd8f0) },
    uHaze: { value: o.haze ?? 0 },
    uOpacity: { value: o.opacity ?? 1 },
    uBase: { value: o.base ?? -0.55 },
    uFlat: { value: o.flat ?? 1 },
    uTop: { value: o.top ?? 1.25 },
    uSoft: { value: o.soft ?? 0.0 },
    uDrift: { value: o.drift ?? 0.0 },
  };

  const fragmentShader = /* glsl */ `
      uniform float uTime, uAspect, uSeed, uOpacity, uHaze, uBase, uFlat, uTop, uSoft, uWarmAmt;
      uniform int uCount;
      uniform vec3 uLight, uLit, uShade, uDark, uRim, uHazeColor, uWarm;
      varying vec2 vUv;
      ${NOISE_GLSL}

      void main() {
        vec2 p = vec2((vUv.x * 2.0 - 1.0) * uAspect, vUv.y * 2.0 - 1.0);
        vec2 w = vec2(fbm2(p * 2.2 + uSeed * 13.1 + uTime * 0.01),
                      fbm2(p * 2.2 + uSeed * 7.3 + 5.2 - uTime * 0.008)) - 0.5;
        vec2 q = p + w * 0.14;
        q += (vec2(vnoise(p * 9.0 + uSeed), vnoise(p * 9.0 + 4.0 - uSeed)) - 0.5) * 0.045;

        float best = -1e3;
        float second = -1e3;
        vec3 nb = vec3(0.0, 0.0, 1.0);
        float inside = -1e3;
        float bestY = 0.0;

        for (int i = 0; i < 96; i++) {
          if (i >= uCount) break;
          float fi = float(i);
          vec4 h = vec4(hash12(vec2(fi * 1.31, uSeed * 3.7)),
                        hash12(vec2(fi + 31.7, uSeed * 1.3)),
                        hash12(vec2(fi * 1.7 + 11.0, uSeed + 4.1)),
                        hash12(vec2(fi * 2.9 + 5.0, uSeed * 2.1 + 9.0)));
          float big = step(fi, 5.0);
          float x = (h.x * 2.0 - 1.0) * uAspect * mix(0.7, 0.5, big);
          float ex = clamp(abs(x) / (uAspect * 0.76), 0.0, 1.0);
          float env = pow(max(1.0 - ex * ex, 0.0), 0.6);
          float r = mix((0.085 + 0.19 * h.z) * (0.45 + 0.55 * env), (0.28 + 0.16 * h.z) * env * uTop, big);
          float y = uBase + r * mix(0.45, 0.85, big) + h.y * max(env * uTop * (0.6 + 0.4 * h.w) - r * 0.9, 0.0) * (1.0 - 0.75 * big);
          vec2 dlt = q - vec2(x, y);
          float dd = dot(dlt, dlt);
          float ins = r - sqrt(dd);
          inside = max(inside, ins);
          if (ins > 0.0) {
            float zz = sqrt(r * r - dd);
            float hgt = zz + (h.w * 0.2 - (y - uBase) * 0.16 - big * 0.12);
            if (hgt > best) {
              second = best;
              best = hgt;
              nb = vec3(dlt, zz) / r;
              bestY = y;
            } else if (hgt > second) {
              second = hgt;
            }
          }
        }

        // flat, slightly ragged base
        float baseLine = uBase + 0.06 * (fbm2(vec2(q.x * 3.0, uSeed)) - 0.5);
        float baseMask = mix(1.0, smoothstep(baseLine - 0.005, baseLine + 0.03, q.y), uFlat);

        float aa = fwidth(inside) * 1.3 + 0.002;
        float alpha = smoothstep(0.0, aa + uSoft, inside) * baseMask;
        if (alpha < 0.004) discard;

        // blend the billow normal with the normal of the whole cloud mass
        vec2 gp = vec2(q.x / (uAspect * 0.9), (q.y - uBase) / (uTop + 0.35) * 1.2 - 0.25);
        vec3 gN = normalize(vec3(gp, sqrt(max(0.08, 1.0 - dot(gp, gp)))));
        vec3 n = normalize(mix(gN, nb, 0.62));
        n.xy += (vec2(vnoise(q * 11.0 + uSeed), vnoise(q * 11.0 + 7.1 + uSeed)) - 0.5) * 0.45;
        n.xy += (vec2(vnoise(q * 31.0 + 3.3), vnoise(q * 31.0 + 1.9)) - 0.5) * 0.18;
        n = normalize(n);

        float dl = dot(n, uLight);
        float lit = smoothstep(0.2, 0.36, dl);
        float hi = smoothstep(0.6, 0.85, dl);
        vec3 col = mix(uShade, uLit, lit);
        col = mix(col, uLit * 1.06 + 0.02, hi * 0.6);

        float crease = smoothstep(0.0, 0.07, best - second);
        col *= mix(0.84, 1.0, crease);

        float low = 1.0 - smoothstep(uBase, uBase + 0.6, q.y);
        col = mix(col, uDark, low * 0.6 * (1.0 - 0.6 * lit));

        // warm light on the lit side (sunset tint)
        col = mix(col, uWarm, uWarmAmt * lit * (0.4 + 0.6 * (1.0 - n.z)));

        // bright silver lining on billows facing the light
        float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.5) * smoothstep(0.0, 0.6, dot(normalize(n.xy + 1e-4), normalize(uLight.xy + 1e-4)));
        col = mix(col, uRim, rim * 0.55);

        col = mix(col, uHazeColor, uHaze);
        float outA = alpha * uOpacity;
        gl_FragColor = vec4(col * outA, outA);
      }
`;

  // Procedural material, only used once to bake the cloud into a texture.
  const bakeMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uDir: uniforms.uDir,
      uSize: uniforms.uSize,
      uDrift: uniforms.uDrift,
      map: { value: null },
    },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      uniform vec3 uDir;
      uniform vec2 uSize;
      uniform float uTime, uDrift;
      varying vec2 vUv;
      ${AT_INFINITY}
      void main() {
        vUv = uv;
        float a = uTime * uDrift;
        vec3 dir0 = vec3(uDir.x * cos(a) - uDir.z * sin(a), uDir.y, uDir.x * sin(a) + uDir.z * cos(a));
        vec3 right = normalize(cross(dir0, vec3(0.0, 1.0, 0.0)));
        vec3 up = normalize(cross(right, dir0));
        vec3 dir = dir0 + right * position.x * uSize.x + up * position.y * uSize.y;
        gl_Position = skyClip(dir);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(map, vUv);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -900 + (o.order ?? 0);
  mesh.visible = false; // shown once baked
  mesh.userData.cumulus = { bakeMaterial, width: o.width, aspect: o.aspect ?? 2 };
  return mesh;
}

/**
 * Render every cumulus in a scene into its own texture once. The procedural
 * shader is far too heavy to run per frame on large, overlapping billboards.
 */
export function bakeClouds(renderer, scene, pxPerDegree = 22) {
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTarget = renderer.getRenderTarget();
  const maxSize = Math.min(2048, renderer.capabilities.maxTextureSize);
  scene.traverse((o) => {
    const info = o.userData.cumulus;
    if (!info || info.baked) return;
    const w = Math.min(maxSize, Math.max(128, Math.round(info.width * pxPerDegree)));
    const h = Math.max(64, Math.round(w / info.aspect));
    const target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    quad.material = info.bakeMaterial;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(quad, cam);
    o.material.uniforms.map.value = target.texture;
    info.bakeMaterial.dispose();
    info.baked = true;
    o.visible = true;
  });
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(0x000000, 1);
  quad.geometry.dispose();
}

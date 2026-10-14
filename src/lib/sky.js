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
  };

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

      void main() {
        vec3 d = normalize(vDir);
        float e = d.y;

        // base gradient
        float tm = smoothstep(0.0, uMidHeight, e);
        float tz = smoothstep(uMidHeight * 0.6, 1.0, e);
        vec3 col = mix(uHorizon, uMid, pow(tm, 0.7));
        col = mix(col, uZenith, tz);
        col = mix(col, uGround, smoothstep(0.0, -0.06, e));

        // painted, watercolour-like variation
        vec2 pp = d.xz / (abs(e) + 0.35);
        float pv = fbm2(pp * 1.7 + 4.0);
        float pv2 = fbm2(pp * 6.0 - 2.0);
        col *= 1.0 + uPaint * ((pv - 0.5) * 1.2 + (pv2 - 0.5) * 0.4);

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
        gl_FragColor = vec4(col, 1.0);
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
  const az = THREE.MathUtils.degToRad(o.azimuth); // 0 = straight ahead (-Z), + = right
  const el = THREE.MathUtils.degToRad(o.elevation); // elevation of billboard centre
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  const w = Math.tan(THREE.MathUtils.degToRad(o.width / 2));
  const h = w / (o.aspect ?? 2);

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

        for (int i = 0; i < 64; i++) {
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

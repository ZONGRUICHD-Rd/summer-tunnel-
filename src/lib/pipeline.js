import * as THREE from 'three';
import { NOISE_GLSL } from './glsl.js';
import { paperTexture } from './textures.js';

class FullScreenQuad {
  constructor(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(renderer, material) {
    this.mesh.material = material;
    renderer.render(this.mesh, this.camera);
  }
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function rt(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    ...opts,
  });
}

export const DEFAULT_POST = {
  outline: 0.75,
  lineColor: new THREE.Color(0.18, 0.2, 0.32),
  lineNear: 0.0,
  lineFar: 160,
  lineThreshold: 0.035,
  creaseThreshold: 0.25,
  bloom: 0.35,
  bloomThreshold: 0.85,
  exposure: 1.0,
  saturation: 1.12,
  contrast: 1.05,
  lift: new THREE.Color(0, 0, 0),
  gain: new THREE.Color(1, 1, 1),
  vignette: 0.25,
  vignetteColor: new THREE.Color(0.05, 0.08, 0.2),
  paper: 0.035,
  paint: 0, // Kuwahara radius in px (0 = off)
  colorEdge: 0, // strength of ink lines between colour patches
  colorEdgeThreshold: 0.07,
  toneMap: true,
};

/**
 * Scene -> MSAA HDR target -> bloom chain -> composite (ink outlines from
 * the depth buffer, tone mapping, grading, vignette, paper grain).
 */
export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.quad = new FullScreenQuad(null);
    this.width = 1;
    this.height = 1;

    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture,
    });
    this.bloomRT = [rt(1, 1), rt(1, 1), rt(1, 1)];
    this.tmpRT = [rt(1, 1), rt(1, 1), rt(1, 1)];
    this.prevRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.paintRT = rt(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.paintRadius = 0;

    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, uThreshold: { value: 0.8 } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform float uThreshold;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tColor, vUv).rgb;
          float l = max(c.r, max(c.g, c.b));
          float knee = 0.25;
          float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
          soft = soft * soft / (4.0 * knee + 1e-4);
          float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
          gl_FragColor = vec4(c * contrib, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform vec2 uDir;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tColor, vUv).rgb * 0.2270270270;
          c += texture2D(tColor, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
          c += texture2D(tColor, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
          c += texture2D(tColor, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
          c += texture2D(tColor, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0); }
      `,
      depthTest: false,
      depthWrite: false,
    });

    // Kuwahara filter: flattens surfaces into painted patches, keeps edges
    this.paintMat = new THREE.ShaderMaterial({
      defines: { RADIUS: 3 },
      uniforms: { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
          vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
          for (int j = -RADIUS; j <= RADIUS; j++) {
            for (int i = -RADIUS; i <= RADIUS; i++) {
              vec3 c = sqrt(max(texture2D(tColor, vUv + vec2(float(i), float(j)) * uTexel).rgb, vec3(0.0)));
              vec3 cc = c * c;
              if (i <= 0 && j <= 0) { m0 += c; s0 += cc; }
              if (i >= 0 && j <= 0) { m1 += c; s1 += cc; }
              if (i <= 0 && j >= 0) { m2 += c; s2 += cc; }
              if (i >= 0 && j >= 0) { m3 += c; s3 += cc; }
            }
          }
          float n = float((RADIUS + 1) * (RADIUS + 1));
          m0 /= n; m1 /= n; m2 /= n; m3 /= n;
          vec3 v0 = s0 / n - m0 * m0;
          vec3 v1 = s1 / n - m1 * m1;
          vec3 v2 = s2 / n - m2 * m2;
          vec3 v3 = s3 / n - m3 * m3;
          float a0 = v0.r + v0.g + v0.b;
          float a1 = v1.r + v1.g + v1.b;
          float a2 = v2.r + v2.g + v2.b;
          float a3 = v3.r + v3.g + v3.b;
          vec3 best = m0;
          float bv = a0;
          if (a1 < bv) { bv = a1; best = m1; }
          if (a2 < bv) { bv = a2; best = m2; }
          if (a3 < bv) { bv = a3; best = m3; }
          gl_FragColor = vec4(best * best, texture2D(tColor, vUv).a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    const p = DEFAULT_POST;
    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tBloom0: { value: null },
        tBloom1: { value: null },
        tBloom2: { value: null },
        tPaper: { value: paperTexture() },
        tPrev: { value: this.prevRT.texture },
        uTexel: { value: new THREE.Vector2() },
        uResolution: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uOutline: { value: p.outline },
        uLineColor: { value: p.lineColor.clone() },
        uLineFar: { value: p.lineFar },
        uLineThreshold: { value: p.lineThreshold },
        uCreaseThreshold: { value: p.creaseThreshold },
        uBloom: { value: p.bloom },
        uExposure: { value: p.exposure },
        uSaturation: { value: p.saturation },
        uContrast: { value: p.contrast },
        uLift: { value: p.lift.clone() },
        uGain: { value: p.gain.clone() },
        uVignette: { value: p.vignette },
        uVignetteColor: { value: p.vignetteColor.clone() },
        uPaper: { value: p.paper },
        uColorEdge: { value: 0 },
        uToneMap: { value: 1 },
        uColorEdgeTh: { value: p.colorEdgeThreshold },
        uEdgeScale: { value: 1 },
        uTransition: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor, tDepth, tBloom0, tBloom1, tBloom2, tPaper, tPrev;
        uniform vec2 uTexel, uResolution;
        uniform float uNear, uFar, uOutline, uLineFar, uLineThreshold, uCreaseThreshold;
        uniform vec3 uLineColor;
        uniform float uBloom, uExposure, uSaturation, uContrast, uVignette, uPaper, uTransition, uTime;
        uniform float uColorEdge, uColorEdgeTh, uEdgeScale, uToneMap;
        uniform vec3 uLift, uGain, uVignetteColor;
        varying vec2 vUv;
        ${NOISE_GLSL}

        float linDepth(vec2 uv) {
          float d = texture2D(tDepth, uv).r;
          float z = d * 2.0 - 1.0;
          return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
        }

        vec3 neutral(vec3 color) {
          const float startCompression = 0.8 - 0.04;
          const float desaturation = 0.15;
          // (the PBR-neutral toe is left out: it crushes painted shadows)
          float peak = max(color.r, max(color.g, color.b));
          if (peak < startCompression) return color;
          const float d = 1.0 - startCompression;
          float newPeak = 1.0 - d * d / (peak + d - startCompression);
          color *= newPeak / peak;
          float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
          return mix(color, vec3(newPeak), g);
        }

        vec3 toSRGB(vec3 c) {
          c = max(c, vec3(0.0));
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
        }

        float edgeAt(vec2 uv) {
          vec2 o = uTexel;
          float dc = linDepth(uv);
          float dl = linDepth(uv - vec2(o.x, 0.0));
          float dr = linDepth(uv + vec2(o.x, 0.0));
          float du = linDepth(uv + vec2(0.0, o.y));
          float dd = linDepth(uv - vec2(0.0, o.y));
          float dmin = min(dc, min(min(dl, dr), min(du, dd)));
          // 1/z is affine across a plane in screen space, so its laplacian is
          // ~0 on flat surfaces (even at grazing angles) and spikes at both
          // folds and silhouettes. Normalised it is independent of depth.
          float ic = 1.0 / dc;
          float lap = abs(1.0 / dl + 1.0 / dr - 2.0 * ic) + abs(1.0 / du + 1.0 / dd - 2.0 * ic);
          float rel = lap / ic * uResolution.y * 0.5;
          float crease = smoothstep(uCreaseThreshold, uCreaseThreshold * 2.5, rel);
          float sil = smoothstep(uLineThreshold, uLineThreshold * 3.0, rel / (uResolution.y * 0.5));
          float e = max(crease * 0.85, sil);
          float fade = 1.0 - smoothstep(uLineFar * 0.4, uLineFar, dmin);
          // per-material line weight stored in alpha (grass etc. opt out)
          float w = texture2D(tColor, uv).a;
          w = min(w, texture2D(tColor, uv - vec2(o.x, 0.0)).a);
          w = min(w, texture2D(tColor, uv + vec2(o.x, 0.0)).a);
          w = min(w, texture2D(tColor, uv + vec2(0.0, o.y)).a);
          w = min(w, texture2D(tColor, uv - vec2(0.0, o.y)).a);
          return e * fade * clamp(w, 0.0, 1.0);
        }

        void main() {
          vec3 col = texture2D(tColor, vUv).rgb;

          // ink lines from depth
          float edge = edgeAt(vUv) * uOutline;
          // ink lines around colour patches (painted look)
          if (uColorEdge > 0.0) {
            vec2 o = uTexel * uEdgeScale;
            vec3 W = vec3(0.2126, 0.7152, 0.0722);
            float tl = sqrt(dot(texture2D(tColor, vUv + vec2(-o.x, o.y)).rgb, W));
            float tc = sqrt(dot(texture2D(tColor, vUv + vec2(0.0, o.y)).rgb, W));
            float tr = sqrt(dot(texture2D(tColor, vUv + vec2(o.x, o.y)).rgb, W));
            float ml = sqrt(dot(texture2D(tColor, vUv + vec2(-o.x, 0.0)).rgb, W));
            float mr = sqrt(dot(texture2D(tColor, vUv + vec2(o.x, 0.0)).rgb, W));
            float bl = sqrt(dot(texture2D(tColor, vUv + vec2(-o.x, -o.y)).rgb, W));
            float bc = sqrt(dot(texture2D(tColor, vUv + vec2(0.0, -o.y)).rgb, W));
            float br = sqrt(dot(texture2D(tColor, vUv + vec2(o.x, -o.y)).rgb, W));
            float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
            float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
            float g = sqrt(gx * gx + gy * gy);
            float lum = sqrt(dot(col, W));
            // only darken the darker side of a boundary, so lines stay thin
            float dark = step(lum, (tl + tc + tr + ml + mr + bl + bc + br) / 8.0 + 0.002);
            float ce = smoothstep(uColorEdgeTh, uColorEdgeTh * 2.2, g) * mix(0.35, 1.0, dark);
            float w = texture2D(tColor, vUv).a;
            edge = max(edge, ce * uColorEdge * clamp(w * 1.15, 0.0, 1.0));
          }
          col = mix(col, col * uLineColor, edge);

          // bloom
          vec3 bloom = texture2D(tBloom0, vUv).rgb * 0.6 + texture2D(tBloom1, vUv).rgb * 0.8 + texture2D(tBloom2, vUv).rgb * 1.0;
          col += bloom * uBloom;

          col *= uExposure;
          col = uToneMap > 0.5 ? neutral(col) : min(col, vec3(1.0));
          col = toSRGB(col);

          // grading in display space
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, uSaturation);
          col = (col - 0.5) * uContrast + 0.5;
          col = col * uGain + uLift * (1.0 - col);

          // vignette
          vec2 vc = vUv - 0.5;
          float v = smoothstep(0.25, 0.95, length(vc * vec2(1.0, 0.85)) * 1.25);
          col = mix(col, col * uVignetteColor * 3.0, v * uVignette);

          // paper grain + dither
          vec2 puv = vUv * uResolution / 256.0;
          float paper = texture2D(tPaper, puv).r - 0.5;
          col += paper * uPaper;
          col += (hash12(vUv * uResolution + fract(uTime) * 61.0) - 0.5) / 255.0;

          // painted dissolve between scenes
          if (uTransition < 1.0) {
            vec3 prev = texture2D(tPrev, vUv).rgb;
            float n = fbm2(vUv * vec2(uResolution.x / uResolution.y, 1.0) * 4.0) * 0.8 + vUv.x * 0.2;
            float t = uTransition * 1.3 - 0.15;
            float m = smoothstep(n - 0.08, n + 0.08, t);
            col = mix(prev, col, m);
          }

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  setSize(w, h) {
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    for (let i = 0; i < 3; i++) {
      const s = 1 << i;
      this.bloomRT[i].setSize(Math.max(1, (hw / s) | 0), Math.max(1, (hh / s) | 0));
      this.tmpRT[i].setSize(Math.max(1, (hw / s) | 0), Math.max(1, (hh / s) | 0));
    }
    this.prevRT.setSize(w, h);
    this.paintRT.setSize(w, h);
    this.paintMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    const u = this.compositeMat.uniforms;
    u.uEdgeScale.value = Math.max(1, h / 1100);
    u.uTexel.value.set(1 / w, 1 / h);
    u.uResolution.value.set(w, h);
  }

  applyPost(post) {
    const u = this.compositeMat.uniforms;
    const p = { ...DEFAULT_POST, ...post };
    u.uOutline.value = p.outline;
    u.uLineColor.value.copy(p.lineColor);
    u.uLineFar.value = p.lineFar;
    u.uLineThreshold.value = p.lineThreshold;
    u.uCreaseThreshold.value = p.creaseThreshold;
    u.uBloom.value = p.bloom;
    u.uExposure.value = p.exposure;
    u.uSaturation.value = p.saturation;
    u.uContrast.value = p.contrast;
    u.uLift.value.copy(p.lift);
    u.uGain.value.copy(p.gain);
    u.uVignette.value = p.vignette;
    u.uVignetteColor.value.copy(p.vignetteColor);
    u.uPaper.value = p.paper;
    u.uColorEdge.value = p.colorEdge;
    u.uToneMap.value = p.toneMap ? 1 : 0;
    u.uColorEdgeTh.value = p.colorEdgeThreshold;
    this.paintRadius = p.paint;
    if (p.paint > 0 && this.paintMat.defines.RADIUS !== p.paint) {
      this.paintMat.defines.RADIUS = p.paint;
      this.paintMat.needsUpdate = true;
    }
    this.brightMat.uniforms.uThreshold.value = p.bloomThreshold;
  }

  /** Render a scene; pass toPrev=true to capture the frame for a transition. */
  render(scene, camera, { time = 0, toPrev = false } = {}) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    // bloom chain
    this.brightMat.uniforms.tColor.value = this.sceneRT.texture;
    r.setRenderTarget(this.bloomRT[0]);
    this.quad.render(r, this.brightMat);
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        this.copyMat.uniforms.tColor.value = this.bloomRT[i - 1].texture;
        r.setRenderTarget(this.bloomRT[i]);
        this.quad.render(r, this.copyMat);
      }
      const w = this.bloomRT[i].width;
      const h = this.bloomRT[i].height;
      this.blurMat.uniforms.tColor.value = this.bloomRT[i].texture;
      this.blurMat.uniforms.uDir.value.set(1 / w, 0);
      r.setRenderTarget(this.tmpRT[i]);
      this.quad.render(r, this.blurMat);
      this.blurMat.uniforms.tColor.value = this.tmpRT[i].texture;
      this.blurMat.uniforms.uDir.value.set(0, 1 / h);
      r.setRenderTarget(this.bloomRT[i]);
      this.quad.render(r, this.blurMat);
    }

    const u = this.compositeMat.uniforms;
    u.tColor.value = this.sceneRT.texture;
    if (this.paintRadius > 0) {
      this.paintMat.uniforms.tColor.value = this.sceneRT.texture;
      r.setRenderTarget(this.paintRT);
      this.quad.render(r, this.paintMat);
      u.tColor.value = this.paintRT.texture;
    }
    u.tDepth.value = this.sceneRT.depthTexture;
    u.tBloom0.value = this.bloomRT[0].texture;
    u.tBloom1.value = this.bloomRT[1].texture;
    u.tBloom2.value = this.bloomRT[2].texture;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uTime.value = time;

    if (toPrev) {
      // freeze this frame for the dissolve; never sample the target we draw into
      const t = u.uTransition.value;
      u.uTransition.value = 1;
      u.tPrev.value = null;
      r.setRenderTarget(this.prevRT);
      this.quad.render(r, this.compositeMat);
      u.tPrev.value = this.prevRT.texture;
      u.uTransition.value = t;
    }
    r.setRenderTarget(null);
    this.quad.render(r, this.compositeMat);
  }

  set transition(v) {
    this.compositeMat.uniforms.uTransition.value = v;
  }
}

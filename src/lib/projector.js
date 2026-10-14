import * as THREE from 'three';

/**
 * Camera projection mapping (the matte-painting technique): a painting is
 * projected onto the 3D scene from the camera it was painted from. Seen from
 * that viewpoint the scene reproduces the painting exactly, while looking
 * around keeps it locked to the geometry. A depth map rendered from the
 * projector stops the paint from leaking onto surfaces the painting cannot
 * see (they keep their own procedural shading), which matters in free view.
 */
export class Projector {
  constructor({ width, height, lens, eye, near = 0.05, far = 6000 }) {
    this.camera = new THREE.PerspectiveCamera();
    this.camera.position.set(0, eye, 0);
    this.camera.updateMatrixWorld();
    const n = near;
    const { F, px, py } = lens;
    this.camera.projectionMatrix.makePerspective((n * -px) / F, (n * (width - px)) / F, (n * py) / F, (n * (py - height)) / F, n, far);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.near = near;
    this.far = far;
    this.depthTarget = new THREE.WebGLRenderTarget(width, height, { depthTexture: new THREE.DepthTexture(width, height, THREE.FloatType) });
    this.uniforms = {
      uProjMap: { value: null },
      uProjDepth: { value: null },
      uProjMatrix: { value: new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse) },
      uProjAmount: { value: 0 },
      uProjNearFar: { value: new THREE.Vector2(near, far) },
      uProjEdge: { value: new THREE.Vector2(2 / width, 2 / height) },
    };
  }

  load(url) {
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      this.uniforms.uProjMap.value = tex;
      this.uniforms.uProjAmount.value = 1;
    });
  }

  /** Render what the projector camera sees into its depth map. */
  renderDepth(renderer, scene) {
    const keep = this.uniforms.uProjDepth.value;
    this.uniforms.uProjDepth.value = null;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear();
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prev);
    this.uniforms.uProjDepth.value = keep ?? this.depthTarget.depthTexture;
  }
}

/** GLSL: returns (painting colour, weight) for a world position or direction (w = 0). */
export const PROJECTOR_GLSL = /* glsl */ `
  uniform sampler2D uProjMap;
  uniform sampler2D uProjDepth;
  uniform mat4 uProjMatrix;
  uniform float uProjAmount;
  uniform vec2 uProjNearFar;
  uniform vec2 uProjEdge;
  float projLinear(float d) {
    float z = d * 2.0 - 1.0;
    return 2.0 * uProjNearFar.x * uProjNearFar.y / (uProjNearFar.y + uProjNearFar.x - z * (uProjNearFar.y - uProjNearFar.x));
  }
  vec4 projectPainting(vec4 wp) {
    if (uProjAmount <= 0.0) return vec4(0.0);
    vec4 clip = uProjMatrix * wp;
    if (clip.w <= 0.0) return vec4(0.0);
    vec3 ndc = clip.xyz / clip.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    vec2 e = min(uv, 1.0 - uv);
    if (min(e.x, e.y) <= 0.0) return vec4(0.0);
    float fade = smoothstep(0.0, 1.0, min(e.x / uProjEdge.x, e.y / uProjEdge.y));
    float seen = projLinear(texture2D(uProjDepth, uv).r);
    float mine = wp.w > 0.5 ? clip.w : uProjNearFar.y;
    // visible from the projector if nothing nearer covers this point
    float vis = 1.0 - smoothstep(0.02, 0.06, (mine - seen) / max(seen, 0.5));
    return vec4(texture2D(uProjMap, uv).rgb, fade * vis * uProjAmount);
  }
`;

/** Patch a built-in material (toon / basic) so it shows the projected painting. */
export function addProjector(material, projector) {
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prevCompile?.call(material, shader, renderer);
    Object.assign(shader.uniforms, projector.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vProjW;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 pW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          pW = instanceMatrix * pW;
        #endif
        vProjW = (modelMatrix * pW).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `varying vec3 vProjW;\n${PROJECTOR_GLSL}\nvoid main() {`)
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        vec4 painted = projectPainting(vec4(vProjW, 1.0));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, painted.rgb, painted.a);`
      );
  };
  material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|proj';
  material.needsUpdate = true;
}

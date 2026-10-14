import * as THREE from 'three';
import { NOISE_GLSL } from './glsl.js';

// Uniforms shared by every animated material.
export const shared = {
  uTime: { value: 0 },
};

/**
 * Anime-style two-tone material built on MeshToonMaterial.
 * The default gradient lookup is replaced by a smooth ramp so the
 * terminator stays crisp but anti-aliased. Optional extras:
 *  - foliage: perturbs normals with 3D noise for leafy, mottled lighting
 *  - wind:    sways vertices with height (expects geometry rooted at y=0)
 */
export function toon(opts = {}) {
  const {
    color = 0xffffff,
    map = null,
    alphaMap = null,
    vertexColors = false,
    side = THREE.FrontSide,
    alphaTest = 0,
    transparent = false,
    opacity = 1,
    emissive = 0x000000,
    ramp = [0.47, 0.55],
    shadowFloor = 0.0,
    litFloor = 0.82,
    foliage = 0,
    foliageScale = 1.5,
    wind = 0,
    fog = true,
    lineWeight = 1,
  } = opts;

  const mat = new THREE.MeshToonMaterial({
    color,
    map,
    alphaMap,
    vertexColors,
    side,
    alphaTest,
    transparent,
    opacity,
    emissive,
    fog,
  });

  const uniforms = {
    uRamp: { value: new THREE.Vector2(ramp[0], ramp[1]) },
    uFloors: { value: new THREE.Vector2(shadowFloor, litFloor) },
    uFoliage: { value: foliage },
    uFoliageScale: { value: foliageScale },
    uWind: { value: wind },
    uLineWeight: { value: lineWeight },
  };
  mat.userData.uniforms = uniforms;

  const key = `toon-${foliage > 0 ? 'f' : ''}${wind > 0 ? 'w' : ''}${lineWeight < 1 ? 'l' : ''}`;
  mat.customProgramCacheKey = () => key;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    Object.assign(shader.uniforms, uniforms);

    const defines = [];
    if (foliage > 0) defines.push('#define USE_FOLIAGE');
    if (wind > 0) defines.push('#define USE_WIND');
    if (lineWeight < 1) defines.push('#define USE_LINEWEIGHT');
    const head = defines.join('\n') + '\n';

    shader.vertexShader =
      head +
      `uniform float uTime;\nuniform float uWind;\nvarying vec3 vWPos;\n` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        #ifdef USE_WIND
          vec3 wOrig;
          #ifdef USE_INSTANCING
            wOrig = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #else
            wOrig = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #endif
          float wh = max(position.y, 0.0);
          float gust = 0.6 + 0.4 * sin(uTime * 0.45 + wOrig.x * 0.05);
          transformed.x += sin(uTime * 1.9 + wOrig.x * 0.37 + wOrig.z * 0.23) * uWind * wh * wh * gust;
          transformed.z += cos(uTime * 1.4 + wOrig.x * 0.29 + wOrig.z * 0.31) * uWind * 0.5 * wh * wh * gust;
        #endif
        `
      ).replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        vec4 myWP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          myWP = instanceMatrix * myWP;
        #endif
        vWPos = (modelMatrix * myWP).xyz;
        `
      );

    shader.fragmentShader =
      head +
      `uniform vec2 uRamp;\nuniform vec2 uFloors;\nuniform float uFoliage;\nuniform float uFoliageScale;\nuniform float uLineWeight;\nvarying vec3 vWPos;\n` +
      NOISE_GLSL +
      shader.fragmentShader
        .replace(
          '#include <gradientmap_pars_fragment>',
          /* glsl */ `
          vec3 getGradientIrradiance(vec3 normal, vec3 lightDirection) {
            float x = dot(normal, lightDirection) * 0.5 + 0.5;
            float lit = smoothstep(uRamp.x, uRamp.y, x);
            float tone = mix(uFloors.x * x * 2.0, mix(uFloors.y, 1.0, smoothstep(uRamp.y, 1.0, x)), lit);
            return vec3(tone);
          }`
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `#include <normal_fragment_maps>
          #ifdef USE_FOLIAGE
            vec3 fp = vWPos * uFoliageScale;
            vec3 nn = vec3(vnoise3(fp), vnoise3(fp + 17.3), vnoise3(fp + 41.7)) - 0.5;
            nn += 0.5 * (vec3(vnoise3(fp * 2.7 + 3.1), vnoise3(fp * 2.7 + 9.4), vnoise3(fp * 2.7 + 23.9)) - 0.5);
            normal = normalize(normal + (viewMatrix * vec4(nn, 0.0)).xyz * uFoliage);
          #endif
          `
        )
        .replace(
          '#include <dithering_fragment>',
          /* glsl */ `#include <dithering_fragment>
          #ifdef USE_LINEWEIGHT
            // alpha carries the ink-line weight for the composite pass
            gl_FragColor.a = uLineWeight;
          #endif
          `
        );
  };

  return mat;
}

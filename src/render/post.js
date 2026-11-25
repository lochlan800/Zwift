import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, Effect, EffectAttribute, BlendFunction,
  BloomEffect, SMAAEffect, SMAAPreset, FXAAEffect, GodRaysEffect, KernelSize,
} from 'postprocessing';
import { sunDirection } from '../world/sky.js';

// ---------------------------------------------------------------------------------------------
// AO: depth-only screen-space ambient occlusion (Alchemy/HBAO-lite). No normal pass (that would
// re-render the whole scene); the normal is rebuilt from depth derivatives. N taps/pixel with a
// per-pixel rotated spiral, range-limited so it only gives contact shading (walls/ground, hedges,
// kerbs, under eaves) and fades out with distance.
// GPU cost: one full-res fullscreen shader, N depth fetches. High: 10 taps, Medium: 6. Off on Low.
// ---------------------------------------------------------------------------------------------
class AOEffect extends Effect {
  constructor(camera, samples) {
    super('AOEffect', /* glsl */`
      uniform vec2 uProj;
      uniform float uRadius;
      uniform float uStrength;
      uniform vec2 uFade;
      float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
      vec3 vpos(vec2 uv, float d) {
        float vz = perspectiveDepthToViewZ(d, cameraNear, cameraFar);
        vec2 n = uv * 2.0 - 1.0;
        return vec3(n.x * (-vz) / uProj.x, n.y * (-vz) / uProj.y, vz);
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
        outputColor = inputColor;
        if (depth > 0.99995) return;
        vec3 P = vpos(uv, depth);
        float dist = -P.z;
        if (dist > uFade.y) return;
        vec3 N = normalize(cross(dFdx(P), dFdy(P)));
        float rpx = clamp(uRadius * uProj.y / dist * 0.5 * resolution.y, 3.0, 70.0);
        vec2 ruv = rpx * texelSize;
        float rot = ign(gl_FragCoord.xy) * 6.2831853;
        float R2 = uRadius * uRadius * 1.6;
        float occ = 0.0;
        for (int i = 0; i < AO_SAMPLES; i++) {
          float fi = (float(i) + 0.5) / float(AO_SAMPLES);
          float a = rot + float(i) * 2.399963;
          vec2 suv = uv + vec2(cos(a), sin(a)) * sqrt(fi) * ruv;
          float sd = texture2D(depthBuffer, suv).x;
          if (sd > 0.99995) continue;
          vec3 v = vpos(suv, sd) - P;
          float l2 = dot(v, v);
          float ndv = dot(N, v) * inversesqrt(l2 + 1e-4);
          occ += max(ndv - 0.10, 0.0) * (1.0 - clamp(l2 / R2, 0.0, 1.0));
        }
        float ao = 1.0 - uStrength * occ / float(AO_SAMPLES) * 2.0;
        ao = mix(clamp(ao, 0.35, 1.0), 1.0, smoothstep(uFade.x, uFade.y, dist));
        outputColor.rgb = inputColor.rgb * ao;
      }`, {
      attributes: EffectAttribute.DEPTH,
      defines: new Map([['AO_SAMPLES', String(samples)]]),
      uniforms: new Map([
        ['uProj', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['uRadius', new THREE.Uniform(1.3)],
        ['uStrength', new THREE.Uniform(0.85)],
        ['uFade', new THREE.Uniform(new THREE.Vector2(55, 150))],
      ]),
    });
    this.camera = camera;
  }
  update() {
    const e = this.camera.projectionMatrix.elements;
    this.uniforms.get('uProj').value.set(e[0], e[5]);
  }
}

// ---------------------------------------------------------------------------------------------
// Grade: exposure + Khronos "PBR Neutral" tone mapping (keeps hues clean and bright, no ACES
// desaturation) + a filmic-ish grade done in gamma space: gentle S-curve, warm lifted blacks,
// cool shadows / warm highlights split-tone, vibrance with extra push on greens, soft vignette,
// and a tiny dither to kill banding in the sky gradient. ~30 ALU, merged into the single main pass.
// ---------------------------------------------------------------------------------------------
class GradeEffect extends Effect {
  constructor(opts = {}) {
    super('GradeEffect', /* glsl */`
      uniform float uExposure;
      uniform float uContrast;
      uniform float uSat;
      uniform float uVig;
      vec3 neutralTM(vec3 c) {
        const float startC = 0.76, desat = 0.15;
        float x = min(c.r, min(c.g, c.b));
        float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
        c -= off;
        float peak = max(c.r, max(c.g, c.b));
        if (peak < startC) return c;
        float d = 1.0 - startC;
        float np = 1.0 - d * d / (peak + d - startC);
        c *= np / peak;
        float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
        return mix(c, vec3(np), g);
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = neutralTM(max(inputColor.rgb, 0.0) * uExposure);
        vec3 g = pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
        // S-curve
        g = mix(g, g * g * (3.0 - 2.0 * g), uContrast);
        float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
        // lifted warm blacks, cool shadows, warm highlights
        g = vec3(0.028, 0.026, 0.026) + g * (1.0 - vec3(0.028, 0.026, 0.026));
        g += vec3(-0.006, 0.0, 0.014) * (1.0 - l) * (1.0 - l);
        g += vec3(0.014, 0.007, -0.012) * l * l;
        // vibrance: boost low-saturation pixels more, greens a bit more again
        float mx = max(g.r, max(g.g, g.b)), mn = min(g.r, min(g.g, g.b));
        float s = (mx - mn) / (mx + 1e-4);
        float greenW = clamp((g.g - max(g.r, g.b)) * 5.0, 0.0, 1.0);
        float k = uSat * (1.0 + (1.0 - s) * 0.25) + greenW * 0.14;
        float lum = dot(g, vec3(0.2126, 0.7152, 0.0722));
        g = max(mix(vec3(lum), g, k), 0.0);
        // vignette
        vec2 q = uv - 0.5;
        q.x *= resolution.x / resolution.y * 0.55 + 0.45;
        g *= 1.0 - uVig * smoothstep(0.30, 0.95, length(q) * 1.25);
        // dither
        float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        g += (n - 0.5) / 255.0;
        outputColor = vec4(pow(clamp(g, 0.0, 1.0), vec3(2.2)), inputColor.a);
      }`, {
      uniforms: new Map([
        ['uExposure', new THREE.Uniform(opts.exposure ?? 1.1)],
        ['uContrast', new THREE.Uniform(opts.contrast ?? 0.2)],
        ['uSat', new THREE.Uniform(opts.sat ?? 1.18)],
        ['uVig', new THREE.Uniform(opts.vignette ?? 0.2)],
      ]),
    });
  }
  set exposure(v) { this.uniforms.get('uExposure').value = v; }
  get exposure() { return this.uniforms.get('uExposure').value; }
}

export function createPost(renderer, scene, camera, cfg) {
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: cfg.msaa || 0 });
  composer.addPass(new RenderPass(scene, camera));

  const effects = [];
  let ao = null;
  if (cfg.ao) { ao = new AOEffect(camera, cfg.ao); effects.push(ao); }

  // Bloom on HDR highlights only (sun disc, specular glints, windows catching the sun): threshold is in
  // scene-linear units, well above normal sunlit surfaces. mipmapBlur = ~2*levels small passes.
  // Medium 4 levels / High 6; Off on Low. ADD blend because screen-blend misbehaves on HDR input.
  let bloom = null;
  if (cfg.bloom) {
    bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD, intensity: cfg.tier === 'high' ? 0.45 : 0.35,
      luminanceThreshold: 3.4, luminanceSmoothing: 0.6, mipmapBlur: true, radius: 0.55, levels: cfg.tier === 'high' ? 6 : 4,
    });
    effects.push(bloom);
  }

  // Sun light shafts (high tier only): a small emissive mesh at the sun position, occluded by scene depth,
  // radial-blurred at 1/2 res. Cost: light-mask render + copy + blur + 40-tap radial pass at half res.
  let godrays = null, sunMesh = null;
  if (cfg.godrays) {
    sunMesh = new THREE.Mesh(new THREE.SphereGeometry(110, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.85, 0.6), transparent: true, fog: false }));
    sunMesh.frustumCulled = false;
    godrays = new GodRaysEffect(camera, sunMesh, {
      blendFunction: BlendFunction.ADD, samples: 40, density: 0.93, decay: 0.93, weight: 0.32, exposure: 0.5, clampMax: 0.7,
      resolutionScale: 0.4, kernelSize: KernelSize.SMALL, blur: true,
    });
    effects.push(godrays);
  }

  const tone = new GradeEffect({ exposure: 1.1 });
  effects.push(tone);
  composer.addPass(new EffectPass(camera, ...effects));

  // AA: SMAA on medium/high; FXAA (single cheap pass) on low.
  if (cfg.smaa) composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: cfg.mobile ? SMAAPreset.MEDIUM : SMAAPreset.HIGH })));
  else if (cfg.fxaa) composer.addPass(new EffectPass(camera, new FXAAEffect()));

  if (sunMesh) {
    const sd = sunDirection().multiplyScalar(4200);
    const render = composer.render.bind(composer);
    composer.render = (dt) => { sunMesh.position.copy(camera.position).add(sd); sunMesh.updateMatrixWorld(true); render(dt); };
  }
  return { composer, bloom, tone, ao, godrays };
}

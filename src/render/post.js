import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect, BrightnessContrastEffect, HueSaturationEffect,
} from 'postprocessing';

export function createPost(renderer, scene, camera, cfg) {
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: cfg.msaa || 0 });
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new BloomEffect({ intensity: 0.55, luminanceThreshold: 1.0, luminanceSmoothing: 0.35, mipmapBlur: true, radius: 0.7, levels: cfg.mobile ? 5 : 7 });
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const grade = new HueSaturationEffect({ saturation: 0.16 });
  const contrast = new BrightnessContrastEffect({ contrast: 0.07 });
  const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.5 });
  const effects = cfg.bloom ? [bloom, tone, grade, contrast, vignette] : [tone, grade, contrast, vignette];
  composer.addPass(new EffectPass(camera, ...effects));
  let smaaPass = null;
  if (cfg.smaa) {
    smaaPass = new EffectPass(camera, new SMAAEffect({ preset: cfg.mobile ? SMAAPreset.MEDIUM : SMAAPreset.HIGH }));
    composer.addPass(smaaPass);
  }
  return { composer, bloom, tone };
}

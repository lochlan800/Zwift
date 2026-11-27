import * as THREE from 'three';
// CC0 photo-scanned texture sets (Poly Haven), inlined into the single-file build.
import brD from '../textures/red_brick_diff_1k.jpg';
import brN from '../textures/red_brick_nor_512.jpg';
import brR from '../textures/red_brick_rough_512.jpg';
import stD from '../textures/large_sandstone_blocks_01_diff_1k.jpg';
import stN from '../textures/large_sandstone_blocks_01_nor_512.jpg';
import stR from '../textures/large_sandstone_blocks_01_rough_512.jpg';
import slD from '../textures/roof_slates_03_diff_1k.jpg';
import slN from '../textures/roof_slates_03_nor_512.jpg';
import slR from '../textures/roof_slates_03_rough_512.jpg';
import pvD from '../textures/concrete_pavement_diff_1k.jpg';
import pvN from '../textures/concrete_pavement_nor_512.jpg';
import pvR from '../textures/concrete_pavement_rough_512.jpg';

const SETS = { Br: [brD, brN, brR], St: [stD, stN, stR], Sl: [slD, slN, slR], Pv: [pvD, pvN, pvR] };

// uniforms shared by the building + road materials: u<Set>D/N/R, u<Set>Mean, uPhotoOn, uPhotoNrm
export const PHOTO = { uPhotoOn: { value: 0 }, uPhotoNrm: { value: 1 } };
for (const k of Object.keys(SETS)) { PHOTO[`u${k}D`] = { value: null }; PHOTO[`u${k}N`] = { value: null }; PHOTO[`u${k}R`] = { value: null }; PHOTO[`u${k}Mean`] = { value: 0.2 }; }

export function loadPhotoTextures(renderer, normals = true) {
  const loader = new THREE.TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  PHOTO.uPhotoNrm.value = normals ? 1 : 0;
  const setup = (t, srgb) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = aniso; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true; return t; };
  const keys = Object.keys(SETS);
  let pending = keys.length * 3;
  const done = () => { if (--pending === 0) PHOTO.uPhotoOn.value = 1; };
  for (const k of keys) {
    const [d, n, r] = SETS[k];
    PHOTO[`u${k}D`].value = loader.load(d, (t) => {
      setup(t, true);
      try {
        const c = document.createElement('canvas'); c.width = c.height = 32;
        const g = c.getContext('2d'); g.drawImage(t.image, 0, 0, 32, 32);
        const px = g.getImageData(0, 0, 32, 32).data; let acc = 0;
        for (let i = 0; i < px.length; i += 4) acc += Math.pow((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255, 2.2);
        PHOTO[`u${k}Mean`].value = acc / (px.length / 4);
      } catch (e) { /* default */ }
      done();
    });
    if (normals) PHOTO[`u${k}N`].value = loader.load(n, (t) => { setup(t, false); done(); });
    else { PHOTO[`u${k}N`].value = new THREE.Texture(); done(); }
    PHOTO[`u${k}R`].value = loader.load(r, (t) => { setup(t, false); done(); });
  }
}

export const PHOTO_GLSL = /* glsl */`
uniform float uPhotoOn; uniform float uPhotoNrm;
uniform sampler2D uBrD; uniform sampler2D uBrN; uniform sampler2D uBrR; uniform float uBrMean;
uniform sampler2D uStD; uniform sampler2D uStN; uniform sampler2D uStR; uniform float uStMean;
uniform sampler2D uSlD; uniform sampler2D uSlN; uniform sampler2D uSlR; uniform float uSlMean;
uniform sampler2D uPvD; uniform sampler2D uPvN; uniform sampler2D uPvR; uniform float uPvMean;
`;

import * as THREE from 'three';
// CC0 photo-scanned texture sets (Poly Haven), channel-packed so every material samples <= 8 textures.
import detUrl from '../textures/photo_detail.webp';
import nAUrl from '../textures/photo_nrm_a.webp';

// uDet: RGBA luminance (brick, stone, slate, flags); uNrmA: brick xy | stone xy
export const PHOTO = { uPhotoOn: { value: 0 }, uPhotoNrm: { value: 1 }, uDet: { value: null }, uNrmA: { value: null }, uDetMean: { value: new THREE.Vector4(0.2, 0.2, 0.2, 0.2) } };

export function loadPhotoTextures(renderer, normals = true) {
  const loader = new THREE.TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  PHOTO.uPhotoNrm.value = normals ? 1 : 0;
  const setup = (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.premultiplyAlpha = false; t.anisotropy = aniso; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true; return t; };
  let pending = 2;
  const done = () => { if (--pending === 0) PHOTO.uPhotoOn.value = 1; };
  PHOTO.uDet.value = loader.load(detUrl, (t) => {
    setup(t);
    try {
      const c = document.createElement('canvas'); c.width = c.height = 32;
      const g = c.getContext('2d'); g.drawImage(t.image, 0, 0, 32, 32);
      const px = g.getImageData(0, 0, 32, 32).data; const m = [0, 0, 0, 0];
      for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 4; k++) m[k] += Math.pow(px[i + k] / 255, 2.2);
      const n = px.length / 4; PHOTO.uDetMean.value.set(m[0] / n, m[1] / n, m[2] / n, m[3] / n);
    } catch (e) { /* default */ }
    done();
  });
  if (normals) {
    PHOTO.uNrmA.value = loader.load(nAUrl, (t) => { setup(t); done(); });
  } else { PHOTO.uNrmA.value = new THREE.Texture(); done(); }
}

export const PHOTO_GLSL = /* glsl */`
uniform float uPhotoOn; uniform float uPhotoNrm;
uniform sampler2D uDet; uniform sampler2D uNrmA; uniform vec4 uDetMean;
vec3 unpackN(vec2 xy) { vec2 n = xy * 2.0 - 1.0; return vec3(n, sqrt(max(0.0, 1.0 - dot(n, n)))); }
`;

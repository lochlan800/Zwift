import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { U } from './shared.js';

// Late-afternoon UK light: sun low in the WSW.
export const SUN_AZIMUTH_DEG = 244; // clockwise from north
export const SUN_ELEVATION_DEG = 21;
const SKY_SCALE = 3.2; // brings Preetham output into our lighting units

const PARAMS = { turbidity: 2.0, rayleigh: 1.7, mieCoefficient: 0.0022, mieDirectionalG: 0.8 };

function skyMaterial(lut) {
  const S = Sky.SkyShader;
  let vs = S.vertexShader, fs = S.fragmentShader;
  if (lut) {
    vs = vs.replace('varying vec3 vWorldPosition;', 'varying vec3 vWorldPosition;\nvarying vec2 vLutUv;')
      .replace(/gl_Position = projectionMatrix \* modelViewMatrix \* vec4\( position, 1\.0 \);\s*gl_Position\.z = gl_Position\.w;[^\n]*/,
        'gl_Position = vec4( position.xy, 0.0, 1.0 ); vLutUv = uv;');
    fs = fs.replace('varying vec3 vWorldPosition;', 'varying vec3 vWorldPosition;\nvarying vec2 vLutUv;')
      .replace('vec3 direction = normalize( vWorldPosition - cameraPosition );',
        `float lphi = (vLutUv.x - 0.5) * 6.2831853; float lth = (vLutUv.y - 0.5) * 3.14159265;
         vec3 direction = vec3(cos(lth) * cos(lphi), sin(lth), cos(lth) * sin(lphi));`);
  }
  fs = fs.replace('uniform float time;', 'uniform float time;\nuniform float skyScale;\nuniform vec3 groundColor;\nuniform float desat;')
    .replace('gl_FragColor = vec4( texColor, 1.0 );',
      `texColor *= skyScale;
       if (any(isnan(texColor)) || any(isinf(texColor))) texColor = vec3(0.4, 0.5, 0.7);
       texColor = clamp(texColor, 0.0, 30.0);
       ${lut ? 'texColor = mix(texColor, vec3(dot(texColor, vec3(0.3, 0.5, 0.2))), desat); texColor = mix(texColor, groundColor, smoothstep(0.0, -0.25, direction.y));' : ''}
       gl_FragColor = vec4( texColor, 1.0 );`);
  if (vs === S.vertexShader && lut) console.warn('sky LUT patch failed');
  const uniforms = THREE.UniformsUtils.clone(S.uniforms);
  uniforms.skyScale = { value: SKY_SCALE };
  uniforms.groundColor = { value: new THREE.Color(0.06, 0.07, 0.045) };
  uniforms.desat = { value: 0 };
  return new THREE.ShaderMaterial({
    name: lut ? 'SkyLUT' : 'SkyDome', uniforms, vertexShader: vs, fragmentShader: fs,
    side: lut ? THREE.FrontSide : THREE.BackSide, depthWrite: false, depthTest: false, toneMapped: false,
  });
}

export function sunDirection() {
  const az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG), el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
}

export function createSky(renderer) {
  const sunDir = sunDirection();
  U.uSunDir.value.copy(sunDir);

  // visible dome
  const dome = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), skyMaterial(false));
  dome.scale.setScalar(5000);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  const du = dome.material.uniforms;
  Object.entries(PARAMS).forEach(([k, v]) => (du[k].value = v));
  du.sunPosition.value.copy(sunDir).multiplyScalar(450000);
  du.cloudCoverage.value = 0.32;
  du.cloudDensity.value = 0.55;
  du.cloudScale.value = 0.00022;
  du.cloudElevation.value = 0.6;
  du.cloudSpeed.value = 0.00003;

  // LUT: equirect 256x128 HDR, no sun disc, no clouds -> fog colour + environment
  const lutRT = new THREE.WebGLRenderTarget(256, 128, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  lutRT.texture.mapping = THREE.EquirectangularReflectionMapping;
  lutRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const lutMat = skyMaterial(true);
  const lu = lutMat.uniforms;
  Object.entries(PARAMS).forEach(([k, v]) => (lu[k].value = v));
  lu.sunPosition.value.copy(du.sunPosition.value);
  lu.showSunDisc.value = 0;
  lu.cloudCoverage.value = 0.0;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lutMat);
  quad.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  renderer.setRenderTarget(lutRT);
  renderer.render(sc, cam);
  renderer.setRenderTarget(null);
  U.uSkyLUT.value = lutRT.texture;

  // read back to estimate sun & ambient colours
  const px = new Uint16Array(256 * 128 * 4);
  let sunCol = new THREE.Color(1.0, 0.86, 0.68);
  try {
    renderer.readRenderTargetPixels(lutRT, 0, 0, 256, 128, px);
    const f = THREE.DataUtils.fromHalfFloat;
    // zenith-ish average for ambient
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 100; y < 128; y++) for (let x = 0; x < 256; x += 8) {
      const k = (y * 256 + x) * 4; r += f(px[k]); g += f(px[k + 1]); b += f(px[k + 2]); n++;
    }
    U.uSkyAmb.value.setRGB(r / n, g / n, b / n);
  } catch (e) { /* not fatal */ }

  // environment for PBR IBL (sky above, dark ground below)
  const pmrem = new THREE.PMREMGenerator(renderer);
  // environment: same sky, partly desaturated (real skylight is mixed with grey cloud and
  // green ground bounce) and a brighter ground hemisphere
  const envLut = lutRT.clone();
  lu.desat.value = 0.4; lu.groundColor.value.setRGB(0.16, 0.17, 0.11);
  renderer.setRenderTarget(envLut); renderer.render(sc, cam); renderer.setRenderTarget(null);
  const envRT = pmrem.fromEquirectangular(envLut.texture);
  pmrem.dispose();

  // Sun colour: warm late-afternoon (transmittance through ~4 air masses)
  sunCol = new THREE.Color().setRGB(1.0, 0.80, 0.60);
  U.uSunColor.value.copy(sunCol);

  return {
    dome, sunDir, sunColor: sunCol, envMap: envRT.texture, lut: lutRT.texture,
    update(t, camPos) { du.time.value = t; dome.position.copy(camPos); },
  };
}

import * as THREE from 'three';

// Spring-damped chase camera that looks ahead along the route and never clips
// into terrain or buildings.
export class ChaseCamera {
  constructor(camera, hf, buildingIndex, route) {
    this.cam = camera; this.hf = hf; this.bi = buildingIndex; this.route = route;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.look = new THREE.Vector3(); this.lookVel = new THREE.Vector3();
    this.desired = new THREE.Vector3(); this.target = new THREE.Vector3();
    this.tmp = new THREE.Vector3(); this.tmp2 = new THREE.Vector3(); this.fwd = new THREE.Vector3();
    this.dist = 6.2; this.height = 2.3; this.curDist = 6.2;
    this.initialized = false;
    this.orbit = 0;
  }
  _spring(p, v, target, omega, dt) {
    // critically damped spring (semi-implicit)
    const k = omega * omega, c = 2 * omega;
    this.tmp2.subVectors(target, p).multiplyScalar(k).addScaledVector(v, -c);
    v.addScaledVector(this.tmp2, dt);
    p.addScaledVector(v, dt);
  }
  // clearance limit for camera at distance d behind rider along back vector
  _clipDistance(rider, back, maxD) {
    const bi = this.bi;
    let d = maxD;
    for (let t = 1.0; t <= maxD; t += 0.5) {
      const x = rider.x + back.x * t, z = rider.z + back.z * t, y = rider.y + 1.4 + (this.height - 1.4) * (t / maxD);
      const b = bi.find(x, z);
      if (b && y < b.b + b.h + 0.6) { d = Math.max(2.4, t - 0.8); break; }
    }
    return d;
  }
  update(dt, riderPos, s, speed) {
    const route = this.route;
    // forward direction from route (smoothed over a few metres)
    route.at(s + 4, this.tmp); route.at(s - 4, this.tmp2);
    this.fwd.subVectors(this.tmp, this.tmp2); this.fwd.y = 0; this.fwd.normalize();
    // camera sits behind along the route path (follows the road around corners)
    route.at(s - this.dist, this.desired);
    const back = this.tmp.subVectors(this.desired, riderPos); back.y = 0;
    const bl = back.length() || 1; back.multiplyScalar(1 / bl);
    const maxD = this.dist + Math.min(2.5, speed * 0.12);
    const clip = this._clipDistance(riderPos, back, maxD);
    this.curDist += (clip - this.curDist) * Math.min(1, dt * (clip < this.curDist ? 8 : 1.5));
    this.desired.set(riderPos.x + back.x * this.curDist, riderPos.y + this.height, riderPos.z + back.z * this.curDist);
    // look-ahead target
    route.at(s + 14 + speed * 0.6, this.target);
    this.target.y = this.target.y * 0.35 + (riderPos.y + 1.1) * 0.65;
    this.target.lerp(this.tmp2.copy(riderPos).setY(riderPos.y + 1.2), 0.45);
    if (!this.initialized) {
      this.pos.copy(this.desired); this.look.copy(this.target); this.vel.set(0, 0, 0); this.lookVel.set(0, 0, 0); this.initialized = true;
    }
    this._spring(this.pos, this.vel, this.desired, 3.2, dt);
    this._spring(this.look, this.lookVel, this.target, 4.5, dt);
    this._ground(this.pos);
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
  }
  _ground(p) {
    const g = this.hf.sample(p.x, p.z) + 1.1;
    if (p.y < g) { p.y = g; if (this.vel.y < 0) this.vel.y = 0; }
    const b = this.bi.find(p.x, p.z);
    if (b && p.y < b.b + b.h + 0.8) p.y = b.b + b.h + 0.8;
  }
  // title-screen orbit around a point
  orbitUpdate(dt, center, t) {
    const r = 70, a = t * 0.05;
    this.tmp.set(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
    this.tmp.y = Math.max(this.hf.sample(this.tmp.x, this.tmp.z), center.y) + 32;
    this.cam.position.copy(this.tmp);
    this.cam.lookAt(center.x, center.y + 4, center.z);
    this.initialized = false;
  }
}

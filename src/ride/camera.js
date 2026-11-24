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
    // drone mode
    this.mode = 0; this.blend = 0; // 0 = chase, 1 = drone
    this.dPos = new THREE.Vector3(); this.dVel = new THREE.Vector3();
    this.dLook = new THREE.Vector3(); this.dLookVel = new THREE.Vector3();
    this.cPos = new THREE.Vector3(); this.cLook = new THREE.Vector3();
    this.dDesired = new THREE.Vector3(); this.dTarget = new THREE.Vector3();
    this.droneHeight = 150; this.droneBack = 105;
  }
  setMode(m) { this.mode = m; }
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
    // tight turns: raise and pull back a little, and keep the look target closer to the rider
    route.at(s + 18, this.tmp2); const ax = this.tmp2.x - riderPos.x, az = this.tmp2.z - riderPos.z;
    const turnA = Math.acos(Math.max(-1, Math.min(1, (ax * this.fwd.x + az * this.fwd.z) / (Math.hypot(ax, az) || 1))));
    const tk = Math.min(1, Math.max(0, (turnA - 0.25) / 0.8));
    this.turn = (this.turn || 0) + (tk - (this.turn || 0)) * Math.min(1, dt * 1.2);
    const lift = this.turn * 1.6;
    this.desired.set(riderPos.x + back.x * (this.curDist + this.turn * 1.5), riderPos.y + this.height + lift, riderPos.z + back.z * (this.curDist + this.turn * 1.5));
    // look-ahead target
    route.at(s + 10 + speed * 0.4, this.target);
    this.target.y = this.target.y * 0.35 + (riderPos.y + 1.1) * 0.65;
    this.target.lerp(this.tmp2.copy(riderPos).setY(riderPos.y + 1.2), 0.6 + 0.3 * (this.turn || 0));
    // drone: high, ~55 deg down, behind along the route heading, looking ahead
    route.at(s - 60, this.dDesired);
    this.tmp.subVectors(riderPos, this.dDesired); this.tmp.y = 0;
    if (this.tmp.lengthSq() < 1) this.tmp.copy(this.fwd);
    this.tmp.normalize();
    this.dDesired.set(riderPos.x - this.tmp.x * this.droneBack, riderPos.y + this.droneHeight, riderPos.z - this.tmp.z * this.droneBack);
    route.at(s + 45, this.dTarget);
    this.dTarget.lerp(riderPos, 0.5);
    if (!this.initialized) {
      this.pos.copy(this.desired); this.look.copy(this.target); this.vel.set(0, 0, 0); this.lookVel.set(0, 0, 0);
      this.dPos.copy(this.dDesired); this.dLook.copy(this.dTarget); this.dVel.set(0, 0, 0); this.dLookVel.set(0, 0, 0);
      this.blend = this.mode; this.initialized = true;
    }
    this._spring(this.pos, this.vel, this.desired, 3.2, dt);
    this._spring(this.look, this.lookVel, this.target, 4.5 - 1.8 * (this.turn || 0), dt);
    this._spring(this.dPos, this.dVel, this.dDesired, 1.2, dt);
    this._spring(this.dLook, this.dLookVel, this.dTarget, 2.0, dt);
    this._ground(this.pos);
    // animated transition (ease in/out over ~1.6 s)
    this.blend += Math.sign(this.mode - this.blend) * Math.min(Math.abs(this.mode - this.blend), dt / 1.6);
    const b = this.blend * this.blend * (3 - 2 * this.blend);
    if (b <= 0.0001) { this.cam.position.copy(this.pos); this.cam.lookAt(this.look); return; }
    // arc up: lift mid-transition so the path clears roofs
    this.cPos.lerpVectors(this.pos, this.dPos, b);
    this.cPos.y += Math.sin(b * Math.PI) * 25;
    this.cLook.lerpVectors(this.look, this.dLook, b);
    this._ground(this.cPos);
    this.cam.position.copy(this.cPos);
    this.cam.lookAt(this.cLook);
  }
  _ground(p) {
    const g = this.hf.sample(p.x, p.z) + 1.1;
    if (p.y < g) { p.y = g; if (this.vel.y < 0) this.vel.y = 0; }
    const b = this.bi.find(p.x, p.z);
    if (b && p.y < b.b + b.h + 0.8) p.y = b.b + b.h + 0.8;
  }
  // title-screen orbit around a point
  orbitUpdate(dt, center, t) {
    const r = 120, a = 2.2 + t * 0.035;
    this.tmp.set(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
    this.tmp.y = Math.max(this.hf.sample(this.tmp.x, this.tmp.z), center.y) + 48;
    this.cam.position.copy(this.tmp);
    this.cam.lookAt(center.x, center.y + 4, center.z);
    this.initialized = false;
  }
}

// 3D viewer: rendering, navigation tools, picking, section, explode, measure,
// annotations, view cube and axis triad.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { fmtLen, fmtDia, units } from './util.js';

const LOOKS = {
  titanium: { color: 0xa4a8ae, metalness: 0.92, roughness: 0.27 },
  aluminum: { color: 0xd3d6da, metalness: 0.85, roughness: 0.38 },
  steel: { color: 0x7a7f86, metalness: 0.9, roughness: 0.42 },
  original: null,
};
const GLOW = 0x4d8dff;
const VIEW_DIRS = {
  iso: new THREE.Vector3(0.95, -1.35, 0.9),
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  top: new THREE.Vector3(0, 0, 1),
  bottom: new THREE.Vector3(0, 0, -1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Viewer extends EventTarget {
  constructor({ host, labels, viewcube, triad }) {
    super();
    this.host = host; this.labelsEl = labels; this.triadEl = triad;
    this.parts = [];
    this.tool = 'select';
    this.pick = 'part';
    this.displayMode = 'shaded-edges';
    this.look = 'titanium';
    this.explode = 0;
    this.annotations = true;
    this.section = { enabled: false, axis: 'z', t: 0.5, flip: false };
    this.selection = null;
    this.hovered = null;
    this.measurePts = [];
    this.labelItems = [];
    this.dirty = true;

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.98;
    r.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.9;
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(3, -4, 6);
    const rim = new THREE.DirectionalLight(0x9fbfff, 0.8); rim.position.set(-5, 6, 2);
    this.scene.add(key, rim, new THREE.HemisphereLight(0xdfe8ff, 0x0b1222, 0.35));

    this.persp = new THREE.PerspectiveCamera(32, 1, 0.01, 1e6);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    [this.persp, this.ortho].forEach((c) => c.up.set(0, 0, 1));
    this.camera = this.persp;
    this.camera.position.copy(VIEW_DIRS.iso).multiplyScalar(10);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => { this.dirty = true; this.emit('camera'); });

    this.modelGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.scene.add(this.modelGroup, this.overlayGroup);
    this.shadow = this.makeShadow();
    this.scene.add(this.shadow);

    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.raycaster = new THREE.Raycaster();

    this.initViewCube(viewcube);
    this.bindPointer();
    this.setTool('select');
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.tween) this.stepTween();
      if (this.controls.update()) this.dirty = true;
      if (this.dirty) { this.render(); this.dirty = false; }
    };
    loop();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h; this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.dirty = true;
  }

  updateOrthoFrustum() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    const d = this.persp.position.distanceTo(this.controls.target);
    const halfH = d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    this.ortho.left = -halfH * w / h; this.ortho.right = halfH * w / h;
    this.ortho.top = halfH; this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
  }

  setOrthographic(on) {
    const from = this.camera, to = on ? this.ortho : this.persp;
    if (from === to) return;
    if (on) { this.persp.position.copy(from.position); this.updateOrthoFrustum(); this.ortho.zoom = 1; }
    to.position.copy(from.position); to.quaternion.copy(from.quaternion);
    if (!on) {
      // keep apparent size when leaving ortho
      const dir = from.position.clone().sub(this.controls.target);
      to.position.copy(this.controls.target).add(dir.multiplyScalar(1 / (this.ortho.zoom || 1)));
    }
    to.updateProjectionMatrix();
    this.camera = to; this.controls.object = to; this.controls.update();
    this.dirty = true;
  }

  render() {
    const cam = this.camera;
    this.renderer.clippingPlanes = this.section.enabled ? [this.clipPlane] : [];
    this.renderer.render(this.scene, cam);
    this.updateLabels();
    this.renderViewCube();
    this.drawTriad();
  }

  // ---------- model ----------
  clear() {
    this.clearSelection(true);
    this.clearMeasure();
    for (const p of this.parts) { p.mesh.geometry.dispose(); p.mesh.material.dispose(); p.edges?.geometry.dispose(); }
    this.modelGroup.clear();
    this.parts = [];
    this.setLabels([]);
    this.dirty = true;
  }

  setModel(desc) {
    this.clear();
    this.desc = desc;
    desc.meshes.forEach((m, i) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
      if (m.normal) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
      g.setIndex(new THREE.BufferAttribute(m.index, 1));
      if (!m.normal) g.computeVertexNormals();
      g.computeBoundingBox(); g.computeBoundingSphere();
      const mat = new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.partIndex = i;
      mesh.name = m.name;
      this.modelGroup.add(mesh);
      const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : null;
      this.parts.push({ index: i, name: m.name, mesh, src: m, fileColor: color, keepColor: !!m.keepColor, visible: true, data: null, center: g.boundingBox.getCenter(new THREE.Vector3()) });
    });
    this.computeExplodeVectors();
    this.applyLook();
    this.applyDisplayMode();
    this.setExplode(0);
    this.fit(false, 'iso');
    this.updateShadow();
    this.dirty = true;
  }

  computeExplodeVectors() {
    const box = this.modelBox(true);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    for (const p of this.parts) {
      const d = p.center.clone().sub(c);
      if (d.length() < size * 0.02) d.set(0, 0, 0.0001);
      p.explodeDir = d.multiplyScalar(1.1);
    }
  }

  modelBox(all = false) {
    const box = new THREE.Box3();
    for (const p of this.parts) {
      if (!all && !p.visible) continue;
      const b = p.mesh.geometry.boundingBox.clone().translate(p.mesh.position);
      box.union(b);
    }
    return box;
  }

  applyLook() {
    const look = LOOKS[this.look];
    for (const p of this.parts) {
      const m = p.mesh.material;
      if (p.keepColor) { m.color.set(0x3a3e45); m.metalness = 0.85; m.roughness = 0.35; }
      else if (look) { m.color.set(look.color); m.metalness = look.metalness; m.roughness = look.roughness; }
      else { m.color.copy(p.fileColor || new THREE.Color(0xb8babd)); m.metalness = p.fileColor ? 0.25 : 0.85; m.roughness = p.fileColor ? 0.55 : 0.32; }
      m.needsUpdate = true;
    }
    this.refreshHighlight();
    this.dirty = true;
  }

  ensureEdges(p) {
    if (p.edges) return p.edges;
    const tris = p.mesh.geometry.index.count / 3;
    const eg = tris > 800000 ? new THREE.BufferGeometry() : new THREE.EdgesGeometry(p.mesh.geometry, 28);
    p.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x141a24, transparent: true, opacity: 0.55 }));
    p.edges.raycast = () => {};
    p.mesh.add(p.edges);
    return p.edges;
  }

  applyDisplayMode() {
    const mode = this.displayMode;
    for (const p of this.parts) {
      const m = p.mesh.material;
      const edges = mode !== 'shaded' ? this.ensureEdges(p) : p.edges;
      m.wireframe = false;
      m.transparent = mode === 'xray' || mode === 'wireframe';
      m.opacity = mode === 'xray' ? 0.22 : mode === 'wireframe' ? 0.0 : 1;
      m.depthWrite = !m.transparent;
      m.side = this.section.enabled ? THREE.DoubleSide : THREE.FrontSide;
      m.needsUpdate = true;
      if (edges) {
        edges.visible = mode !== 'shaded';
        edges.material.color.set(mode === 'wireframe' || mode === 'xray' ? 0x9db7e6 : 0x141a24);
        edges.material.opacity = mode === 'wireframe' ? 0.9 : mode === 'xray' ? 0.5 : 0.55;
      }
    }
    this.refreshHighlight();
    this.dirty = true;
  }

  setVisible(partIdxs, visible) {
    for (const i of partIdxs) { const p = this.parts[i]; if (!p) continue; p.visible = visible; p.mesh.visible = visible; }
    if (this.selection && !this.parts[this.selection.part]?.visible) this.clearSelection();
    this.updateShadow();
    this.refreshAnnotations();
    this.emit('visibility');
    this.dirty = true;
  }

  isolate(partIdxs) {
    if (this.isolated) {
      this.parts.forEach((p, i) => { p.visible = this.isolated[i]; p.mesh.visible = p.visible; });
      this.isolated = null;
    } else {
      if (!partIdxs.length) return false;
      this.isolated = this.parts.map((p) => p.visible);
      this.parts.forEach((p, i) => { p.visible = partIdxs.includes(i); p.mesh.visible = p.visible; });
    }
    this.updateShadow();
    this.refreshAnnotations();
    this.emit('visibility');
    this.dirty = true;
    return !!this.isolated;
  }

  setExplode(a) {
    this.explode = a;
    for (const p of this.parts) p.mesh.position.copy(p.explodeDir || new THREE.Vector3()).multiplyScalar(a);
    this.modelGroup.updateMatrixWorld(true);
    this.updateSectionPlane();
    this.refreshAnnotations();
    this.updateShadow();
    this.emit('explode', a);
    this.dirty = true;
  }

  // ---------- section ----------
  setSection(opts) {
    Object.assign(this.section, opts);
    this.updateSectionPlane();
    this.applyDisplayMode();
    this.emit('section', this.section);
  }
  updateSectionPlane() {
    const box = this.modelBox(true);
    if (box.isEmpty()) return;
    const ax = this.section.axis;
    const n = new THREE.Vector3(ax === 'x' ? 1 : 0, ax === 'y' ? 1 : 0, ax === 'z' ? 1 : 0);
    const v = THREE.MathUtils.lerp(box.min[ax], box.max[ax], this.section.t);
    // Keep the side "below" v unless flipped.
    if (this.section.flip) this.clipPlane.set(n, -v); else this.clipPlane.set(n.clone().negate(), v);
    this.sectionValue = v;
    this.dirty = true;
  }

  // ---------- camera ----------
  fit(animate = true, viewName) {
    let box;
    const sel = this.selection;
    if (sel && this.fitToSelection) box = this.selectionBox(); else box = this.modelBox();
    this.fitToSelection = false;
    if (!box || box.isEmpty()) box = this.modelBox(true);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const dir = viewName ? VIEW_DIRS[viewName].clone().normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    const up = Math.abs(dir.z) > 0.99 ? new THREE.Vector3(0, dir.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
    const fwd = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const upv = new THREE.Vector3().crossVectors(right, fwd).normalize();
    let W = 0, H = 0, Z = 0;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const d = new THREE.Vector3(x, y, z).sub(center);
      W = Math.max(W, Math.abs(d.dot(right))); H = Math.max(H, Math.abs(d.dot(upv))); Z = Math.max(Z, d.dot(dir));
    }
    const vh = Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    const aspect = this.persp.aspect || 1;
    const margin = this.fitMargin || 1.12;
    const dist = Math.max(H / vh, W / (vh * aspect)) * margin + Z;
    this.flyTo(center, center.clone().add(dir.clone().multiplyScalar(dist)), up, animate);
  }

  setView(name) { this.fit(true, name); }

  flyTo(target, position, up, animate = true) {
    const cam = this.camera;
    if (!animate || reducedMotion) {
      this.controls.target.copy(target); cam.position.copy(position); cam.up.copy(up);
      if (cam.isOrthographicCamera) { this.persp.position.copy(position); this.updateOrthoFrustum(); cam.zoom = 1; cam.updateProjectionMatrix(); }
      cam.lookAt(target); this.controls.update(); this.dirty = true; return;
    }
    this.tween = {
      t0: performance.now(), dur: 380,
      fromT: this.controls.target.clone(), toT: target.clone(),
      fromP: cam.position.clone(), toP: position.clone(),
      fromU: cam.up.clone(), toU: up.clone(),
    };
  }
  stepTween() {
    const tw = this.tween, cam = this.camera;
    let k = Math.min(1, (performance.now() - tw.t0) / tw.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
    // interpolate around the target for a smooth orbit
    const a = tw.fromP.clone().sub(tw.fromT), b = tw.toP.clone().sub(tw.toT);
    const la = a.length(), lb = b.length();
    const dir = a.normalize().lerp(b.normalize(), e);
    if (dir.lengthSq() < 1e-8) dir.copy(b);
    dir.normalize().multiplyScalar(THREE.MathUtils.lerp(la, lb, e));
    cam.position.copy(this.controls.target).add(dir);
    cam.up.lerpVectors(tw.fromU, tw.toU, e).normalize();
    if (cam.isOrthographicCamera) { this.persp.position.copy(cam.position); this.updateOrthoFrustum(); cam.zoom = THREE.MathUtils.lerp(cam.zoom, 1, e); cam.updateProjectionMatrix(); }
    cam.lookAt(this.controls.target);
    this.dirty = true;
    if (k >= 1) this.tween = null;
  }

  setTool(tool) {
    this.tool = tool;
    const c = this.controls, M = THREE.MOUSE;
    const left = tool === 'pan' ? M.PAN : tool === 'zoom' ? M.DOLLY : M.ROTATE;
    c.mouseButtons = { LEFT: left, MIDDLE: M.DOLLY, RIGHT: M.PAN };
    c.touches = { ONE: tool === 'pan' ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.renderer.domElement.style.cursor = tool === 'measure' ? 'crosshair' : tool === 'pan' ? 'grab' : tool === 'zoom' ? 'zoom-in' : 'default';
    if (tool !== 'measure') this.clearMeasure();
  }

  // ---------- picking ----------
  bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      const b = down.b; down = null;
      if (moved < 5 && quick && b === 0) this.onClick(e);
    });
    el.addEventListener('dblclick', (e) => {
      const hit = this.hitTest(e);
      if (hit) { this.fitToSelection = true; this.fit(true); }
    });
    let pending = false;
    el.addEventListener('pointermove', (e) => {
      if (pending || e.buttons) return;
      pending = true;
      setTimeout(() => { pending = false; this.onHover(e); }, 50);
    });
    el.addEventListener('pointerleave', () => this.setHover(null));
  }

  ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  hitTest(e) {
    if (!this.parts.length) return null;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const meshes = this.parts.filter((p) => p.visible).map((p) => p.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      if (this.section.enabled && this.clipPlane.distanceToPoint(h.point) < 0) continue;
      if (this.displayMode === 'wireframe' && h.distance < 0) continue;
      const p = this.parts[h.object.userData.partIndex];
      const faceId = p.data?.faceOf ? p.data.faceOf[h.faceIndex] : -1;
      return { part: p.index, faceIndex: h.faceIndex, faceId, point: h.point.clone(), local: h.object.worldToLocal(h.point.clone()) };
    }
    return null;
  }

  onHover(e) {
    const tris = this.parts.reduce((s, p) => s + (p.visible ? p.mesh.geometry.index.count / 3 : 0), 0);
    if (tris > 1200000) return;
    const hit = this.hitTest(e);
    this.setHover(hit);
    this.emit('hover', hit);
  }

  setHover(hit) {
    const idx = hit ? hit.part : null;
    if (this.hovered === idx) return;
    this.hovered = idx;
    this.refreshHighlight();
    this.renderer.domElement.style.cursor = this.tool === 'measure' ? 'crosshair' : idx != null && this.tool === 'select' ? 'pointer' : (this.tool === 'pan' ? 'grab' : this.tool === 'zoom' ? 'zoom-in' : 'default');
  }

  onClick(e) {
    const hit = this.hitTest(e);
    if (this.tool === 'measure') { this.addMeasurePoint(hit); return; }
    if (!hit) { this.clearSelection(); return; }
    const p = this.parts[hit.part];
    if (this.pick === 'face' && hit.faceId >= 0) { this.select({ kind: 'face', part: hit.part, faceId: hit.faceId }); return; }
    if (this.pick === 'feature' && hit.faceId >= 0 && p.data) {
      const f = p.data.features.find((f) => f.kind !== 'pattern' && f.faceIds.includes(hit.faceId));
      if (f) { this.select({ kind: 'feature', part: hit.part, feature: f.name }); return; }
    }
    this.select({ kind: 'part', part: hit.part });
  }

  // ---------- selection & highlight ----------
  select(sel, silent = false) {
    this.selection = sel;
    this.refreshHighlight();
    this.refreshAnnotations();
    if (!silent) this.emit('select', sel);
    this.dirty = true;
  }
  clearSelection(silent = false) {
    if (!this.selection && silent) return;
    this.selection = null;
    this.refreshHighlight();
    this.refreshAnnotations();
    if (!silent) this.emit('select', null);
    this.dirty = true;
  }

  featureOf(sel) {
    if (!sel || sel.kind !== 'feature') return null;
    return this.parts[sel.part]?.data?.features.find((f) => f.name === sel.feature) || null;
  }

  selectionBox() {
    const sel = this.selection;
    if (!sel) return null;
    if (sel.kind === 'assembly') {
      const box = new THREE.Box3();
      sel.parts.forEach((i) => { const p = this.parts[i]; if (p.visible) box.union(p.mesh.geometry.boundingBox.clone().translate(p.mesh.position)); });
      return box;
    }
    const p = this.parts[sel.part];
    if (!p) return null;
    const faceIds = sel.kind === 'face' ? [sel.faceId] : sel.kind === 'feature' ? (this.featureOf(sel)?.faceIds || []) : null;
    if (!faceIds) return p.mesh.geometry.boundingBox.clone().translate(p.mesh.position);
    const box = new THREE.Box3(), v = new THREE.Vector3();
    const pos = p.src.position, idx = p.src.index;
    for (const fid of faceIds) for (const t of p.data.faces[fid].tris) for (let k = 0; k < 3; k++) {
      const i = idx[t * 3 + k] * 3; box.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]));
    }
    return box.translate(p.mesh.position);
  }

  refreshHighlight() {
    // Clear overlays.
    for (const o of this.overlayParts || []) { o.parent?.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    this.overlayParts = [];
    const sel = this.selection;
    const selParts = sel ? (sel.kind === 'assembly' ? sel.parts : [sel.part]) : [];
    for (const p of this.parts) {
      const m = p.mesh.material;
      const isSel = sel && (sel.kind === 'part' || sel.kind === 'assembly') && selParts.includes(p.index);
      const isHover = this.hovered === p.index && !isSel;
      m.emissive.set(isSel ? 0x1a4cc0 : isHover ? 0x0d2148 : 0x000000);
      m.emissiveIntensity = isSel ? 0.55 : 1;
      if (p.edges && p.edges.visible) {
        p.edges.material.color.set(isSel ? 0x7fb0ff : (this.displayMode === 'wireframe' || this.displayMode === 'xray') ? 0x9db7e6 : 0x141a24);
      }
    }
    if (!sel || (sel.kind !== 'face' && sel.kind !== 'feature')) { this.dirty = true; return; }
    const p = this.parts[sel.part];
    if (!p?.data) return;
    const feat = this.featureOf(sel);
    const faceIds = sel.kind === 'face' ? [sel.faceId] : (feat?.faceIds || []);
    const tris = [];
    for (const fid of faceIds) tris.push(...p.data.faces[fid].tris);
    if (!tris.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', p.mesh.geometry.getAttribute('position'));
    const ix = new Uint32Array(tris.length * 3);
    const src = p.src.index;
    tris.forEach((t, k) => { ix[k * 3] = src[t * 3]; ix[k * 3 + 1] = src[t * 3 + 1]; ix[k * 3 + 2] = src[t * 3 + 2]; });
    g.setIndex(new THREE.BufferAttribute(ix, 1));
    const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: GLOW, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    fill.renderOrder = 5; fill.raycast = () => {};
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(g, 35), new THREE.LineBasicMaterial({ color: 0xa9c8ff, transparent: true, opacity: 0.95 }));
    edge.renderOrder = 6; edge.raycast = () => {};
    p.mesh.add(fill, edge);
    this.overlayParts.push(fill, edge);
    // Hole: show the removed volume as a translucent glowing cylinder.
    if (feat && (feat.kind === 'hole' || feat.kind === 'boss')) {
      const segs = [];
      const L = feat.length;
      const ghost = new THREE.Group();
      const mk = (r, len, off) => {
        const cg = new THREE.CylinderGeometry(r, r, len, 48, 1, true);
        const cm = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: GLOW, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
        cm.position.y = off; cm.renderOrder = 7; cm.raycast = () => {};
        const rings = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(r, r, len, 48, 1, false), 30), new THREE.LineBasicMaterial({ color: 0x8fb7ff, transparent: true, opacity: 0.8, depthTest: false }));
        rings.position.y = off; rings.renderOrder = 8; rings.raycast = () => {};
        ghost.add(cm, rings);
      };
      if (feat.cbore) {
        mk(feat.cbore.radius, feat.cbore.depth, -feat.cbore.depth / 2);
        mk(feat.radius, L - feat.cbore.depth, -feat.cbore.depth - (L - feat.cbore.depth) / 2);
      } else mk(feat.radius, L, -L / 2);
      // Cylinder axis is +Y; orient to point from the entry outward (-inward).
      ghost.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), feat.axis.clone().negate().normalize());
      ghost.position.copy(feat.entry);
      if (feat.kind === 'boss') ghost.visible = false;
      p.mesh.add(ghost);
      this.overlayParts.push(ghost);
    }
    this.dirty = true;
  }

  // ---------- annotations ----------
  setAnnotations(on) { this.annotations = on; this.refreshAnnotations(); }

  refreshAnnotations() {
    for (const o of this.annoObjs || []) { o.parent?.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    this.annoObjs = [];
    const items = [];
    if (this.annotations && this.parts.length) {
      const feat = this.featureOf(this.selection);
      const sel = this.selection;
      const useSel = sel && (sel.kind === 'part' || sel.kind === 'assembly');
      const box = useSel ? this.selectionBox() : this.modelBox();
      if (box && !box.isEmpty()) items.push(...this.boxDims(box));
      if (feat && feat.kind === 'hole') items.push(...this.holeCallout(feat, this.parts[sel.part]));
      else if (feat && feat.kind === 'fillet') items.push(...this.simpleCallout(feat, this.parts[sel.part], `R${fmtLen(feat.radius)}${feat.edges > 1 ? `  ${feat.edges}X` : ''}`));
      else if (feat && feat.kind === 'boss') items.push(...this.simpleCallout(feat, this.parts[sel.part], fmtDia(feat.radius)));
    }
    this.setLabels(items);
    this.dirty = true;
  }

  line(points, color = 0xdfe6f2, opacity = 0.9) {
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
    l.renderOrder = 10; l.raycast = () => {};
    this.overlayGroup.add(l);
    this.annoObjs.push(l);
    return l;
  }

  boxDims(box) {
    const size = box.getSize(new THREE.Vector3());
    const d = size.length();
    const off = d * 0.08, tick = d * 0.025;
    const { min, max } = box;
    const segs = [], labels = [];
    const dim = (a, b, ext, label) => {
      // extension lines
      segs.push(a.clone(), a.clone().add(ext.clone().multiplyScalar(1.15)));
      segs.push(b.clone(), b.clone().add(ext.clone().multiplyScalar(1.15)));
      const a2 = a.clone().add(ext), b2 = b.clone().add(ext);
      segs.push(a2, b2);
      const dir = b2.clone().sub(a2).normalize();
      const side = ext.clone().normalize().multiplyScalar(tick * 0.5);
      for (const [p, s] of [[a2, 1], [b2, -1]]) {
        const tip = p.clone();
        const back = p.clone().add(dir.clone().multiplyScalar(s * tick));
        segs.push(tip, back.clone().add(side), tip, back.clone().sub(side));
      }
      labels.push({ cls: 'dim-label', text: label, point: a2.clone().lerp(b2, 0.5).add(ext.clone().normalize().multiplyScalar(off * 0.45)) });
    };
    if (size.x > 1e-9) dim(new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(0, -off, 0), fmtLen(size.x));
    if (size.y > 1e-9) dim(new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, max.y, min.z), new THREE.Vector3(off, 0, 0), fmtLen(size.y));
    if (size.z > 1e-9) dim(new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(min.x, min.y, max.z), new THREE.Vector3(-off * 0.7, -off * 0.7, 0), fmtLen(size.z));
    this.line(segs);
    return labels;
  }

  holeCallout(feat, part) {
    const off = part.mesh.position;
    const entry = feat.entry.clone().add(off);
    const ax = feat.axis.clone().normalize();
    // Rim point on the side facing world +Z (or +Y for vertical holes).
    const ref = Math.abs(ax.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const radial = ref.sub(ax.clone().multiplyScalar(ref.dot(ax))).normalize();
    const R = feat.cbore ? feat.cbore.radius : feat.radius;
    const rim = entry.clone().add(radial.multiplyScalar(R));
    // Axis centerline through the hole.
    const d = part.data?.diag || 1;
    this.line([entry.clone().sub(ax.clone().multiplyScalar(d * 0.05)), entry.clone().add(ax.clone().multiplyScalar(feat.length + d * 0.05))], 0xcfd9ea, 0.45);
    let text = `${feat.patternCount > 1 ? feat.patternCount + 'X ' : ''}${fmtDia(feat.radius)}\n${feat.thru ? 'THRU ALL' : '↧ ' + fmtLen(feat.depth)}`;
    if (feat.cbore) text += `\n⌴ ${fmtDia(feat.cbore.radius)} ↧ ${fmtLen(feat.cbore.depth)}`;
    return [{ cls: 'callout', text, point: rim, leader: { x: 86, y: -78 } }];
  }

  simpleCallout(feat, part, text) {
    const p = part.data;
    const f = p.faces[feat.faceIds[0]];
    // Anchor on the first face's centroid.
    const v = new THREE.Vector3(), c = new THREE.Vector3();
    let n = 0;
    for (const t of f.tris.slice(0, 400)) for (let k = 0; k < 3; k++) { const i = part.src.index[t * 3 + k] * 3; c.add(v.set(part.src.position[i], part.src.position[i + 1], part.src.position[i + 2])); n++; }
    c.divideScalar(Math.max(1, n)).add(part.mesh.position);
    return [{ cls: 'callout', text, point: c, leader: { x: 80, y: -70 } }];
  }

  setLabels(items) {
    this.labelItems.forEach((l) => l.el.remove());
    this.labelItems = items.map((it) => {
      const el = document.createElement('div');
      el.className = it.cls;
      el.innerHTML = String(it.text).split('\n').map((s) => `<div>${s.replace(/</g, '&lt;')}</div>`).join('');
      this.labelsEl.appendChild(el);
      return { ...it, el };
    });
    this.dirty = true;
  }

  updateLabels() {
    if (!this.leaderSvg) {
      this.leaderSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.leaderSvg.setAttribute('class', 'leaders');
      this.labelsEl.appendChild(this.leaderSvg);
    }
    let paths = '';
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const v = new THREE.Vector3();
    for (const l of this.labelItems) {
      const p = typeof l.point === 'function' ? l.point() : l.point;
      v.copy(p).project(this.camera);
      const visible = v.z < 1 && v.z > -1;
      l.el.style.display = visible ? '' : 'none';
      let x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      if (l.leader && visible) {
        const ex = Math.min(x + l.leader.x, w - 190), ey = Math.max(y + l.leader.y, 100);
        paths += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#e8eef8"/><path d="M${x.toFixed(1)} ${y.toFixed(1)} L${ex.toFixed(1)} ${ey.toFixed(1)} h18" stroke="#e8eef8" stroke-width="1.4" fill="none"/>`;
        x = ex + 24; y = ey;
      }
      l.el.style.left = `${x + (l.dx || 0)}px`;
      l.el.style.top = `${y}px`;
    }
    this.leaderSvg.innerHTML = paths;
  }

  // ---------- measure ----------
  addMeasurePoint(hit) {
    if (!hit) return;
    if (this.measurePts.length >= 2) this.clearMeasure();
    const p = this.parts[hit.part];
    const face = p.data?.faces?.[hit.faceId];
    this.measurePts.push({ ...hit, face });
    this.drawMeasure();
  }
  clearMeasure() {
    for (const o of this.measureObjs || []) { o.parent?.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    this.measureObjs = [];
    (this.measureLabels || []).forEach((l) => { l.el.remove(); this.labelItems = this.labelItems.filter((x) => x !== l); });
    this.measureLabels = [];
    this.measurePts = [];
    this.emit('measure', null);
    this.dirty = true;
  }
  drawMeasure() {
    const pts = this.measurePts;
    (this.measureLabels || []).forEach((l) => { l.el.remove(); this.labelItems = this.labelItems.filter((x) => x !== l); });
    for (const o of this.measureObjs || []) { o.parent?.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    this.measureObjs = []; this.measureLabels = [];
    const mk = (cls, text, point) => {
      const el = document.createElement('div');
      el.className = cls; el.textContent = text || '';
      this.labelsEl.appendChild(el);
      const item = { el, point, cls };
      this.labelItems.push(item); this.measureLabels.push(item);
    };
    pts.forEach((p) => mk('measure-pt', '', p.point));
    let result = null;
    if (pts.length === 2) {
      const [a, b] = pts;
      const g = new THREE.BufferGeometry().setFromPoints([a.point, b.point]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd34d, depthTest: false, transparent: true }));
      l.renderOrder = 12; this.overlayGroup.add(l); this.measureObjs.push(l);
      const d = a.point.distanceTo(b.point);
      const delta = b.point.clone().sub(a.point);
      mk('callout measure-label', fmtLen(d), a.point.clone().lerp(b.point, 0.5));
      result = { distance: d, delta, a, b };
      // Parallel planes: report the true gap between faces.
      if (a.face?.type === 'plane' && b.face?.type === 'plane' && (a.part !== b.part || a.faceId !== b.faceId) && Math.abs(a.face.normal.dot(b.face.normal)) > 0.9999) {
        result.planeGap = Math.abs(delta.dot(a.face.normal));
      }
    }
    this.emit('measure', { points: pts, result });
    this.dirty = true;
  }

  // ---------- shadow ----------
  makeShadow() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.65)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.25)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.renderOrder = -1; m.raycast = () => {};
    return m;
  }
  updateShadow() {
    const box = this.modelBox();
    this.shadow.visible = !box.isEmpty();
    if (box.isEmpty()) return;
    const s = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    this.shadow.position.set(c.x, c.y, box.min.z - s.length() * 0.002);
    this.shadow.scale.set(s.x * 1.9 + s.length() * 0.2, s.y * 1.9 + s.length() * 0.2, 1);
    this.dirty = true;
  }

  // ---------- view cube & triad ----------
  initViewCube(host) {
    this.cubeHost = host;
    const r = this.cubeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setSize(110, 110, false);
    r.domElement.style.width = '100%'; r.domElement.style.height = '100%';
    host.appendChild(r.domElement);
    this.cubeScene = new THREE.Scene();
    this.cubeCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
    this.cubeCam.up.set(0, 0, 1);
    const faceTex = (label) => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 128, 128);
      grd.addColorStop(0, '#d9dee6'); grd.addColorStop(1, '#aab2be');
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = '#7d8796'; g.lineWidth = 4; g.strokeRect(2, 2, 124, 124);
      g.fillStyle = '#1d2533'; g.font = '600 26px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, 64, 66);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      return new THREE.MeshBasicMaterial({ map: t });
    };
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
    const mats = [faceTex('Right'), faceTex('Left'), faceTex('Back'), faceTex('Front'), faceTex('Top'), faceTex('Bottom')];
    // Rotate labels so they read upright with Z up.
    const fixRot = (m, rad) => { m.map.center.set(0.5, 0.5); m.map.rotation = rad; };
    fixRot(mats[0], Math.PI / 2); fixRot(mats[1], -Math.PI / 2); fixRot(mats[2], Math.PI); fixRot(mats[3], 0);
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), mats);
    this.cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0x4a5566 })));
    this.cubeScene.add(this.cube);
    const dirs = ['right', 'left', 'back', 'front', 'top', 'bottom'];
    r.domElement.addEventListener('click', (e) => {
      const rect = r.domElement.getBoundingClientRect();
      const v = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const rc = new THREE.Raycaster(); rc.setFromCamera(v, this.cubeCam);
      const h = rc.intersectObject(this.cube, false)[0];
      if (!h) return;
      // Corner and edge clicks: combine normals near the edges for iso-style views.
      const p = h.point.clone().divideScalar(0.85);
      const dir = new THREE.Vector3(Math.abs(p.x) > 0.6 ? Math.sign(p.x) : 0, Math.abs(p.y) > 0.6 ? Math.sign(p.y) : 0, Math.abs(p.z) > 0.6 ? Math.sign(p.z) : 0);
      if (dir.lengthSq() === 0) dir.copy(h.face.normal);
      const nonZero = [dir.x, dir.y, dir.z].filter((x) => x !== 0).length;
      if (nonZero === 1) this.setView(dirs[h.face.materialIndex]);
      else { VIEW_DIRS.custom = dir; this.fit(true, 'custom'); }
    });
  }
  renderViewCube() {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.cubeCam.position.copy(dir.multiplyScalar(6));
    this.cubeCam.up.copy(this.camera.up);
    this.cubeCam.lookAt(0, 0, 0);
    this.cubeRenderer.render(this.cubeScene, this.cubeCam);
  }
  drawTriad() {
    const q = this.camera.quaternion.clone().invert();
    const axes = [['X', new THREE.Vector3(1, 0, 0), '#ef4b4b'], ['Y', new THREE.Vector3(0, 1, 0), '#3fcf73'], ['Z', new THREE.Vector3(0, 0, 1), '#4d8dff']];
    const c = 45, L = 30;
    const items = axes.map(([n, v, col]) => { const s = v.clone().applyQuaternion(q); return { n, col, x: c + s.x * L, y: c - s.y * L, z: s.z }; })
      .sort((a, b) => a.z - b.z);
    this.triadEl.innerHTML = items.map((a) => `<line x1="${c}" y1="${c}" x2="${a.x.toFixed(1)}" y2="${a.y.toFixed(1)}" stroke="${a.col}" stroke-width="2.4" stroke-linecap="round"/>` +
      `<text x="${(c + (a.x - c) * 1.32).toFixed(1)}" y="${(c + (a.y - c) * 1.32 + 5).toFixed(1)}" fill="#e7ecf4" font-size="15" font-family="Inter, system-ui" text-anchor="middle">${a.n}</text>`).join('');
  }

  screenshot() {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }
}

// Generates a 2D engineering drawing sheet (third-angle orthographic views + iso)
// from the visible geometry, with hidden lines removed, overall dimensions,
// hole callouts and a title block.
import * as THREE from 'three';
import { fmtLen, fmtDia, units, toDisplay } from './util.js';

const SHEET_W = 2400, SHEET_H = 1550;
const INK = '#141414';
let renderer = null;

function getRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    renderer.setPixelRatio(1);
  }
  return renderer;
}

function outlineMaterial(thickness) {
  const m = new THREE.MeshBasicMaterial({ color: 0x141414, side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uThick = { value: thickness };
    sh.vertexShader = 'uniform float uThick;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * uThick;');
  };
  return m;
}

function buildScene(viewer, pxPerUnit) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  const fill = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x141414 });
  const outline = outlineMaterial(1.1 / pxPerUnit);
  for (const p of viewer.parts) {
    if (!p.visible) continue;
    const g = p.mesh.geometry;
    const m = new THREE.Mesh(g, fill); m.position.copy(p.mesh.position);
    const o = new THREE.Mesh(g, outline); o.position.copy(p.mesh.position);
    const edges = viewer.ensureEdges(p).geometry;
    const l = new THREE.LineSegments(edges, lineMat); l.position.copy(p.mesh.position);
    scene.add(o, m, l);
  }
  return scene;
}

function renderView(viewer, box, dir, up, w, h, pxPerUnit, pad) {
  const r = getRenderer();
  const scene = buildScene(viewer, pxPerUnit);
  const c = box.getCenter(new THREE.Vector3());
  const diag = box.getSize(new THREE.Vector3()).length();
  const cam = new THREE.OrthographicCamera(-(w / 2 + pad) / pxPerUnit, (w / 2 + pad) / pxPerUnit, (h / 2 + pad) / pxPerUnit, -(h / 2 + pad) / pxPerUnit, 0.001, diag * 4);
  cam.up.copy(up);
  cam.position.copy(c).add(dir.clone().normalize().multiplyScalar(diag * 2));
  cam.lookAt(c);
  cam.updateProjectionMatrix();
  r.setSize(Math.round(w + pad * 2), Math.round(h + pad * 2), false);
  r.clippingPlanes = viewer.section.enabled ? [viewer.clipPlane] : [];
  r.render(scene, cam);
  return r.domElement;
}

function arrow(g, x, y, ang, size = 14) {
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x - size * Math.cos(ang - 0.28), y - size * Math.sin(ang - 0.28));
  g.lineTo(x - size * Math.cos(ang + 0.28), y - size * Math.sin(ang + 0.28));
  g.closePath(); g.fill();
}

// Linear dimension between sheet points a and b, offset perpendicular by off (px).
function dimension(g, a, b, off, text) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  if (L < 2) return;
  const nx = -dy / L, ny = dx / L;
  const A = { x: a.x + nx * off, y: a.y + ny * off }, B = { x: b.x + nx * off, y: b.y + ny * off };
  const ext = Math.sign(off) * 10;
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(a.x + nx * Math.sign(off) * 6, a.y + ny * Math.sign(off) * 6); g.lineTo(A.x + nx * ext, A.y + ny * ext);
  g.moveTo(b.x + nx * Math.sign(off) * 6, b.y + ny * Math.sign(off) * 6); g.lineTo(B.x + nx * ext, B.y + ny * ext);
  g.stroke();
  const ang = Math.atan2(dy, dx);
  g.font = '500 24px Inter, Arial, sans-serif';
  const tw = g.measureText(text).width + 16;
  const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  g.beginPath();
  if (L > tw + 40) {
    g.moveTo(A.x, A.y); g.lineTo(mid.x - (dx / L) * tw / 2, mid.y - (dy / L) * tw / 2);
    g.moveTo(mid.x + (dx / L) * tw / 2, mid.y + (dy / L) * tw / 2); g.lineTo(B.x, B.y);
  } else { g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); }
  g.stroke();
  arrow(g, A.x, A.y, ang + Math.PI); arrow(g, B.x, B.y, ang);
  g.save();
  g.translate(mid.x, mid.y);
  let rot = ang; if (rot > Math.PI / 2 || rot < -Math.PI / 2) rot += Math.PI;
  g.rotate(rot);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (L <= tw + 40) g.translate(0, -18);
  g.fillText(text, 0, 1);
  g.restore();
}

function leader(g, from, to, lines) {
  g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(to.x, to.y);
  const dir = to.x >= from.x ? 1 : -1;
  g.lineTo(to.x + dir * 24, to.y); g.stroke();
  arrow(g, from.x, from.y, Math.atan2(from.y - to.y, from.x - to.x), 13);
  g.font = '500 22px Inter, Arial, sans-serif';
  g.textAlign = dir > 0 ? 'left' : 'right'; g.textBaseline = 'middle';
  lines.forEach((t, i) => g.fillText(t, to.x + dir * 30, to.y + (i - (lines.length - 1) / 2) * 26));
}

export function generateDrawing(viewer, project, desc) {
  const box = viewer.modelBox();
  const sheet = document.createElement('canvas');
  sheet.width = SHEET_W; sheet.height = SHEET_H;
  const g = sheet.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, SHEET_W, SHEET_H);
  if (box.isEmpty()) return sheet;
  const size = box.getSize(new THREE.Vector3());

  // Frame with zone markers.
  const M = 40;
  g.strokeStyle = INK; g.fillStyle = INK; g.lineWidth = 3;
  g.strokeRect(M, M, SHEET_W - 2 * M, SHEET_H - 2 * M);
  g.lineWidth = 1; g.strokeRect(M - 18, M - 18, SHEET_W - 2 * M + 36, SHEET_H - 2 * M + 36);
  g.font = '500 18px Inter, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const cols = 8, rows = 4;
  for (let i = 0; i < cols; i++) {
    const x = M + (i + 0.5) * (SHEET_W - 2 * M) / cols;
    g.fillText(String(cols - i), x, M - 9); g.fillText(String(cols - i), x, SHEET_H - M + 9);
  }
  for (let j = 0; j < rows; j++) {
    const y = M + (j + 0.5) * (SHEET_H - 2 * M) / rows;
    g.fillText('DCBA'[j], M - 9, y); g.fillText('DCBA'[j], SHEET_W - M + 9, y);
  }

  // Layout and common scale.
  const areaX = M + 120, areaY = M + 90, areaW = 1420, areaH = SHEET_H - 2 * M - 200;
  const gap = 150;
  const s = Math.min((areaW - gap) / (size.x + size.y), (areaH - gap) / (size.z + size.y));
  const fw = size.x * s, fh = size.z * s, th = size.y * s, rw = size.y * s;
  const pad = 6;
  const topPos = { x: areaX, y: areaY };
  const frontPos = { x: areaX, y: areaY + th + gap };
  const rightPos = { x: areaX + fw + gap, y: frontPos.y };

  const views = [
    { name: 'front', pos: frontPos, w: fw, h: fh, dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1), map: (p) => ({ x: frontPos.x + (p.x - box.min.x) * s, y: frontPos.y + (box.max.z - p.z) * s }), axis: 'y' },
    { name: 'top', pos: topPos, w: fw, h: th, dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), map: (p) => ({ x: topPos.x + (p.x - box.min.x) * s, y: topPos.y + (box.max.y - p.y) * s }), axis: 'z' },
    { name: 'right', pos: rightPos, w: rw, h: fh, dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1), map: (p) => ({ x: rightPos.x + (p.y - box.min.y) * s, y: rightPos.y + (box.max.z - p.z) * s }), axis: 'x' },
  ];
  for (const v of views) {
    if (v.w < 2 || v.h < 2) continue;
    const img = renderView(viewer, box, v.dir, v.up, v.w, v.h, s, pad);
    g.drawImage(img, v.pos.x - pad, v.pos.y - pad);
  }

  // Isometric view, upper right.
  const isoBox = { x: areaX + areaW + 40, y: areaY, w: SHEET_W - M - 40 - (areaX + areaW + 40), h: 520 };
  {
    const dir = new THREE.Vector3(0.95, -1.35, 0.9).normalize();
    const cam = new THREE.Camera();
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const right = new THREE.Vector3().crossVectors(dir.clone().negate(), new THREE.Vector3(0, 0, 1)).normalize();
    const upv = new THREE.Vector3().crossVectors(right, dir.clone().negate()).normalize();
    const c = box.getCenter(new THREE.Vector3());
    let wU = 0, hU = 0;
    corners.forEach((p) => { const d = p.clone().sub(c); wU = Math.max(wU, Math.abs(d.dot(right))); hU = Math.max(hU, Math.abs(d.dot(upv))); });
    const si = Math.min(isoBox.w / (2 * wU), isoBox.h / (2 * hU)) * 0.9;
    const img = renderView(viewer, box, dir, new THREE.Vector3(0, 0, 1), 2 * wU * si, 2 * hU * si, si, pad);
    g.drawImage(img, isoBox.x + (isoBox.w - img.width) / 2, isoBox.y + (isoBox.h - img.height) / 2);
    void cam;
  }

  // View labels.
  g.font = '600 20px Inter, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const label = (t, x, y) => g.fillText(t, x, y);
  label('TOP', topPos.x + fw / 2, topPos.y - 28);
  label('FRONT', frontPos.x + fw / 2, frontPos.y + fh + 110);
  label('RIGHT', rightPos.x + rw / 2, rightPos.y + fh + 110);
  label('ISOMETRIC', isoBox.x + isoBox.w / 2, isoBox.y + isoBox.h + 24);

  // Overall dimensions.
  g.strokeStyle = INK; g.fillStyle = INK;
  const fv = views[0], tv = views[1], rv = views[2];
  dimension(g, fv.map({ x: box.min.x, z: box.min.z }), fv.map({ x: box.max.x, z: box.min.z }), 60, fmtLen(size.x, false));
  dimension(g, fv.map({ x: box.min.x, z: box.min.z }), fv.map({ x: box.min.x, z: box.max.z }), -60, fmtLen(size.z, false));
  dimension(g, rv.map({ y: box.min.y, z: box.min.z }), rv.map({ y: box.max.y, z: box.min.z }), 60, fmtLen(size.y, false));
  dimension(g, tv.map({ x: box.min.x, y: box.min.y }), tv.map({ x: box.min.x, y: box.max.y }), -60, fmtLen(size.y, false));

  // Hole callouts: one per unique hole specification.
  const callouts = [];
  const seen = new Set();
  for (const p of viewer.parts) {
    if (!p.visible || !p.data) continue;
    for (const f of p.data.features) {
      if (f.kind !== 'hole') continue;
      const spec = `${f.type}|${f.radius.toFixed(4)}|${f.cbore ? f.cbore.radius.toFixed(4) : ''}|${f.thru}`;
      if (seen.has(spec)) continue;
      const ax = f.axis.clone().normalize();
      const v = Math.abs(ax.y) > 0.999 ? fv : Math.abs(ax.z) > 0.999 ? tv : Math.abs(ax.x) > 0.999 ? rv : null;
      if (!v) continue;
      seen.add(spec);
      const center = f.entry.clone().add(p.mesh.position);
      const c2 = v.map(center);
      const lines = [`${f.patternCount > 1 ? f.patternCount + 'X ' : ''}${fmtDia(f.radius).replace(` ${units.display}`, '')} ${f.thru ? 'THRU' : '↧ ' + fmtLen(f.depth, false)}`];
      if (f.cbore) lines.push(`⌴ ${fmtDia(f.cbore.radius).replace(` ${units.display}`, '')} ↧ ${fmtLen(f.cbore.depth, false)}`);
      callouts.push({ v, c2, r: (f.cbore ? f.cbore.radius : f.radius) * s, lines });
      if (callouts.length >= 5) break;
    }
  }
  callouts.forEach((co, i) => {
    const ang = -Math.PI / 4 - i * 0.12;
    const from = { x: co.c2.x + Math.cos(ang) * co.r, y: co.c2.y + Math.sin(ang) * co.r };
    const to = { x: from.x + 70 + i * 10, y: from.y - 60 - i * 34 };
    leader(g, from, to, co.lines);
  });

  // Title block.
  const tbW = 760, tbH = 210;
  const tbX = SHEET_W - M - tbW, tbY = SHEET_H - M - tbH;
  g.lineWidth = 2; g.strokeRect(tbX, tbY, tbW, tbH);
  g.lineWidth = 1;
  const rowsTB = 4, rh = tbH / rowsTB;
  for (let i = 1; i < rowsTB; i++) { g.beginPath(); g.moveTo(tbX, tbY + i * rh); g.lineTo(tbX + tbW, tbY + i * rh); g.stroke(); }
  g.beginPath(); g.moveTo(tbX + tbW / 2, tbY + rh); g.lineTo(tbX + tbW / 2, tbY + tbH); g.stroke();
  const drawingRef = project.thread.find((t) => t.kind === 'Drawing')?.refs || `DWG-${(desc.name || 'MODEL').toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 18)}`;
  // sheet pixels per real inch vs. pixels per paper inch on a 17 in wide B-size sheet
  const nominal = (s * 25.4 / units.mmPerModelUnit) / (SHEET_W / 17);
  const scaleText = nominal >= 1 ? `${nominal.toFixed(nominal >= 10 ? 0 : 1)}:1` : `1:${(1 / nominal).toFixed(1 / nominal >= 10 ? 0 : 1)}`;
  const cell = (x, y, k, val, big) => {
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = '500 15px Inter, Arial, sans-serif'; g.fillStyle = '#555'; g.fillText(k, x + 12, y + 8);
    g.font = `${big ? 600 : 500} ${big ? 26 : 20}px Inter, Arial, sans-serif`; g.fillStyle = INK; g.fillText(val, x + 12, y + 26);
  };
  cell(tbX, tbY, 'TITLE', desc.name.slice(0, 48), true);
  cell(tbX, tbY + rh, 'DRAWING NO.', drawingRef.slice(0, 30));
  cell(tbX + tbW / 2, tbY + rh, 'REV', project.meta.rev || '');
  cell(tbX, tbY + rh * 2, 'MATERIAL', project.material.name.slice(0, 32));
  cell(tbX + tbW / 2, tbY + rh * 2, 'UNITS / SCALE (B SIZE)', `${units.display === 'in' ? 'INCHES' : 'MILLIMETERS'}  ${scaleText}`);
  cell(tbX, tbY + rh * 3, 'PROJECTION', 'THIRD ANGLE');
  cell(tbX + tbW / 2, tbY + rh * 3, 'DATE', new Date().toISOString().slice(0, 10));
  g.font = '500 16px Inter, Arial, sans-serif'; g.fillStyle = '#555'; g.textAlign = 'right'; g.textBaseline = 'bottom';
  g.fillText('Generated by Engineering Workbench from the visible model geometry', tbX + tbW, tbY - 10);
  if (viewer.section.enabled) { g.textAlign = 'left'; g.fillText(`SECTION ${viewer.section.axis.toUpperCase()} = ${fmtLen(viewer.sectionValue)}`, areaX, SHEET_H - M - 16); }
  void toDisplay;
  return sheet;
}

// Right-hand details panel for the current selection.
import * as THREE from 'three';
import { icon } from './icons.js';
import { esc, fmtLen, fmtArea, fmtVol, fmtMass, fmtDia, massGrams, toDisplay, lenDigits, units } from './util.js';
import { FEATURE_STATUSES } from './store.js';
import { featureLabel } from './tree.js';

const v3 = (v) => `${fmtLen(v.x, false)}, ${fmtLen(v.y, false)}, ${fmtLen(v.z, false)} ${units.display}`;
function axisText(a) {
  const n = a.clone().normalize();
  const names = [['X', n.x], ['Y', n.y], ['Z', n.z]];
  const m = names.find(([, c]) => Math.abs(c) > 0.9995);
  if (m) return `${m[1] > 0 ? '+' : '−'}${m[0]} axis`;
  return `(${n.x.toFixed(3)}, ${n.y.toFixed(3)}, ${n.z.toFixed(3)})`;
}
const boxText = (b) => { const s = b.getSize(new THREE.Vector3()); return `${fmtLen(s.x, false)} × ${fmtLen(s.y, false)} × ${fmtLen(s.z, false)} ${units.display}`; };
const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

export class DetailsPanel {
  constructor(el, { viewer, store, onLink }) {
    this.el = el; this.viewer = viewer; this.store = store; this.onLink = onLink;
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-link]');
      if (a) { e.preventDefault(); onLink(a.dataset.link); }
    });
    el.addEventListener('change', (e) => this.onEdit(e));
    el.addEventListener('input', (e) => { if (e.target.matches('textarea[data-meta]')) this.onEdit(e); });
  }

  onEdit(e) {
    const t = e.target;
    if (!t.dataset.meta || !this.metaKey) return;
    const m = this.store.featureMeta(this.metaKey);
    m[t.dataset.meta] = t.value;
    this.store.changed('meta');
    if (t.dataset.meta === 'status' || t.dataset.meta === 'requirement') this.render();
  }

  header(title, actions = true) {
    return `<div class="details-head"><h2>${esc(title)}</h2>${actions ? `<div class="card-tools">
      <button class="icon-btn sm" data-link="copy-ref" title="Copy reference">${icon('link')}</button>
      <button class="icon-btn sm" data-link="fit-selection" title="Zoom to selection">${icon('fit')}</button></div>` : ''}</div>`;
  }

  render() {
    const v = this.viewer, sel = v.selection;
    this.metaKey = null;
    if (!v.parts.length) { this.el.innerHTML = this.header('Details', false) + '<p class="details-empty">Open a model to see its properties.</p>'; return; }
    if (!sel) return this.renderModel();
    if (sel.kind === 'assembly') return this.renderAssembly(sel);
    if (sel.kind === 'material') return this.renderModel();
    const part = v.parts[sel.part];
    if (sel.kind === 'part') return this.renderPart(part);
    if (sel.kind === 'face') return this.renderFace(part, sel.faceId);
    const f = v.featureOf(sel);
    if (f) return this.renderFeature(part, f);
    this.renderPart(part);
  }

  density() { return this.store.project?.material?.density || 2.7; }

  totals(idxs) {
    const v = this.viewer;
    let vol = 0, area = 0, tris = 0, ready = true;
    const box = new THREE.Box3();
    idxs.forEach((i) => {
      const p = v.parts[i];
      if (!p.data) { ready = false; return; }
      vol += p.data.volume; area += p.data.area; tris += p.data.triangles;
      box.union(p.data.box.clone().translate(p.mesh.position));
    });
    return { vol, area, tris, box, ready };
  }

  renderModel() {
    const v = this.viewer, d = v.desc;
    const t = this.totals(v.parts.map((_, i) => i));
    const feats = v.parts.flatMap((p) => p.data?.features || []);
    const holes = feats.filter((f) => f.kind === 'hole').length;
    this.el.innerHTML = this.header('Model Details', false) +
      `<div class="details-title">${esc(d.name)}</div>` +
      kv([
        ['File', esc(d.fileName)],
        ['Format', esc(d.format || 'STEP')],
        ['Parts', String(v.parts.length)],
        ['Triangles', t.tris.toLocaleString()],
        t.ready && ['Bounding box', boxText(t.box)],
        t.ready && ['Volume', fmtVol(t.vol)],
        t.ready && ['Mass', `${fmtMass(massGrams(t.vol, this.density()))}`],
        ['Material', `<a href="#" data-link="goto:analysis">${esc(this.store.project.material.name)}</a>`],
        ['Features', feats.length ? `${feats.length} recognized (${holes} holes)` : (t.ready ? 'None recognized' : 'Analyzing…')],
      ]) +
      `<div class="section-title">Getting around</div>
      <div class="details-empty"><ul>
        <li>Click a part to select it. Use the Parts / Features / Faces filter to pick holes, fillets or single faces.</li>
        <li>Drag to orbit, right-drag to pan, scroll to zoom. Double-click zooms to what you clicked.</li>
        <li>Measure: pick two points. Parallel faces also report the true gap.</li>
      </ul></div>`;
  }

  renderAssembly(sel) {
    const v = this.viewer;
    const t = this.totals(sel.parts);
    const visible = sel.parts.filter((i) => v.parts[i].visible).length;
    this.el.innerHTML = this.header('Assembly Details') +
      `<div class="details-title">${esc(sel.name)}</div>` +
      kv([
        ['Type', 'Assembly'],
        ['Parts', `${sel.parts.length} (${visible} visible)`],
        t.ready && ['Bounding box', boxText(t.box)],
        t.ready && ['Volume', fmtVol(t.vol)],
        t.ready && ['Surface area', fmtArea(t.area)],
        t.ready && ['Mass', fmtMass(massGrams(t.vol, this.density()))],
        ['Triangles', t.tris.toLocaleString()],
      ]);
  }

  provenance(key, extra = '') {
    this.metaKey = key;
    const m = this.store.featureMeta(key);
    const reqs = this.store.project.requirements;
    const req = reqs.find((r) => r.id === m.requirement);
    const statusDot = m.status === 'Engineer Confirmed' ? 'ok' : m.status === 'Rejected' ? 'bad' : m.status === 'In Review' ? 'warn' : 'idle';
    const input = (f, ph, cls = '') => `<input class="meta-input ${cls}" data-meta="${f}" value="${esc(m[f])}" placeholder="${ph}" />`;
    return `<div class="section-title">Source &amp; Provenance</div>` + kv([
      ['Drawing', input('drawing', 'Sheet, zone', m.drawing ? 'link' : '')],
      ['Dimension', input('dimension', 'Dimension ID', m.dimension ? 'link' : '')],
      ['Requirement', `<select class="meta-input ${m.requirement ? 'link' : ''}" data-meta="requirement"><option value="">None</option>${reqs.map((r) => `<option value="${esc(r.id)}" ${r.id === m.requirement ? 'selected' : ''}>${esc(r.id)} ${esc(r.title)}</option>`).join('')}</select>${req ? `<a href="#" data-link="goto:requirements:${esc(req.id)}">Open ${esc(req.id)}</a>` : ''}`],
      ['Specification', input('specification', 'Spec or standard', m.specification ? 'link' : '')],
      ['Material condition', input('condition', 'e.g. Apply after coating')],
      extra,
      ['Status', `<span class="status-select"><span class="dot ${statusDot}"></span><select data-meta="status">${FEATURE_STATUSES.map((s) => `<option ${s === m.status ? 'selected' : ''}>${s}</option>`).join('')}</select></span>`],
    ].filter(Boolean)) +
      `<div class="section-title">Notes</div><textarea class="details-notes" data-meta="notes" placeholder="Design intent, review comments…">${esc(m.notes)}</textarea>`;
  }

  renderPart(p) {
    const d = p.data;
    const feats = d?.features || [];
    const counts = {};
    feats.forEach((f) => { counts[f.type] = (counts[f.type] || 0) + 1; });
    this.el.innerHTML = this.header('Part Details') +
      `<div class="details-title">${esc(p.name)}</div>` +
      (d ? kv([
        ['Type', 'Part (solid body)'],
        ['Faces', `${d.faces.length.toLocaleString()} ${d.faceSource === 'brep' ? '(B-rep)' : d.faceSource === 'mesh' ? '(from mesh)' : ''}`],
        ['Triangles', d.triangles.toLocaleString()],
        ['Bounding box', boxText(d.box)],
        ['Volume', d.closed ? fmtVol(d.volume) : `${fmtVol(d.volume)} (open mesh, approximate)`],
        ['Surface area', fmtArea(d.area)],
        ['Mass', `${fmtMass(massGrams(d.volume, this.density()))}`],
        ['Center of mass', v3(d.centroid.clone().add(p.mesh.position))],
        ['Features', feats.length ? Object.entries(counts).map(([k, n]) => `${n} ${k.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ') : 'None recognized'],
        ['Visible', p.visible ? 'Yes' : `No <a href="#" data-link="show:${p.index}">Show</a>`],
      ]) : '<p class="details-empty">Analyzing geometry…</p>') +
      this.provenance(p.name);
  }

  renderFeature(p, f) {
    const key = `${p.name}#${f.name}`;
    let rows = [], geo = '', art = '';
    if (f.kind === 'hole') {
      rows = [
        ['Type', esc(f.type)],
        ['Operation', 'Cut (remove material)'],
        ['Diameter', fmtDia(f.radius)],
        f.cbore && ['Counterbore', `${fmtDia(f.cbore.radius)} x ${fmtLen(f.cbore.depth)} deep`],
        ['Depth', f.thru ? 'THRU ALL' : fmtLen(f.depth)],
        ['Position', v3(f.entry.clone().add(p.mesh.position))],
        ['Axis direction', axisText(f.axis)],
        f.pattern && ['Pattern', `<a href="#" data-link="feature:${p.index}:${esc(f.pattern)}">Part of ${esc(f.pattern)} (${f.patternCount}x)</a>`],
      ];
      geo = this.geomStats([['Faces', f.faceIds.length], ['Length', fmtLen(f.length)], ['Volume (removed)', fmtVol(f.volumeRemoved)]]);
      art = holeArt(f);
    } else if (f.kind === 'pattern') {
      const first = p.data.features.find((x) => x.name === f.members[0]);
      rows = [
        ['Type', `${esc(f.arrangement)} pattern`],
        ['Instances', String(f.count)],
        first && ['Seed feature', `<a href="#" data-link="feature:${p.index}:${esc(first.name)}">${esc(first.name)}</a> ${esc(featureLabel(first))}`],
        ['Members', f.members.map((m) => `<a href="#" data-link="feature:${p.index}:${esc(m)}">${esc(m)}</a>`).join(', ')],
      ];
      if (first) geo = this.geomStats([['Faces', f.faceIds.length], ['Each removes', fmtVol(first.volumeRemoved)], ['Total removed', fmtVol(first.volumeRemoved * f.count)]]);
      art = first ? holeArt(first) : '';
    } else if (f.kind === 'fillet') {
      const area = f.faceIds.reduce((s, id) => s + p.data.faces[id].area, 0);
      rows = [
        ['Type', f.type === 'Fillet' ? 'Fillet (concave)' : 'Round (convex)'],
        ['Radius', `R${fmtLen(f.radius)}`],
        ['Edges', String(f.edges)],
      ];
      geo = this.geomStats([['Faces', f.faceIds.length], ['Area', fmtArea(area)], ['Radius', `R${fmtLen(f.radius)}`]]);
    } else if (f.kind === 'boss') {
      rows = [['Type', 'Boss / shaft'], ['Diameter', fmtDia(f.radius)], ['Length', fmtLen(f.length)], ['Axis direction', axisText(f.axis)]];
      geo = this.geomStats([['Faces', f.faceIds.length], ['Length', fmtLen(f.length)], ['Diameter', fmtDia(f.radius)]]);
    }
    const conf = f.confidence != null ? ['Confidence (AI)', `<span class="confidence"><b>${f.confidence}%</b><span class="bar"><i style="width:${f.confidence}%"></i></span></span>`] : null;
    this.el.innerHTML = this.header('Feature Details') +
      `<div class="details-title">${esc(f.name)} <small>in <a href="#" class="link-btn" data-link="part:${p.index}">${esc(p.name)}</a></small></div>` +
      kv(rows) + (art ? geo.replace('<div class="stats">', `<div class="geo-wrap"><div class="stats">`).replace(/<\/div>$/, `</div><div class="feature-art">${art}</div></div>`) : geo) +
      this.provenance(key, conf);
  }

  geomStats(items) {
    return `<div class="section-title">Geometry</div><div class="stats">${items.map(([k, v]) => `<div><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>`;
  }

  renderFace(p, faceId) {
    const f = p.data?.faces?.[faceId];
    if (!f) return this.renderPart(p);
    const owner = p.data.features.find((x) => x.kind !== 'pattern' && x.faceIds.includes(faceId));
    const rows = [['Type', f.type === 'plane' ? 'Planar' : f.type === 'cylinder' ? 'Cylindrical' : 'Freeform / other'], ['Area', fmtArea(f.area)], ['Triangles', f.tris.length.toLocaleString()]];
    if (f.type === 'plane') rows.push(['Normal', axisText(f.normal)]);
    if (f.type === 'cylinder') {
      rows.push(['Radius', fmtLen(f.radius)], ['Diameter', fmtDia(f.radius)], ['Axis', axisText(f.axis)],
        ['Sweep', `${THREE.MathUtils.radToDeg(f.sweep).toFixed(1)}°`], ['Side', f.concave ? 'Inside (hole-like)' : 'Outside (shaft-like)'], ['Length', fmtLen(f.tMax - f.tMin)]);
    }
    rows.push(['Part', `<a href="#" data-link="part:${p.index}">${esc(p.name)}</a>`]);
    if (owner) rows.push(['Feature', `<a href="#" data-link="feature:${p.index}:${esc(owner.name)}">${esc(owner.name)}</a> ${esc(featureLabel(owner))}`]);
    this.el.innerHTML = this.header('Face Details') + `<div class="details-title">Face ${faceId + 1}</div>` + kv(rows);
  }
}

function holeArt(f) {
  // Proportional sketch of the hole: counterbore over the through hole, with the removed volume in blue.
  const W = 92, H = 160, cx = 46;
  const L = f.length, r = f.radius, R = f.cbore ? f.cbore.radius : r;
  const maxR = Math.max(R, L * 0.18);
  const sx = 36 / maxR;
  const sy = Math.min(120 / L, sx * 3);
  const top = 18, ry = 6;
  const cbD = f.cbore ? f.cbore.depth * sy : 0;
  const total = L * sy;
  const rr = Math.max(5, r * sx), RR = Math.max(rr + 3, R * sx);
  const ell = (y, rx, cls) => `<ellipse cx="${cx}" cy="${y}" rx="${rx}" ry="${ry * rx / RR}" class="${cls}"/>`;
  const body = (y0, y1, rx) => `<path d="M${cx - rx} ${y0} L${cx - rx} ${y1} A${rx} ${ry * rx / RR} 0 0 0 ${cx + rx} ${y1} L${cx + rx} ${y0}" class="b"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <style>.b{fill:rgba(77,141,255,.16);stroke:#8fb7ff;stroke-width:1.2}.t{fill:rgba(77,141,255,.28);stroke:#a9c8ff;stroke-width:1.2}.d{stroke:#8291a7;stroke-width:1;fill:none}.c{stroke:#cfd9ea;stroke-dasharray:4 3;stroke-width:.8}</style>
    ${f.cbore ? body(top, top + cbD, RR) + ell(top + cbD, RR, 't') : ''}
    ${body(top + cbD, top + total, rr)}
    ${f.cbore ? ell(top, RR, 't') : ''}
    ${ell(top + cbD, rr, 't')}
    <line x1="${cx}" y1="${top - 10}" x2="${cx}" y2="${top + total + 10}" class="c"/>
    <path d="M${W - 6} ${top} V${top + total} M${W - 10} ${top} H${W - 2} M${W - 10} ${top + total} H${W - 2}" class="d"/>
  </svg>`;
}

// Requirements, Manufacturing, Digital Thread and Analysis views (compact cards + full pages).
import * as THREE from 'three';
import { icon } from './icons.js';
import { esc, fmtLen, fmtVol, fmtArea, fmtMass, fmtDia, massGrams, download, units } from './util.js';
import { MATERIALS, REQ_STATUSES, THREAD_KINDS } from './store.js';
import { featureLabel } from './tree.js';

const STATUS_DOT = { Verified: 'ok', 'In Progress': 'warn', Planned: 'idle', Failed: 'bad' };
const THREAD_ICON = { Drawing: 'drawing', '3D Model': 'box', Requirements: 'requirements', Manufacturing: 'manufacturing', Inspection: 'inspection', Test: 'test', 'Change order': 'file', Supplier: 'file' };

export class Panels {
  constructor({ viewer, store, onLink }) {
    this.viewer = viewer; this.store = store; this.onLink = onLink;
    this.highlightReq = null;
    const root = document;
    root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-link]');
      if (a && !a.closest('#details, #chat')) { e.preventDefault(); onLink(a.dataset.link); }
      const del = e.target.closest('[data-del]');
      if (del) { const [list, i] = del.dataset.del.split(':'); this.store.project[list].splice(+i, 1); this.store.changed(list); }
      const row = e.target.closest('#reqCompact tr[data-req]');
      if (row) this.focusRequirement(row.dataset.req);
      const prow = e.target.closest('tr[data-part-row]');
      if (prow && !e.target.closest('a,button,input,select')) onLink(`part:${prow.dataset.partRow}`);
      const frow = e.target.closest('tr[data-feat-row]');
      if (frow && !e.target.closest('a,button,input,select')) onLink(`feature:${frow.dataset.featRow}`);
    });
    root.addEventListener('change', (e) => this.onEdit(e));
    root.addEventListener('input', (e) => { if (e.target.matches('[data-field].live')) this.onEdit(e, true); });
    document.getElementById('reqAdd').addEventListener('click', () => {
      const reqs = this.store.project.requirements;
      const nums = reqs.map((r) => parseInt(String(r.id).replace(/\D/g, ''), 10)).filter(Number.isFinite);
      reqs.push({ id: `REQ-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`, title: 'New requirement', status: 'Planned', notes: '' });
      this.store.changed('requirements');
      setTimeout(() => document.querySelector('#reqFull tbody tr:last-child input[data-field="title"]')?.select(), 0);
    });
    document.getElementById('threadAdd').addEventListener('click', () => {
      this.store.project.thread.push({ kind: 'Inspection', refs: '', href: '' });
      this.store.changed('thread');
    });
  }

  onEdit(e, live = false) {
    const t = e.target;
    const f = t.dataset.field;
    if (!f) return;
    const p = this.store.project;
    const [scope, a, b] = f.split(':');
    if (scope === 'req') p.requirements[+a][b] = t.value;
    else if (scope === 'thread') p.thread[+a][b] = t.value;
    else if (scope === 'mfg') p.manufacturing[a] = t.value;
    else if (scope === 'meta') p.meta[a] = t.value;
    else if (scope === 'material') {
      if (a === 'preset') { const m = MATERIALS.find((x) => x.name === t.value); if (m) { p.material = { ...m }; p.manufacturing.material = m.name; } }
      else if (a === 'density') p.material.density = Math.max(0.01, parseFloat(t.value) || p.material.density);
    } else return;
    this.store.changed(live ? 'live' : scope);
  }

  // Features and parts that point at a requirement through their metadata.
  linksFor(reqId) {
    const out = [];
    const meta = this.store.project.featureMeta;
    for (const [key, m] of Object.entries(meta)) {
      if (m.requirement !== reqId) continue;
      const [partName, feat] = key.split('#');
      const p = this.viewer.parts.find((x) => x.name === partName);
      if (!p) continue;
      out.push({ key, label: feat || partName, link: feat ? `feature:${p.index}:${feat}` : `part:${p.index}` });
    }
    return out;
  }

  focusRequirement(id) {
    const links = this.linksFor(id);
    this.highlightReq = id;
    if (links.length) this.onLink(links[0].link);
    this.renderRequirements();
  }

  renderAll() {
    this.renderRequirements();
    this.renderManufacturing();
    this.renderThread();
    this.renderAnalysis();
  }

  renderRequirements() {
    const reqs = this.store.project?.requirements || [];
    const statusCell = (s) => `<span class="status-cell">${s === 'Verified' ? `<span class="ok-check">${icon('check')}</span>` : `<span class="dot ${STATUS_DOT[s] || 'idle'}"></span>`}${esc(s)}</span>`;
    document.getElementById('reqCompact').innerHTML = reqs.length
      ? `<table class="grid"><thead><tr><th>ID</th><th>Title</th><th>Status</th></tr></thead><tbody>${reqs.map((r) =>
        `<tr data-req="${esc(r.id)}" class="${this.highlightReq === r.id ? 'hl' : ''}" title="${esc(r.notes || '')}"><td>${esc(r.id)}</td><td>${esc(r.title)}</td><td>${statusCell(r.status)}</td></tr>`).join('')}</tbody></table>`
      : `<p class="details-empty">No requirements yet. <a href="#" class="link-btn" data-link="goto:requirements">Add one</a> and link it to features from the details panel.</p>`;
    document.getElementById('reqFull').innerHTML = `<table class="grid"><thead><tr><th style="width:120px">ID</th><th style="width:24%">Title</th><th style="width:150px">Status</th><th style="width:22%">Linked geometry</th><th>Notes</th><th style="width:40px"></th></tr></thead><tbody>${reqs.map((r, i) => {
      const links = this.linksFor(r.id);
      return `<tr class="${this.highlightReq === r.id ? 'hl' : ''}">
        <td><input data-field="req:${i}:id" value="${esc(r.id)}" /></td>
        <td><input data-field="req:${i}:title" value="${esc(r.title)}" /></td>
        <td><select data-field="req:${i}:status">${REQ_STATUSES.map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
        <td>${links.length ? links.map((l) => `<a href="#" class="link-btn" data-link="${esc(l.link)}">${esc(l.label)}</a>`).join(', ') : '<span class="details-empty">Link from a feature\'s details</span>'}</td>
        <td><input data-field="req:${i}:notes" value="${esc(r.notes || '')}" /></td>
        <td><button class="icon-btn sm row-del" data-del="requirements:${i}" title="Delete requirement">${icon('trash')}</button></td></tr>`;
    }).join('')}</tbody></table>${reqs.length ? '' : '<p class="details-empty">No requirements yet.</p>'}`;
  }

  renderManufacturing() {
    const m = this.store.project?.manufacturing; if (!m) return;
    const rows = [['Process', m.process], ['Material', m.material], ['Finish', m.finish], ['Critical feature', m.criticalFeature], ['Tolerance', m.tolerance], ['Notes', m.notes]];
    document.getElementById('mfgCompact').innerHTML = `<dl class="kv compact">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v ? esc(v) : '<span class="details-empty">Not set</span>'}</dd>`).join('')}</dl>`;
    const feats = this.viewer.parts.flatMap((p) => (p.data?.features || []).map((f) => f.name));
    const field = (key, label, ph) => `<label for="mfg-${key}">${label}</label><input id="mfg-${key}" class="live" data-field="mfg:${key}" value="${esc(m[key])}" placeholder="${ph}" ${key === 'criticalFeature' ? 'list="featList"' : ''}/>`;
    document.getElementById('mfgFull').innerHTML = `<div class="form-grid">
      ${field('process', 'Process', 'e.g. CNC Machining (5-Axis)')}
      ${field('material', 'Material', 'Material and spec')}
      ${field('finish', 'Finish', 'e.g. Bead blast per AMS 2488')}
      ${field('criticalFeature', 'Critical feature', 'Feature name and datum')}
      ${field('tolerance', 'General tolerance', 'e.g. ±0.005 in')}
      <label for="mfg-notes">Notes</label><textarea id="mfg-notes" class="live" rows="4" data-field="mfg:notes">${esc(m.notes)}</textarea>
    </div><datalist id="featList">${feats.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>`;
  }

  renderThread() {
    const th = this.store.project?.thread || [];
    const refLinks = (t) => String(t.refs || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map((r) => `<a href="#" data-link="thread:${esc(t.kind)}:${esc(r)}:${esc(t.href || '')}">${esc(r)}</a>`).join(', ');
    document.getElementById('threadCompact').innerHTML = th.length
      ? `<div class="thread-list">${th.map((t) => `${icon(THREAD_ICON[t.kind] || 'file')}<span>${esc(t.kind)}</span><span class="refs">${refLinks(t) || '<span class="details-empty">—</span>'}</span>`).join('')}</div>`
      : '<p class="details-empty">No linked records.</p>';
    document.getElementById('threadFull').innerHTML = `<table class="grid"><thead><tr><th style="width:180px">Record type</th><th>References (comma separated)</th><th style="width:34%">Link (optional URL)</th><th style="width:40px"></th></tr></thead><tbody>${th.map((t, i) => `<tr>
      <td><select data-field="thread:${i}:kind">${THREAD_KINDS.map((k) => `<option ${k === t.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
      <td><input data-field="thread:${i}:refs" value="${esc(t.refs)}" /></td>
      <td><input data-field="thread:${i}:href" value="${esc(t.href || '')}" placeholder="https://" /></td>
      <td><button class="icon-btn sm row-del" data-del="thread:${i}" title="Remove link">${icon('trash')}</button></td></tr>`).join('')}</tbody></table>
      <p class="page-note" style="margin-top:14px">References to requirement IDs open the Requirements view. Drawing, 3D Model and Manufacturing records open their views. Other records open their URL when one is set.</p>`;
  }

  renderAnalysis() {
    const v = this.viewer, p = this.store.project;
    const el = document.getElementById('analysisFull');
    if (!p || !v.parts.length) { el.innerHTML = '<p class="details-empty">Open a model to analyze it.</p>'; return; }
    const ready = v.parts.every((x) => x.data);
    const dens = p.material.density;
    let vol = 0, area = 0;
    v.parts.forEach((x) => { if (x.data) { vol += x.data.volume; area += x.data.area; } });
    const feats = v.parts.flatMap((x) => (x.data?.features || []).map((f) => ({ f, part: x })));
    const holes = feats.filter(({ f }) => f.kind === 'hole');
    const box = v.modelBox(true); const sz = box.getSize(new THREE.Vector3());
    document.getElementById('analysisActions').innerHTML = `<button class="btn" data-link="export-csv">${icon('download')}Export CSV</button>`;
    el.innerHTML = `
      <div class="form-grid" style="margin-bottom:18px">
        <label for="matPreset">Material</label>
        <select id="matPreset" data-field="material:preset">${MATERIALS.map((m) => `<option ${m.name === p.material.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}${MATERIALS.some((m) => m.name === p.material.name) ? '' : `<option selected>${esc(p.material.name)}</option>`}</select>
        <label for="matDensity">Density (g/cm³)</label>
        <input id="matDensity" type="number" step="0.01" min="0.01" data-field="material:density" value="${dens}" />
      </div>
      <div class="analysis-summary">
        <div><span>Parts</span><b>${v.parts.length}</b></div>
        <div><span>Envelope</span><b>${fmtLen(sz.x, false)} × ${fmtLen(sz.y, false)} × ${fmtLen(sz.z, false)}</b></div>
        <div><span>Volume</span><b>${fmtVol(vol)}</b></div>
        <div><span>Surface area</span><b>${fmtArea(area)}</b></div>
        <div><span>Mass</span><b>${fmtMass(massGrams(vol, dens))}</b></div>
        <div><span>Recognized features</span><b>${feats.length} (${holes.length} holes)</b></div>
      </div>
      ${ready ? '' : '<p class="details-empty">Geometry analysis is still running; totals will update.</p>'}
      <h3>Parts</h3>
      <table class="grid"><thead><tr><th>Part</th><th class="num">Volume</th><th class="num">Surface area</th><th class="num">Mass</th><th>Bounding box (${units.display})</th><th class="num">Faces</th><th class="num">Triangles</th><th class="num">Features</th></tr></thead>
      <tbody>${v.parts.map((x) => { const d = x.data; if (!d) return `<tr><td>${esc(x.name)}</td><td colspan="7" class="details-empty">Analyzing…</td></tr>`; const s = d.box.getSize(new THREE.Vector3());
        return `<tr data-part-row="${x.index}" style="cursor:pointer"><td>${esc(x.name)}${d.closed ? '' : ' <span class="details-empty">(open mesh)</span>'}</td><td class="num">${fmtVol(d.volume)}</td><td class="num">${fmtArea(d.area)}</td><td class="num">${fmtMass(massGrams(d.volume, dens))}</td><td>${fmtLen(s.x, false)} × ${fmtLen(s.y, false)} × ${fmtLen(s.z, false)}</td><td class="num">${d.faces.length.toLocaleString()}</td><td class="num">${d.triangles.toLocaleString()}</td><td class="num">${d.features.length}</td></tr>`; }).join('')}</tbody></table>
      <h3>Recognized features</h3>
      ${feats.length ? `<table class="grid"><thead><tr><th>Feature</th><th>Part</th><th>Type</th><th>Size</th><th>Depth</th><th>Pattern</th><th class="num">Volume removed</th><th class="num">Confidence</th></tr></thead><tbody>${feats.map(({ f, part }) => `<tr data-feat-row="${part.index}:${esc(f.name)}" style="cursor:pointer">
        <td>${esc(f.name)}</td><td>${esc(part.name)}</td><td>${esc(f.kind === 'pattern' ? `${f.arrangement} pattern` : f.type)}</td><td>${esc(featureLabel(f))}</td>
        <td>${f.kind === 'hole' ? (f.thru ? 'THRU ALL' : fmtLen(f.depth)) : ''}</td><td>${f.pattern ? esc(f.pattern) : ''}</td>
        <td class="num">${f.volumeRemoved ? fmtVol(f.volumeRemoved) : ''}</td><td class="num">${f.confidence != null ? f.confidence + '%' : ''}</td></tr>`).join('')}</tbody></table>`
        : '<p class="details-empty">No holes, fillets or bosses were recognized. Feature recognition works best on STEP, IGES and BREP files.</p>'}`;
  }

  exportCsv(name) {
    const v = this.viewer, dens = this.store.project.material.density;
    const rows = [['Part', `Volume (${units.display}^3)`, `Area (${units.display}^2)`, `Mass (${units.display === 'in' ? 'lb' : 'g'})`, 'Faces', 'Triangles', 'Features']];
    v.parts.forEach((x) => {
      const d = x.data; if (!d) return;
      const m = massGrams(d.volume, dens);
      rows.push([x.name, fmtVol(d.volume).split(' ')[0].replace(/,/g, ''), fmtArea(d.area).split(' ')[0].replace(/,/g, ''), units.display === 'in' ? (m / 453.59237).toFixed(4) : m.toFixed(2), d.faces.length, d.triangles, d.features.length]);
    });
    rows.push([]);
    rows.push(['Feature', 'Part', 'Type', 'Description', 'Depth', 'Pattern', 'Confidence']);
    v.parts.forEach((x) => (x.data?.features || []).forEach((f) => rows.push([f.name, x.name, f.type, featureLabel(f), f.kind === 'hole' ? (f.thru ? 'THRU ALL' : fmtLen(f.depth)) : '', f.pattern || '', f.confidence ?? ''])));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    download(`${name}-analysis.csv`, csv, 'text/csv');
  }
}
void fmtDia;

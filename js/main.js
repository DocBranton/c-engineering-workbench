import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { hydrateIcons, icon } from './icons.js';
import { units, esc, $, $$, toast, download, debounce, fmtLen, baseName } from './util.js';
import { Viewer } from './viewer.js';
import { loadFile, ACCEPTED } from './loaders.js';
import { buildSampleBracket } from './sample.js';
import { analyzePart } from './analysis.js';
import { Store, sampleProject, blankProject } from './store.js';
import { ModelTree, featureLabel } from './tree.js';
import { DetailsPanel } from './details.js';
import { Panels } from './panels.js';
import { generateDrawing } from './drawing.js';
import { Wingman } from './wingman.js';

hydrateIcons();

const viewer = new Viewer({ host: $('#canvasHost'), labels: $('#labels'), viewcube: $('#viewcube'), triad: $('#triad') });
const store = new Store();
let desc = null;
let analysisRun = 0;
let drawingCanvas = null;

const tree = new ModelTree($('#tree'), $('#treeSearch'), {
  onSelect: (n) => selectNode(n),
  onFit: (n) => { selectNode(n); viewer.fitToSelection = true; viewer.fit(true); },
  onVisibility: (parts, show) => viewer.setVisible(parts, show),
});
const details = new DetailsPanel($('#details'), { viewer, store, onLink: handleLink });
const panels = new Panels({ viewer, store, onLink: handleLink });
const wingman = new Wingman({ chatEl: $('#chat'), formEl: $('#chatForm'), inputEl: $('#chatText'), viewer, store, onLink: handleLink, openModal });

// ---------- model loading ----------
async function openModel(d) {
  analysisRun++;
  const run = analysisRun;
  desc = d;
  units.mmPerModelUnit = d.mmPerUnit;
  const pref = safeGet('ewb:units');
  units.display = pref || (d.mmPerUnit === 25.4 ? 'in' : 'mm');
  viewer.setModel(d);
  $('#emptyState').hidden = true;
  store.load(d, d.sample ? sampleProject(d) : blankProject(d));
  tree.setModel(d, viewer);
  tree.setMaterial(store.project.material);
  renderChrome();
  details.render();
  panels.renderAll();
  wingman.reset();
  updateStatus();
  await runAnalysis(run);
}

async function runAnalysis(run) {
  const counters = { hole: 0, fillet: 0, boss: 0, pattern: 0 };
  const t0 = performance.now();
  for (const p of viewer.parts) {
    if (run !== analysisRun) return;
    setStatusNote(`Analyzing ${p.index + 1} of ${viewer.parts.length}: ${p.name}`);
    await new Promise((r) => setTimeout(r, 0));
    try { p.data = analyzePart(p.src, counters); } catch (e) { console.error(e); p.data = null; }
  }
  if (run !== analysisRun) return;
  setStatusNote(`Analysis done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  tree.setFeatures();
  if (desc.sample && store.fresh) seedSampleProject();
  details.render();
  panels.renderAll();
  updateStatus();
  regenDrawing();
  if (desc.sample) {
    const main = viewer.parts[0]?.data?.features.find((f) => f.type === 'Counterbore');
    if (main) {
      viewer.pick = 'feature';
      $$('#pickFilter button').forEach((b) => b.classList.toggle('active', b.dataset.pick === 'feature'));
      viewer.select({ kind: 'feature', part: 0, feature: main.name });
      wingman.ask(`Explain the design intent of ${main.name} and how it relates to REQ-042.`);
    }
  }
}

function seedSampleProject() {
  const p = store.project;
  const up = viewer.parts[0], plate = viewer.parts[1];
  const main = up?.data?.features.find((f) => f.type === 'Counterbore');
  const light = up?.data?.features.find((f) => f.type === 'Hole');
  const pattern = plate?.data?.features.find((f) => f.kind === 'pattern');
  if (main) {
    Object.assign(store.featureMeta(`${up.name}#${main.name}`), { drawing: 'Sheet 2, Zone D4', dimension: 'DIM-117', requirement: 'REQ-042', specification: 'AS9100-5612', condition: 'Apply after coating', status: 'Engineer Confirmed', notes: '' });
    p.manufacturing.criticalFeature = `${main.name}, Datum A`;
  }
  if (light) Object.assign(store.featureMeta(`${up.name}#${light.name}`), { drawing: 'Sheet 2, Zone C5', dimension: 'DIM-121', requirement: 'REQ-061', status: 'In Review' });
  if (pattern) Object.assign(store.featureMeta(`${plate.name}#${pattern.name}`), { drawing: 'Sheet 1, Zone B2', dimension: 'DIM-104', requirement: 'REQ-042', status: 'Engineer Confirmed' });
  Object.assign(store.featureMeta(up.name), { requirement: 'REQ-087', specification: 'AMS 4928', status: 'Engineer Confirmed' });
  store.changed('seed');
}

async function openFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!ACCEPTED.includes(ext)) { toast(`.${ext} files can't be opened. Use STEP, IGES, BREP, STL, OBJ or glTF.`, 'error'); return; }
  showLoading(`Reading ${file.name}`);
  try {
    const d = await loadFile(file, (msg) => showLoading(msg));
    showLoading('Building the scene');
    await new Promise((r) => setTimeout(r, 20));
    await openModel(d);
    toast(`Opened ${file.name}: ${d.meshes.length} part${d.meshes.length > 1 ? 's' : ''}`);
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error');
  } finally { hideLoading(); }
}

function showLoading(msg) { $('#loading').hidden = false; $('#loadingText').textContent = msg; }
function hideLoading() { $('#loading').hidden = true; }

// ---------- selection plumbing ----------
function selectNode(n) {
  if (!n) return;
  if (n.type === 'part') viewer.select({ kind: 'part', part: n.partIdx });
  else if (n.type === 'assembly') viewer.select({ kind: 'assembly', parts: n.parts, key: n.key, name: n.name });
  else if (n.type === 'feature') viewer.select({ kind: 'feature', part: n.partIdx, feature: n.feature });
  else if (n.type === 'material') switchTab('analysis');
}

viewer.addEventListener('select', () => { tree.setSelection(viewer.selection); details.render(); });
viewer.addEventListener('visibility', () => { tree.render(); details.render(); regenDrawing(); setToolState(); });
viewer.addEventListener('explode', debounce(() => regenDrawing(), 500));
viewer.addEventListener('section', debounce(() => regenDrawing(), 500));
viewer.addEventListener('hover', (e) => {
  const h = e.detail;
  $('#hoverInfo') && ($('#hoverInfo').textContent = h ? `${viewer.parts[h.part].name}  ·  ${fmtLen(h.point.x, false)}, ${fmtLen(h.point.y, false)}, ${fmtLen(h.point.z, false)}` : '');
});
viewer.addEventListener('measure', (e) => {
  const m = e.detail, el = $('#measureReadout');
  if (!m || !m.points.length) { el.hidden = viewer.tool !== 'measure'; el.innerHTML = 'Pick the first point'; return; }
  el.hidden = false;
  if (!m.result) {
    const f = m.points[0].face;
    el.innerHTML = `Pick the second point${f?.type === 'cylinder' ? ` · first face is Ø${fmtLen(2 * f.radius)}` : ''}`;
    return;
  }
  const r = m.result;
  el.innerHTML = `<span>Distance <b>${fmtLen(r.distance)}</b></span><span>ΔX ${fmtLen(Math.abs(r.delta.x), false)}</span><span>ΔY ${fmtLen(Math.abs(r.delta.y), false)}</span><span>ΔZ ${fmtLen(Math.abs(r.delta.z), false)}</span>${r.planeGap != null ? `<span>Face gap <b>${fmtLen(r.planeGap)}</b></span>` : ''}<button class="link-btn" id="measureClear">Clear</button>`;
  $('#measureClear').onclick = () => { viewer.clearMeasure(); };
});

store.addEventListener('change', (e) => {
  const what = e.detail;
  if (what === 'live') { panels.renderManufacturing(); return; }
  renderChrome();
  if (what !== 'meta') panels.renderAll(); else panels.renderRequirements();
  if (what === 'material' || what === 'import' || what === 'load') { tree.setMaterial(store.project.material); details.render(); }
  if (['meta', 'material', 'thread', 'import'].includes(what)) regenDrawing();
});

// ---------- links ----------
function handleLink(link) {
  const [kind, ...rest] = link.split(':');
  if (kind === 'goto') {
    switchTab(rest[0]);
    if (rest[0] === 'requirements' && rest[1]) { panels.highlightReq = rest[1]; panels.renderRequirements(); }
  } else if (kind === 'part') {
    switchTab('model'); viewer.select({ kind: 'part', part: +rest[0] });
  } else if (kind === 'feature') {
    switchTab('model');
    const part = +rest[0], name = rest.slice(1).join(':');
    viewer.select({ kind: 'feature', part, feature: name });
  } else if (kind === 'show') {
    viewer.setVisible([+rest[0]], true);
  } else if (kind === 'fit-selection') {
    viewer.fitToSelection = true; viewer.fit(true);
  } else if (kind === 'copy-ref') {
    const s = viewer.selection; if (!s) return;
    const p = viewer.parts[s.part];
    const ref = s.kind === 'feature' ? `${desc.fileName} › ${p.name} › ${s.feature}` : s.kind === 'face' ? `${desc.fileName} › ${p.name} › Face ${s.faceId + 1}` : s.kind === 'assembly' ? `${desc.fileName} › ${s.name}` : `${desc.fileName} › ${p.name}`;
    navigator.clipboard?.writeText(ref).then(() => toast('Reference copied'), () => toast(ref));
  } else if (kind === 'thread') {
    const [tk, ref, ...hrefParts] = rest;
    const href = hrefParts.join(':');
    const req = store.project.requirements.find((r) => r.id === ref);
    if (req) { handleLink(`goto:requirements:${req.id}`); return; }
    if (tk === 'Drawing') return switchTab('drawings');
    if (tk === '3D Model') return switchTab('model');
    if (tk === 'Manufacturing') return switchTab('manufacturing');
    if (/^https?:\/\//.test(href)) { window.open(href, '_blank', 'noopener'); return; }
    toast(`${ref}: add a URL on the Digital Thread tab to open this record.`);
  } else if (kind === 'export-csv') {
    panels.exportCsv(baseName(desc?.fileName || 'model'));
  }
}

// ---------- chrome ----------
function renderChrome() {
  const m = store.project?.meta;
  if (!m) return;
  $('#breadcrumbs').innerHTML = [m.program, m.structure, m.assembly, m.rev].filter(Boolean)
    .map((s) => `<button data-action="project-edit">${esc(s)}</button>`).join('<span class="sep">›</span>');
  $('#avatarBtn').textContent = (m.initials || 'EW').slice(0, 3).toUpperCase();
  document.title = `${m.assembly || desc?.name || 'Model'} · Engineering Workbench`;
}

let statusNote = '';
function setStatusNote(s) { statusNote = s; updateStatus(); }
function updateStatus() {
  if (!desc) { $('#statusBar').innerHTML = ''; return; }
  const tris = viewer.parts.reduce((s, p) => s + p.mesh.geometry.index.count / 3, 0);
  $('#statusBar').innerHTML = `<span><b>${esc(desc.fileName)}</b></span><span>${viewer.parts.length} parts</span><span>${tris.toLocaleString()} triangles</span><span>Units: ${units.display}</span><span id="hoverInfo"></span><span style="margin-left:auto">${esc(statusNote)}</span>`;
}

const regenDrawing = debounce(() => {
  if (!viewer.parts.length || !store.project) return;
  try {
    drawingCanvas = generateDrawing(viewer, store.project, desc);
    const url = drawingCanvas.toDataURL('image/png');
    $('#drawingThumb').innerHTML = `<img alt="Generated drawing sheet" src="${url}">`;
    const full = $('#drawingFull'); full.innerHTML = ''; full.appendChild(drawingCanvas);
  } catch (e) { console.error(e); $('#drawingThumb').innerHTML = '<span class="ph">The drawing could not be generated.</span>'; }
}, 250);

// ---------- tabs ----------
function switchTab(tab) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#view-model').hidden = tab !== 'model';
  ['drawings', 'requirements', 'analysis', 'manufacturing', 'thread'].forEach((t) => { $(`#view-${t}`).hidden = t !== tab; });
  if (tab === 'model') requestAnimationFrame(() => viewer.resize());
  if (tab === 'analysis') panels.renderAnalysis();
  if (tab === 'drawings' && !drawingCanvas) regenDrawing();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));
$('#drawingThumb').addEventListener('click', () => switchTab('drawings'));
$('#drawingRefresh').addEventListener('click', () => regenDrawing());
$('#drawingRegen').addEventListener('click', () => regenDrawing());

// ---------- toolbar ----------
const popovers = { section: '#sectionPop', explode: '#explodePop', appearance: '#appearancePop', views: '#viewsPop' };
function togglePopover(name, btn) {
  for (const [k, sel] of Object.entries(popovers)) {
    const el = $(sel);
    if (k === name && el.hidden) {
      el.hidden = false;
      const vr = $('#viewport').getBoundingClientRect(), br = btn.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(vr.width - el.offsetWidth - 8, br.left - vr.left))}px`;
    } else el.hidden = true;
  }
}
function closePopovers() { Object.values(popovers).forEach((s) => { $(s).hidden = true; }); }

function setToolState() {
  $$('#toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === viewer.tool));
  $('[data-cmd="section"]').classList.toggle('on', viewer.section.enabled);
  $('[data-cmd="explode"]').classList.toggle('on', viewer.explode > 0);
  $('[data-cmd="isolate"]').classList.toggle('on', !!viewer.isolated);
  $('[data-cmd="annotations"]').classList.toggle('on', viewer.annotations);
}

function selectedParts() {
  const s = viewer.selection;
  if (!s) return [];
  return s.kind === 'assembly' ? s.parts : [s.part];
}

function runCommand(cmd, btn) {
  if (!viewer.parts.length && !['views', 'appearance'].includes(cmd)) return;
  switch (cmd) {
    case 'fit': viewer.fitToSelection = false; viewer.fit(true); break;
    case 'section':
      if (!viewer.section.enabled) viewer.setSection({ enabled: true });
      togglePopover('section', btn); syncSectionUI(); break;
    case 'explode': togglePopover('explode', btn); break;
    case 'appearance': togglePopover('appearance', btn); break;
    case 'views': togglePopover('views', btn); break;
    case 'hide': {
      const sp = selectedParts();
      if (sp.length) { viewer.setVisible(sp, false); toast(`Hidden. Press H with nothing selected to show all.`); }
      else if (viewer.parts.some((p) => !p.visible)) viewer.setVisible(viewer.parts.map((p) => p.index), true);
      else toast('Select a part to hide it.');
      break;
    }
    case 'isolate': {
      const sp = selectedParts();
      if (!viewer.isolated && !sp.length) { toast('Select a part or assembly to isolate it.'); break; }
      viewer.isolate(sp);
      viewer.fit(true);
      break;
    }
    case 'annotations': viewer.setAnnotations(!viewer.annotations); break;
  }
  setToolState();
}

$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tool) {
    viewer.setTool(b.dataset.tool);
    $('#measureReadout').hidden = b.dataset.tool !== 'measure';
    if (b.dataset.tool === 'measure') $('#measureReadout').innerHTML = 'Pick the first point';
    closePopovers();
  }
  if (b.dataset.cmd) runCommand(b.dataset.cmd, b);
  setToolState();
});
$('#pickFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  viewer.pick = b.dataset.pick;
  $$('#pickFilter button').forEach((x) => x.classList.toggle('active', x === b));
});

function syncSectionUI() {
  const s = viewer.section;
  $$('#sectionAxis button').forEach((b) => b.classList.toggle('active', b.dataset.axis === s.axis));
  $('#sectionOffset').value = s.t;
  $('#sectionValue').textContent = s.enabled ? `${s.axis.toUpperCase()} = ${fmtLen(viewer.sectionValue ?? 0)}` : 'Off';
}
$('#sectionAxis').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; viewer.setSection({ enabled: true, axis: b.dataset.axis }); syncSectionUI(); setToolState(); });
$('#sectionOffset').addEventListener('input', (e) => { viewer.setSection({ enabled: true, t: +e.target.value }); syncSectionUI(); setToolState(); });
$('#sectionFlip').addEventListener('click', () => { viewer.setSection({ flip: !viewer.section.flip }); syncSectionUI(); });
$('#sectionOff').addEventListener('click', () => { viewer.setSection({ enabled: false }); syncSectionUI(); closePopovers(); setToolState(); });
$('#explodeAmount').addEventListener('input', (e) => { viewer.setExplode(+e.target.value); $('#explodeValue').textContent = `${Math.round(e.target.value * 100)}%`; setToolState(); });
$('#explodeReset').addEventListener('click', () => { viewer.setExplode(0); $('#explodeAmount').value = 0; $('#explodeValue').textContent = '0%'; setToolState(); });
$('#displayMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; viewer.displayMode = b.dataset.mode; viewer.applyDisplayMode(); $$('#displayMode button').forEach((x) => x.classList.toggle('active', x === b)); });
$('#materialLook').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; viewer.look = b.dataset.look; viewer.applyLook(); $$('#materialLook button').forEach((x) => x.classList.toggle('active', x === b)); });
$('#viewsList').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; viewer.setView(b.dataset.view); closePopovers(); });
$('#orthoToggle').addEventListener('change', (e) => viewer.setOrthographic(e.target.checked));
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.popover, #toolbar')) closePopovers();
  if (!e.target.closest('.menu-wrap')) $$('.menu').forEach((m) => { m.hidden = true; });
  if (!e.target.closest('.search')) $('#searchResults').hidden = true;
});

// ---------- menus & actions ----------
function bindMenu(btnSel, menuSel) {
  $(btnSel).addEventListener('click', () => { const m = $(menuSel); const open = m.hidden; $$('.menu').forEach((x) => { x.hidden = true; }); m.hidden = !open; });
}
bindMenu('#exportBtn', '#exportMenu');
bindMenu('#moreBtn', '#moreMenu');
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]'); if (!a) return;
  $$('.menu').forEach((m) => { m.hidden = true; });
  doAction(a.dataset.action);
});

function doAction(action) {
  const name = baseName(desc?.fileName || 'model');
  switch (action) {
    case 'open': $('#fileInput').click(); break;
    case 'sample': openModel(buildSampleBracket()); break;
    case 'export-png': if (desc) download(`${name}-view.png`, dataUrlToBlob(viewer.screenshot())); break;
    case 'export-drawing':
      if (!drawingCanvas) regenDrawing();
      setTimeout(() => drawingCanvas && drawingCanvas.toBlob((b) => download(`${name}-drawing.png`, b)), 300);
      break;
    case 'export-glb': exportModel('glb'); break;
    case 'export-stl': exportModel('stl'); break;
    case 'project-export': if (store.project) download(`${name}-project.json`, JSON.stringify(store.project, null, 2), 'application/json'); break;
    case 'project-import': $('#projectInput').click(); break;
    case 'project-reset':
      if (!desc) break;
      openModal(`<h3>Reset project data?</h3><p>Requirements, manufacturing notes, digital thread links and feature metadata for this model go back to their defaults. The model file isn't changed.</p><div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn danger" value="ok">Reset project data</button></div>`,
        (_, v) => { if (v === 'ok') { store.reset(desc.sample ? sampleProject(desc) : blankProject(desc)); if (desc.sample) seedSampleProject(); toast('Project data reset'); } });
      break;
    case 'units-in': setUnits('in'); break;
    case 'units-mm': setUnits('mm'); break;
    case 'project-edit': editProject(); break;
  }
}

function setUnits(u) {
  units.display = u;
  try { localStorage.setItem('ewb:units', u); } catch { /* ignore */ }
  tree.setFeatures(); details.render(); panels.renderAll(); viewer.refreshAnnotations(); updateStatus(); regenDrawing();
  toast(`Showing ${u === 'in' ? 'inches' : 'millimeters'}`);
}

function exportModel(kind) {
  if (!desc) return;
  const group = new THREE.Group();
  for (const p of viewer.parts) {
    if (!p.visible) continue;
    const m = new THREE.Mesh(p.mesh.geometry, new THREE.MeshStandardMaterial({ color: p.mesh.material.color, metalness: p.mesh.material.metalness, roughness: p.mesh.material.roughness }));
    m.name = p.name; m.position.copy(p.mesh.position);
    group.add(m);
  }
  const name = baseName(desc.fileName);
  if (kind === 'stl') {
    const data = new STLExporter().parse(group, { binary: true });
    download(`${name}.stl`, data, 'model/stl');
  } else {
    // glTF is metres; scale from model units.
    group.scale.setScalar(units.mmPerModelUnit / 1000);
    new GLTFExporter().parse(group, (res) => download(`${name}.glb`, res, 'model/gltf-binary'), (err) => toast('Export failed: ' + err.message, 'error'), { binary: true });
  }
}

function dataUrlToBlob(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: head.match(/:(.*?);/)[1] });
}

function editProject() {
  const m = store.project?.meta; if (!m) return;
  openModal(`<h3>Project details</h3><p>Shown in the breadcrumb and on the drawing title block.</p>
    <div class="fields">
      <label>Program<input name="program" value="${esc(m.program)}"></label>
      <label>Structure<input name="structure" value="${esc(m.structure)}"></label>
      <label>Assembly<input name="assembly" value="${esc(m.assembly)}"></label>
      <label>Revision<input name="rev" value="${esc(m.rev)}"></label>
      <label>Your initials<input name="initials" maxlength="3" value="${esc(m.initials)}"></label>
    </div>
    <div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Save details</button></div>`,
  (dlg, v) => {
    if (v !== 'ok') return;
    dlg.querySelectorAll('input[name]').forEach((i) => { m[i.name] = i.value.trim(); });
    store.changed('meta');
  });
}

function openModal(html, onClose) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">${html}</form>`;
  hydrateIcons(dlg);
  dlg.onclose = () => onClose?.(dlg, dlg.returnValue);
  dlg.returnValue = '';
  dlg.showModal();
}

$('#avatarBtn').addEventListener('click', editProject);
$('#helpBtn').addEventListener('click', () => openModal(`<h3>Shortcuts and help</h3>
  <div class="shortcuts">
    <kbd>S</kbd><span>Select tool</span><kbd>P</kbd><span>Pan tool</span><kbd>R</kbd><span>Rotate tool</span><kbd>Z</kbd><span>Zoom tool</span>
    <kbd>M</kbd><span>Measure two points</span><kbd>F</kbd><span>Fit all (with a selection: fit selection)</span>
    <kbd>X</kbd><span>Section plane</span><kbd>E</kbd><span>Explode</span><kbd>H</kbd><span>Hide selection, or show all</span>
    <kbd>I</kbd><span>Isolate selection</span><kbd>A</kbd><span>Annotations on/off</span><kbd>1–7</kbd><span>Iso, front, back, top, bottom, left, right</span>
    <kbd>Esc</kbd><span>Clear selection and measurements</span>
  </div>
  <p>Files open in your browser; nothing is uploaded. STEP, IGES and BREP files are tessellated by OpenCascade compiled to WebAssembly, which keeps B-rep faces so holes, counterbores, fillets and patterns can be recognized.</p>
  <div class="modal-actions"><button class="btn primary" value="ok">Done</button></div>`));
$('#wingmanSettings').addEventListener('click', () => wingman.openSettings());
$('#wingmanClear').addEventListener('click', () => wingman.reset());

$('#openBtn').addEventListener('click', () => $('#fileInput').click());
$('#sampleBtn').addEventListener('click', () => openModel(buildSampleBracket()));
$('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; });
$('#projectInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { store.import(await f.text()); toast('Project data imported'); } catch (err) { toast(err.message, 'error'); }
});

// Drag and drop onto the viewport.
const vp = $('#viewport');
let dragDepth = 0;
vp.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropHint').hidden = false; });
vp.addEventListener('dragover', (e) => e.preventDefault());
vp.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
vp.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
  const f = e.dataTransfer.files[0]; if (f) openFile(f);
});

// ---------- global search ----------
const searchInput = $('#globalSearch'), searchResults = $('#searchResults');
let searchItems = [], searchIdx = 0;
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { searchResults.hidden = true; return; }
  const items = [];
  viewer.parts.forEach((p) => {
    if (p.name.toLowerCase().includes(q)) items.push({ kind: 'Part', label: p.name, link: `part:${p.index}` });
    (p.data?.features || []).forEach((f) => { const l = `${f.name} ${featureLabel(f)}`; if (l.toLowerCase().includes(q)) items.push({ kind: 'Feature', label: `${f.name} · ${featureLabel(f)}`, link: `feature:${p.index}:${f.name}` }); });
  });
  (store.project?.requirements || []).forEach((r) => { if (`${r.id} ${r.title} ${r.notes}`.toLowerCase().includes(q)) items.push({ kind: 'Requirement', label: `${r.id} ${r.title}`, link: `goto:requirements:${r.id}` }); });
  (store.project?.thread || []).forEach((t) => { if (`${t.kind} ${t.refs}`.toLowerCase().includes(q)) items.push({ kind: t.kind, label: t.refs, link: `thread:${t.kind}:${String(t.refs).split(',')[0].trim()}:${t.href || ''}` }); });
  if ('drawing'.includes(q) || q.startsWith('dwg')) items.push({ kind: 'Drawing', label: 'Generated drawing sheet', link: 'goto:drawings' });
  searchItems = items.slice(0, 20); searchIdx = 0;
  renderSearch();
});
function renderSearch() {
  searchResults.hidden = false;
  searchResults.innerHTML = searchItems.length
    ? searchItems.map((it, i) => `<button class="${i === searchIdx ? 'on' : ''}" data-i="${i}"><span class="kind">${esc(it.kind)}</span><span>${esc(it.label)}</span></button>`).join('')
    : '<div class="none">No matches in parts, features, requirements or records.</div>';
}
searchResults.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pickSearch(+b.dataset.i); });
searchInput.addEventListener('keydown', (e) => {
  if (searchResults.hidden || !searchItems.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); searchIdx = (searchIdx + 1) % searchItems.length; renderSearch(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); searchIdx = (searchIdx - 1 + searchItems.length) % searchItems.length; renderSearch(); }
  if (e.key === 'Enter') { e.preventDefault(); pickSearch(searchIdx); }
  if (e.key === 'Escape') searchResults.hidden = true;
});
function pickSearch(i) { const it = searchItems[i]; if (!it) return; searchResults.hidden = true; searchInput.blur(); handleLink(it.link); }

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const toolKeys = { s: 'select', p: 'pan', r: 'rotate', z: 'zoom', m: 'measure' };
  if (toolKeys[k]) { $(`[data-tool="${toolKeys[k]}"]`).click(); return; }
  const cmdKeys = { f: 'fit', x: 'section', e: 'explode', h: 'hide', i: 'isolate', a: 'annotations' };
  if (cmdKeys[k]) {
    if (k === 'f' && viewer.selection) { viewer.fitToSelection = true; viewer.fit(true); return; }
    $(`[data-cmd="${cmdKeys[k]}"]`).click(); return;
  }
  const views = ['iso', 'front', 'back', 'top', 'bottom', 'left', 'right'];
  if (/^[1-7]$/.test(k)) { viewer.setView(views[+k - 1]); return; }
  if (k === 'escape') { closePopovers(); viewer.clearMeasure(); viewer.clearSelection(); }
});

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }

// ---------- start ----------
setToolState();
const params = new URLSearchParams(location.search);
if (params.get('empty') === '1') { $('#emptyState').hidden = false; tree.render(); details.render(); }
else openModel(buildSampleBracket());

window.__ewb = { viewer, store, tree, openFile, openModel, handleLink, switchTab, setUnits };
void icon;

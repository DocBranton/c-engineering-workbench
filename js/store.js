// Project data (requirements, manufacturing, digital thread, feature metadata),
// kept per model in the browser and portable as JSON.
import { debounce } from './util.js';

export const MATERIALS = [
  { name: 'Ti-6Al-4V (AMS 4928)', density: 4.43 },
  { name: 'Aluminum 6061-T6', density: 2.70 },
  { name: 'Aluminum 7075-T6', density: 2.81 },
  { name: '17-4 PH Stainless (H1025)', density: 7.78 },
  { name: '304 Stainless', density: 8.00 },
  { name: 'Inconel 718', density: 8.19 },
  { name: 'Carbon steel 4340', density: 7.85 },
  { name: 'PEEK', density: 1.32 },
  { name: 'ABS', density: 1.05 },
];

export const REQ_STATUSES = ['Verified', 'In Progress', 'Planned', 'Failed'];
export const FEATURE_STATUSES = ['Draft', 'In Review', 'Engineer Confirmed', 'Rejected'];
export const THREAD_KINDS = ['Drawing', '3D Model', 'Requirements', 'Manufacturing', 'Inspection', 'Test', 'Change order', 'Supplier'];

export function blankProject(model) {
  return {
    version: 1,
    meta: { program: 'Programs', structure: model.format ? `${model.format} import` : 'Imports', assembly: model.name, rev: 'REV A', initials: 'EW' },
    material: { ...MATERIALS[1] },
    requirements: [],
    manufacturing: { process: '', material: MATERIALS[1].name, finish: '', criticalFeature: '', tolerance: '', notes: '' },
    thread: [{ kind: '3D Model', refs: model.fileName, href: '' }],
    featureMeta: {},
  };
}

export function sampleProject(model) {
  return {
    version: 1,
    meta: { program: 'Aerospace Programs', structure: 'Wing Structure', assembly: 'Bracket Assembly', rev: 'REV B', initials: 'EW' },
    material: { ...MATERIALS[0] },
    requirements: [
      { id: 'REQ-042', title: 'Mounting Interface', status: 'Verified', feature: '', notes: 'Accepts a 3/8" mounting fastener; counterbore for flush installation.' },
      { id: 'REQ-061', title: 'Weight Reduction', status: 'In Progress', feature: '', notes: 'Bracket assembly mass below 0.50 lb.' },
      { id: 'REQ-087', title: 'Material Specification', status: 'Verified', feature: '', notes: 'Ti-6Al-4V per AMS 4928.' },
      { id: 'REQ-101', title: 'Manufacturing Process', status: 'Planned', feature: '', notes: '5-axis CNC from billet.' },
    ],
    manufacturing: {
      process: 'CNC Machining (5-Axis)', material: MATERIALS[0].name, finish: 'Bead Blast per AMS 2488',
      criticalFeature: '', tolerance: '±0.005 in', notes: 'Deburr all edges, no sharp corners',
    },
    thread: [
      { kind: 'Drawing', refs: 'BRKT-001-02 (Sheet 2)', href: '' },
      { kind: '3D Model', refs: model.fileName, href: '' },
      { kind: 'Requirements', refs: 'REQ-042, REQ-061, REQ-087', href: '' },
      { kind: 'Manufacturing', refs: 'MFG-2231', href: '' },
      { kind: 'Inspection', refs: 'INSP-5567', href: '' },
      { kind: 'Test', refs: 'TST-7781', href: '' },
    ],
    featureMeta: {},
  };
}

const KEY = (k) => `ewb:project:${k}`;

export class Store extends EventTarget {
  constructor() { super(); this.project = null; this.key = null; this.saveSoon = debounce(() => this.save(), 400); }

  load(model, fallback) {
    this.key = `${model.fileName}:${model.meshes.length}`;
    let p = null;
    try { p = JSON.parse(localStorage.getItem(KEY(this.key)) || 'null'); } catch { p = null; }
    this.project = p && p.version === 1 ? p : fallback;
    this.fresh = !p;
    this.changed('load');
    return this.project;
  }

  save() {
    try { localStorage.setItem(KEY(this.key), JSON.stringify(this.project)); } catch { /* storage unavailable: keep in memory */ }
  }

  changed(what = 'edit') {
    if (what !== 'load') this.saveSoon();
    this.dispatchEvent(new CustomEvent('change', { detail: what }));
  }

  reset(fallback) {
    try { localStorage.removeItem(KEY(this.key)); } catch { /* ignore */ }
    this.project = fallback;
    this.changed('load');
  }

  import(json) {
    const p = typeof json === 'string' ? JSON.parse(json) : json;
    if (!p || p.version !== 1 || !Array.isArray(p.requirements)) throw new Error('This JSON file is not Engineering Workbench project data.');
    this.project = p;
    this.changed('import');
  }

  featureMeta(key) {
    const m = this.project.featureMeta;
    if (!m[key]) m[key] = { drawing: '', dimension: '', requirement: '', specification: '', condition: '', status: 'Draft', notes: '' };
    return m[key];
  }
}

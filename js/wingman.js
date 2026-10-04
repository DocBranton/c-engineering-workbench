// AI Wingman: answers questions about the open model.
// Built-in answers come from the geometry analysis and project data; with a Claude API key
// set in the assistant settings, questions go to Claude with the model summary as context.
import * as THREE from 'three';
import { icon } from './icons.js';
import { esc, fmtLen, fmtVol, fmtArea, fmtMass, fmtDia, massGrams, units, toDisplay } from './util.js';
import { featureLabel } from './tree.js';

const SETTINGS_KEY = 'ewb:assistant';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

export class Wingman {
  constructor({ chatEl, formEl, inputEl, viewer, store, onLink, openModal }) {
    this.chat = chatEl; this.input = inputEl; this.viewer = viewer; this.store = store; this.onLink = onLink; this.openModal = openModal;
    this.history = [];
    this.settings = { apiKey: '', model: DEFAULT_MODEL, remember: false };
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* ignore */ }
    formEl.addEventListener('submit', (e) => { e.preventDefault(); const q = inputEl.value.trim(); if (q) { inputEl.value = ''; this.ask(q); } });
    chatEl.addEventListener('click', (e) => {
      const h = e.target.closest('[data-ask]'); if (h) this.ask(h.dataset.ask);
      const a = e.target.closest('[data-link]'); if (a) { e.preventDefault(); onLink(a.dataset.link); }
    });
    this.reset();
  }

  reset() {
    this.history = [];
    this.chat.innerHTML = '';
    this.botHtml(`<p>Ask about dimensions, mass, holes, requirements or manufacturability. Select a feature first to ask about it directly.</p>
      <div class="chat-hints">${['Explain the selected feature', 'What does the model weigh?', 'List the holes', 'Check manufacturability'].map((h) => `<button data-ask="${h}">${h}</button>`).join('')}</div>`);
  }

  userMsg(text) {
    const d = document.createElement('div'); d.className = 'msg user'; d.textContent = text;
    this.chat.appendChild(d); this.chat.scrollTop = this.chat.scrollHeight;
  }
  botHtml(html, cls = '') {
    const d = document.createElement('div'); d.className = `msg bot ${cls}`;
    d.innerHTML = `<span class="bot-mark">${icon('logo')}</span><div>${html}</div>`;
    this.chat.appendChild(d); this.chat.scrollTop = this.chat.scrollHeight;
    return d;
  }

  async ask(q) {
    this.userMsg(q);
    if (this.settings.apiKey) {
      const wait = this.botHtml('<p>Thinking…</p>', 'thinking');
      try {
        const text = await this.askClaude(q);
        wait.remove();
        this.botHtml(md(text));
      } catch (err) {
        wait.remove();
        this.botHtml(`<p>Claude couldn't be reached: ${esc(err.message)}. Here's the built-in answer instead.</p>` + this.local(q));
      }
      return;
    }
    this.botHtml(this.local(q));
  }

  // ---------- context ----------
  allFeatures() { return this.viewer.parts.flatMap((p) => (p.data?.features || []).map((f) => ({ f, p }))); }
  findFeature(name) { return this.allFeatures().find(({ f }) => f.name.toLowerCase() === name.toLowerCase()); }

  summary() {
    const v = this.viewer, pr = this.store.project, dens = pr.material.density;
    let vol = 0, area = 0;
    v.parts.forEach((p) => { if (p.data) { vol += p.data.volume; area += p.data.area; } });
    const box = v.modelBox(true), s = box.getSize(new THREE.Vector3());
    return { vol, area, mass: massGrams(vol, dens), size: s, dens };
  }

  // ---------- built-in answers ----------
  local(q) {
    const v = this.viewer, pr = this.store.project;
    if (!v.parts.length) return '<p>Open a model first, then ask me about it.</p>';
    const ql = q.toLowerCase();
    const named = q.match(/\b(hole|pattern|fillet|boss)\d{3}\b/i);
    const reqId = q.match(/\bREQ-\d+\b/i)?.[0]?.toUpperCase();
    const sel = v.selection;
    const selFeat = v.featureOf(sel);

    if (named || /explain|intent|tell me about|what is this|describe|selected/.test(ql)) {
      let target = named ? this.findFeature(named[0]) : selFeat ? { f: selFeat, p: v.parts[sel.part] } : null;
      if (!target && sel?.kind === 'part') return this.describePart(v.parts[sel.part], reqId);
      if (!target) {
        const first = this.allFeatures().find(({ f }) => f.kind === 'hole');
        if (!first) return '<p>Select a feature or part first (use the Features filter in the viewport), then ask again.</p>';
        target = first;
      }
      return this.describeFeature(target.f, target.p, reqId);
    }
    if (reqId) return this.describeRequirement(reqId);
    if (/weigh|mass|heavy|volume/.test(ql)) {
      const s = this.summary();
      if (sel?.kind === 'part' && v.parts[sel.part].data) {
        const d = v.parts[sel.part].data;
        return `<p><b>${esc(v.parts[sel.part].name)}</b> has a volume of ${fmtVol(d.volume)} and weighs ${fmtMass(massGrams(d.volume, s.dens))} in ${esc(pr.material.name)} (${s.dens} g/cm³).</p><p>The whole model weighs ${fmtMass(s.mass)}.</p>`;
      }
      const heaviest = v.parts.filter((p) => p.data).sort((a, b) => b.data.volume - a.data.volume).slice(0, 3);
      return `<p>The model's volume is ${fmtVol(s.vol)}, so it weighs <b>${fmtMass(s.mass)}</b> in ${esc(pr.material.name)} (${s.dens} g/cm³). Change the material on the <a href="#" data-link="goto:analysis">Analysis</a> tab.</p>` +
        (heaviest.length > 1 ? `<p>Heaviest parts:</p><ul>${heaviest.map((p) => `<li><a href="#" data-link="part:${p.index}">${esc(p.name)}</a>: ${fmtMass(massGrams(p.data.volume, s.dens))}</li>`).join('')}</ul>` : '');
    }
    if (/size|dimension|envelope|bounding|how big|how large|tall|wide|long/.test(ql)) {
      const s = this.summary();
      return `<p>The overall envelope is <b>${fmtLen(s.size.x)}</b> (X) × <b>${fmtLen(s.size.y)}</b> (Y) × <b>${fmtLen(s.size.z)}</b> (Z), with ${fmtArea(s.area)} of surface area.</p>`;
    }
    if (/hole|bore|drill/.test(ql)) {
      const holes = this.allFeatures().filter(({ f }) => f.kind === 'hole');
      if (!holes.length) return '<p>No holes were recognized in this model.</p>';
      const groups = new Map();
      holes.forEach(({ f, p }) => { const k = featureLabel(f); if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ f, p }); });
      return `<p>I found <b>${holes.length} holes</b> in ${groups.size} size${groups.size > 1 ? 's' : ''}:</p><ul>${[...groups.entries()].map(([k, list]) =>
        `<li>${list.length}× ${esc(k)}: ${list.slice(0, 6).map(({ f, p }) => `<a href="#" data-link="feature:${p.index}:${f.name}">${f.name}</a>`).join(', ')}${list.length > 6 ? '…' : ''}</li>`).join('')}</ul>`;
    }
    if (/manufactur|machin|dfm|produc|tool/.test(ql)) return this.dfm();
    if (/requirement|verified|status/.test(ql)) {
      const reqs = pr.requirements;
      if (!reqs.length) return '<p>No requirements are defined yet. Add them on the <a href="#" data-link="goto:requirements">Requirements</a> tab.</p>';
      const by = {}; reqs.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
      return `<p>${reqs.length} requirements: ${Object.entries(by).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ')}.</p><ul>${reqs.map((r) => `<li><a href="#" data-link="goto:requirements:${esc(r.id)}">${esc(r.id)}</a> ${esc(r.title)}: ${esc(r.status)}</li>`).join('')}</ul>`;
    }
    if (/part|component|how many|assembly/.test(ql)) {
      return `<p>The model has <b>${v.parts.length} part${v.parts.length > 1 ? 's' : ''}</b>:</p><ul>${v.parts.slice(0, 12).map((p) => `<li><a href="#" data-link="part:${p.index}">${esc(p.name)}</a>${p.data ? ` (${p.data.features.length} features)` : ''}</li>`).join('')}</ul>${v.parts.length > 12 ? `<p>…and ${v.parts.length - 12} more.</p>` : ''}`;
    }
    if (/material|alloy/.test(ql)) return `<p>The project material is <b>${esc(pr.material.name)}</b> at ${pr.material.density} g/cm³. Finish: ${esc(pr.manufacturing.finish || 'not set')}.</p>`;
    return `<p>I can answer from the model geometry and project data: mass and volume, overall size, holes and patterns, requirement status, manufacturability, and what a selected feature is for.</p>${this.settings.apiKey ? '' : '<p>For open-ended questions, add a Claude API key in the assistant settings (gear icon).</p>'}`;
  }

  describeFeature(f, p, reqId) {
    const pr = this.store.project;
    const meta = pr.featureMeta[`${p.name}#${f.name}`] || {};
    const req = pr.requirements.find((r) => r.id === (reqId || meta.requirement));
    const linkF = `<a href="#" data-link="feature:${p.index}:${f.name}">${f.name}</a>`;
    let html = '';
    if (f.kind === 'hole') {
      const fastener = nominalFastener(2 * toDisplay(f.radius), units.display);
      html += `<p>${linkF} is a ${f.type.toLowerCase()} in ${esc(p.name)}: ${fmtDia(f.radius)} ${f.thru ? 'through all' : `to ${fmtLen(f.depth)} deep`}${f.cbore ? `, counterbored ${fmtDia(f.cbore.radius)} × ${fmtLen(f.cbore.depth)} so a fastener head sits below the surface` : ''}.`;
      if (fastener) html += ` That size suits a ${fastener} fastener with clearance.`;
      html += '</p>';
      if (f.pattern) html += `<p>It belongs to ${f.pattern}, a ${f.patternCount}× pattern of identical holes, which spreads the load across ${f.patternCount} fasteners.</p>`;
    } else if (f.kind === 'pattern') {
      html += `<p>${linkF} is a ${f.arrangement.toLowerCase()} pattern of ${f.count} identical holes (${f.members.join(', ')}). Patterns like this usually locate the part and share the joint load evenly.</p>`;
    } else if (f.kind === 'fillet') {
      html += `<p>${linkF} is a ${f.type === 'Fillet' ? 'concave fillet' : 'convex round'} of R${fmtLen(f.radius)} on ${f.edges} edge${f.edges > 1 ? 's' : ''}. ${f.type === 'Fillet' ? 'It reduces stress concentration at the inside corner.' : 'It breaks a sharp outside edge for handling and coating.'}</p>`;
    } else if (f.kind === 'boss') {
      html += `<p>${linkF} is a cylindrical boss or shaft, ${fmtDia(f.radius)} × ${fmtLen(f.length)} long.</p>`;
    }
    if (req) html += `<p>It's linked to <a href="#" data-link="goto:requirements:${esc(req.id)}">${esc(req.id)}</a> (${esc(req.title)}, ${esc(req.status.toLowerCase())})${req.notes ? `: ${esc(req.notes)}` : '.'}</p>`;
    else if (reqId) html += `<p>${esc(reqId)} isn't linked to this feature yet. Link it from the Requirement field in the details panel.</p>`;
    const extras = [];
    if (meta.specification) extras.push(`it is controlled by ${esc(meta.specification)}`);
    if (meta.condition) extras.push(`material condition: ${esc(meta.condition.toLowerCase())}`);
    if (meta.drawing) extras.push(`dimensioned on ${esc(meta.drawing)}${meta.dimension ? ` (${esc(meta.dimension)})` : ''}`);
    if (extras.length) html += `<p>Per its provenance, ${extras.join('; ')}.</p>`;
    if (f.confidence) html += `<p>Recognition confidence: ${f.confidence}%${meta.status ? `, status ${esc(meta.status.toLowerCase())}` : ''}.</p>`;
    if (meta.notes) html += `<p>Notes: ${esc(meta.notes)}</p>`;
    return html;
  }

  describePart(p, reqId) {
    const d = p.data, pr = this.store.project;
    if (!d) return '<p>That part is still being analyzed.</p>';
    const meta = pr.featureMeta[p.name] || {};
    const req = pr.requirements.find((r) => r.id === (reqId || meta.requirement));
    return `<p><a href="#" data-link="part:${p.index}">${esc(p.name)}</a> is ${fmtLen(d.box.getSize(new THREE.Vector3()).x)} × ${fmtLen(d.box.getSize(new THREE.Vector3()).y)} × ${fmtLen(d.box.getSize(new THREE.Vector3()).z)}, weighs ${fmtMass(massGrams(d.volume, pr.material.density))} and has ${d.faces.length} faces with ${d.features.length} recognized features.</p>` +
      (req ? `<p>It's linked to ${esc(req.id)} (${esc(req.title)}).</p>` : '');
  }

  describeRequirement(id) {
    const r = this.store.project.requirements.find((x) => x.id === id);
    if (!r) return `<p>There's no ${esc(id)} in this project's requirements.</p>`;
    const links = Object.entries(this.store.project.featureMeta).filter(([, m]) => m.requirement === id).map(([k]) => k.replace('#', ' › '));
    return `<p><b>${esc(r.id)} ${esc(r.title)}</b> is ${esc(r.status.toLowerCase())}.${r.notes ? ` ${esc(r.notes)}` : ''}</p><p>${links.length ? `Linked geometry: ${links.map(esc).join(', ')}.` : 'No geometry is linked to it yet.'}</p>`;
  }

  dfm() {
    const items = [];
    for (const { f, p } of this.allFeatures()) {
      if (f.kind === 'hole') {
        const ld = f.length / (2 * f.radius);
        if (ld > 10) items.push(`<a href="#" data-link="feature:${p.index}:${f.name}">${f.name}</a> has a depth-to-diameter ratio of ${ld.toFixed(1)}:1; plan for gun drilling or peck cycles.`);
        if (!f.thru && ld > 4) items.push(`<a href="#" data-link="feature:${p.index}:${f.name}">${f.name}</a> is a blind hole ${ld.toFixed(1)}× its diameter deep; chip evacuation and the drill-point bottom need attention.`);
      }
      if (f.kind === 'fillet' && f.type === 'Fillet' && toDisplay(f.radius) < (units.display === 'in' ? 0.03 : 0.75)) {
        items.push(`<a href="#" data-link="feature:${p.index}:${f.name}">${f.name}</a> has an internal radius of R${fmtLen(f.radius)}, which needs a very small end mill.`);
      }
    }
    const open = this.viewer.parts.filter((p) => p.data && !p.data.closed);
    if (open.length) items.push(`${open.length} part${open.length > 1 ? 's are' : ' is'} not a closed solid, so mass values are approximate.`);
    const m = this.store.project.manufacturing;
    return `<p>Process: ${esc(m.process || 'not set')}${m.tolerance ? `, general tolerance ${esc(m.tolerance)}` : ''}.</p>` +
      (items.length ? `<p>Things to review:</p><ul>${items.slice(0, 8).map((i) => `<li>${i}</li>`).join('')}</ul>` : '<p>No deep holes, tight internal radii or open bodies were found in the recognized features.</p>');
  }

  // ---------- Claude ----------
  contextJson() {
    const v = this.viewer, pr = this.store.project;
    const s = this.summary();
    const sel = v.selection;
    return JSON.stringify({
      units: units.display,
      model: { name: v.desc?.name, file: v.desc?.fileName, envelope: [s.size.x, s.size.y, s.size.z].map((x) => +toDisplay(x).toFixed(4)), volume: +toDisplay(s.vol, 3).toFixed(4), mass: fmtMass(s.mass) },
      material: pr.material,
      parts: v.parts.slice(0, 60).map((p) => ({ name: p.name, visible: p.visible, volume: p.data ? +toDisplay(p.data.volume, 3).toFixed(4) : null, faces: p.data?.faces.length })),
      features: this.allFeatures().slice(0, 150).map(({ f, p }) => ({ name: f.name, part: p.name, type: f.type, description: featureLabel(f), thru: f.thru, pattern: f.pattern, confidence: f.confidence, meta: pr.featureMeta[`${p.name}#${f.name}`] })),
      selection: sel ? { kind: sel.kind, part: v.parts[sel.part]?.name, feature: sel.feature } : null,
      requirements: pr.requirements, manufacturing: pr.manufacturing, digitalThread: pr.thread,
    });
  }

  async askClaude(q) {
    this.history.push({ role: 'user', content: q });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.settings.model || DEFAULT_MODEL,
        max_tokens: 900,
        system: `You are an engineering assistant inside a CAD review workbench. Answer concisely and precisely using the model data below. Use the stated units. If the data doesn't contain the answer, say so.\n\nMODEL DATA:\n${this.contextJson()}`,
        messages: this.history.slice(-12),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { this.history.pop(); throw new Error(data?.error?.message || `HTTP ${res.status}`); }
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    this.history.push({ role: 'assistant', content: text });
    return text;
  }

  openSettings() {
    const s = this.settings;
    this.openModal(`<h3>Assistant settings</h3>
      <p>Built-in answers work without a key. Add a Claude API key to send open-ended questions, with a summary of this model, to Claude. The key is sent only to api.anthropic.com.</p>
      <div class="fields">
        <label>Claude API key<input id="asKey" type="password" autocomplete="off" value="${esc(s.apiKey)}" placeholder="sk-ant-..." /></label>
        <label>Model<input id="asModel" value="${esc(s.model || DEFAULT_MODEL)}" /></label>
        <label class="check"><input type="checkbox" id="asRemember" ${s.remember ? 'checked' : ''}/> Remember on this device</label>
      </div>
      <div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok" id="asSave">Save</button></div>`,
    (dlg, val) => {
      if (val !== 'ok') return;
      s.apiKey = dlg.querySelector('#asKey').value.trim();
      s.model = dlg.querySelector('#asModel').value.trim() || DEFAULT_MODEL;
      s.remember = dlg.querySelector('#asRemember').checked;
      try {
        if (s.remember) localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        else localStorage.removeItem(SETTINGS_KEY);
      } catch { /* ignore */ }
    });
  }
}

function nominalFastener(dia, u) {
  const inch = u === 'in' ? dia : dia / 25.4;
  const table = [['#4', 0.112], ['#6', 0.138], ['#8', 0.164], ['#10', 0.19], ['1/4"', 0.25], ['5/16"', 0.3125], ['3/8"', 0.375], ['1/2"', 0.5], ['5/8"', 0.625], ['3/4"', 0.75]];
  const metric = [['M3', 3], ['M4', 4], ['M5', 5], ['M6', 6], ['M8', 8], ['M10', 10], ['M12', 12], ['M16', 16]];
  if (u === 'in') {
    // Clearance holes run 0–12% over nominal; also accept an exact nominal match.
    const m = table.filter(([, d]) => inch >= d * 0.99 && inch <= d * 1.12).pop();
    return m ? m[0] : null;
  }
  const mm = inch * 25.4;
  const m = metric.filter(([, d]) => mm >= d * 0.99 && mm <= d * 1.15).pop();
  return m ? m[0] : null;
}

function md(text) {
  const lines = esc(text).split(/\n/);
  let html = '', inList = false;
  for (const l of lines) {
    const li = l.match(/^\s*[-*•]\s+(.*)/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}
function inline(s) { return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>'); }

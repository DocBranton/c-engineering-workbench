// Model tree: assembly structure, parts, recognized features.
import { icon } from './icons.js';
import { esc, fmtLen, fmtDia } from './util.js';

export function featureLabel(f) {
  switch (f.kind) {
    case 'hole': {
      let s = `${fmtDia(f.radius)} ${f.thru ? 'thru' : 'x ' + fmtLen(f.depth)}`;
      if (f.cbore) s += `, cbore ${fmtDia(f.cbore.radius)}`;
      return s;
    }
    case 'pattern': return `${f.count}x ${f.arrangement}`;
    case 'fillet': return `${f.type === 'Fillet' ? 'Fillet' : 'Round'} R${fmtLen(f.radius)}${f.edges > 1 ? ` (${f.edges})` : ''}`;
    case 'boss': return `Boss ${fmtDia(f.radius)}`;
    default: return '';
  }
}
const FEATURE_ICON = { hole: 'hole', pattern: 'pattern', fillet: 'fillet', boss: 'box' };

export class ModelTree {
  constructor(el, searchEl, handlers) {
    this.el = el; this.handlers = handlers; this.query = '';
    this.open = new Set();
    this.selectedKey = null;
    this.materialNode = { key: 'materials', type: 'folder', name: 'Materials', children: [], parts: [] };
    searchEl.addEventListener('input', () => { this.query = searchEl.value.trim().toLowerCase(); this.render(); });
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.tree-row'); if (!row || e.target.closest('.vis,.twisty')) return;
      handlers.onFit?.(this.byKey.get(row.dataset.key));
    });
    el.addEventListener('keydown', (e) => {
      const row = e.target.closest('.tree-row'); if (!row) return;
      const n = this.byKey.get(row.dataset.key);
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.activate(n); }
      if (e.key === 'ArrowRight' && n.children.length) { this.open.add(n.key); this.render(); }
      if (e.key === 'ArrowLeft') { this.open.delete(n.key); this.render(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...el.querySelectorAll('.tree-row')];
        const i = rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1);
        rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
      }
    });
  }

  setModel(desc, viewer) {
    this.viewer = viewer;
    let asmId = 0;
    const build = (n, depth) => {
      const kids = [];
      const meshParts = n.meshes.map((i) => this.partNode(i));
      if (!n.children.length && n.meshes.length === 1 && depth > 0) return meshParts[0];
      kids.push(...meshParts, ...n.children.map((c) => build(c, depth + 1)));
      const node = { key: `asm:${asmId++}`, type: 'assembly', name: n.name || 'Assembly', children: kids };
      node.parts = collect(node);
      return node;
    };
    const collect = (n) => n.type === 'part' ? [n.partIdx] : n.children.flatMap(collect);
    let root = build(desc.root, 0);
    if (root.type === 'part') root = { key: 'asm:root', type: 'assembly', name: desc.name, children: [root], parts: [root.partIdx] };
    this.root = root;
    this.open = new Set([root.key]);
    // Open the first level of sub-assemblies on small models.
    // Open single-child assembly chains, and the first level of small models.
    let n = root;
    while (n.children.length === 1 && n.children[0].type === 'assembly') { n = n.children[0]; this.open.add(n.key); }
    if (viewer.parts.length <= 12) n.children.forEach((c) => c.type === 'assembly' && this.open.add(c.key));
    this.index();
    this.render();
  }

  partNode(i) {
    const p = this.viewer.parts[i];
    return { key: `part:${i}`, type: 'part', name: p.name, partIdx: i, parts: [i], children: [] };
  }

  setFeatures() {
    const walk = (n) => {
      if (n.type === 'part') {
        const f = this.viewer.parts[n.partIdx].data?.features || [];
        const order = { hole: 0, pattern: 1, fillet: 2, boss: 3 };
        n.children = f.slice().sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name))
          .map((ft) => ({ key: `feat:${n.partIdx}:${ft.name}`, type: 'feature', name: ft.name, desc: featureLabel(ft), kind: ft.kind, partIdx: n.partIdx, feature: ft.name, parts: [n.partIdx], children: [] }));
      } else n.children.forEach(walk);
    };
    if (this.root) { walk(this.root); this.index(); this.render(); }
  }

  setMaterial(mat) {
    this.materialNode.children = [{ key: 'material:0', type: 'material', name: mat.name, desc: `${mat.density} g/cm³`, parts: [], children: [] }];
    this.index(); this.render();
  }

  index() {
    this.byKey = new Map();
    const walk = (n, parent) => { n.parent = parent; this.byKey.set(n.key, n); n.children.forEach((c) => walk(c, n)); };
    if (this.root) walk(this.root, null);
    walk(this.materialNode, null);
  }

  matches(n) {
    if (!this.query) return true;
    return (n.name + ' ' + (n.desc || '')).toLowerCase().includes(this.query);
  }

  render() {
    if (!this.root) { this.el.innerHTML = '<div class="tree-empty">No model open.</div>'; return; }
    const rows = [];
    const visibleSubtree = (n) => this.matches(n) || n.children.some(visibleSubtree);
    const walk = (n, depth) => {
      if (!visibleSubtree(n)) return;
      const open = this.query ? true : this.open.has(n.key);
      rows.push(this.row(n, depth, open));
      if (open) n.children.forEach((c) => walk(c, depth + 1));
    };
    walk(this.root, 0);
    walk(this.materialNode, 0);
    this.el.innerHTML = rows.join('') || '<div class="tree-empty">No features match your search.</div>';
  }

  row(n, depth, open) {
    const parts = n.parts || [];
    const hidden = parts.length && parts.every((i) => !this.viewer.parts[i]?.visible);
    const iconName = n.type === 'assembly' ? 'assembly' : n.type === 'part' ? 'box' : n.type === 'feature' ? FEATURE_ICON[n.kind] : n.type === 'folder' ? 'material' : 'material';
    const twisty = n.children.length
      ? `<button class="twisty ${open ? 'open' : ''}" tabindex="-1" aria-label="${open ? 'Collapse' : 'Expand'}">${icon('chevron-right')}</button>`
      : '<span class="twisty"></span>';
    const vis = parts.length && n.type !== 'feature'
      ? `<button class="vis" tabindex="-1" title="${hidden ? 'Show' : 'Hide'}">${icon(hidden ? 'eye-off' : 'eye')}</button>` : '';
    const sel = this.selectedKey === n.key ? ' selected' : '';
    return `<div class="tree-row ${n.type}${sel}${hidden ? ' dim' : ''}" role="treeitem" tabindex="0" data-key="${esc(n.key)}" style="padding-left:${6 + depth * 16}px" aria-expanded="${n.children.length ? open : ''}">
      ${twisty}${icon(iconName, `kind-icon ${n.type}`)}<span class="tree-name" title="${esc(n.name)}">${esc(n.name)}</span>${n.desc ? `<span class="tree-desc">${esc(n.desc)}</span>` : ''}${vis}</div>`;
  }

  onClick(e) {
    const row = e.target.closest('.tree-row'); if (!row) return;
    const n = this.byKey.get(row.dataset.key);
    if (e.target.closest('.twisty')) {
      if (this.open.has(n.key)) this.open.delete(n.key); else this.open.add(n.key);
      this.render(); return;
    }
    if (e.target.closest('.vis')) {
      const hidden = n.parts.every((i) => !this.viewer.parts[i].visible);
      this.handlers.onVisibility?.(n.parts, hidden);
      return;
    }
    this.activate(n);
  }

  activate(n) {
    this.handlers.onSelect?.(n);
  }

  // Reflect a viewer selection.
  setSelection(sel) {
    let key = null;
    if (sel) {
      if (sel.kind === 'part' || sel.kind === 'face') key = `part:${sel.part}`;
      else if (sel.kind === 'feature') key = `feat:${sel.part}:${sel.feature}`;
      else if (sel.kind === 'assembly') key = sel.key;
      else if (sel.kind === 'material') key = 'material:0';
    }
    this.selectedKey = key;
    // Expand ancestors so the row is visible.
    let n = key && this.byKey.get(key);
    let expanded = false;
    for (let p = n?.parent; p; p = p.parent) if (!this.open.has(p.key)) { this.open.add(p.key); expanded = true; }
    this.render();
    if (key) this.el.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
    return expanded;
  }
}

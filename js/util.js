// Shared helpers: units, formatting, DOM, downloads.

export const units = {
  display: 'in',     // 'in' | 'mm'
  mmPerModelUnit: 1, // set per loaded model
};

const MM_PER = { in: 25.4, mm: 1 };

export function toDisplay(v, power = 1) {
  const f = units.mmPerModelUnit / MM_PER[units.display];
  return v * Math.pow(f, power);
}
export function fromDisplay(v) {
  return v * MM_PER[units.display] / units.mmPerModelUnit;
}
export function lenDigits() { return units.display === 'in' ? 3 : 2; }

export function fmtLen(v, withUnit = true) {
  const s = toDisplay(v).toFixed(lenDigits());
  return withUnit ? `${s} ${units.display}` : s;
}
export function fmtArea(v) {
  const d = toDisplay(v, 2);
  return `${fmtNum(d, units.display === 'in' ? 3 : 1)} ${units.display}²`;
}
export function fmtVol(v) {
  const d = toDisplay(v, 3);
  return `${fmtNum(d, units.display === 'in' ? 3 : 1)} ${units.display}³`;
}
export function fmtNum(n, digits = 2) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
// Mass in grams given model-unit volume and density in g/cm³.
export function massGrams(volModel, density) {
  const mm3 = volModel * Math.pow(units.mmPerModelUnit, 3);
  return (mm3 / 1000) * density;
}
export function fmtMass(g) {
  if (units.display === 'in') return `${fmtNum(g / 453.59237, 3)} lb`;
  return g >= 1000 ? `${fmtNum(g / 1000, 3)} kg` : `${fmtNum(g, 1)} g`;
}
export function fmtDia(r) { return `Ø${fmtLen(2 * r)}`; }

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

let toastTimer;
export function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3000);
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function pad3(n) { return String(n).padStart(3, '0'); }

export function baseName(name) { return String(name).replace(/\.[^.]+$/, ''); }

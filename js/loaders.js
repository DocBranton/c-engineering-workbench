// Reads CAD and mesh files into a common model description:
// { name, fileName, mmPerUnit, root: {name, meshes:[i], children:[]}, meshes: [{name, color, position, normal, index, brepFaces}] }
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { baseName } from './util.js';

export const ACCEPTED = ['step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl', 'obj', 'glb', 'gltf'];

let worker = null, nextId = 1;
const pending = new Map();
function occtWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./occt-worker.js', import.meta.url));
  worker.onmessage = (ev) => {
    const { id, progress, result, error } = ev.data;
    const p = pending.get(id);
    if (!p) return;
    if (progress) { p.onProgress?.(progress); return; }
    pending.delete(id);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error('The CAD kernel failed to start: ' + (e.message || 'worker error')));
    pending.clear();
    worker = null;
  };
  return worker;
}

function runOcct(format, buffer, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    occtWorker().postMessage({ id, format, buffer }, [buffer]);
  });
}

export async function loadFile(file, onProgress = () => {}) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!ACCEPTED.includes(ext)) throw new Error(`.${ext} files aren't supported. Open a STEP, IGES, BREP, STL, OBJ or glTF file.`);
  onProgress(`Reading ${file.name}`);
  const buffer = await file.arrayBuffer();
  const name = baseName(file.name);

  if (['step', 'stp', 'iges', 'igs', 'brep', 'brp'].includes(ext)) {
    const format = ext.startsWith('st') ? 'step' : ext.startsWith('ig') ? 'iges' : 'brep';
    const res = await runOcct(format, buffer, onProgress);
    if (!res.meshes.length) throw new Error('The file was read, but it contains no solid or surface geometry to display.');
    const root = res.root || { name, meshes: res.meshes.map((_, i) => i), children: [] };
    if (!root.name) root.name = name;
    // Name unnamed meshes from their owning node.
    const walk = (n) => {
      n.meshes.forEach((i, k) => { if (!res.meshes[i].name) res.meshes[i].name = n.meshes.length > 1 ? `${n.name || 'Body'} ${k + 1}` : (n.name || `Body ${i + 1}`); });
      n.children.forEach(walk);
    };
    walk(root);
    return { name: root.name || name, fileName: file.name, mmPerUnit: 1, root, meshes: res.meshes, format: format.toUpperCase() };
  }

  if (ext === 'stl') {
    const geo = new STLLoader().parse(buffer);
    const m = fromGeometry(geo, name);
    return { name, fileName: file.name, mmPerUnit: 1, root: { name, meshes: [0], children: [] }, meshes: [m], format: 'STL', meshOnly: true };
  }

  if (ext === 'obj') {
    const text = new TextDecoder().decode(buffer);
    const obj = new OBJLoader().parse(text);
    return fromObject3D(obj, name, file.name, 1, 'OBJ');
  }

  // glTF / GLB (embedded resources only)
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, (e) => reject(new Error('glTF could not be read: ' + (e.message || e) + '. Use a .glb or a .gltf with embedded buffers.')));
  });
  return fromObject3D(gltf.scene, name, file.name, 1000, 'glTF');
}

function fromGeometry(geo, name, matrix, color) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (matrix) g.applyMatrix4(matrix);
  const pos = g.getAttribute('position');
  const count = pos.count;
  const position = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { position[i * 3] = pos.getX(i); position[i * 3 + 1] = pos.getY(i); position[i * 3 + 2] = pos.getZ(i); }
  const index = new Uint32Array(count);
  for (let i = 0; i < count; i++) index[i] = i;
  return { name, color: color || null, position, normal: null, index, brepFaces: null };
}

function fromObject3D(rootObj, name, fileName, mmPerUnit, format) {
  rootObj.updateMatrixWorld(true);
  const meshes = [];
  const build = (o, fallback) => {
    const node = { name: o.name || fallback, meshes: [], children: [] };
    if (o.isMesh && o.geometry?.getAttribute('position')) {
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const c = mat?.color ? [mat.color.r, mat.color.g, mat.color.b] : null;
      meshes.push(fromGeometry(o.geometry, o.name || fallback, o.matrixWorld, c));
      node.meshes.push(meshes.length - 1);
    }
    o.children.forEach((ch, i) => {
      const n = build(ch, `${node.name} ${i + 1}`);
      if (n.meshes.length || n.children.length) node.children.push(n);
    });
    // Collapse a group that only wraps a single mesh node.
    if (!node.meshes.length && node.children.length === 1 && !o.name) return node.children[0];
    return node;
  };
  const root = build(rootObj, name);
  root.name = root.name || name;
  if (!meshes.length) throw new Error('The file contains no mesh geometry.');
  return { name, fileName, mmPerUnit, root, meshes, format, meshOnly: true };
}

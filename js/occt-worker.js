/* Runs the OpenCascade (occt-import-js) STEP/IGES/BREP importer off the main thread. */
importScripts('../vendor/occt/occt-import-js.js');

let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    occtPromise = occtimportjs({ locateFile: (path) => '../vendor/occt/' + path });
  }
  return occtPromise;
}

onmessage = async (ev) => {
  const { id, format, buffer } = ev.data;
  try {
    postMessage({ id, progress: 'Starting the OpenCascade kernel' });
    const occt = await getOcct();
    postMessage({ id, progress: 'Reading and tessellating B-rep geometry' });
    const params = {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.0012,
      angularDeflection: 0.35,
    };
    const content = new Uint8Array(buffer);
    let result;
    if (format === 'step') result = occt.ReadStepFile(content, params);
    else if (format === 'iges') result = occt.ReadIgesFile(content, params);
    else result = occt.ReadBrepFile(content, params);
    if (!result || !result.success) throw new Error('The file could not be read as ' + format.toUpperCase() + '. Check that it is a valid, unencrypted file.');

    // Pack into typed arrays so the transfer is cheap.
    const meshes = result.meshes.map((m) => ({
      name: m.name || '',
      color: m.color || null,
      position: new Float32Array(m.attributes.position.array),
      normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
      index: new Uint32Array(m.index.array),
      brepFaces: (m.brep_faces || []).map((f) => ({ first: f.first, last: f.last, color: f.color || null })),
    }));
    const transfer = [];
    meshes.forEach((m) => { transfer.push(m.position.buffer, m.index.buffer); if (m.normal) transfer.push(m.normal.buffer); });
    postMessage({ id, result: { root: result.root, meshes } }, transfer);
  } catch (err) {
    postMessage({ id, error: String(err && err.message || err) });
  }
};

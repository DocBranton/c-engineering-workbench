# Engineering Workbench

A browser-based CAD review workbench. Open STEP, IGES, BREP, STL, OBJ or glTF files, inspect parts and recognized features, measure, section, explode, generate a 2D drawing, and keep requirements, manufacturing notes and digital-thread links next to the geometry.

Files are read in the browser and never uploaded. STEP, IGES and BREP files are tessellated by [OpenCascade](https://dev.opencascade.org/) compiled to WebAssembly ([occt-import-js](https://github.com/kovacsv/occt-import-js)), which keeps the B-rep face structure so features can be recognized.

## Run it

There is no build step. Serve the folder with any static web server and open it:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk won't work, because browsers block module and WebAssembly loading from `file://` URLs.

### GitHub Pages

`.github/workflows/pages.yml` deploys the site on every push to `main`. In the repository settings, under **Pages**, set **Source** to **GitHub Actions** once.

## What it does

**Viewer**
- Select, pan, rotate and zoom tools; fit; standard views (keys 1–7) and a clickable view cube; perspective or orthographic
- Pick filter for parts, features or single faces; double-click to zoom to what you clicked
- Section plane on X, Y or Z with offset and flip
- Explode assemblies; show, hide and isolate parts
- Display modes (shaded with edges, shaded, wireframe, X-ray) and material looks
- Measure point-to-point distance with ΔX/ΔY/ΔZ; parallel faces also report the true gap
- Annotations: overall dimensions and hole callouts (Ø, THRU / depth, counterbore)

**Geometry analysis** (runs on load, per part)
- Volume, surface area, center of mass, bounding box and mass for a chosen material
- Face classification (planar, cylindrical, freeform) by least-squares fitting
- Feature recognition: through and blind holes, counterbores, stepped holes, fillets and rounds, bosses
- Hole patterns grouped by specification and classified as linear, rectangular or circular
- A confidence score per feature, derived from the fit residual

Recognition works best on STEP, IGES and BREP files, where faces come from the B-rep. For STL, OBJ and glTF, faces are rebuilt from the mesh by normal-based region growing, which is less exact.

**Engineering data** (stored per model in the browser, portable as JSON from the ⋮ menu)
- Requirements with status, linked to parts and features from the details panel
- Manufacturing process, finish, critical feature and tolerance
- Digital thread links to drawings, requirements, inspection and test records
- Source and provenance fields per feature: drawing zone, dimension ID, requirement, specification, material condition, review status and notes

**Drawings**
- Third-angle front, top and right views plus an isometric, with hidden lines removed, generated from the visible geometry (respects hidden parts, explode and section)
- Overall dimensions, hole callouts and a title block; download as PNG

**AI Wingman**
- Built-in answers from the analysis and project data: mass, size, holes, requirement status, manufacturability checks, and what a selected feature is for
- Optional: add a Claude API key in the assistant settings to send open-ended questions to Claude with a summary of the model. The key is kept in memory unless you choose to remember it on the device, and is sent only to `api.anthropic.com`

**Export**: glTF binary (.glb), STL, viewport PNG, drawing PNG, analysis CSV, project JSON.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| S / P / R / Z | Select, pan, rotate, zoom tools |
| M | Measure |
| F | Fit all, or fit the selection |
| X | Section |
| E | Explode |
| H | Hide selection, or show all |
| I | Isolate selection |
| A | Annotations on or off |
| 1–7 | Iso, front, back, top, bottom, left, right |
| Esc | Clear selection and measurement |

## Project layout

```
index.html            App shell and layout
css/app.css           Theme and layout
js/main.js            Wiring: loading, tabs, toolbar, menus, search, shortcuts
js/viewer.js          three.js viewer: tools, picking, section, explode, measure, annotations, view cube
js/loaders.js         File readers (STEP/IGES/BREP via a Web Worker, STL, OBJ, glTF)
js/occt-worker.js     OpenCascade WebAssembly importer, off the main thread
js/analysis.js        Mass properties, face segmentation and classification, feature recognition
js/tree.js            Model tree
js/details.js         Details panel for parts, features and faces
js/panels.js          Requirements, manufacturing, digital thread and analysis views
js/drawing.js         2D drawing sheet generator
js/wingman.js         Assistant
js/store.js           Project data and persistence
js/sample.js          Procedural sample bracket assembly
vendor/               three.js r170 (MIT) and occt-import-js 0.0.24 (LGPL-2.1), with licenses
```

Add `?empty=1` to the URL to start without the sample model.

## Third-party software

- [three.js](https://threejs.org) r170, MIT license (`vendor/three/LICENSE`)
- [occt-import-js](https://github.com/kovacsv/occt-import-js) 0.0.24 and Open CASCADE Technology, LGPL-2.1 (`vendor/occt/license.*.txt`). The library is loaded unmodified as a separate file, so it can be replaced with another build.

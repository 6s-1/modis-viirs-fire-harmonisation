// Linked hover across the globes.
//
// The outline used to belong to the fire grid source, so on a globe showing population it sat
// under pop-fill and was all but invisible, and only the fire grid listened for the mouse. It is
// now its own source with its own layers, added last so they sit above every fill, and every
// hoverable layer feeds it.
//
// The two globes may draw different layers at different resolutions (the fire grid is coarse in
// compare, population is not). So the hovered cell is translated to whatever the other globe
// shows: its H3 children when that layer is finer, its parent when coarser, itself when equal,
// merged into one outer boundary.

import { cellToBoundary, cellToChildren, cellToParent, cellsToMultiPolygon, getResolution } from "h3-js";

const CASING = 3.5, LINE = 1.5;

export function addHoverLayers(map) {
  map.addSource("hover", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "hover-casing", type: "line", source: "hover",
    paint: { "line-color": "#0b0d12", "line-width": CASING, "line-opacity": 0.85 } });
  map.addLayer({ id: "hover-line", type: "line", source: "hover",
    paint: { "line-color": "#ffffff", "line-width": LINE, "line-opacity": 1 } });
}

// Keep the hover layers on top whenever anything else is added above them.
export function raiseHover(map) {
  for (const id of ["hover-casing", "hover-line"]) {
    if (map.getLayer(id)) { try { map.moveLayer(id); } catch { /* already last */ } }
  }
}

// The ground covered by one H3 cell, expressed in the resolution another layer draws at.
// Returns GeoJSON rings: one cell, its children, or its parent, merged into outer boundaries.
export function footprint(h3id, targetRes) {
  if (!h3id) return [];
  const res = getResolution(h3id);
  if (targetRes === res) return [cellToBoundary(h3id, true)];
  if (targetRes > res) {
    // the other layer is finer: the children of this cell cover exactly the same ground
    const kids = cellToChildren(h3id, targetRes);
    const multi = cellsToMultiPolygon(kids, true);
    return multi.flatMap((poly) => poly); // each polygon's rings
  }
  // the other layer is coarser: the parent that contains this cell
  return [cellToBoundary(cellToParent(h3id, targetRes), true)];
}

export function setHover(map, rings) {
  const src = map.getSource("hover");
  if (!src) return;
  src.setData({ type: "FeatureCollection", features: rings.map((ring) => ({
    type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } })) });
}

// One update per animation frame, shared by every map.
let frame = 0, pending = null;
export function scheduleHover(apply) {
  pending = apply;
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; const fn = pending; pending = null; if (fn) fn(); });
}

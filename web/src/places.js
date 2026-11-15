// The Places layer: province and territory borders and names, town and city labels that come in
// as you zoom, and lakes and rivers labelled at closer zooms.
//
// The basemap already carries all of this, but below the fire grid, where the grid hides it. This
// moves those layers above the grid and gives the text a halo so it stays readable over any
// colour. Nothing new is fetched.

// Basemap layers that make up "Places", in the order they should sit (last on top).
const BORDER_LAYERS = ["boundary_3", "boundary_2", "boundary_disputed"];
const WATER_LABELS = ["waterway_line_label", "water_name_line_label", "water_name_point_label"];
const PLACE_LABELS = ["label_other", "label_village", "label_town", "label_state", "label_city", "label_city_capital"];
const ALL = [...BORDER_LAYERS, ...WATER_LABELS, ...PLACE_LABELS];

// Labels sit over fire colours, so they need a halo heavy enough to read on dark red.
function styleLabel(map, id) {
  if (map.getLayer(id) === undefined) return;
  try {
    map.setPaintProperty(id, "text-halo-color", "rgba(10,12,17,0.9)");
    map.setPaintProperty(id, "text-halo-width", 1.6);
    map.setPaintProperty(id, "text-halo-blur", 0.4);
    map.setPaintProperty(id, "text-color", "#f4f5f7");
  } catch { /* some label layers carry no text paint */ }
}

// Move the Places layers to the top, so they draw over the fire grid and the overlays.
export function raisePlaces(map) {
  for (const id of ALL) {
    if (!map.getLayer(id)) continue;
    try { map.moveLayer(id); } catch { /* already on top */ }
  }
  for (const id of [...WATER_LABELS, ...PLACE_LABELS]) styleLabel(map, id);
  // province and territory borders: visible but quiet against the grid
  for (const id of BORDER_LAYERS) {
    if (!map.getLayer(id)) continue;
    try {
      map.setPaintProperty(id, "line-color", "#f0f1f3");
      map.setPaintProperty(id, "line-opacity", 0.45);
      map.setPaintProperty(id, "line-width", 0.9);
    } catch { /* not a line layer */ }
  }
  // province names show further out than the basemap default, so the view always has a reference
  if (map.getLayer("label_state")) {
    try { map.setLayerZoomRange("label_state", 2.6, 9); } catch { /* ignore */ }
  }
}

export function setPlacesVisible(map, on) {
  for (const id of ALL) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }
}

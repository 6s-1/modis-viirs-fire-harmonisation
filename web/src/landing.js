// The landing page: the wordmark, one line, and the way in. Behind it, the same Canada globe
// and fire grid as the dashboard, dimmed so the words stay readable. It is decoration, so it is
// built only when the browser can spare it and never animates under reduced motion.
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./fonts.js";
import "./style.css";
import { initTextSize } from "./textsize.js";
import { aggregate, loadData } from "./data.js";
import { addGridLayers, buildGrid, setGrid } from "./grid.js";

initTextSize();

const CANADA = { south: 41.5, north: 83.5, west: -141.5, east: -52.0 };
const STYLE = "https://tiles.openfreemap.org/styles/positron";

async function backdrop() {
  const host = document.getElementById("land-globe");
  if (!host) return;
  const map = new maplibregl.Map({
    container: host, style: STYLE, center: [-96, 60], zoom: 1.6,
    interactive: false, attributionControl: false,
  });
  map.on("style.load", () => {
    map.setProjection({ type: "globe" });
    // the same flat grey basemap the dashboard uses, so the fire reads as the only colour
    const paint = { background: ["background-color", "#a0a3a8"], water: ["fill-color", "#6f747c"],
      park: ["fill-color", "#9a9da2"], landcover_wood: ["fill-color", "#9a9da2"] };
    for (const [id, [prop, val]] of Object.entries(paint)) if (map.getLayer(id)) map.setPaintProperty(id, prop, val);
    for (const l of map.getStyle().layers) if (l.type === "symbol") map.setLayoutProperty(l.id, "visibility", "none");
  });
  map.on("load", async () => {
    try {
      const d = await loadData("harmonised/");
      map.addSource("selection", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-opacity": 0 } });
      addGridLayers(map);
      const agg = aggregate(d, CANADA);
      setGrid(map, buildGrid(d, agg, [0, d.months.length - 1], { coarse: true }).features);
    } catch { /* the page stands on its own without the grid */ }
    fit(map);
    host.classList.add("ready");
  });
  addEventListener("resize", () => fit(map));
}

// all of Canada, filling the window, centred behind the words
function fit(map) {
  const el = map.getContainer(), W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  const side = 1.15 * Math.min(W, H); // a little larger than the window, so it fills the edges
  const px = Math.max((W - side) / 2, 0), py = Math.max((H - side) / 2, 0);
  const cam = map.cameraForBounds([[CANADA.west, CANADA.south], [CANADA.east, CANADA.north]],
    { padding: { top: py, bottom: py, left: px, right: px }, maxZoom: 6 });
  if (cam) map.jumpTo({ center: cam.center, zoom: cam.zoom });
}

backdrop();

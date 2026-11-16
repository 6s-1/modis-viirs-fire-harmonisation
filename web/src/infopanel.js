// The "i" panel in the header: what this app is built from and who to call in an emergency.
// It replaces the separate About page; the full method write-up lives in docs/HOW-IT-WORKS.md.
// Numbers come from about.json, the same file the pipeline writes.

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const REPO = "https://github.com/6s-1/modis-viirs-fire-harmonisation";
const DOCS = `${REPO}/blob/main/docs/HOW-IT-WORKS.md`;

const EMERGENCY = [
  ["British Columbia", "https://www.emergencyinfobc.gov.bc.ca/", "EmergencyInfoBC"],
  ["Alberta", "https://www.alberta.ca/alberta-emergency-alert", "Alberta Emergency Alert"],
  ["Saskatchewan", "https://www.saskpublicsafety.ca/", "Saskatchewan Public Safety Agency"],
  ["Manitoba", "https://www.gov.mb.ca/emo/", "Manitoba Emergency Management"],
  ["Ontario", "https://www.ontario.ca/page/forest-fires", "Ontario forest fires"],
  ["Québec", "https://www.sopfeu.qc.ca/en/", "SOPFEU"],
  ["New Brunswick", "https://www.gnb.ca/en/topic/laws-safety/emergency-preparedness-alerts.html", "Emergency preparedness and alerts"],
  ["Nova Scotia", "https://novascotia.ca/alerts/", "Nova Scotia alerts"],
  ["Prince Edward Island", "https://www.princeedwardisland.ca/en/topic/emergency-management", "Emergency management"],
  ["Newfoundland and Labrador", "https://www.gov.nl.ca/ffa/wildfires/", "Wildfires"],
  ["Yukon", "https://yukon.ca/", "Government of Yukon"],
  ["Northwest Territories", "https://www.maca.gov.nt.ca/en/services/emergency-management", "Emergency management"],
  ["Nunavut", "https://www.gov.nu.ca/", "Government of Nunavut"],
  ["Across Canada", "https://www.alertready.ca/", "Alert Ready"],
];

function body(a) {
  const end = a && a.data_end;
  const endDays = end ? Math.max(...Object.values(end.days)) : null;
  const freshness = end
    ? `Historical data to ${endDays} ${MONTHS[end.m - 1]} ${end.y}; live data from NASA FIRMS, near real time.`
    : "Historical data from NASA FIRMS; live data near real time.";
  return `
  <section>
    <h3>Emergency information</h3>
    <p>This app shows fire history and recent detections. <strong>It is not an emergency service.</strong>
      For evacuation orders, alerts and routes, follow your provincial or territorial emergency service.</p>
    <ul class="info-links">${EMERGENCY.map(([p, href, name]) =>
      `<li><span class="muted">${p}:</span> <a href="${href}" target="_blank" rel="noopener">${name}</a></li>`).join("")}</ul>
  </section>

  <section>
    <h3>Data freshness</h3>
    <p>${freshness}</p>
  </section>

  <section>
    <h3>How it works</h3>
    <p>MODIS and VIIRS see fire at different resolutions, so their raw counts cannot be laid end to
      end. Ember converts the whole record to VIIRS-equivalent fire cell-days so years can be
      compared. The full method, every validation test and the honest limits are written up in
      <a href="${DOCS}" target="_blank" rel="noopener">docs/HOW-IT-WORKS.md</a>.</p>
  </section>

  <section>
    <h3>Use of AI tools</h3>
    <p>Ember was built with the help of an AI coding assistant (Claude), under my direction, for
      writing and debugging code, running data checks and drafting text. The method, the data
      choices, the design and every final decision are mine. The logo and the mascot are my own
      drawings, converted to SVG with AI help.</p>
  </section>

  <section>
    <h3>Data credits</h3>
    <ul class="info-credits">
      <li><strong>Active fire detections:</strong> NASA Fire Information for Resource Management System
        (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS). MODIS Collection 6.1
        (Terra, Aqua) and VIIRS 375 m Collection 2 (S-NPP, NOAA-20).</li>
      <li><strong>Burned area and fire points:</strong> National Burned Area Composite (NBAC) and
        Canadian National Fire Database (NFDB), Canadian Forest Service, Natural Resources Canada,
        via the Canadian Wildland Fire Information System (CWFIS).</li>
      <li><strong>Fires reported by agencies:</strong> Active Fires Dataset (CWFIS), from the
        provincial, territorial and Parks Canada agencies.</li>
      <li><strong>Fire regions:</strong> Terrestrial Ecozones of Canada, Agriculture and Agri-Food Canada.</li>
      <li><strong>Land cover:</strong> © ESA WorldCover project 2021 / Contains modified Copernicus
        Sentinel data (2021), licensed under CC BY 4.0.</li>
      <li><strong>Boundaries:</strong> Natural Earth (public domain).</li>
      <li><strong>Population:</strong> WorldPop, 2020 1 km UN-adjusted population for Canada (CC BY 4.0).</li>
      <li><strong>Place names:</strong> GeoNames (cities500), licensed under CC BY 4.0.</li>
      <li><strong>Base map:</strong> OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors.</li>
      <li><strong>Software:</strong> H3 hexagonal grid (Uber), MapLibre GL JS.</li>
    </ul>
    <p class="muted small">NBAC, NFDB, CWFIS and the ecozones contain information licensed under the
      <a href="https://open.canada.ca/en/open-government-licence-canada" target="_blank" rel="noopener">Open
      Government Licence – Canada</a>. Source code and the full pipeline:
      <a href="${REPO}" target="_blank" rel="noopener">github.com/6s-1/modis-viirs-fire-harmonisation</a>.</p>
  </section>`;
}

export function initInfoPanel(btn) {
  if (!btn) return;
  let dialog = null, data = null, loading = null;

  const close = () => {
    if (!dialog) return;
    dialog.close();
    btn.setAttribute("aria-expanded", "false");
    btn.focus({ preventScroll: true });
  };

  const open = async () => {
    // the figures are small and only needed here, so they load on first open
    if (!data && !loading) {
      loading = fetch("about/about.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    if (!data) data = await loading;

    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "infodlg";
      dialog.innerHTML = `<div class="info-head">
          <h2>About Ember</h2>
          <button type="button" class="info-x" aria-label="Close">×</button>
        </div>
        <div class="info-body">${body(data)}</div>`;
      document.body.appendChild(dialog);
      dialog.querySelector(".info-x").addEventListener("click", close);
      dialog.addEventListener("close", () => btn.setAttribute("aria-expanded", "false"));
      // clicking the backdrop closes it, clicking the panel does not
      dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
    }
    dialog.showModal();
    btn.setAttribute("aria-expanded", "true");
    dialog.querySelector(".info-x").focus({ preventScroll: true });
  };

  btn.addEventListener("click", () => {
    if (btn.getAttribute("aria-expanded") === "true") close(); else open();
  });
}

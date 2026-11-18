/* ============ CONFIGURATION (à adapter si besoin) ============ */
const CONFIG = {
  fichiers: {
    chateaux:     "data/chateaux.geojson",
    communes:     "data/communes.geojson",
    departements: "data/departements.geojson"
  },
  // Noms de champs : laisser null pour une détection automatique
  champCategorie: "Categorie",  // couche châteaux
  champNom:       "NOM",        // couche châteaux
  champCommune:   "nomcom",     // couche communes
  champDep:       "NumDep"      // couche départements
};
const COULEURS = ["#5b8def", "#7fa23c", "#f28c38", "#d64545", "#9b6bd6", "#2bb5a0"];

/* ============ OUTILS ============ */
const $ = s => document.querySelector(s);
const fmt = n => n.toLocaleString("fr-FR");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const propsOf = fc => fc.features.map(f => f.properties || {});

function distinct(fc, key) { return [...new Set(propsOf(fc).map(p => p[key]).filter(v => v !== null && v !== ""))]; }

function detectCategorie(fc) {
  const keys = Object.keys(fc.features[0].properties || {});
  const ok = k => { const n = distinct(fc, k).length; return n >= 2 && n <= 10; };
  return keys.find(k => /cat|class|type|interet|niveau/i.test(k) && ok(k)) || keys.find(ok) || keys[0];
}
function detectNom(fc, exclude) {
  const keys = Object.keys(fc.features[0].properties || {});
  return keys.find(k => /^(nom|name|libelle|appellation|denomination|titre)/i.test(k) && k !== exclude)
      || keys.find(k => typeof fc.features[0].properties[k] === "string" && k !== exclude);
}
function detectCle(fc, regex) {
  const keys = Object.keys(fc.features[0].properties || {});
  return keys.find(k => regex.test(k)) || detectNom(fc);
}

/* Point dans un polygone (ray casting), géométrie Polygon / MultiPolygon */
function inRing(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function inGeom(pt, g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some(p => inRing(pt, p[0]) && !p.slice(1).some(h => inRing(pt, h)));
}
function bbox(g) {
  let a = [Infinity, Infinity, -Infinity, -Infinity];
  (function walk(c) { typeof c[0] === "number"
    ? (a = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[0]), Math.max(a[3], c[1])])
    : c.forEach(walk); })(g.coordinates);
  return a;
}
function findIn(fc, pt) {
  return fc.features.find(f => {
    const b = f._bb || (f._bb = bbox(f.geometry));
    return pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3] && inGeom(pt, f.geometry);
  });
}

/* ============ CHARGEMENT ============ */
let D = {};
async function charger() {
  try {
    const noms = Object.keys(CONFIG.fichiers);
    const res = await Promise.all(noms.map(n => fetch(CONFIG.fichiers[n]).then(r => { if (!r.ok) throw new Error(n); return r.json(); })));
    noms.forEach((n, i) => D[n] = res[i]);
    demarrer();
  } catch (e) {
    console.warn("Chargement automatique impossible :", e);
    $("#fallback").hidden = false;
    $("#lead").textContent = "En attente des fichiers GeoJSON…";
  }
}
$("#files").addEventListener("change", async e => {
  for (const f of e.target.files) {
    const json = JSON.parse(await f.text()), n = f.name.toLowerCase();
    if (/chateau|demeure/.test(n)) D.chateaux = json;
    else if (/depart/.test(n)) D.departements = json;
    else if (/commun/.test(n)) D.communes = json;
  }
  if (D.chateaux && D.communes && D.departements) { $("#fallback").hidden = true; demarrer(); }
});

/* ============ TABLEAU DE BORD ============ */
let map, couche, marqueurs = [], actives = new Set(), cats = [], catKey, nomKey;

function demarrer() {
  const ch = D.chateaux;
  catKey = CONFIG.champCategorie || detectCategorie(ch);
  nomKey = CONFIG.champNom || detectNom(ch, catKey);
  cats = distinct(ch, catKey).map(String).sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
  actives = new Set(cats);
  const couleur = c => COULEURS[cats.indexOf(String(c)) % COULEURS.length];

  /* Statistiques */
  const total = ch.features.length;
  const parCat = cats.map(c => ch.features.filter(f => String(f.properties[catKey]) === c).length);
  const iTop = parCat.indexOf(Math.max(...parCat));

  const comKey = CONFIG.champCommune || detectCle(D.communes, /^(nomcom|nom_com|nom_commune|libelle|nom)/i);
  const depKey = CONFIG.champDep || detectCle(D.departements, /^(nom_dep|nom|libelle|num_dep|code_dep|dep)/i);
  const parCom = new Map(), depsTouches = new Set();
  ch.features.forEach(f => {
    const pt = f.geometry.coordinates;
    const c = findIn(D.communes, pt), d = findIn(D.departements, pt);
    f._commune = c ? c.properties[comKey] : null;
    f._dep = d ? d.properties[depKey] : null;
    if (c) parCom.set(f._commune, (parCom.get(f._commune) || 0) + 1);
    if (d) depsTouches.add(f._dep);
  });
  const nbCom = parCom.size, totalCom = D.communes.features.length;
  const pct = n => Math.round(n / total * 100);

  /* Indicateurs */
  $("#k-total").textContent = fmt(total);
  $("#k-total-s").textContent = cats.length + " catégories";
  $("#k-top").textContent = cats[iTop].replace(/^\d+\s*[-–]\s*/, "");
  $("#k-top-s").textContent = parCat[iTop] + " sites · " + pct(parCat[iTop]) + " %";
  $("#k-com").textContent = fmt(nbCom);
  $("#k-com-s").textContent = "sur " + fmt(totalCom) + " communes";
  $("#k-dep").textContent = depsTouches.size || D.departements.features.length;
  $("#k-dep-s").textContent = "sur " + D.departements.features.length + " en Île-de-France";
  $("#lead").textContent = `Répartition de ${fmt(total)} châteaux et demeures selon leur niveau d’intérêt patrimonial, sur ${totalCom} communes et ${D.departements.features.length} départements.`;

  /* Légende + puces de filtre */
  $("#legend").innerHTML = cats.map((c, i) => `<li><i style="background:${couleur(c)}"></i><span>${esc(c)} <b>(${parCat[i]})</b></span></li>`).join("");
  $("#chips").innerHTML = cats.map(c => `<button class="chip" data-c="${esc(c)}"><i style="background:${couleur(c)}"></i>${esc(c.split(" - ")[0].length < 4 ? "Catégorie " + c.split(" - ")[0] : c)}</button>`).join("");
  document.querySelectorAll(".chip").forEach(b => b.onclick = () => {
    const c = b.dataset.c;
    actives.has(c) ? actives.delete(c) : actives.add(c);
    b.classList.toggle("off", !actives.has(c));
    filtrer();
  });

  /* Graphique */
  new Chart($("#chart"), {
    type: "bar",
    data: { labels: cats.map(c => c.split(" - ")[0]), datasets: [{ data: parCat, backgroundColor: cats.map(couleur), borderRadius: 10 }] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: i => cats[i[0].dataIndex] } } },
      scales: { y: { beginAtZero: true, grid: { color: "#0000000d" }, title: { display: true, text: "Nombre de sites" } }, x: { grid: { display: false } } }
    }
  });

  /* Classement des communes */
  const top = [...parCom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  $("#rank").innerHTML = top.map(([n, v]) => `<li><span>${esc(n)}</span><b>${v}</b></li>`).join("");

  /* Interprétation */
  $("#reading").innerHTML =
    `Le jeu de données contient <b>${fmt(total)}</b> châteaux et demeures répartis en <b>${cats.length}</b> catégories. ` +
    `La catégorie « ${esc(cats[iTop])} » est la plus représentée (${parCat[iTop]} sites, ${pct(parCat[iTop])} %). ` +
    `Les sites se répartissent dans <b>${fmt(nbCom)}</b> communes sur ${fmt(totalCom)}, soit ${Math.round(nbCom / totalCom * 100)} % du territoire communal. ` +
    (top.length ? `La commune la mieux dotée est <b>${esc(top[0][0])}</b> avec ${top[0][1]} site${top[0][1] > 1 ? "s" : ""}. ` : "") +
    `Les sites d’intérêt supérieur restent minoritaires : ce sont des lieux rares, tandis que les sites d’intérêt local forment le tissu de base du patrimoine.`;

  /* Carte */
  map = L.map("map").setView([48.7, 2.5], 9);
  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
  const style = (w, fill) => ({ color: "#222", weight: w, fillOpacity: fill });
  const lCom = L.geoJSON(D.communes, { style: style(.6, 0), onEachFeature: (f, l) => l.bindTooltip(esc(f.properties[comKey]), { sticky: true }) });
  const lDep = L.geoJSON(D.departements, { style: style(2.2, 0), interactive: false }).addTo(map);
  couche = L.layerGroup().addTo(map);

  ch.features.forEach(f => {
    const [x, y] = f.geometry.coordinates, c = String(f.properties[catKey]);
    const m = L.circleMarker([y, x], { radius: 5 + cats.indexOf(c) * 1.6, color: "#fff", weight: 1.5, fillColor: couleur(c), fillOpacity: .9 });
    m.bindTooltip(esc(f.properties[nomKey]));
    m.on("click", () => fiche(f, couleur(c)));
    marqueurs.push({ m, f, c });
  });
  L.control.layers({ OpenStreetMap: osm }, { "Châteaux et demeures": couche, "Départements": lDep, "Communes": lCom }, { collapsed: false }).addTo(map);
  filtrer();
  map.fitBounds(lDep.getBounds());

  $("#search").addEventListener("input", filtrer);
}

function filtrer() {
  const q = $("#search").value.trim().toLowerCase();
  couche.clearLayers();
  marqueurs.forEach(({ m, f, c }) => {
    const nom = String(f.properties[nomKey] ?? "").toLowerCase();
    if (actives.has(c) && nom.includes(q)) couche.addLayer(m);
  });
}

function fiche(f, couleur) {
  const p = f.properties;
  const lignes = Object.entries(p).filter(([k, v]) => k !== nomKey && v !== null && v !== "").slice(0, 8)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $("#detail").innerHTML = `<h2>Détails du site</h2>
    <p class="name">${esc(p[nomKey])}</p>
    <span class="pill" style="border-left:10px solid ${couleur}">${esc(p[catKey])}</span>
    <dl>${f._commune ? `<dt>Commune</dt><dd>${esc(f._commune)}</dd>` : ""}${lignes}</dl>`;
}

charger();

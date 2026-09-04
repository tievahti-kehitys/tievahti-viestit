// Tievahdin kirjepaja — selainkäyttöliittymä kirjepalvelun REST-rajapinnalle.
//
// Turvaperiaatteet (turvakatselmus 20.8.2026):
//  - Palvelimelta tulevaa tekstiä ei koskaan sijoiteta innerHTML:ään, vaan aina
//    textContentiin. Näin sisällöntuottajan syöte ei voi ajautua koodina
//    hyväksyjän selaimessa (eikä varastaa API-avainta).
//  - Ei inline-käsittelijöitä: sivun CSP kieltää inline-skriptit.
//  - Rooli tulee palvelimelta (/me), sitä ei päätellä virheilmoituksista.
//  - Avain on oletuksena vain istunnon ajan; "Muista tämä laite" siirtää sen
//    pysyvään talletukseen käyttäjän valinnalla.
"use strict";

// Kehysmurto: estä sivun upottaminen toiselle sivulle (meta-CSP ei kata frame-ancestorsia)
if (window.top !== window.self) {
  try { window.top.location = window.self.location; } catch (_) { /* eri origin */ }
  document.documentElement.textContent = "";
  throw new Error("kehystetty");
}

const API = "https://uzaaynqxbfpjxgvetgam.supabase.co/functions/v1/kirjepalvelu";
const $ = (id) => document.getElementById(id);

let KEY = sessionStorage.getItem("tvk_key") || localStorage.getItem("tvk_key") || "";
let ME = null;      // { label, role, test_domains }
let CUR = null;     // avoinna oleva luonnos
let AUDS = [];
let jobTimer = null;

async function api(path, opts) {
  const res = await fetch(API + path, Object.assign({}, opts, {
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
  }));
  let data = {};
  try { data = await res.json(); } catch (_) { /* tyhjä vastaus */ }
  if (!res.ok) {
    const err = new Error(data.error || ("Palvelin vastasi " + res.status));
    err.details = data.blockers || (data.validation && data.validation.errors) || [];
    throw err;
  }
  return data;
}

// Viesti aina tekstinä; lista rakennetaan elementteinä
function msg(boxId, text, kind, items) {
  const box = $(boxId);
  box.textContent = "";
  if (!text) return;
  const div = document.createElement("div");
  div.className = "msg " + (kind === "ok" ? "ok" : "err");
  div.textContent = text;
  if (items && items.length) {
    const ul = document.createElement("ul");
    items.forEach((i) => {
      const li = document.createElement("li");
      li.textContent = i;
      ul.appendChild(li);
    });
    div.appendChild(ul);
  }
  box.appendChild(div);
}

function show(view) {
  ["login", "listView", "editView"].forEach((v) =>
    $(v).classList.toggle("hide", v !== view));
}

// ---------- kirjautuminen ----------
async function login() {
  KEY = $("key").value.trim();
  if (!KEY) return msg("loginMsg", "Syötä avain.");
  try {
    ME = await api("/me");
    sessionStorage.setItem("tvk_key", KEY);
    if ($("remember").checked) localStorage.setItem("tvk_key", KEY);
    msg("loginMsg", "");
    $("whoami").textContent = ME.role === "approver"
      ? "Kirjautunut hyväksyjänä (" + ME.label + ") — voit hyväksyä ja lähettää."
      : "Kirjautunut sisällöntuottajana (" + ME.label + ") — testilähetykset ja hyväksyntäpyynnöt.";
    await loadAll();
    show("listView");
  } catch (e) {
    msg("loginMsg", e.message);
  }
}

function logout() {
  sessionStorage.removeItem("tvk_key");
  localStorage.removeItem("tvk_key");
  location.reload();
}

// ---------- lista ----------
async function loadAll() {
  const [a, d] = await Promise.all([api("/audiences"), api("/drafts")]);
  AUDS = a.audiences;

  const auds = $("auds");
  auds.textContent = "";
  AUDS.forEach((x) => {
    const box = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = x.recipients.toLocaleString("fi-FI");
    const s = document.createElement("span");
    s.textContent = x.label;
    box.append(b, s);
    auds.appendChild(box);
  });

  const sel = $("stream");
  sel.textContent = "";
  AUDS.forEach((x) => {
    const o = document.createElement("option");
    o.value = x.stream;
    o.textContent = x.label + " (" + x.recipients.toLocaleString("fi-FI") + ")";
    sel.appendChild(o);
  });

  const list = $("list");
  list.textContent = "";
  if (!d.drafts.length) {
    const empty = document.createElement("div");
    empty.className = "card";
    empty.textContent = 'Ei kirjeitä vielä. Aloita napista "Uusi kirje".';
    list.appendChild(empty);
    return;
  }
  d.drafts.forEach((x) => {
    const errs = (x.validation && x.validation.errors) ? x.validation.errors.length : 0;
    const aud = AUDS.find((a2) => a2.stream === x.stream);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item";
    const left = document.createElement("span");
    const h = document.createElement("h3");
    h.textContent = x.subject || "(nimetön)";
    const small = document.createElement("small");
    small.textContent = (aud ? aud.label : x.stream) + " · " + x.created_by +
      (errs ? " · " + errs + " korjattavaa" : "");
    left.append(h, small);
    const chip = document.createElement("span");
    chip.className = "chip c-" + x.status;
    chip.textContent = x.status;
    btn.append(left, chip);
    btn.addEventListener("click", () => openDraft(x.id));
    list.appendChild(btn);
  });
}

// ---------- lohkot ----------
// Sama lohkotyyppijoukko kuin kirjepalvelun BLOCK_TYPES. Aiemmin UI tunsi vain
// kolme ensimmäistä, jolloin AI:n tekemän kirjeen kuponki/vinkki/askeleet/ehdot
// muuttuivat tallennettaessa hiljaa tavalliseksi tekstiksi (havaittu 1.9.2026).
const BLOCK_TYPES = [
  ["text", "Tavallinen teksti"],
  ["fakta", "Vihreä nosto (fakta tai lista)"],
  ["nosto", "Oranssi nosto (tarjous)"],
  ["kuponki", "Kuponki (iso etu, katkoviivareunus)"],
  ["vinkki", "Vinkkilaatikko (Hyvä tietää)"],
  ["askeleet", "Askeleet (numeroitu 1-2-3)"],
  ["ehdot", "Ehdot (pikkuprintti)"],
];

function blockEl(b) {
  b = b || {};
  const wrap = document.createElement("div");
  wrap.className = "blk";

  const mk = (labelText, el) => {
    const l = document.createElement("label");
    l.textContent = labelText;
    wrap.append(l, el);
    return el;
  };
  const type = document.createElement("select");
  BLOCK_TYPES.forEach(([v, t]) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = t;
    type.appendChild(o);
  });
  type.className = "b-type";
  mk("Lohkon tyyli", type);

  const heading = document.createElement("input");
  heading.className = "b-heading";
  mk("Väliotsikko (valinnainen)", heading);

  const text = document.createElement("textarea");
  text.className = "b-text";
  mk("Teksti (tyhjä rivi = uusi kappale)", text);

  const items = document.createElement("textarea");
  items.className = "b-items short";
  mk("Luettelo, yksi kohta per rivi (valinnainen)", items);

  // Muotoilu on kirjoittajan valinta (4.9.2026): asettelu ja listamerkki.
  // Nämä pitää olla myös UI:ssa, muuten selaimessa tehty muokkaus pyyhkisi
  // AI:n tekemän valinnan hiljaa pois (sama vika kuin lohkotyypeissä 1.9.).
  const valinta = (cls, labelText, vaihtoehdot) => {
    const s = document.createElement("select");
    vaihtoehdot.forEach(([v, t]) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = t;
      s.appendChild(o);
    });
    s.className = cls;
    return mk(labelText, s);
  };
  const asettelu = valinta("b-asettelu", "Tasaus", [
    ["", "Oletus (kuponki keskellä, muut vasemmalla)"],
    ["vasen", "Vasemmalle"],
    ["keskitetty", "Keskitetty"],
  ]);
  const merkki = valinta("b-merkki", "Luettelon merkki", [
    ["", "Oletus (rasti ✅)"],
    ["rasti", "Rasti ✅"],
    ["luoti", "Luotelmapallo •"],
    ["ei", "Ei merkkiä"],
  ]);

  const row = document.createElement("div");
  row.className = "row";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "ghost";
  del.textContent = "Poista lohko";
  del.addEventListener("click", () => wrap.remove());
  row.appendChild(del);
  wrap.appendChild(row);

  // Tuntematon tyyppi (esim. palvelimelle lisätty uusi lohkotyyppi) säilytetään
  // omana valintanaan — tallennus ei saa koskaan hiljaa muuttaa sitä tekstiksi.
  const wanted = b.type || "text";
  if (!BLOCK_TYPES.some(([v]) => v === wanted)) {
    const o = document.createElement("option");
    o.value = wanted; o.textContent = wanted + " (tuntematon tyyppi, säilytetään)";
    type.appendChild(o);
  }
  type.value = wanted;
  heading.value = b.heading || "";
  text.value = b.text || "";
  items.value = (b.items || []).join("\n");
  asettelu.value = b.asettelu || "";
  merkki.value = b.merkki || "";
  return wrap;
}

function readBlocks() {
  return Array.prototype.map.call($("blocks").querySelectorAll(".blk"), (d) => ({
    type: d.querySelector(".b-type").value,
    heading: d.querySelector(".b-heading").value.trim(),
    text: d.querySelector(".b-text").value.trim(),
    items: d.querySelector(".b-items").value.split("\n")
      .map((s) => s.trim()).filter(Boolean),
    asettelu: d.querySelector(".b-asettelu").value,
    merkki: d.querySelector(".b-merkki").value,
  })).filter((b) => b.text || b.items.length || b.heading);
}

// Kaikki kirjepalvelun DRAFT_FIELDS-tekstikentät (stream ja body_blocks käsitellään erikseen).
// CTA-laatikon otsikko, saateteksti ja toinen nappi puuttuivat aiemmin → eivät näkyneet UI:ssa.
const FIELDS = ["subject", "preheader", "heading", "hero_url", "hero_alt",
  "cta_heading", "cta_text", "cta_label", "cta_url", "cta2_label", "cta2_url", "footer_reason"];

function newDraft() {
  CUR = null;
  FIELDS.forEach((f) => { $(f).value = ""; });
  $("footer_reason").value =
    "Sait tämän viestin, koska olet Tievahdin asiakas tai olet tilannut uutiskirjeemme.";
  $("blocks").textContent = "";
  $("blocks").appendChild(blockEl());
  $("previewCard").classList.add("hide");
  msg("editMsg", ""); msg("actionMsg", ""); msg("jobBox", "");
  show("editView");
}

async function openDraft(id) {
  try {
    const d = await api("/drafts/" + id);
    CUR = d;
    $("stream").value = d.stream;
    FIELDS.forEach((f) => { $(f).value = d[f] || ""; });
    $("blocks").textContent = "";
    let blocks = d.body_blocks;
    if (typeof blocks === "string") { try { blocks = JSON.parse(blocks); } catch (_) { blocks = []; } }
    if (!Array.isArray(blocks) || !blocks.length) blocks = [{}];
    blocks.forEach((b) => $("blocks").appendChild(blockEl(b)));
    msg("editMsg", ""); msg("actionMsg", ""); msg("jobBox", "");
    renderPreview(d);
    show("editView");
    // Jos lähetys on kesken tai keskeytynyt, palataan seuraamaan/jatkamaan sitä
    if (d.status === "lahetys_kesken") {
      const r = await api("/drafts/" + d.id + "/job");
      if (r.job) reflectJob(r.job);
    }
  } catch (e) {
    msg("actionMsg", e.message);
  }
}

// Näyttää työn tilan ja tarjoaa jatkon, jos työ on keskeytynyt
function reflectJob(job) {
  const stuck = job.status === "interrupted" || job.status === "error";
  msg("jobBox", "Lähetystyö: " + job.status + " — lähetetty " + job.sent + "/" + job.total +
    (Number(job.failed) ? ", epäonnistui " + job.failed : ""), stuck ? "err" : "ok");
  const canResume = stuck && ME && ME.role === "approver";
  $("resumeBtn").classList.toggle("hide", !canResume);
  if (job.status === "running") pollJob(job.id);
}

function payload() {
  const p = { stream: $("stream").value, body_blocks: readBlocks() };
  FIELDS.forEach((f) => { p[f] = $(f).value.trim(); });
  return p;
}

async function save() {
  try {
    const body = JSON.stringify(payload());
    const r = CUR && CUR.id
      ? await api("/drafts/" + CUR.id, { method: "PATCH", body: body })
      : await api("/drafts", { method: "POST", body: body });
    CUR = Object.assign({}, CUR || {}, r);
    renderPreview(r);
    const v = r.validation || { errors: [], warnings: [] };
    // Käyttäjän hyväksymät poikkeamat kerrotaan aina: hyväksyjän pitää tietää,
    // mikä on tehty tarkoituksella toisin kuin koneisto ehdottaisi.
    const poikkeamat = (v.poikkeamat || []).map((p) =>
      "Poikkeama: " + p.saanto + (p.syy ? " — " + p.syy : ""));
    if (v.errors.length) msg("editMsg", "Korjaa ennen hyväksyntää:", "err", v.errors.concat(poikkeamat));
    else if (v.warnings.length || poikkeamat.length) {
      msg("editMsg", "Tallennettu. Huomioi:", "ok", v.warnings.concat(poikkeamat));
    } else msg("editMsg", "Tallennettu — kirje läpäisi tarkistukset.", "ok");
    loadAll();
  } catch (e) {
    msg("editMsg", e.message, "err", e.details);
  }
}

async function renderPreview(d) {
  if (!d || !d.preview_url) return;
  // Haetaan HTML tekstinä ja renderöidään sandbox-iframeen: Supabase tarjoilee sen
  // text/plainina (näkyisi lähdekoodina .src-latauksella), ja tyhjä sandbox antaa
  // iframelle oman opaakin originin, joten esikatselu ei pääse käsiksi avaimeen.
  try {
    const html = await (await fetch(d.preview_url + "&r=" + Date.now())).text();
    $("preview").srcdoc = html;
  } catch (_) {
    $("preview").srcdoc = "<p style='font-family:sans-serif;padding:20px'>Esikatselua ei voitu ladata.</p>";
  }
  $("previewCard").classList.remove("hide");
  updateActionButtons(d.status);
  if (ME && ME.test_domains && !$("testTo").placeholder.includes(ME.test_domains[0])) {
    $("testTo").placeholder = "oma.osoite@" + ME.test_domains[0];
  }
}

// Napit näkyvät sekä roolin ETTÄ kirjeen tilan mukaan
function updateActionButtons(status) {
  const approver = ME && ME.role === "approver";
  const locked = status === "lahetetty" || status === "lahetys_kesken";
  $("approvalBtn").classList.toggle("hide", locked || status === "lahetetty");
  $("approveBtn").classList.toggle("hide",
    !approver || !["luonnos", "hyvaksyntapyynto", "hylatty"].includes(status));
  $("rejectBtn").classList.toggle("hide",
    !approver || !["luonnos", "hyvaksyntapyynto", "hyvaksytty"].includes(status));
  $("sendBtn").classList.toggle("hide", !approver || status !== "hyvaksytty");
  // Resume-nappi paljastetaan vain työn tilan perusteella (reflectJob/pollJob)
  if (status !== "lahetys_kesken") $("resumeBtn").classList.add("hide");
}

async function testSend() {
  const to = $("testTo").value.trim();
  if (!CUR || !CUR.id) return msg("actionMsg", "Tallenna kirje ensin.");
  if (!to) return msg("actionMsg", "Anna sisäinen testiosoite.");
  try {
    await api("/drafts/" + CUR.id + "/test", { method: "POST", body: JSON.stringify({ to: to }) });
    msg("actionMsg", "Testikirje lähetetty osoitteeseen " + to, "ok");
  } catch (e) {
    msg("actionMsg", e.message, "err", e.details);
  }
}

async function requestApproval() {
  if (!CUR || !CUR.id) return msg("actionMsg", "Tallenna kirje ensin.");
  try {
    const r = await api("/drafts/" + CUR.id + "/request-approval", { method: "POST" });
    msg("actionMsg", "Hyväksyntäpyyntö lähetetty. Tila: " + r.status, "ok");
    loadAll();
  } catch (e) {
    msg("actionMsg", e.message, "err", e.details);
  }
}

async function decide(action) {
  if (!CUR || !CUR.id) return;
  try {
    const r = await api("/drafts/" + CUR.id + "/" + action, { method: "POST" });
    CUR.status = r.status;
    updateActionButtons(r.status);
    msg("actionMsg", action === "approve"
      ? "Hyväksytty. Voit nyt lähettää yleisölle."
      : "Kirje hylätty.", "ok");
    loadAll();
  } catch (e) {
    msg("actionMsg", e.message, "err", e.details);
  }
}

async function sendReal() {
  if (!CUR || !CUR.id) return;
  // Yleisö luetaan AINA tallennetusta kirjeestä, ei lomakkeen valitsimesta: palvelin
  // lähettää kirjeen oman stream-arvon mukaan. Aiemmin tämä luki lomakkeen valitsimen,
  // joten vahvistusdialogi näytti väärän yleisön ja väärän määrän juuri siinä kohdassa,
  // joka on ihmisen viimeinen tarkistus ennen peruuttamatonta lähetystä. Havaittu
  // 4.9.2026: dialogi lupasi "8206 (Uutiskirje)" kun lähdössä oli 308 tieisännöitsijää.
  if ($("stream").value !== CUR.stream) {
    return msg("actionMsg", "Lomakkeen yleisö (" + $("stream").value + ") ei vastaa tallennettua " +
      "kirjettä (" + CUR.stream + "). Lataa sivu uudelleen ja avaa kirje listasta ennen lähetystä.", "err");
  }
  const aud = AUDS.find((a) => a.stream === CUR.stream) || { recipients: "?", label: CUR.stream };
  const typed = prompt("Kirje: " + (CUR.subject || "(ei aihetta)") +
    "\nYleisö: " + aud.label + " (" + CUR.stream + ")" +
    "\nLähetetään " + aud.recipients + " vastaanottajalle." +
    "\nTätä ei voi peruuttaa.\nKirjoita LÄHETÄ vahvistukseksi:");
  if (typed !== "LÄHETÄ") return msg("actionMsg", "Lähetys peruttu.");
  try {
    const r = await api("/drafts/" + CUR.id + "/send", { method: "POST" });
    msg("actionMsg", "Lähetys käynnistyi: " + r.total + " vastaanottajaa.", "ok");
    pollJob(r.job_id);
    loadAll();
  } catch (e) {
    msg("actionMsg", e.message, "err", e.details);
  }
}

function pollJob(jobId) {
  if (jobTimer) clearInterval(jobTimer);
  const tick = async () => {
    try {
      const j = await api("/jobs/" + jobId);
      msg("jobBox", "Lähetystyö: " + j.status + " — lähetetty " + j.sent + "/" + j.total +
        (Number(j.failed) ? ", epäonnistui " + j.failed : ""), j.status === "done" ? "ok" : "err");
      if (["done", "error", "interrupted"].includes(j.status)) {
        clearInterval(jobTimer);
        jobTimer = null;
        // Keskeytynyt työ voidaan jatkaa; valmis/virhe palauttaa napit normaaliksi
        const canResume = (j.status === "interrupted" || j.status === "error")
          && ME && ME.role === "approver";
        $("resumeBtn").classList.toggle("hide", !canResume);
        loadAll();
      }
    } catch (_) { /* ohitetaan yksittäinen kysely */ }
  };
  tick();
  jobTimer = setInterval(tick, 5000);
}

async function resumeSend() {
  if (!CUR || !CUR.id) return;
  $("resumeBtn").disabled = true;
  try {
    const r = await api("/drafts/" + CUR.id + "/resume", { method: "POST" });
    $("resumeBtn").classList.add("hide");
    msg("actionMsg", "Lähetystä jatketaan: " + (r.total || "?") + " vastaanottajaa.", "ok");
    pollJob(r.job_id);
  } catch (e) {
    msg("actionMsg", e.message, "err", e.details);
  } finally {
    $("resumeBtn").disabled = false;
  }
}

// ---------- käsittelijät ----------
$("loginBtn").addEventListener("click", login);
$("key").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
$("logoutBtn").addEventListener("click", logout);
$("reloadBtn").addEventListener("click", () => loadAll());
$("newBtn").addEventListener("click", newDraft);
$("backBtn").addEventListener("click", () => { show("listView"); loadAll(); });
$("addBlockBtn").addEventListener("click", () => $("blocks").appendChild(blockEl()));
$("saveBtn").addEventListener("click", save);
$("testBtn").addEventListener("click", testSend);
$("approvalBtn").addEventListener("click", requestApproval);
$("approveBtn").addEventListener("click", () => decide("approve"));
$("rejectBtn").addEventListener("click", () => decide("reject"));
$("sendBtn").addEventListener("click", sendReal);
$("resumeBtn").addEventListener("click", resumeSend);

if (KEY) {
  $("key").value = KEY;
  $("remember").checked = !!localStorage.getItem("tvk_key");
  login();
}

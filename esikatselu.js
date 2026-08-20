// Tievahdin kirjeen esikatselu — avattavissa suoraan (puhelin, ChatGPT-linkki).
//
// Hakee kirjeen HTML:n tekstinä kirjepalvelun preview-päätepisteestä ja renderöi
// sen tyhjään sandbox-iframeen. Supabase tarjoilee HTML:n text/plainina, joten
// suora .src näyttäisi lähdekoodin; siksi haetaan tekstinä ja asetetaan srcdociin.
// Sivu ei käytä API-avainta: allekirjoitettu token on linkissä.
"use strict";

// Kehysmurto: älä anna upottaa tätä toiselle sivulle.
if (window.top !== window.self) {
  try { window.top.location = window.self.location; } catch (_) { /* eri origin */ }
  document.documentElement.textContent = "";
  throw new Error("kehystetty");
}

const API = "https://uzaaynqxbfpjxgvetgam.supabase.co/functions/v1/kirjepalvelu";
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const id = params.get("id") || "";
const t = params.get("t") || "";

// Kevyt muototarkistus ennen hakua: id = uuid, t = heksatiiviste.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,128}$/i;

function fail(text) {
  $("status").textContent = text;
  $("preview").srcdoc = "<!doctype html><meta charset='utf-8'><p style='font:16px/1.5 sans-serif;padding:24px;color:#444'>" + text + "</p>";
}

async function main() {
  if (!UUID.test(id) || !HEX.test(t)) {
    fail("Virheellinen esikatselulinkki.");
    return;
  }
  const url = API + "/preview/" + id + "?t=" + encodeURIComponent(t) + "&r=" + Date.now();
  try {
    const res = await fetch(url);
    if (!res.ok) {
      fail(res.status === 403
        ? "Esikatselulinkki on vanhentunut tai virheellinen."
        : "Esikatselua ei voitu ladata (" + res.status + ").");
      return;
    }
    $("preview").srcdoc = await res.text();
    $("status").textContent = "Näin kirje näyttää saapuneissa.";
  } catch (_) {
    fail("Esikatselua ei voitu ladata. Tarkista verkkoyhteys.");
  }
}
main();

"use strict";

// ===========================================================================
// KONSTANTEN (portiert aus obsidian-dashboard/dashboard.py)
// ===========================================================================

const DIESE_WOCHE_TAGE = 7;
const KLAUSUR_VORSCHAU_TAGE = 14;
const VERGANGENE_AUFGABEN_TAGE = 14;
const PRIORITAET_REIHENFOLGE = { hoch: 0, mittel: 1, niedrig: 2 };
const LERNSTAND_WERTE = new Set(["verstanden", "teilweise", "offen"]);
const KLAUSUR_COUNTDOWN_ROT_TAGE = 3;
const KLAUSUR_COUNTDOWN_GELB_TAGE = 7;
const KLAUSUR_BALD_TAGE = 7; // Aufgaben mit Klausur im Fach in <= X Tagen -> Badge "Klausur bald"
const LK_FAECHER = new Set(["Mathe-LK", "Physik-LK", "Geschichte"]);
const GEWICHT_LK = { schriftlich: 0.4, muendlich: 0.6 };
const GEWICHT_GK = { schriftlich: 0.3, muendlich: 0.7 };
const WOCHENTAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

const BEGLEITER_DATEI_NAME = "Begleiter-Uebersicht.md"; // liegt in Schule/ im Vault, wird von der Begleiter-Automatik geschrieben
const BEGLEITER_NEU_TAGE = 7;       // Updates der letzten X Tage bekommen ein "Neu"-Badge
const BEGLEITER_MAX_UPDATES = 5;    // so viele letzte Updates pro Fach anzeigen

// Feste Drive-Ordner-ID des echten Vaults. Die Namenssuche allein hat
// 2026-09 eine alte Vault-Kopie gleichen Namens erwischt (-> fehlende
// Begleiter-Infos, veraltete Daten); sie ist nur noch Fallback.
const VAULT_FOLDER_ID = "1GOFBNm2FztTj5XjNf8dTssn2Ai-F8z1X";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
// Scope, den ein Token haben muss, damit die Schreibfunktionen freigeschaltet
// werden. Solange DRIVE_SCOPE oben nur drive.readonly anfragt, bleibt die App
// lesend und zeigt den Schreibrechte-Hinweis (siehe README).
const SCHREIB_SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

// ===========================================================================
// KLEINE HELFER
// ===========================================================================

function esc(text) {
  const d = document.createElement("div");
  d.textContent = String(text ?? "");
  return d.innerHTML;
}

function dateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addTage(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function diffTage(a, b) {
  // a - b in ganzen Tagen (beide bereits dateOnly())
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function formatiereDatumLang(d) {
  const wt = WOCHENTAGE[(d.getDay() + 6) % 7]; // JS: So=0..Sa=6 -> Mo=0..So=6
  const tt = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${wt}, ${tt}.${mm}.${d.getFullYear()}`;
}

function formatiereDatumKurz(d) {
  const tt = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${tt}.${mm}.${d.getFullYear()}`;
}

function formatiereMinuten(minuten) {
  if (minuten <= 0) return "0 Min";
  const stunden = Math.floor(minuten / 60);
  const rest = minuten % 60;
  if (stunden && rest) return `${stunden}h ${rest}min`;
  if (stunden) return `${stunden}h`;
  return `${rest} Min`;
}

function qEscape(name) {
  return name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ===========================================================================
// GOOGLE DRIVE ZUGRIFF (Lesen; Schreiben nur ueber schreibeDatei/erstelleDatei)
// ===========================================================================

let accessToken = null;
let tokenAblauf = 0;          // Zeitpunkt (ms), ab dem das Token als abgelaufen gilt
let erneuerungsTimer = null;
let schreibrechte = false;    // hat das aktuelle Token den vollen drive-Scope?

// Login per Weiterleitung statt Popup (seit 2026-09-27): Safari blockiert
// Popups, die nicht direkt durch einen Tap ausgeloest werden - der stille
// Login beim App-Start per GIS-Popup scheiterte auf dem iPad deshalb fast
// immer. Eine Weiterleitung zu Google mit prompt=none wird nie blockiert:
// Ist man im Browser bei Google angemeldet und hat schon zugestimmt, kommt
// man nach ~1 s mit frischem Token zurueck, ohne etwas zu tippen. Das Token
// steht nur im URL-Fragment, wird sofort daraus entfernt und nirgends
// gespeichert. Die Rueckkehr-Adresse muss in der Google Cloud Console als
// "Autorisierte Weiterleitungs-URI" eingetragen sein (siehe README).
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, "");
const STILL_SPERRE_MS = 60 * 1000; // hoechstens ein stiller Versuch pro Minute (kein Weiterleitungs-Kreisel)

function zufallsHex(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function speicher(art) {
  try { return art === "session" ? sessionStorage : localStorage; } catch (e) { return null; }
}
function speicherLesen(art, schluessel) {
  try { return speicher(art)?.getItem(schluessel) ?? null; } catch (e) { return null; }
}
function speicherSchreiben(art, schluessel, wert) {
  try {
    if (wert === null) speicher(art)?.removeItem(schluessel);
    else speicher(art)?.setItem(schluessel, wert);
  } catch (e) { /* privater Modus o.ae. - dann eben ohne */ }
}

// Leitet zu Google weiter. still = prompt=none (keine Oberflaeche, Fehler
// kommt als error=... zurueck); zustimmung = Rechte-Abfrage erzwingen.
function starteLogin({ still = false, zustimmung = false } = {}) {
  const state = zufallsHex();
  speicherSchreiben("session", "oauth_state", state);
  speicherSchreiben("session", "oauth_still", still ? "1" : "0");
  if (still) speicherSchreiben("session", "oauth_still_zeit", String(Date.now()));
  const params = new URLSearchParams({
    client_id: CONFIG.OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "token",
    scope: DRIVE_SCOPE,
    include_granted_scopes: "true",
    state,
  });
  if (still) params.set("prompt", "none");
  else if (zustimmung) params.set("prompt", "consent");
  const konto = speicherLesen("local", "dashboard_konto");
  if (konto) params.set("login_hint", konto);
  location.assign(`${GOOGLE_AUTH_URL}?${params.toString()}`);
}

// Stiller Versuch nur, wenn nicht bewusst abgemeldet und nicht gerade erst
// einer fehlgeschlagen ist. Gibt true zurueck, wenn weitergeleitet wird.
function versucheStillenLogin() {
  if (speicherLesen("local", "dashboard_abgemeldet") === "1") return false;
  const zuletzt = Number(speicherLesen("session", "oauth_still_zeit") || 0);
  if (Date.now() - zuletzt < STILL_SPERRE_MS) return false;
  setStatus("Melde bei Google an …");
  starteLogin({ still: true });
  return true;
}

// Wertet die Rueckkehr von Google aus (#access_token=... bzw. #error=...)
// und entfernt das Fragment sofort aus der Adresszeile/History.
function leseLoginAntwort() {
  const fragment = location.hash.slice(1);
  if (!/(^|&)(access_token|error)=/.test(fragment)) return null;
  const p = new URLSearchParams(fragment);
  history.replaceState(null, "", location.pathname + location.search);
  const erwartet = speicherLesen("session", "oauth_state");
  const still = speicherLesen("session", "oauth_still") === "1";
  speicherSchreiben("session", "oauth_state", null);
  if (!erwartet || p.get("state") !== erwartet) return { fehler: "state_mismatch", still };
  if (p.get("error")) return { fehler: p.get("error"), still };
  return {
    token: p.get("access_token"),
    gueltigSekunden: Number(p.get("expires_in")) || 3600,
    scopes: (p.get("scope") || "").split(/\s+/),
  };
}

function initAuth() {
  const antwort = leseLoginAntwort();
  if (antwort && antwort.token) {
    speicherSchreiben("session", "oauth_still_zeit", null);
    uebernehmeToken(antwort);
    return;
  }
  if (antwort && antwort.fehler) {
    // Beim stillen Versuch ist ein Fehlschlag normal (nicht bei Google
    // angemeldet, mehrere Konten, ...) - dann einfach den Login-Button
    // zeigen. Nur bei einem bewussten Login die Fehlermeldung.
    if (!antwort.still && antwort.fehler !== "access_denied") zeigeAnmeldeFehler(antwort.fehler);
    return;
  }
  versucheStillenLogin();
}

function uebernehmeToken({ token, gueltigSekunden, scopes }) {
  accessToken = token;
  tokenAblauf = Date.now() + (gueltigSekunden - 120) * 1000; // 2 Minuten Puffer
  // Ein Token nur mit drive.readonly reicht weiter zum Anzeigen; Schreiben
  // geht erst nach einmaliger neuer Zustimmung (Hinweis-Banner mit Button).
  schreibrechte = scopes.includes(SCHREIB_SCOPE);
  zeigeSchreibrechteHinweis(!schreibrechte);
  planeTokenErneuerung();
  merkeKonto();
  aufAnmeldungReagieren();
}

// Merkt sich die Google-Adresse als login_hint, damit der stille Login auch
// bei mehreren angemeldeten Google-Konten ohne Kontoauswahl klappt.
async function merkeKonto() {
  try {
    const info = await driveFetchJson("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)");
    if (info.user && info.user.emailAddress) speicherSchreiben("local", "dashboard_konto", info.user.emailAddress);
  } catch (e) { /* nur Komfort */ }
}

// Kurz vor Ablauf (nach ~58 Min.) still ein neues Token holen - aber nur,
// wenn die Seite sichtbar ist und gerade nichts gespeichert oder eingegeben
// wird. Sonst passiert das beim naechsten Zurueckkehren bzw. Drive-Aufruf.
function planeTokenErneuerung() {
  clearTimeout(erneuerungsTimer);
  erneuerungsTimer = setTimeout(erneuereFallsNoetig, Math.max(tokenAblauf - Date.now(), 30 * 1000));
}

function nutzerIstBeschaeftigt() {
  const aktiv = document.activeElement;
  return schreibVorgangLaeuft
    || document.getElementById("bestaetigen-dialog").open
    || (aktiv && ["INPUT", "SELECT", "TEXTAREA"].includes(aktiv.tagName) && aktiv.type !== "checkbox");
}

function erneuereFallsNoetig() {
  if (!accessToken || Date.now() < tokenAblauf) return;
  if (document.visibilityState !== "visible" || nutzerIstBeschaeftigt()) {
    erneuerungsTimer = setTimeout(erneuereFallsNoetig, 60 * 1000);
    return;
  }
  versucheStillenLogin();
}

// Nach laengerer Pause (Handy im Standby, Tab im Hintergrund) beim
// Zurueckkehren sofort pruefen statt auf den Timer zu warten.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") erneuereFallsNoetig();
});

function zeigeAnmeldeFehler(fehler) {
  const el = document.getElementById("anmelde-fehler");
  el.textContent = `Anmeldung fehlgeschlagen: ${fehler}. Pruefe config.js (Client-ID) und in der Google Cloud Console die autorisierte Weiterleitungs-URI ${REDIRECT_URI}.`;
  el.hidden = false;
}

// Fehler "Token hat keine Schreibrechte" (403 insufficientPermissions bzw.
// ACCESS_TOKEN_SCOPE_INSUFFICIENT) - fuehrt zum Neu-Anmelden-Hinweis.
class SchreibrechteFehler extends Error {
  constructor() {
    super("Bitte einmal neu anmelden, um Schreibrechte zu erteilen.");
  }
}

// Gemeinsame Fehlerbehandlung fuer alle Drive-Aufrufe (lesend und schreibend).
async function driveAntwortPruefen(resp) {
  if (resp.status === 401) {
    // Token abgelaufen (z.B. Handy war laenger im Standby): still neu
    // anmelden; klappt das nicht (gerade erst versucht), Login-Screen.
    clearTimeout(erneuerungsTimer);
    accessToken = null;
    if (!versucheStillenLogin()) zeigeAnmeldeAnsicht();
    throw new Error("Sitzung abgelaufen, bitte erneut anmelden.");
  }
  if (resp.ok) return resp;
  const text = await resp.text();
  if (resp.status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(text)) {
    schreibrechte = false;
    zeigeSchreibrechteHinweis(true);
    throw new SchreibrechteFehler();
  }
  throw new Error(`Drive-API-Fehler ${resp.status}: ${text}`);
}

async function driveFetchJson(url, optionen = {}) {
  const resp = await fetch(url, {
    ...optionen,
    headers: { ...(optionen.headers || {}), Authorization: `Bearer ${accessToken}` },
  });
  await driveAntwortPruefen(resp);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Vault-Register: Nur Dateien/Ordner, die beim Laden aus dem Vault-Ordner
// (VAULT_FOLDER_ID und Unterordner) kamen, duerfen beschrieben bzw. als
// Ziel fuer neue Dateien genutzt werden. rev = headRevisionId zum Zeitpunkt
// des Ladens (Konfliktschutz: hat sich die Datei seitdem geaendert, wird
// nicht geschrieben).
// ---------------------------------------------------------------------------
const vaultOrdner = new Set();
const vaultDateien = new Map(); // id -> { name, rev }

function registriereVaultEintrag(eintrag, parentId) {
  if (!eintrag || !vaultOrdner.has(parentId)) return;
  if (eintrag.mimeType === FOLDER_MIME) vaultOrdner.add(eintrag.id);
  else vaultDateien.set(eintrag.id, { name: eintrag.name, rev: eintrag.headRevisionId || eintrag.modifiedTime || null });
}

async function driveListChildren(parentId, extraQuery = "") {
  let ergebnis = [];
  let pageToken = null;
  const q = `'${parentId}' in parents and trashed=false${extraQuery}`;
  do {
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken, files(id, name, mimeType, headRevisionId, modifiedTime)",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await driveFetchJson(`${DRIVE_API}?${params.toString()}`);
    ergebnis = ergebnis.concat(data.files || []);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  ergebnis.forEach((e) => registriereVaultEintrag(e, parentId));
  return ergebnis;
}

// Wie driveFindFolderByName, gibt aber null statt eines Fehlers zurueck.
async function driveSucheOrdner(name, parentId) {
  const parentClause = parentId ? ` and '${parentId}' in parents` : "";
  const q = `name='${qEscape(name)}' and mimeType='${FOLDER_MIME}' and trashed=false${parentClause}`;
  const params = new URLSearchParams({ q, fields: "files(id, name, mimeType)", pageSize: "5" });
  const data = await driveFetchJson(`${DRIVE_API}?${params.toString()}`);
  const ordner = data.files && data.files.length ? data.files[0] : null;
  if (ordner && parentId) registriereVaultEintrag(ordner, parentId);
  return ordner;
}

async function driveFindFolderByName(name, parentId) {
  const ordner = await driveSucheOrdner(name, parentId);
  if (!ordner) throw new Error(`Ordner '${name}' nicht gefunden (in Drive-Ordner ${parentId ?? "root"}).`);
  return ordner;
}

// Sucht eine (Nicht-Ordner-)Datei per Name in einem Ordner. Gibt null
// zurueck statt zu werfen, wenn es sie (noch) nicht gibt.
async function driveFindFileByName(name, parentId) {
  const q = `name='${qEscape(name)}' and '${parentId}' in parents and mimeType!='${FOLDER_MIME}' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id, name, mimeType, headRevisionId, modifiedTime)", pageSize: "5" });
  const data = await driveFetchJson(`${DRIVE_API}?${params.toString()}`);
  const datei = data.files && data.files.length ? data.files[0] : null;
  if (datei) registriereVaultEintrag(datei, parentId);
  return datei;
}

async function driveGetFileContent(fileId) {
  const resp = await fetch(`${DRIVE_API}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Konnte Datei nicht lesen (${resp.status})`);
  return resp.text();
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

// Durchsucht einen Ordner rekursiv nach .md-Dateien (Platzhalter mit
// fuehrendem "_" werden uebersprungen). parentName = Name des unmittelbaren
// Elternordners jeder Datei, analog zu Path.parent.name in dashboard.py.
async function listMdRecursive(folderId, parentName) {
  const kinder = await driveListChildren(folderId);

  // Unterordner parallel statt nacheinander durchsuchen - bei z.B. 11
  // Fach-Ordnern sonst 11 Netzwerk-Runden hintereinander statt gleichzeitig.
  const unterordnerErgebnisse = await Promise.all(
    kinder.filter((k) => k.mimeType === FOLDER_MIME).map((k) => listMdRecursive(k.id, k.name))
  );

  const dateien = kinder
    .filter((k) => k.mimeType !== FOLDER_MIME && k.name.endsWith(".md") && !k.name.startsWith("_"))
    .map((k) => ({ id: k.id, name: k.name, parentName }));

  return dateien.concat(...unterordnerErgebnisse);
}

// ===========================================================================
// PARSING: FRONTMATTER
// ===========================================================================

// Analog zu Python text.split("---", 2): findet die ersten zwei "---" und
// gibt [frontmatterRoh, body] zurueck. frontmatterRoh ist null, wenn kein
// gueltiges Frontmatter vorhanden ist (dann ist body == text).
function splitFrontmatter(text) {
  const ohneBom = text.replace(/^﻿/, "");
  if (!ohneBom.startsWith("---")) return [null, ohneBom];
  const zweiterIndex = ohneBom.indexOf("---", 3);
  if (zweiterIndex === -1) return [null, ohneBom];
  return [ohneBom.slice(3, zweiterIndex), ohneBom.slice(zweiterIndex + 3)];
}

function leseFrontmatter(text) {
  const [roh] = splitFrontmatter(text);
  if (roh === null) return {};
  try {
    const geladen = jsyaml.load(roh);
    return geladen && typeof geladen === "object" && !Array.isArray(geladen) ? geladen : {};
  } catch (e) {
    console.warn("Frontmatter konnte nicht geparst werden:", e);
    return {};
  }
}

function extrahiereFeld(block, feldname) {
  const escaped = feldname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const muster = new RegExp("\\*\\*" + escaped + ":\\*\\*[ \\t]*(.*)");
  const treffer = muster.exec(block);
  return treffer ? treffer[1].trim() : "";
}

// ===========================================================================
// PARSING: AUFGABEN (Aufgaben/Aufgaben-JJJJ-MM.md)
// ===========================================================================

const DEADLINE_MUSTER = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;

function parseDeadline(text) {
  const treffer = DEADLINE_MUSTER.exec(text);
  if (!treffer) return null;
  const [, datumText, zeitText] = treffer;
  const [jahr, monat, tag] = datumText.split("-").map(Number);
  if (zeitText) {
    const [std, min] = zeitText.split(":").map(Number);
    return new Date(jahr, monat - 1, tag, std, min);
  }
  return new Date(jahr, monat - 1, tag);
}

// Klausuren wurden frueher zusaetzlich als Aufgabe eingetragen ("## Deutsch:
// Klausur 1" mit Link auf [[Schule/Klausuren/...]]) - wie ist_klausur_eintrag()
// in dashboard.py ausblenden, sie haben ihren eigenen Tab.
const KLAUSUR_EINTRAG_TITEL = /^[^:]+:\s*Klausur\b/i;
function istKlausurEintrag(titel, beschreibung) {
  return KLAUSUR_EINTRAG_TITEL.test(titel || "") && (beschreibung || "").includes("[[Schule/Klausuren/");
}

function parseAufgabenDatei(text, dateiname) {
  const [, body] = splitFrontmatter(text);
  const bloecke = body.split(/^##[ \t]+/m).slice(1);

  const aufgaben = [];
  for (const block of bloecke) {
    const zeilen = block.split("\n");
    const titel = (zeilen[0] || "").trim() || "Unbenannte Aufgabe";

    const deadline = parseDeadline(extrahiereFeld(block, "Deadline"));
    if (deadline === null) continue; // ohne gueltige Deadline nicht anzeigbar

    let prioritaet = extrahiereFeld(block, "Priorität").toLowerCase();
    if (!(prioritaet in PRIORITAET_REIHENFOLGE)) prioritaet = "mittel";

    const status = extrahiereFeld(block, "Status").toLowerCase() || "nicht-gestartet";
    const fach = extrahiereFeld(block, "Fach") || "-";
    const beschreibung = extrahiereFeld(block, "Beschreibung");

    if (istKlausurEintrag(titel, beschreibung)) continue;
    aufgaben.push({ titel, fach, deadline, prioritaet, status, beschreibung, dateiname });
  }
  return aufgaben;
}

// Baut {fach_ordner: tage_bis} fuer die jeweils naechste anstehende Klausur
// je Fach-Ordner - Pendant zu berechne_klausur_naehe_pro_fach() im Desktop-
// Dashboard (dashboard.py). klausurenAnstehend hat tage_bis bereits gesetzt
// (siehe sammleAlleKlausuren), bei mehreren Klausuren im Fach zaehlt die
// naeher liegende.
function berechneKlausurNaeheProFach(klausurenAnstehend) {
  const naehe = {};
  for (const k of klausurenAnstehend) {
    const bisher = naehe[k.fachOrdnerName];
    if (bisher === undefined || k.tage_bis < bisher) naehe[k.fachOrdnerName] = k.tage_bis;
  }
  return naehe;
}

// Eine Aufgabe kann mehrere Faecher kommagetrennt im Fach-Feld haben (z.B.
// "Mathe-LK, Physik-LK" bei fachuebergreifenden Lernplaenen). Gibt die Tage
// bis zur naechsten Klausur ueber alle genannten Faecher zurueck, oder null.
function ermittleKlausurTageFuerAufgabe(aufgabeFach, klausurNaeheProFach) {
  if (!aufgabeFach || aufgabeFach.trim() === "-" || aufgabeFach.trim() === "–") return null;
  const treffer = aufgabeFach
    .split(",")
    .map((f) => f.trim())
    .filter((f) => klausurNaeheProFach[f] !== undefined)
    .map((f) => klausurNaeheProFach[f]);
  return treffer.length ? Math.min(...treffer) : null;
}

function kategorisiereAufgaben(aufgaben, heute, klausurNaeheProFach = {}) {
  const kategorien = { ueberfaellig: [], heute: [], diese_woche: [], spaeter: [], abgeschlossen: [] };
  const wocheEnde = addTage(heute, DIESE_WOCHE_TAGE);

  for (const aufgabe of aufgaben) {
    aufgabe.klausurTage = ermittleKlausurTageFuerAufgabe(aufgabe.fach, klausurNaeheProFach);
    const deadlineDatum = dateOnly(aufgabe.deadline);

    if (aufgabe.status === "abgeschlossen") {
      const tageSeit = diffTage(heute, deadlineDatum);
      if (tageSeit <= VERGANGENE_AUFGABEN_TAGE) kategorien.abgeschlossen.push(aufgabe);
      continue;
    }

    if (deadlineDatum < heute) kategorien.ueberfaellig.push(aufgabe);
    else if (deadlineDatum.getTime() === heute.getTime()) kategorien.heute.push(aufgabe);
    else if (deadlineDatum <= wocheEnde) kategorien.diese_woche.push(aufgabe);
    else kategorien.spaeter.push(aufgabe);
  }

  const sortierschluessel = (a) => [PRIORITAET_REIHENFOLGE[a.prioritaet] ?? 3, a.deadline.getTime()];
  for (const [name, liste] of Object.entries(kategorien)) {
    if (name === "abgeschlossen") {
      // Erledigte zuletzt-faellige zuerst - Klausurnaehe spielt fuer bereits
      // erledigte Aufgaben keine Rolle
      liste.sort((a, b) => {
        const [pa, da] = sortierschluessel(a);
        const [pb, db] = sortierschluessel(b);
        return -(pa - pb || da - db);
      });
    } else {
      // Aufgaben mit naher Klausur im gleichen Fach werden innerhalb der
      // Kategorie nach oben gezogen, ohne Klausurbezug = niedrigste
      // Prioritaet innerhalb der Kategorie (dann wie bisher Prioritaet/Deadline)
      liste.sort((a, b) => {
        const ka = a.klausurTage ?? Infinity;
        const kb = b.klausurTage ?? Infinity;
        if (ka !== kb) return ka - kb;
        const [pa, da] = sortierschluessel(a);
        const [pb, db] = sortierschluessel(b);
        return pa - pb || da - db;
      });
    }
  }
  return kategorien;
}

async function ladeAufgaben(aufgabenOrdnerId, heute) {
  const kinder = await driveListChildren(aufgabenOrdnerId);
  const dateien = [];
  for (const versatz of [-1, 0, 1]) {
    const monatIndex = heute.getMonth() + versatz;
    const jahr = heute.getFullYear() + Math.floor(monatIndex / 12);
    const monat = ((monatIndex % 12) + 12) % 12; // 0-basiert
    const name = `Aufgaben-${jahr}-${String(monat + 1).padStart(2, "0")}.md`;
    const datei = kinder.find((k) => k.name === name);
    if (datei) dateien.push(datei);
  }

  const inhalte = await Promise.all(dateien.map((d) => driveGetFileContent(d.id)));
  let alleAufgaben = [];
  inhalte.forEach((text, i) => {
    const aufgaben = parseAufgabenDatei(text, dateien[i].name);
    aufgaben.forEach((a) => { a.dateiId = dateien[i].id; });
    alleAufgaben = alleAufgaben.concat(aufgaben);
  });
  return alleAufgaben;
}

// ===========================================================================
// PARSING: KLAUSUREN (Schule/Klausuren/<Fach>/*.md)
// ===========================================================================

function parseKlausurDatum(wert) {
  if (wert instanceof Date) {
    // js-yaml parst unquoted JJJJ-MM-TT als UTC-Date - hier auf lokale
    // Kalendertag-Werte umsetzen, um Zeitzonen-Verschiebung zu vermeiden.
    return new Date(wert.getUTCFullYear(), wert.getUTCMonth(), wert.getUTCDate());
  }
  if (typeof wert === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(wert.trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return null;
}

function normalisiereThemen(wert) {
  if (wert == null) return [];
  if (Array.isArray(wert)) return wert.map((t) => String(t).trim()).filter(Boolean);
  if (typeof wert === "string") return wert.split(",").map((t) => t.trim()).filter(Boolean);
  return [String(wert)];
}

function normalisiereLernstandEintrag(wert) {
  if (typeof wert === "string") {
    const status = wert.trim().toLowerCase();
    return { status: LERNSTAND_WERTE.has(status) ? status : "offen", zeit_minuten: 0, sessions: [] };
  }
  if (typeof wert === "object" && wert !== null && !Array.isArray(wert)) {
    const status = String(wert.status || "").trim().toLowerCase();

    const sessions = [];
    for (const eintrag of wert.sessions || []) {
      if (typeof eintrag !== "object" || eintrag === null) continue;
      const datumText = String(eintrag.datum || "").trim();
      const minuten = Number(eintrag.minuten) || 0;
      if (datumText && minuten > 0) sessions.push({ datum: datumText, minuten });
    }

    const zeitMinuten = Number.isFinite(Number(wert.zeit_minuten))
      ? Number(wert.zeit_minuten)
      : sessions.reduce((s, e) => s + e.minuten, 0);

    return {
      status: LERNSTAND_WERTE.has(status) ? status : "offen",
      zeit_minuten: zeitMinuten,
      sessions,
    };
  }
  return { status: "offen", zeit_minuten: 0, sessions: [] };
}

function normalisiereLernstand(themen, wert) {
  const roh = typeof wert === "object" && wert !== null && !Array.isArray(wert) ? wert : {};
  const ergebnis = {};
  for (const thema of themen) ergebnis[thema] = normalisiereLernstandEintrag(roh[thema]);
  return ergebnis;
}

function klausurFarbstufe(tageBis) {
  if (tageBis <= KLAUSUR_COUNTDOWN_ROT_TAGE) return "hoch";
  if (tageBis <= KLAUSUR_COUNTDOWN_GELB_TAGE) return "mittel";
  return "niedrig";
}

// Punkte als ganze Zahl 0-15, auch aus Strings wie "12" - Pendant zu
// parse_punkte() in dashboard.py. null bei fehlendem/ungueltigem Wert.
function parsePunkte(wert) {
  if (wert === null || wert === undefined || typeof wert === "boolean") return null;
  const zahl = Number(String(wert).trim().replace(",", "."));
  if (String(wert).trim() === "" || !Number.isInteger(zahl) || zahl < 0 || zahl > 15) return null;
  return zahl;
}

const FEHLERANALYSE_FELDER = ["thema", "fehler", "ursache", "verbesserung"];

function normalisiereFehleranalyse(wert) {
  if (!Array.isArray(wert)) return [];
  const ergebnis = [];
  for (let eintrag of wert) {
    if (typeof eintrag === "string" && eintrag.trim()) eintrag = { fehler: eintrag };
    if (typeof eintrag !== "object" || eintrag === null) continue;
    const normal = {};
    for (const feld of FEHLERANALYSE_FELDER) normal[feld] = String(eintrag[feld] ?? "").trim();
    if (Object.values(normal).some(Boolean)) ergebnis.push(normal);
  }
  return ergebnis;
}

function parseKlausurDatei(text, titel, fachOrdnerName) {
  const fm = leseFrontmatter(text);
  const datum = parseKlausurDatum(fm.datum);
  if (datum === null) return null;

  const fach = fm.fach || fachOrdnerName;
  const themen = normalisiereThemen(fm.themen);
  const status = String(fm.status || "").trim().toLowerCase();
  const punkte = fm.punkte !== undefined && fm.punkte !== null && fm.punkte !== "" ? String(fm.punkte).trim() : "";

  return {
    titel,
    fach: String(fach),
    fachOrdnerName,
    datum,
    themen,
    status,
    punkte,
    punkteZahl: parsePunkte(fm.punkte),
    fehleranalyse: normalisiereFehleranalyse(fm.fehleranalyse),
    korrekturQuelle: String(fm.korrektur_quelle ?? "").trim(),
    lernstand: normalisiereLernstand(themen, fm.lernstand),
  };
}

async function ladeKlausuren(klausurenOrdnerId) {
  const dateien = await listMdRecursive(klausurenOrdnerId, null);
  const inhalte = await Promise.all(dateien.map((d) => driveGetFileContent(d.id)));
  const klausuren = [];
  inhalte.forEach((text, i) => {
    const titel = dateien[i].name.replace(/\.md$/i, "");
    const klausur = parseKlausurDatei(text, titel, dateien[i].parentName);
    if (klausur) {
      klausur.dateiId = dateien[i].id;
      klausuren.push(klausur);
    }
  });
  return klausuren;
}

// Drei Gruppen wie sammle_alle_klausuren() in dashboard.py: anstehend
// (ab heute), abzuhaken (Datum vorbei, aber noch nicht als geschrieben
// markiert - zaehlt NICHT als ueberfaellig) und abgeschlossen (neueste zuerst).
function sammleAlleKlausuren(klausuren, heute) {
  const anstehend = [];
  const abzuhaken = [];
  const abgeschlossen = [];
  for (const k of klausuren) {
    const eintrag = { ...k, tage_bis: diffTage(k.datum, heute) };
    if (k.status === "abgeschlossen") abgeschlossen.push(eintrag);
    else if (eintrag.tage_bis < 0) abzuhaken.push(eintrag);
    else anstehend.push(eintrag);
  }
  anstehend.sort((a, b) => a.datum - b.datum);
  abzuhaken.sort((a, b) => a.datum - b.datum);
  abgeschlossen.sort((a, b) => b.datum - a.datum);
  return [anstehend, abzuhaken, abgeschlossen];
}

function sammleKlausurVorschau(klausuren, heute) {
  const ergebnis = [];
  for (const k of klausuren) {
    const tageBis = diffTage(k.datum, heute);
    if (tageBis >= 0 && tageBis <= KLAUSUR_VORSCHAU_TAGE && k.status !== "abgeschlossen") ergebnis.push({ ...k, tage_bis: tageBis });
  }
  ergebnis.sort((a, b) => a.datum - b.datum);
  return ergebnis;
}

// ===========================================================================
// PARSING: PUNKTE-TAB (Schule/Noten/<Fach>/Noten.md + Klausur-Punkte)
// ===========================================================================

function leseNotenAusText(text) {
  const fm = leseFrontmatter(text);
  const normalisiereListe = (roh) => {
    if (!Array.isArray(roh)) return [];
    const ergebnis = [];
    for (const eintrag of roh) {
      if (typeof eintrag !== "object" || eintrag === null) continue;
      // id nur als echter String (js-yaml liest z.B. 12e45678 unquoted als
      // Zahl) - ohne gueltige id wie am Desktop nicht bearbeitbar.
      const id = typeof eintrag.id === "string" ? eintrag.id.trim() : "";
      const bezeichnung = String(eintrag.bezeichnung || "").trim();
      const punkte = Number(eintrag.punkte);
      const datumRoh = eintrag.datum instanceof Date ? eintrag.datum.toISOString().slice(0, 10) : String(eintrag.datum ?? "").trim();
      const datum = /^\d{4}-\d{2}-\d{2}$/.test(datumRoh) ? datumRoh : null;
      if (bezeichnung && Number.isFinite(punkte)) ergebnis.push({ id, bezeichnung, punkte, datum });
    }
    return ergebnis;
  };
  return {
    schriftlich: normalisiereListe(fm.schriftliche_noten),
    muendlich: normalisiereListe(fm.muendliche_noten),
  };
}

async function ladeNotenProFach(notenOrdnerId) {
  const alleDateien = await listMdRecursive(notenOrdnerId, null);
  const dateien = alleDateien.filter((d) => d.name === "Noten.md");
  const inhalte = await Promise.all(dateien.map((d) => driveGetFileContent(d.id)));
  const notenProFach = {};
  inhalte.forEach((text, i) => {
    notenProFach[dateien[i].parentName] = { ...leseNotenAusText(text), dateiId: dateien[i].id };
  });
  return notenProFach;
}

function isoDatum(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Wie sammle_schriftliche_werte() in dashboard.py: Klausur-Punkte + manuelle
// schriftliche Noten; eine manuelle Note mit gleichem Datum wie eine Klausur
// MIT Punkten im selben Fach zaehlt nicht doppelt (Klausur hat Vorrang).
function sammleSchriftlichPunkteProFach(klausuren, notenProFach) {
  const wertProFach = {};
  const klausurDaten = {};
  for (const k of klausuren) {
    if (k.status !== "abgeschlossen" || k.punkteZahl === null) continue;
    (wertProFach[k.fachOrdnerName] ??= []).push(k.punkteZahl);
    (klausurDaten[k.fachOrdnerName] ??= new Set()).add(isoDatum(k.datum));
  }
  for (const [fach, noten] of Object.entries(notenProFach)) {
    for (const eintrag of noten.schriftlich) {
      if (eintrag.datum && klausurDaten[fach]?.has(eintrag.datum)) continue;
      (wertProFach[fach] ??= []).push(eintrag.punkte);
    }
  }
  const ergebnis = {};
  for (const [fach, werte] of Object.entries(wertProFach)) {
    ergebnis[fach] = { durchschnitt: werte.reduce((a, b) => a + b, 0) / werte.length, anzahl: werte.length };
  }
  return ergebnis;
}

function berechneGesamtpunktzahl(fachOrdner, schriftlich, muendlich) {
  if (schriftlich == null || muendlich == null) return null;
  const gewicht = LK_FAECHER.has(fachOrdner) ? GEWICHT_LK : GEWICHT_GK;
  return schriftlich * gewicht.schriftlich + muendlich * gewicht.muendlich;
}

// ===========================================================================
// DATEN LADEN & ZUSAMMENFUEHREN
// ===========================================================================

// ---------------------------------------------------------------------------
// BEGLEITER-UEBERSICHT (Schule/Begleiter-Uebersicht.md, Frontmatter-Schema:
//   begleiter:
//     - fach: "Mathe-LK"
//       url: "https://drive.google.com/file/d/.../view"
//       seiten: 14
//       zuletzt_aktualisiert: "2026-09-21"
//       updates:
//         - datum: "2026-09-21"
//           thema: "Kettenregel"
//           zusammenfassung: "Ein Satz ..."
//           seite: 12
// Portiert identisch in dashboard.py (parse_begleiter_uebersicht).
// ---------------------------------------------------------------------------

function parseDatumIso(wert) {
  if (!wert) return null;
  if (wert instanceof Date) return dateOnly(wert);
  const m = String(wert).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function parseBegleiterUebersicht(text, heute) {
  const fm = leseFrontmatter(text);
  const liste = Array.isArray(fm.begleiter) ? fm.begleiter : [];
  const faecher = liste
    .filter((b) => b && typeof b === "object" && b.fach)
    .map((b) => {
      const updates = (Array.isArray(b.updates) ? b.updates : [])
        .filter((u) => u && typeof u === "object")
        .map((u) => ({
          datum: parseDatumIso(u.datum),
          thema: String(u.thema ?? ""),
          zusammenfassung: String(u.zusammenfassung ?? ""),
          seite: Number.isFinite(Number(u.seite)) && u.seite !== null && u.seite !== "" ? Number(u.seite) : null,
        }))
        .sort((a, c) => (c.datum?.getTime() ?? 0) - (a.datum?.getTime() ?? 0));
      const zuletzt = parseDatumIso(b.zuletzt_aktualisiert) || (updates[0] && updates[0].datum) || null;
      const tageSeit = zuletzt ? diffTage(heute, zuletzt) : null;
      return {
        fach: String(b.fach),
        url: b.url ? String(b.url) : null,
        seiten: Number.isFinite(Number(b.seiten)) && b.seiten ? Number(b.seiten) : null,
        zuletzt,
        tageSeit,
        istNeu: tageSeit !== null && tageSeit <= BEGLEITER_NEU_TAGE && updates.length > 0,
        updates: updates.slice(0, BEGLEITER_MAX_UPDATES),
      };
    })
    // Zuletzt aktualisierte Faecher zuerst, nie aktualisierte alphabetisch ans Ende
    .sort((a, c) => {
      if (a.zuletzt && c.zuletzt) return c.zuletzt - a.zuletzt;
      if (a.zuletzt) return -1;
      if (c.zuletzt) return 1;
      return a.fach.localeCompare(c.fach, "de");
    });
  return { faecher, stand: parseDatumIso(fm.stand) };
}

// Gibt die geparste Uebersicht zurueck, oder bei fehlender/unlesbarer Datei
// { fehlt: true, pfad, vaultId, schuleId, fehler } fuer einen aussagekraeftigen
// Hinweis im Tab (welcher Ordner wurde durchsucht?).
async function ladeBegleiter(schuleOrdnerId, heute, vaultId) {
  const info = {
    fehlt: true,
    pfad: `${CONFIG.VAULT_ORDNER_NAME}/Schule/${BEGLEITER_DATEI_NAME}`,
    vaultId,
    schuleId: schuleOrdnerId,
    fehler: null,
  };
  try {
    const datei = await driveFindFileByName(BEGLEITER_DATEI_NAME, schuleOrdnerId);
    if (!datei) return info;
    return parseBegleiterUebersicht(await driveGetFileContent(datei.id), heute);
  } catch (e) {
    // Die Begleiter-Uebersicht ist ein Zusatz - ein Fehler hier soll die
    // restlichen Tabs nicht blockieren.
    console.warn("Begleiter-Uebersicht konnte nicht geladen werden:", e);
    return { ...info, fehler: e.message };
  }
}

function begleiterSeitenUrl(url, seite) {
  if (!url) return null;
  return seite ? `${url.split("#")[0]}#page=${seite}` : url;
}

let appDaten = null; // zuletzt geladener Zustand, fuer Klick-Handler der Detailansicht
let ordnerIds = null; // Drive-IDs der Vault-Ordner (vault, aufgaben, schule, klausuren, noten)

// Primaer die feste Ordner-ID. Nur wenn die nicht erreichbar ist (geloescht,
// im Papierkorb, keine Rechte): Namenssuche, bei mehreren Treffern der
// zuletzt geaenderte Ordner plus sichtbarer Hinweis.
async function findeVaultOrdner() {
  try {
    const params = new URLSearchParams({ fields: "id, name, mimeType, trashed" });
    const ordner = await driveFetchJson(`${DRIVE_API}/${VAULT_FOLDER_ID}?${params.toString()}`);
    if (ordner && ordner.mimeType === FOLDER_MIME && !ordner.trashed) {
      vaultOrdner.add(ordner.id);
      return { id: ordner.id, hinweis: null };
    }
  } catch (e) {
    if (!accessToken) throw e; // 401: Sitzung abgelaufen, nicht auf Namenssuche ausweichen
    console.warn("Vault-Ordner-ID nicht erreichbar, weiche auf Namenssuche aus:", e);
  }

  const params = new URLSearchParams({
    q: `name='${qEscape(CONFIG.VAULT_ORDNER_NAME)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: "files(id, name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: "10",
  });
  const data = await driveFetchJson(`${DRIVE_API}?${params.toString()}`);
  const treffer = (data.files || []).slice().sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
  if (!treffer.length) {
    throw new Error(`Vault-Ordner weder per ID (${VAULT_FOLDER_ID}) noch per Name '${CONFIG.VAULT_ORDNER_NAME}' gefunden.`);
  }
  let hinweis = `Feste Vault-Ordner-ID ${VAULT_FOLDER_ID} nicht erreichbar – verwende Ordner per Namenssuche (ID ${treffer[0].id}).`;
  if (treffer.length > 1) {
    hinweis = `Mehrere Vault-Ordner gefunden (${treffer.length}× „${CONFIG.VAULT_ORDNER_NAME}“) – verwende den zuletzt geänderten (ID ${treffer[0].id}). ` + hinweis;
  }
  vaultOrdner.add(treffer[0].id);
  return { id: treffer[0].id, hinweis };
}

async function ladeAlleDaten() {
  setStatus("Verbinde mit Google Drive ...");
  const { id: vaultId, hinweis: vaultHinweis } = await findeVaultOrdner();
  zeigeVaultHinweis(vaultHinweis);

  setStatus("Suche Ordnerstruktur ...");
  const [aufgabenOrdner, schuleOrdner] = await Promise.all([
    driveFindFolderByName("Aufgaben", vaultId),
    driveFindFolderByName("Schule", vaultId),
  ]);
  const [klausurenOrdner, notenOrdner] = await Promise.all([
    driveFindFolderByName("Klausuren", schuleOrdner.id),
    driveFindFolderByName("Noten", schuleOrdner.id),
  ]);

  ordnerIds = { vault: vaultId, aufgaben: aufgabenOrdner.id, schule: schuleOrdner.id, klausuren: klausurenOrdner.id, noten: notenOrdner.id };
  const heute = dateOnly(new Date());

  setStatus("Lade Aufgaben, Klausuren, Punkte & Begleiter ...");
  const [aufgaben, klausurenRoh, notenProFach, faecherOrdner, begleiter] = await Promise.all([
    ladeAufgaben(aufgabenOrdner.id, heute),
    ladeKlausuren(klausurenOrdner.id),
    ladeNotenProFach(notenOrdner.id),
    driveListChildren(klausurenOrdner.id, ` and mimeType='${FOLDER_MIME}'`),
    ladeBegleiter(schuleOrdner.id, heute, vaultId),
  ]);

  appDaten = baueAppDaten({
    heute, aufgaben, klausurenRoh, notenProFach,
    faecherListe: faecherOrdner.map((f) => f.name).sort(),
    begleiter,
  });

  setStatus(`Zuletzt aktualisiert: ${new Date().toLocaleTimeString("de-DE")}`);
  renderAlles();
  aktualisiereOffeneDetailansicht();
}

function baueAppDaten({ heute, aufgaben, klausurenRoh, notenProFach, faecherListe, begleiter }) {
  const [klausurenAnstehend, klausurenAbzuhaken, klausurenAbgeschlossen] = sammleAlleKlausuren(klausurenRoh, heute);
  const klausurVorschau = sammleKlausurVorschau(klausurenRoh, heute);
  const schriftlichProFach = sammleSchriftlichPunkteProFach(klausurenRoh, notenProFach);
  const klausurNaeheProFach = berechneKlausurNaeheProFach(klausurenAnstehend);

  const daten = {
    heute,
    aufgaben: kategorisiereAufgaben(aufgaben, heute, klausurNaeheProFach),
    klausurVorschau,
    klausurenAnstehend,
    klausurenAbzuhaken,
    klausurenAbgeschlossen,
    faecherListe,
    notenProFach,
    schriftlichProFach,
    begleiter,
    heuteLernen: sammleHeuteLernen(klausurenAnstehend, klausurenRoh, heute),
  };
  daten.kpis = berechneKpis(daten);
  return daten;
}

function zeigeVaultHinweis(text) {
  const el = document.getElementById("vault-hinweis");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}

function setStatus(text) {
  document.getElementById("status-zeile").textContent = text;
}

// ===========================================================================
// HEUTE-TAB + KPIs (1:1 portiert aus dashboard.py: sammle_heute_lernen(),
// sammle_heutige_lernzeit(), berechne_kpis() - nur lesend)
// ===========================================================================

const HEUTE_KLAUSUR_FENSTER_TAGE = 21; // Klausur-Themen tauchen ab X Tagen vor der Klausur auf
const HEUTE_MIN_OFFEN = 25;            // empfohlene Minuten je offenem Klausur-Thema
const HEUTE_MIN_TEILWEISE = 15;        // empfohlene Minuten je teilweise verstandenem Thema
const HEUTE_WICHTIG_SCORE = 60;        // score <= X -> "Jetzt wichtig", sonst "Wenn noch Zeit ist"

// Schluessel wie (pfad_relativ, thema) in dashboard.py: Fach-Ordner/Titel + Thema
const lernzeitSchluessel = (k, thema) => `${k.fachOrdnerName}/${k.titel}|${thema}`;

function sammleHeutigeLernzeit(klausuren, heute) {
  const heuteIso = isoDatum(heute);
  const proThema = new Map();
  let gesamt = 0;
  for (const k of klausuren) {
    for (const [thema, eintrag] of Object.entries(k.lernstand)) {
      const minuten = eintrag.sessions.filter((s) => s.datum === heuteIso).reduce((a, s) => a + s.minuten, 0);
      if (minuten) {
        proThema.set(lernzeitSchluessel(k, thema), minuten);
        gesamt += minuten;
      }
    }
  }
  return { gesamt, proThema };
}

function sammleHeuteLernen(klausurenAnstehend, alleKlausuren, heute) {
  const { gesamt, proThema } = sammleHeutigeLernzeit(alleKlausuren, heute);
  const eintraege = [];
  for (const k of klausurenAnstehend) {
    const tage = k.tage_bis;
    if (!(tage >= 0 && tage <= HEUTE_KLAUSUR_FENSTER_TAGE)) continue;
    const wann = tage === 0 ? "heute!" : tage === 1 ? "morgen" : `in ${tage} Tagen`;
    for (const thema of k.themen) {
      const eintrag = k.lernstand[thema];
      if (eintrag.status === "verstanden") continue;
      const offen = eintrag.status === "offen";
      eintraege.push({
        klausur: k,
        fach: k.fach,
        titel: thema,
        wann,
        status: eintrag.status,
        minuten: offen ? HEUTE_MIN_OFFEN : HEUTE_MIN_TEILWEISE,
        farbstufe: klausurFarbstufe(tage),
        score: tage * 10 + (offen ? 0 : 3),
        heuteMinuten: proThema.get(lernzeitSchluessel(k, thema)) || 0,
      });
    }
  }
  eintraege.sort((a, b) => a.score - b.score || a.fach.localeCompare(b.fach) || a.titel.localeCompare(b.titel));
  const wichtig = eintraege.filter((e) => e.score <= HEUTE_WICHTIG_SCORE);
  const spaeter = eintraege.filter((e) => e.score > HEUTE_WICHTIG_SCORE);
  const nochEmpfohlen = wichtig.reduce((s, e) => s + Math.max(e.minuten - e.heuteMinuten, 0), 0);
  return { wichtig, spaeter, nochEmpfohlen, heuteGesamt: gesamt };
}

function berechneKpis({ aufgaben, klausurenAnstehend, faecherListe, notenProFach, schriftlichProFach }) {
  const gesamtpunkte = [];
  for (const fach of faecherListe) {
    const schriftlich = schriftlichProFach[fach] ? schriftlichProFach[fach].durchschnitt : null;
    const muendliche = (notenProFach[fach] || { muendlich: [] }).muendlich;
    const muendlich = muendliche.length ? muendliche[muendliche.length - 1].punkte : null;
    const gesamt = berechneGesamtpunktzahl(fach, schriftlich, muendlich);
    if (gesamt !== null) gesamtpunkte.push(gesamt);
  }
  return {
    anstehendeKlausuren: klausurenAnstehend.length,
    durchschnittPunkte: gesamtpunkte.length ? gesamtpunkte.reduce((a, b) => a + b, 0) / gesamtpunkte.length : null,
    offeneAufgaben: aufgaben.ueberfaellig.length + aufgaben.heute.length + aufgaben.diese_woche.length + aufgaben.spaeter.length,
    ueberfaellig: aufgaben.ueberfaellig.length,
  };
}

// ===========================================================================
// SCHREIBEN (seit 2026-09-27) - alle Schreibvorgaenge laufen ueber
// schreibeDatei() bzw. erstelleDatei(). Die Text-Aenderungen sind Ports der
// Desktop-Funktionen in dashboard.py und erzeugen dieselben Dateiaenderungen,
// lassen aber Zeilenenden (CRLF/LF) und ein BOM der Originaldatei unberuehrt.
// ===========================================================================

// Abbruch ohne Schreiben (Zielzeile nicht gefunden, ungueltige Eingabe, ...)
class SchreibAbbruch extends Error {}
// Datei wurde zwischen Laden und Schreiben woanders geaendert
class SchreibKonflikt extends Error {
  constructor() {
    super("Datei wurde gerade woanders geändert – Daten neu geladen, bitte nochmal versuchen.");
  }
}

const BOM = "﻿";
const reEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function erkenneZeilenende(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// Liest den Inhalt als Text, der Byte fuer Byte zurueckgeschrieben werden
// kann: ein BOM bleibt als "﻿" erhalten (resp.text() wuerde es still
// entfernen), ungueltiges UTF-8 bricht ab statt Zeichen zu verfaelschen.
async function driveLeseRohtext(fileId) {
  const resp = await fetch(`${DRIVE_API}/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
  await driveAntwortPruefen(resp);
  const bytes = await resp.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (e) {
    throw new SchreibAbbruch("Datei ist kein gültiges UTF-8 – nicht geändert.");
  }
}

async function driveMetadaten(fileId) {
  const params = new URLSearchParams({ fields: "id, name, headRevisionId, modifiedTime, trashed" });
  return driveFetchJson(`${DRIVE_API}/${fileId}?${params.toString()}`);
}

const revisionVon = (meta) => meta.headRevisionId || meta.modifiedTime || null;

function pruefeVaultDatei(fileId) {
  if (!fileId || !vaultDateien.has(fileId)) {
    throw new SchreibAbbruch("Sicherheitsstopp: Datei stammt nicht aus dem Vault-Ordner – nichts geschrieben.");
  }
}

function pruefeVaultOrdner(ordnerId) {
  if (!ordnerId || !vaultOrdner.has(ordnerId)) {
    throw new SchreibAbbruch("Sicherheitsstopp: Zielordner liegt nicht im Vault – nichts angelegt.");
  }
}

// Zentrale Schreibfunktion fuer bestehende Dateien:
// 1. Metadaten + Inhalt frisch laden (nie auf dem Stand vom letzten Rendern aendern)
// 2. aendere(text) -> neuerText anwenden (wirft SchreibAbbruch, wenn das Ziel fehlt)
// 3. unmittelbar vor dem Hochladen headRevisionId erneut pruefen
// 4. per PATCH (uploadType=media) als UTF-8 hochladen
// Aendert sich die Datei zwischen Laden (Rendern) und Schreiben, wird nicht
// geschrieben (SchreibKonflikt). Gibt true zurueck, wenn geschrieben wurde.
async function schreibeDatei(fileId, aendere) {
  pruefeVaultDatei(fileId);

  const meta = await driveMetadaten(fileId);
  if (meta.trashed) throw new SchreibAbbruch("Datei liegt im Papierkorb – nichts geschrieben.");
  const bekannt = vaultDateien.get(fileId).rev;
  if (bekannt && revisionVon(meta) !== bekannt) throw new SchreibKonflikt();

  const text = await driveLeseRohtext(fileId);
  const neuerText = aendere(text);
  if (typeof neuerText !== "string") throw new SchreibAbbruch("Interner Fehler: keine Änderung berechnet.");
  if (neuerText === text) return false;

  const metaDavor = await driveMetadaten(fileId);
  if (revisionVon(metaDavor) !== revisionVon(meta)) throw new SchreibKonflikt();

  const params = new URLSearchParams({ uploadType: "media", fields: "id, headRevisionId, modifiedTime" });
  const neu = await driveFetchJson(`${DRIVE_UPLOAD_API}/${fileId}?${params.toString()}`, {
    method: "PATCH",
    headers: { "Content-Type": "text/markdown; charset=UTF-8" },
    body: new TextEncoder().encode(neuerText),
  });
  vaultDateien.set(fileId, { name: vaultDateien.get(fileId).name, rev: revisionVon(neu) });
  return true;
}

// Legt eine neue Datei in einem Vault-Ordner an (multipart-Upload). Bricht
// ab, wenn dort schon eine Datei gleichen Namens liegt.
async function erstelleDatei(ordnerId, name, text) {
  pruefeVaultOrdner(ordnerId);
  if (await driveFindFileByName(name, ordnerId)) {
    throw new SchreibKonflikt();
  }
  const grenze = "grenze" + Math.random().toString(16).slice(2);
  const metadaten = JSON.stringify({ name, parents: [ordnerId], mimeType: "text/markdown" });
  const koerper = new Blob([
    `--${grenze}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadaten}\r\n`,
    `--${grenze}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n`,
    new TextEncoder().encode(text),
    `\r\n--${grenze}--`,
  ]);
  const params = new URLSearchParams({ uploadType: "multipart", fields: "id, name, mimeType, headRevisionId, modifiedTime" });
  const datei = await driveFetchJson(`${DRIVE_UPLOAD_API}?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${grenze}` },
    body: koerper,
  });
  registriereVaultEintrag(datei, ordnerId);
  return datei;
}

// Findet oder erstellt einen Unterordner (z.B. Schule/Noten/[Fach]).
async function stelleOrdnerSicher(parentId, name) {
  pruefeVaultOrdner(parentId);
  const vorhanden = await driveSucheOrdner(name, parentId);
  if (vorhanden) return vorhanden.id;
  const ordner = await driveFetchJson(`${DRIVE_API}?fields=id,name,mimeType`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  registriereVaultEintrag(ordner, parentId);
  return ordner.id;
}

// Loest einen Vault-relativen Pfad (wie in einem Wikilink) auf eine Datei-ID
// auf - Pendant zu VAULT_PATH / f"{link}.md" in finde_verlinkte_notiz().
async function findeVaultDateiPerPfad(relPfad) {
  const teile = relPfad.split("/").map((t) => t.trim()).filter(Boolean);
  if (!teile.length || teile.includes("..")) return null;
  let ordnerId = ordnerIds.vault;
  for (const teil of teile.slice(0, -1)) {
    const ordner = await driveSucheOrdner(teil, ordnerId);
    if (!ordner) return null;
    ordnerId = ordner.id;
  }
  const datei = await driveFindFileByName(`${teile[teile.length - 1]}.md`, ordnerId);
  return datei ? datei.id : null;
}

// --- Text-Aenderungen (Ports aus dashboard.py) ----------------------------

// Trennt ein evtl. BOM ab, wendet fn auf den Rest an und setzt es wieder davor.
function mitBom(text, fn) {
  const hatBom = text.startsWith(BOM);
  const ergebnis = fn(hatBom ? text.slice(1) : text);
  return hatBom ? BOM + ergebnis : ergebnis;
}

// Frontmatter-Grenzen wie FRONTMATTER_MUSTER in dashboard.py: '---' am
// Dateianfang, schliessendes '---' allein auf einer Zeile. Gibt
// { start, ende } des Frontmatter-Inhalts (inkl. letztem Zeilenumbruch)
// zurueck, oder null.
function findeFrontmatter(text) {
  const kopf = /^---[ \t]*\r?\n/.exec(text);
  if (!kopf) return null;
  const schluss = /^---[ \t]*\r?$/gm;
  schluss.lastIndex = kopf[0].length;
  const treffer = schluss.exec(text);
  if (!treffer) return null;
  return { start: kopf[0].length, ende: treffer.index, schlussZeile: treffer[0] };
}

// Port von setze_frontmatter_feld(): ersetzt GENAU EIN Top-Level-Feld
// zeilenbasiert (samt eingerueckter Folgezeilen) oder haengt es am Ende des
// Frontmatters an. Alles andere bleibt Byte fuer Byte gleich.
function setzeFrontmatterFeld(text, feld, wertYaml) {
  return mitBom(text, (t) => {
    const fm = findeFrontmatter(t);
    if (!fm) throw new SchreibAbbruch("Kein Frontmatter gefunden – nichts geändert.");
    const roh = t.slice(fm.start, fm.ende);
    const zeilenende = erkenneZeilenende(roh);
    const neueZeile = `${feld}: ${wertYaml}`;
    const feldMuster = new RegExp(`^${reEscape(feld)}:[^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*`, "m");
    let neu;
    if (feldMuster.test(roh)) {
      neu = roh.replace(feldMuster, () => neueZeile);
    } else {
      neu = roh;
      if (neu && !neu.endsWith("\n")) neu += zeilenende;
      neu += neueZeile + zeilenende;
    }
    return t.slice(0, fm.start) + neu + t.slice(fm.ende);
  });
}

// Findet den Block einer Aufgabe ('## Titel' bis zur naechsten '## '-
// Ueberschrift) - wie das Muster in markiere_aufgabe_status().
function findeAufgabenBlock(text, titel) {
  const muster = new RegExp(`(^##[ \\t]+${reEscape(titel)}[ \\t]*\\r?\\n)([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "m");
  const treffer = muster.exec(text);
  if (!treffer) return null;
  const start = treffer.index + treffer[1].length;
  return { start, ende: start + treffer[2].length, block: treffer[2] };
}

// Port von markiere_aufgabe_status() (ohne die Detail-Notiz): aendert nur
// die Status-Zeile im Block der Aufgabe.
function setzeAufgabeStatusImText(text, titel, neuerStatus) {
  return mitBom(text, (t) => {
    const b = findeAufgabenBlock(t, titel);
    if (!b) throw new SchreibAbbruch(`Aufgabe „${titel}“ nicht in der Datei gefunden – nichts geändert. Bitte neu laden.`);
    const statusMuster = /(\*\*Status:\*\*)[ \t]*[^\r\n]*/;
    let neuerBlock;
    if (statusMuster.test(b.block)) {
      neuerBlock = b.block.replace(statusMuster, (_, feld) => `${feld} ${neuerStatus}`);
    } else {
      const zeilenende = erkenneZeilenende(t);
      neuerBlock = b.block.replace(/(\r?\n)+$/, "") + `${zeilenende}- **Status:** ${neuerStatus}${zeilenende}`;
    }
    return t.slice(0, b.start) + neuerBlock + t.slice(b.ende);
  });
}

// Port von markiere_status_in_freitext() fuer verlinkte Detail-Notizen.
// Gibt null zurueck, wenn die Notiz kein '**Status:**'-Feld hat (dann wie am
// Desktop einfach nichts tun).
function setzeFreitextStatus(text, neuerStatusText) {
  const muster = /^([ \t]*-?[ \t]*\*\*Status:\*\*)[ \t]*[^\r\n]*/m;
  if (!muster.test(text)) return null;
  return text.replace(muster, (_, feld) => `${feld} ${neuerStatusText}`);
}

const WIKILINK_MUSTER = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/;
function verlinkterPfad(beschreibung) {
  const treffer = WIKILINK_MUSTER.exec(beschreibung || "");
  return treffer ? treffer[1].trim() : null;
}

// --- Noten.md: Frontmatter wie am Desktop per YAML neu erzeugen ------------
// dashboard.py (schreibe_frontmatter) laedt das Frontmatter mit
// yaml.safe_load und schreibt es mit yaml.safe_dump(allow_unicode=True,
// sort_keys=False) neu. js-yaml (fest 4.1.0) mit noArrayIndent und ohne
// Zeilenumbruch erzeugt dieselbe Schreibweise; Datumswerte (unquoted
// JJJJ-MM-TT) werden wie bei PyYAML wieder unquoted geschrieben.

function yamlWieDesktop(daten) {
  const platzhalter = [];
  const ersetzeDaten = (wert) => {
    if (wert instanceof Date) {
      const iso = wert.toISOString();
      const text = iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
      platzhalter.push(text);
      return `__DATUM_${platzhalter.length - 1}__`;
    }
    if (Array.isArray(wert)) return wert.map(ersetzeDaten);
    if (wert && typeof wert === "object") return Object.fromEntries(Object.entries(wert).map(([k, v]) => [k, ersetzeDaten(v)]));
    return wert;
  };
  const yaml = jsyaml.dump(ersetzeDaten(daten), { noArrayIndent: true, lineWidth: -1, sortKeys: false });
  return yaml.replace(/__DATUM_(\d+)__/g, (_, i) => platzhalter[Number(i)]);
}

// Port von schreibe_frontmatter(): aktualisiere(fm) gibt das neue Dict oder
// null (nichts zu tun -> SchreibAbbruch) zurueck. Der Body bleibt unberuehrt,
// das neue YAML bekommt das Zeilenende des bisherigen Frontmatters.
function ersetzeFrontmatterPerYaml(text, aktualisiere) {
  return mitBom(text, (t) => {
    const fm = findeFrontmatter(t);
    if (!fm) throw new SchreibAbbruch("Kein Frontmatter in der Noten-Datei gefunden – nichts geändert.");
    const roh = t.slice(fm.start, fm.ende);
    let daten;
    try {
      daten = jsyaml.load(roh) || {};
    } catch (e) {
      throw new SchreibAbbruch("Frontmatter der Noten-Datei ist fehlerhaft – nichts geändert.");
    }
    if (typeof daten !== "object" || Array.isArray(daten)) throw new SchreibAbbruch("Frontmatter der Noten-Datei ist fehlerhaft – nichts geändert.");
    const neu = aktualisiere(daten);
    if (!neu) throw new SchreibAbbruch("Eintrag nicht gefunden – nichts geändert. Bitte neu laden.");
    const zeilenende = erkenneZeilenende(roh);
    const yaml = yamlWieDesktop(neu).replace(/\n/g, zeilenende);
    const kopf = t.slice(0, fm.start);
    return kopf + yaml + t.slice(fm.ende);
  });
}

const notenFeldname = (art) => (art === "schriftlich" ? "schriftliche_noten" : "muendliche_noten");

function neueNotenId() {
  // 8 Hex-Zeichen wie uuid4().hex[:8]; IDs, die YAML als Zahl lesen wuerde
  // (z.B. 12e45678), werden verworfen, damit sie bearbeitbar bleiben.
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (typeof jsyaml.load(id) === "string") return id;
  }
}

// Inhalt einer neuen Noten.md exakt wie fuege_note_hinzu() sie anlegt
// (Desktop schreibt unter Windows CRLF).
function neueNotenDateiText(fach) {
  return [
    "---",
    `fach: "${fach}"`,
    "schriftliche_noten: []",
    "muendliche_noten: []",
    "---",
    "",
    `# Noten – ${fach}`,
    "",
    "Automatisch verwaltet vom Dashboard-Punkte-Tab. Siehe [[Dashboard-System]].",
    "",
  ].join("\r\n");
}

// --- Neue Aufgabe -----------------------------------------------------------

// Kopf einer neuen Monatsdatei - wie die bestehenden Aufgaben-JJJJ-MM.md.
function neueAufgabenDateiText(jahr, monat) {
  return [
    "---",
    `monat: ${jahr}-${String(monat).padStart(2, "0")}`,
    "tags:",
    "  - aufgabe",
    "---",
    "",
    `# Aufgaben ${MONATE[monat - 1]} ${jahr}`,
    "",
    "Verknüpfung mit fachspezifischen Details: [[Schule/Klausur-System]]",
    "",
  ].join("\r\n");
}

function haengeAufgabeAn(text, { fach, titel, deadline, prioritaet, beschreibung }) {
  return mitBom(text, (t) => {
    const ueberschrift = `${fach}: ${titel}`;
    if (findeAufgabenBlock(t, ueberschrift)) {
      throw new SchreibAbbruch(`„${ueberschrift}“ gibt es in dieser Monatsdatei schon – bitte anderen Titel wählen.`);
    }
    const zeilenende = t ? erkenneZeilenende(t) : "\r\n";
    const zeilen = [
      `## ${ueberschrift}`,
      `- **Fach:** ${fach}`,
      `- **Deadline:** ${deadline}`,
      `- **Priorität:** ${prioritaet}`,
      "- **Status:** nicht-gestartet",
    ];
    if (beschreibung) zeilen.push(`- **Beschreibung:** ${beschreibung}`);
    let davor = t;
    if (davor && !davor.endsWith("\n")) davor += zeilenende;
    if (davor && !davor.endsWith(zeilenende + zeilenende)) davor += zeilenende;
    return davor + zeilen.join(zeilenende) + zeilenende;
  });
}

// ===========================================================================
// BESTAETIGUNGSDIALOG + MELDUNGEN
// ===========================================================================

// Eigenes Modal (natives <dialog>), kein window.confirm. Fokus startet auf
// "Abbrechen"; Esc und Tippen ausserhalb = Abbrechen. Resolved true/false.
function bestaetige({ titel, text, hinweis = "", aktion = "Speichern", gefahr = false }) {
  const dialog = document.getElementById("bestaetigen-dialog");
  document.getElementById("bestaetigen-titel").textContent = titel;
  document.getElementById("bestaetigen-text").textContent = text;
  const hinweisEl = document.getElementById("bestaetigen-hinweis");
  hinweisEl.textContent = hinweis;
  hinweisEl.hidden = !hinweis;
  const ok = document.getElementById("bestaetigen-ok");
  ok.className = gefahr ? "btn btn-sekundaer btn-gefahr" : "btn btn-primaer";
  ok.innerHTML = gefahr ? `${icon("muell", 16)} ${esc(aktion)}` : esc(aktion);
  const abbrechen = document.getElementById("bestaetigen-abbrechen");

  return new Promise((resolve) => {
    const ende = (ergebnis) => {
      ok.removeEventListener("click", beiOk);
      abbrechen.removeEventListener("click", beiAbbrechen);
      dialog.removeEventListener("cancel", beiAbbrechen);
      dialog.removeEventListener("click", beiKlick);
      if (dialog.open) dialog.close();
      resolve(ergebnis);
    };
    const beiOk = () => ende(true);
    const beiAbbrechen = (e) => { if (e) e.preventDefault(); ende(false); };
    // Klick auf den Hintergrund (das <dialog> selbst, nicht sein Inhalt)
    const beiKlick = (e) => { if (e.target === dialog) ende(false); };
    ok.addEventListener("click", beiOk);
    abbrechen.addEventListener("click", beiAbbrechen);
    dialog.addEventListener("cancel", beiAbbrechen);
    dialog.addEventListener("click", beiKlick);
    dialog.showModal();
    abbrechen.focus();
  });
}

let meldungTimer = null;
// Erfolg verschwindet nach ~2 s, Fehler bleiben stehen, bis weggetippt.
function zeigeMeldung(text, { fehler = false } = {}) {
  const el = document.getElementById("meldung");
  clearTimeout(meldungTimer);
  el.textContent = text;
  el.classList.toggle("fehler", fehler);
  el.hidden = false;
  if (!fehler) meldungTimer = setTimeout(() => { el.hidden = true; }, 2000);
}

function zeigeSchreibrechteHinweis(zeigen) {
  const el = document.getElementById("schreibrechte-hinweis");
  if (el) el.hidden = !zeigen;
}

let schreibVorgangLaeuft = false;

// Ablauf jeder Schreibaktion: Rechte pruefen -> bestaetigen -> Ausloeser
// sperren -> schreiben -> Meldung -> neu laden. beiAbbruch() setzt z.B. eine
// Checkbox zurueck (Abbrechen oder Fehler).
async function fuehreSchreibaktionAus({ ausloeser = null, bestaetigung, ausfuehren, beiAbbruch = () => {} }) {
  if (schreibVorgangLaeuft) { beiAbbruch(); return; }
  if (!schreibrechte) {
    beiAbbruch();
    zeigeSchreibrechteHinweis(true);
    zeigeMeldung("Schreiben nicht möglich: Bitte einmal neu anmelden, um Schreibrechte zu erteilen.", { fehler: true });
    return;
  }
  if (!(await bestaetige(bestaetigung))) { beiAbbruch(); return; }

  schreibVorgangLaeuft = true;
  if (ausloeser) ausloeser.disabled = true;
  try {
    // ausfuehren() gibt null, einen Erfolgstext oder { meldung, fehler } zurueck
    const ergebnis = await ausfuehren();
    if (ergebnis && ergebnis.fehler) zeigeMeldung(ergebnis.meldung, { fehler: true });
    else zeigeMeldung(ergebnis || "Gespeichert");
  } catch (e) {
    console.error(e);
    beiAbbruch();
    zeigeMeldung(e.message, { fehler: true });
    if (!(e instanceof SchreibKonflikt)) return;
  } finally {
    schreibVorgangLaeuft = false;
    if (ausloeser && ausloeser.isConnected) ausloeser.disabled = false;
  }
  // Nach dem Speichern (bzw. nach einem Konflikt) immer frisch neu laden.
  ladeAlleDaten().catch((f) => {
    console.error(f);
    setStatus(`Fehler beim Neuladen: ${f.message}`);
  });
}

// ===========================================================================
// SCHREIBAKTIONEN
// ===========================================================================

// Aufgabe abhaken / wieder oeffnen (+ Status der verlinkten Detail-Notiz)
function aufgabeUmschalten(aufgabe, checkbox) {
  const erledigen = checkbox.checked;
  const neuerStatus = erledigen ? "abgeschlossen" : "nicht-gestartet";
  const link = verlinkterPfad(aufgabe.beschreibung);
  fuehreSchreibaktionAus({
    ausloeser: checkbox,
    bestaetigung: {
      titel: erledigen ? "Als erledigt markieren?" : "Wieder öffnen?",
      text: erledigen
        ? `Aufgabe „${aufgabe.titel}“ als erledigt markieren?`
        : `Aufgabe „${aufgabe.titel}“ wieder öffnen (Status „nicht-gestartet“)?`,
      hinweis: link ? `Die verlinkte Notiz „${link.split("/").pop()}“ bekommt ebenfalls den Status „${erledigen ? "abgeschlossen" : "nicht begonnen"}“.` : "",
    },
    beiAbbruch: () => { if (checkbox.isConnected) checkbox.checked = !erledigen; },
    ausfuehren: async () => {
      await schreibeDatei(aufgabe.dateiId, (text) => setzeAufgabeStatusImText(text, aufgabe.titel, neuerStatus));
      if (!link) return null;
      // Zweiter, getrennter Schreibvorgang (wie am Desktop): die Aufgabe ist
      // dann schon gespeichert - ein Fehler hier wird nur gemeldet.
      try {
        const notizId = await findeVaultDateiPerPfad(link);
        if (!notizId) return null;
        let ohneStatusFeld = false;
        await schreibeDatei(notizId, (text) => {
          const neu = setzeFreitextStatus(text, erledigen ? "abgeschlossen" : "nicht begonnen");
          if (neu === null) { ohneStatusFeld = true; return text; }
          return neu;
        });
        return ohneStatusFeld ? null : "Gespeichert (inkl. Detail-Notiz)";
      } catch (e) {
        console.error(e);
        return { meldung: `Aufgabe gespeichert, Detail-Notiz aber nicht: ${e.message}`, fehler: true };
      }
    },
  });
}

function klausurStatusSetzen(klausur, neuerStatus, ausloeser) {
  const geschrieben = neuerStatus === "abgeschlossen";
  fuehreSchreibaktionAus({
    ausloeser,
    bestaetigung: {
      titel: geschrieben ? "Als geschrieben markieren?" : "Wieder öffnen?",
      text: geschrieben
        ? `${klausur.fach} ${klausur.titel} als geschrieben markieren?`
        : `${klausur.fach} ${klausur.titel} wieder öffnen (Status „geplant“)?`,
    },
    ausfuehren: () => schreibeDatei(klausur.dateiId, (text) => setzeFrontmatterFeld(text, "status", neuerStatus)).then(() => null),
  });
}

function parsePunkteEingabe(wert) {
  const text = String(wert ?? "").trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const zahl = Number(text);
  return zahl >= 0 && zahl <= 15 ? zahl : null;
}

function klausurPunkteSetzen(klausur, eingabe, ausloeser) {
  const punkte = parsePunkteEingabe(eingabe.value);
  if (punkte === null) {
    zeigeMeldung("Punkte bitte als ganze Zahl von 0 bis 15 eingeben.", { fehler: true });
    eingabe.focus();
    return;
  }
  fuehreSchreibaktionAus({
    ausloeser,
    bestaetigung: { titel: "Punkte speichern?", text: `Punkte für ${klausur.fach} ${klausur.titel} auf ${punkte} setzen?` },
    ausfuehren: () => schreibeDatei(klausur.dateiId, (text) => setzeFrontmatterFeld(text, "punkte", String(punkte))).then(() => null),
  });
}

// Note hinzufuegen (Port von fuege_note_hinzu, inkl. Anlegen von Ordner/Datei)
function noteHinzufuegen(fach, form, ausloeser) {
  const art = form.querySelector(".art-auswahl").value;
  const bezeichnung = form.querySelector(".bezeichnung-eingabe").value.trim().replace(/\s+/g, " ");
  const punkte = parsePunkteEingabe(form.querySelector(".punkte-eingabe").value);
  const datumRoh = form.querySelector(".datum-eingabe").value;
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(datumRoh) ? datumRoh : null;
  if (!bezeichnung) { zeigeMeldung("Bitte eine Bezeichnung eingeben.", { fehler: true }); return; }
  if (punkte === null) { zeigeMeldung("Punkte bitte als ganze Zahl von 0 bis 15 eingeben.", { fehler: true }); return; }
  if (!appDaten.faecherListe.includes(fach)) { zeigeMeldung(`Unbekanntes Fach „${fach}“.`, { fehler: true }); return; }

  const feld = notenFeldname(art);
  const aktualisiere = (fm) => {
    const eintraege = Array.isArray(fm[feld]) ? fm[feld] : [];
    const neuerEintrag = { id: neueNotenId(), bezeichnung, punkte };
    if (datum) neuerEintrag.datum = datum;
    eintraege.push(neuerEintrag);
    fm[feld] = eintraege;
    return fm;
  };
  fuehreSchreibaktionAus({
    ausloeser,
    bestaetigung: {
      titel: "Note hinzufügen?",
      text: `${art === "schriftlich" ? "Schriftliche" : "Mündliche"} Note „${bezeichnung} – ${punkte} P.“${datum ? ` vom ${formatiereDatumKurz(parseDatumIso(datum))}` : ""} für ${fach} hinzufügen?`,
    },
    ausfuehren: async () => {
      const dateiId = appDaten.notenProFach[fach] && appDaten.notenProFach[fach].dateiId;
      if (dateiId) {
        await schreibeDatei(dateiId, (text) => ersetzeFrontmatterPerYaml(text, aktualisiere));
        return null;
      }
      // Noten.md fehlt noch: wie am Desktop anlegen, direkt mit dem Eintrag.
      const ordnerId = await stelleOrdnerSicher(ordnerIds.noten, fach);
      const text = ersetzeFrontmatterPerYaml(neueNotenDateiText(fach), aktualisiere);
      await erstelleDatei(ordnerId, "Noten.md", text);
      return null;
    },
  });
}

function noteBearbeiten(fach, art, eintrag, form, ausloeser) {
  const bezeichnung = form.querySelector(".bezeichnung-eingabe").value.trim().replace(/\s+/g, " ");
  const punkte = parsePunkteEingabe(form.querySelector(".punkte-eingabe").value);
  if (!bezeichnung) { zeigeMeldung("Bitte eine Bezeichnung eingeben.", { fehler: true }); return; }
  if (punkte === null) { zeigeMeldung("Punkte bitte als ganze Zahl von 0 bis 15 eingeben.", { fehler: true }); return; }
  const feld = notenFeldname(art);
  fuehreSchreibaktionAus({
    ausloeser,
    bestaetigung: {
      titel: "Note ändern?",
      text: `Note „${eintrag.bezeichnung} – ${eintrag.punkte} P.“ in „${bezeichnung} – ${punkte} P.“ ändern?`,
    },
    ausfuehren: () => schreibeDatei(appDaten.notenProFach[fach].dateiId, (text) => ersetzeFrontmatterPerYaml(text, (fm) => {
      const liste = fm[feld];
      if (!Array.isArray(liste)) return null;
      const ziel = liste.find((e) => e && typeof e === "object" && typeof e.id === "string" && e.id.trim() === eintrag.id);
      if (!ziel) return null;
      ziel.bezeichnung = bezeichnung;
      ziel.punkte = punkte;
      return fm;
    })).then(() => null),
  });
}

function noteLoeschen(fach, art, eintrag, ausloeser) {
  const feld = notenFeldname(art);
  fuehreSchreibaktionAus({
    ausloeser,
    bestaetigung: {
      titel: "Note löschen?",
      text: `Note „${eintrag.bezeichnung} – ${eintrag.punkte} P.“ löschen? Das lässt sich nicht rückgängig machen.`,
      aktion: "Löschen",
      gefahr: true,
    },
    ausfuehren: () => schreibeDatei(appDaten.notenProFach[fach].dateiId, (text) => ersetzeFrontmatterPerYaml(text, (fm) => {
      const liste = fm[feld];
      if (!Array.isArray(liste)) return null;
      const neu = liste.filter((e) => !(e && typeof e === "object" && typeof e.id === "string" && e.id.trim() === eintrag.id));
      if (neu.length === liste.length) return null;
      fm[feld] = neu;
      return fm;
    })).then(() => null),
  });
}

const KLAUSUR_TITEL_MUSTER = /^\s*Klausur\b/i;

function aufgabeAnlegen(form, ausloeser) {
  const einzeilig = (wert) => String(wert || "").replace(/\s+/g, " ").trim();
  const titel = einzeilig(form.querySelector("#neu-titel").value).replace(/^#+\s*/, "");
  const fach = form.querySelector("#neu-fach").value;
  const deadline = form.querySelector("#neu-deadline").value;
  const prioritaet = form.querySelector("#neu-prioritaet").value;
  const beschreibung = einzeilig(form.querySelector("#neu-beschreibung").value);

  if (!titel) { zeigeMeldung("Bitte einen Titel eingeben.", { fehler: true }); return; }
  if (KLAUSUR_TITEL_MUSTER.test(titel)) {
    zeigeMeldung("Klausuren bitte nicht als Aufgabe anlegen – sie werden im Klausuren-Tab verwaltet.", { fehler: true });
    return;
  }
  if (!fach || !(appDaten.faecherListe.includes(fach) || fach === "Privat")) { zeigeMeldung("Bitte ein Fach wählen.", { fehler: true }); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) { zeigeMeldung("Bitte eine Deadline wählen.", { fehler: true }); return; }
  if (!(prioritaet in PRIORITAET_REIHENFOLGE)) { zeigeMeldung("Ungültige Priorität.", { fehler: true }); return; }

  const ueberschrift = `${fach}: ${titel}`;
  const alle = Object.values(appDaten.aufgaben).flat();
  if (alle.some((a) => a.titel === ueberschrift && isoDatum(a.deadline) === deadline)) {
    zeigeMeldung("Diese Aufgabe gibt es schon (gleiches Fach, Titel und Deadline).", { fehler: true });
    return;
  }

  const [jahr, monat] = deadline.split("-").map(Number);
  const dateiname = `Aufgaben-${jahr}-${String(monat).padStart(2, "0")}.md`;
  const eintrag = { fach, titel, deadline, prioritaet, beschreibung };
  fuehreSchreibaktionAus({
    ausloeser,
    bestaetigung: {
      titel: "Aufgabe anlegen?",
      text: `Aufgabe „${ueberschrift}“ bis ${formatiereDatumKurz(parseDatumIso(deadline))} (Priorität ${prioritaet}) anlegen?`,
      hinweis: `Ziel: Aufgaben/${dateiname}`,
    },
    ausfuehren: async () => {
      const datei = await driveFindFileByName(dateiname, ordnerIds.aufgaben);
      if (datei) {
        await schreibeDatei(datei.id, (text) => haengeAufgabeAn(text, eintrag));
      } else {
        await erstelleDatei(ordnerIds.aufgaben, dateiname, haengeAufgabeAn(neueAufgabenDateiText(jahr, monat), eintrag));
      }
      form.reset();
      return "Aufgabe angelegt";
    },
  });
}

// ===========================================================================
// RENDERING - Design "Clean Dark" (Tokens identisch mit dashboard.py)
// ===========================================================================

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

// Schlichte Strich-Icons (24er-Raster, stroke 1.7, currentColor) - dieselben
// Pfade wie ICON_PFADE in dashboard.py.
const ICON_PFADE = {
  heute: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  aufgaben: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8.5 12 2.5 2.5 5-5.5"/>',
  klausuren: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  punkte: '<path d="M4 20h16M7 16.5v-6M12 16.5V5.5M17 16.5v-3.5"/>',
  begleiter: '<path d="M5.5 4.5h10.5a2.5 2.5 0 0 1 2.5 2.5v13H8a2.5 2.5 0 0 1-2.5-2.5z"/><path d="M5.5 17.5A2.5 2.5 0 0 1 8 15h10.5"/>',
  uhr: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  extern: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10"/>',
  zurueck: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  hinweis: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16.2v.1"/>',
  aktualisieren: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.5H15"/>',
  abmelden: '<path d="M12 3.5v8M6.7 6.7a7.5 7.5 0 1 0 10.6 0"/>',
  haken: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  stift: '<path d="M4.5 19.5h4l10-10-4-4-10 10z"/>',
  muell: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 12.5h9l1-12.5M9.5 7V4.5h5V7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  rueckgaengig: '<path d="M9 13.5 4.5 9 9 4.5"/><path d="M4.5 9h10a5 5 0 0 1 0 10h-3"/>',
};

function icon(name, groesse = 18, klasse = "icon") {
  return `<svg class="${klasse}" width="${groesse}" height="${groesse}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PFADE[name]}</svg>`;
}

const chevron = () => icon("chevron", 16, "icon chevron");

// Farblogik: hoch -> --urgent (einzige Signalfarbe), mittel -> --text, niedrig -> --muted
const ton = (farbstufe) => (["hoch", "mittel", "niedrig"].includes(farbstufe) ? `ton-${farbstufe}` : "ton-niedrig");

function countdownText(tage) {
  if (tage === 0) return "heute";
  if (tage === 1) return "morgen";
  if (tage === -1) return "gestern";
  if (tage < 0) return `vor ${Math.abs(tage)} Tagen`;
  return `in ${tage} Tagen`;
}

function formatiereDatumKopf(d) {
  return `${WOCHENTAGE[(d.getDay() + 6) % 7]}, ${d.getDate()}. ${MONATE[d.getMonth()]}`;
}

const minutenKurz = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}` : `${m} min`);

function karteHtml(titel, inhalt, { meta = "", titelKlasse = "", flach = false } = {}) {
  return `
    <section class="karte">
      <div class="karte-kopf${flach ? " flach" : ""}"><h2 class="${titelKlasse}">${titel}</h2>${meta ? `<span class="karte-meta">${meta}</span>` : ""}</div>
      ${inhalt}
    </section>`;
}

// Aufgaben/Klausuren, auf die die gerenderten Bedienelemente per Index
// verweisen (data-aufgabe / data-klausur) - wird bei jedem Rendern neu gebaut.
let aufgabeRegister = [];
let klausurRegister = [];
const registriereAufgabe = (a) => aufgabeRegister.push(a) - 1;
const registriereKlausur = (k) => klausurRegister.push(k) - 1;

let feldZaehler = 0; // eindeutige IDs fuer <label for>
const neueFeldId = (praefix) => `${praefix}-${++feldZaehler}`;

// Checkbox = erledigt (wie render_aufgabe_check am Desktop), per echtem
// <label> auf 44 px Touch-Flaeche vergroessert.
function aufgabeCheckHtml(a, erledigt) {
  const beschriftung = (erledigt ? "Wieder öffnen: " : "Erledigt: ") + a.titel;
  return `<label class="check-ziel" title="${esc(beschriftung)}"><input type="checkbox" class="aufgabe-check" data-aufgabe="${registriereAufgabe(a)}"${erledigt ? " checked" : ""}><span class="sr-only">${esc(beschriftung)}</span></label>`;
}

function renderAlles() {
  aufgabeRegister = [];
  klausurRegister = [];
  renderKopf();
  renderHeuteTab();
  renderAufgabenTab();
  renderKlausurenTab();
  renderPunkteTab();
  renderBegleiterTab();
}

function renderKopf() {
  document.getElementById("kopf-datum").textContent = formatiereDatumKopf(appDaten.heute);
  const chip = document.getElementById("offen-chip");
  chip.innerHTML = `${icon("uhr", 16)}<span><span class="mono">${appDaten.heuteLernen.nochEmpfohlen}</span> Min offen</span>`;
  chip.hidden = false;
}

// --- Heute -------------------------------------------------------------------

function heuteZeileHtml(e, index, liste) {
  const rest = Math.max(e.minuten - e.heuteMinuten, 0);
  let meta = `${esc(e.fach)} · Klausur ${esc(e.wann)} · ${esc(e.status)}`;
  if (e.heuteMinuten && rest) meta += ` · heute schon ${e.heuteMinuten} min`;
  if (!rest) meta += " · Pensum erreicht";
  return `
    <li><button type="button" class="zeile" data-heute-liste="${liste}" data-heute-index="${index}">
      <span class="punkt ${ton(e.farbstufe)}"></span>
      <span class="zeile-text"><span class="zeile-titel">${esc(e.titel)}</span><span class="zeile-meta">${meta}</span></span>
      <span class="zahl${rest ? "" : " ton-niedrig"}">${rest ? esc(minutenKurz(rest)) : "fertig"}</span>
    </button></li>`;
}

function naechsteKlausurenHtml(klausuren) {
  if (!klausuren.length) return karteHtml("Nächste Klausuren", `<p class="leer">Aktuell keine Klausur geplant.</p>`);
  const kacheln = klausuren.slice(0, 4).map((k, i) => {
    const themen = k.themen.length;
    const verstanden = Object.values(k.lernstand).filter((e) => e.status === "verstanden").length;
    const anteil = themen ? Math.round((verstanden / themen) * 100) : 0;
    const label = k.tage_bis === 0 ? "heute" : k.tage_bis === 1 ? "Tag" : "Tage";
    const themenText = themen ? `${verstanden} von ${themen} Themen` : "keine Themen";
    return `
      <button type="button" class="kachel" data-anstehend-index="${i}">
        <span class="countdown"><span class="countdown-zahl ${ton(klausurFarbstufe(k.tage_bis))}">${k.tage_bis}</span><span class="countdown-label">${label}</span></span>
        <span class="kachel-mitte">
          <span class="kachel-kopf"><span class="kachel-titel">${esc(k.fachOrdnerName)}</span><span class="kachel-meta">${themenText}</span></span>
          <span class="balken" role="img" aria-label="${themenText} verstanden"><span style="width:${anteil}%"></span></span>
        </span>
      </button>`;
  }).join("");
  return karteHtml("Nächste Klausuren", `<div class="kacheln">${kacheln}</div>`, { flach: true });
}

function heuteAufgabenHtml(aufgaben, heute) {
  const eintraege = [
    ...aufgaben.ueberfaellig.map((a) => [a, "ueberfaellig"]),
    ...aufgaben.heute.map((a) => [a, "heute"]),
    ...aufgaben.diese_woche.map((a) => [a, "woche"]),
  ];
  const teile = [];
  if (aufgaben.ueberfaellig.length) teile.push(`${aufgaben.ueberfaellig.length} überfällig`);
  if (aufgaben.heute.length) teile.push(`${aufgaben.heute.length} heute`);
  if (!eintraege.length) return karteHtml("Aufgaben", `<p class="leer">Keine Aufgaben für diese Woche.</p>`, { meta: "nichts dringend" });
  const zeilen = eintraege.slice(0, 6).map(([a, art]) => {
    let faellig, klasse;
    if (art === "ueberfaellig") { faellig = countdownText(diffTage(dateOnly(a.deadline), heute)); klasse = "ton-hoch"; }
    else if (art === "heute") { faellig = "heute"; klasse = "ton-mittel"; }
    else { faellig = WOCHENTAGE[(a.deadline.getDay() + 6) % 7].slice(0, 2); klasse = "ton-niedrig"; }
    return `<li class="zeile zeile-mit-check">${aufgabeCheckHtml(a, false)}<span class="zeile-text"><span class="zeile-titel">${esc(a.titel)}</span></span><span class="faellig ${klasse}">${esc(faellig)}</span></li>`;
  }).join("");
  const mehr = eintraege.length > 6 ? `<p class="karte-fuss">+ ${eintraege.length - 6} weitere im Bereich Aufgaben</p>` : "";
  return karteHtml("Aufgaben", `<ul class="liste">${zeilen}</ul>${mehr}`, { meta: esc(teile.join(" · ") || "nichts dringend") });
}

function kpiHtml(kpis, heuteGesamt) {
  const naechste = appDaten.klausurenAnstehend.length ? `nächste ${countdownText(appDaten.klausurenAnstehend[0].tage_bis)}` : "keine geplant";
  const punkte = kpis.durchschnittPunkte !== null ? kpis.durchschnittPunkte.toFixed(1).replace(".", ",") : "–";
  const zelle = (label, wert, zusatz, zusatzKlasse = "") => `
    <div class="kpi-zelle">
      <div class="kpi-label">${label}</div>
      <div class="kpi-wert-zeile"><span class="kpi-wert">${wert}</span><span class="kpi-zusatz ${zusatzKlasse}">${esc(zusatz)}</span></div>
    </div>`;
  return `
    <div class="kpi-streifen">
      ${zelle("Anstehende Klausuren", kpis.anstehendeKlausuren, naechste)}
      ${zelle("Ø Gesamtpunkte", punkte, "von 15")}
      ${zelle("Offene Aufgaben", kpis.offeneAufgaben, kpis.ueberfaellig ? `${kpis.ueberfaellig} überfällig` : "keine überfällig", kpis.ueberfaellig ? "ton-hoch" : "")}
      ${zelle("Heute gelernt", heuteGesamt, "Min")}
    </div>`;
}

function renderHeuteTab() {
  const { heuteLernen, kpis, klausurenAnstehend, aufgaben, heute } = appDaten;
  const { wichtig, spaeter } = heuteLernen;
  let wichtigInhalt;
  if (wichtig.length) wichtigInhalt = `<ul class="liste">${wichtig.map((e, i) => heuteZeileHtml(e, i, "wichtig")).join("")}</ul>`;
  else if (spaeter.length) wichtigInhalt = `<p class="leer">Nichts Dringendes – alles im grünen Bereich.</p>`;
  else wichtigInhalt = `<p class="leer">Nichts zu lernen empfohlen – keine Klausur mit offenen Themen im ${HEUTE_KLAUSUR_FENSTER_TAGE}-Tage-Fenster.</p>`;
  const spaeterHtml = spaeter.length
    ? `<details class="noch-zeit"><summary>${chevron()} Wenn noch Zeit ist · ${spaeter.length} weitere</summary><ul class="liste">${spaeter.map((e, i) => heuteZeileHtml(e, i, "spaeter")).join("")}</ul></details>`
    : "";

  const container = document.getElementById("tab-heute");
  container.innerHTML = `
    ${kpiHtml(kpis, heuteLernen.heuteGesamt)}
    <div class="heute-raster">
      <section class="karte karte-wichtig">
        <div class="karte-kopf"><h2>Jetzt wichtig</h2></div>
        ${wichtigInhalt}
        ${spaeterHtml}
      </section>
      <div class="stapel">
        ${naechsteKlausurenHtml(klausurenAnstehend)}
        ${heuteAufgabenHtml(aufgaben, heute)}
      </div>
    </div>`;

  container.querySelectorAll("[data-heute-index]").forEach((el) => {
    el.addEventListener("click", () => {
      const liste = el.dataset.heuteListe === "spaeter" ? spaeter : wichtig;
      zeigeKlausurDetail(liste[Number(el.dataset.heuteIndex)].klausur);
    });
  });
  container.querySelectorAll("[data-anstehend-index]").forEach((el) => {
    el.addEventListener("click", () => zeigeKlausurDetail(klausurenAnstehend[Number(el.dataset.anstehendIndex)]));
  });
}

// --- Aufgaben --------------------------------------------------------------

const PRIORITAET_TEXT = { hoch: "Priorität hoch", mittel: "Priorität mittel", niedrig: "Priorität niedrig" };

function aufgabeKarteHtml(a, { ueberfaellig = false, erledigt = false } = {}) {
  // "Klausur bald": Aufgabe eines Fachs mit Klausur in <= KLAUSUR_BALD_TAGE Tagen
  const bald = !erledigt && a.klausurTage !== null && a.klausurTage !== undefined && a.klausurTage >= 0 && a.klausurTage <= KLAUSUR_BALD_TAGE
    ? `<span class="pill ton-hoch" title="Wegen anstehender Klausur im gleichen Fach hochpriorisiert">Klausur bald · ${esc(countdownText(a.klausurTage))}</span>`
    : "";
  const fach = a.fach && a.fach !== "-" && a.fach !== "–" ? `${esc(a.fach)} · ` : "";
  return `
    <li class="zeile aufgabe-zeile zeile-mit-check${erledigt ? " erledigt" : ""}">
      ${aufgabeCheckHtml(a, erledigt)}
      <div class="zeile-text">
        <div class="zeile-titel">${esc(a.titel)}</div>
        <div class="zeile-meta">${fach}<span class="${ueberfaellig ? "ton-hoch" : ""}">${esc(formatiereDatumLang(a.deadline))}</span> · <span class="${erledigt ? "" : ton(a.prioritaet)}">${esc(PRIORITAET_TEXT[a.prioritaet] || a.prioritaet)}</span></div>
        ${bald ? `<div class="pill-reihe">${bald}</div>` : ""}
        <details class="aufklapper">
          <summary>${chevron()} Details</summary>
          <div class="aufklapper-inhalt">
            ${a.beschreibung ? `<p>${esc(a.beschreibung)}</p>` : ""}
            <p>Status: ${esc(a.status)}</p>
          </div>
        </details>
      </div>
    </li>`;
}

function listenKarteHtml(titel, liste, renderZeile, { leerText = null, titelKlasse = "", meta = "" } = {}) {
  if (liste.length === 0 && !leerText) return "";
  const inhalt = liste.length ? `<ul class="liste">${liste.map(renderZeile).join("")}</ul>` : `<p class="leer">${esc(leerText)}</p>`;
  return karteHtml(`${esc(titel)} <span class="zaehler">${liste.length}</span>`, inhalt, { titelKlasse, meta });
}

function renderAufgabenTab() {
  // Nur echte Aufgaben - Klausuren stehen unter Heute ("Naechste Klausuren")
  // und im Klausuren-Tab.
  const { aufgaben } = appDaten;
  let html = neueAufgabeKarteHtml();
  html += listenKarteHtml("Überfällig", aufgaben.ueberfaellig, (a) => aufgabeKarteHtml(a, { ueberfaellig: true }), { titelKlasse: "ton-hoch" });
  html += listenKarteHtml("Heute fällig", aufgaben.heute, (a) => aufgabeKarteHtml(a), { leerText: "Nichts heute fällig." });
  html += listenKarteHtml("Diese Woche", aufgaben.diese_woche, (a) => aufgabeKarteHtml(a), { leerText: "Nichts diese Woche fällig." });
  html += listenKarteHtml("Später", aufgaben.spaeter, (a) => aufgabeKarteHtml(a), { leerText: "Keine weiteren Aufgaben." });

  if (aufgaben.abgeschlossen.length) {
    html += `
      <section class="karte">
        <details>
          <summary class="karte-kopf"><h2>${chevron()} Vergangene Aufgaben <span class="zaehler">${aufgaben.abgeschlossen.length}</span></h2><span class="karte-meta">Haken entfernen = wieder öffnen</span></summary>
          <ul class="liste">${aufgaben.abgeschlossen.map((a) => aufgabeKarteHtml(a, { erledigt: true })).join("")}</ul>
        </details>
      </section>`;
  }

  const container = document.getElementById("tab-aufgaben");
  container.innerHTML = `<div class="stapel">${html}</div>`;
  const details = container.querySelector("#neue-aufgabe-details");
  details.addEventListener("toggle", () => { neueAufgabeOffen = details.open; });
  const form = container.querySelector("#neue-aufgabe-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    aufgabeAnlegen(form, form.querySelector("button[type=submit]"));
  });
}

// "Aufgabe hinzufuegen": Titel, Fach (Fach-Ordner + Privat), Deadline
// (Pflicht), Prioritaet, Beschreibung. Aufgeklappt bleibt es nach dem
// Neuladen, solange der Nutzer es nicht selbst zuklappt.
let neueAufgabeOffen = false;
function neueAufgabeKarteHtml() {
  const faecher = [...appDaten.faecherListe, "Privat"].map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
  return `
    <section class="karte">
      <details id="neue-aufgabe-details"${neueAufgabeOffen ? " open" : ""}>
        <summary class="karte-kopf"><h2>${icon("plus", 16)} Aufgabe hinzufügen</h2></summary>
        <form id="neue-aufgabe-form" class="formular karte-inhalt" novalidate>
          <div class="feld feld-voll"><label class="feld-label" for="neu-titel">Titel</label>
            <input id="neu-titel" type="text" maxlength="200" placeholder="z.B. S. 45 Nr. 3–7" required></div>
          <div class="feld"><label class="feld-label" for="neu-fach">Fach</label>
            <select id="neu-fach" required><option value="">Fach wählen</option>${faecher}</select></div>
          <div class="feld"><label class="feld-label" for="neu-deadline">Deadline</label>
            <input id="neu-deadline" type="date" required></div>
          <div class="feld"><label class="feld-label" for="neu-prioritaet">Priorität</label>
            <select id="neu-prioritaet"><option value="hoch">hoch</option><option value="mittel" selected>mittel</option><option value="niedrig">niedrig</option></select></div>
          <div class="feld feld-voll"><label class="feld-label" for="neu-beschreibung">Beschreibung (optional)</label>
            <input id="neu-beschreibung" type="text" maxlength="500"></div>
          <button type="submit" class="btn btn-primaer">${icon("plus", 16)} Anlegen</button>
        </form>
      </details>
    </section>`;
}

// --- Klausuren ---------------------------------------------------------------

function klausurZeitGesamt(k) {
  return Object.values(k.lernstand).reduce((s, e) => s + e.zeit_minuten, 0);
}

function ergebnisBadgeHtml(k) {
  if (k.punkteZahl !== null) return `<span class="pill wert">${k.punkteZahl} P.</span>`;
  if (k.punkte) return `<span class="pill wert">${esc(k.punkte)}</span>`;
  return `<span class="pill ton-niedrig">Ergebnis ausstehend</span>`;
}

function fehleranalyseHtml(k) {
  const link = /^https?:\/\//.test(k.korrekturQuelle)
    ? `<a class="extern-link" href="${esc(k.korrekturQuelle)}" target="_blank" rel="noopener">Korrigierte Klausur ${icon("extern", 14)}</a>`
    : "";
  if (!k.fehleranalyse.length) return link ? `<div>${link}</div>` : "";
  const labels = [["thema", "Thema"], ["fehler", "Fehler"], ["ursache", "Ursache"], ["verbesserung", "Verbesserung"]];
  const punkte = k.fehleranalyse.map((e) => `
    <li>${labels.filter(([feld]) => e[feld]).map(([feld, label]) => `<dl class="fehler-feld"><dt>${label}</dt><dd>${esc(e[feld])}</dd></dl>`).join("")}</li>`).join("");
  return `
    <details class="aufklapper">
      <summary>${chevron()} Fehleranalyse <span class="zaehler">${k.fehleranalyse.length}</span></summary>
      <div class="aufklapper-inhalt"><ul class="fehler-liste">${punkte}</ul>${link}</div>
    </details>`;
}

// typ: "anstehend" | "abzuhaken" | "abgeschlossen" (Index bezieht sich auf die jeweilige Liste)
function klausurKarteHtml(k, index, typ) {
  const themen = k.themen.length;
  const verstanden = Object.values(k.lernstand).filter((e) => e.status === "verstanden").length;
  const meta = `${esc(formatiereDatumKurz(k.datum))}${themen ? ` · ${verstanden} von ${themen} Themen verstanden` : ""} · <span class="mono">${esc(formatiereMinuten(klausurZeitGesamt(k)))}</span>`;
  if (typ === "abgeschlossen") {
    return `
      <li class="vergangen">
        <button type="button" class="zeile" data-klausur-index="${index}" data-klausur-typ="${typ}">
          <span class="zeile-text"><span class="zeile-titel">${esc(k.fach)} · ${esc(k.titel)}</span><span class="zeile-meta">${esc(formatiereDatumKurz(k.datum))}</span></span>
          ${ergebnisBadgeHtml(k)}
        </button>
        <div class="vergangen-extra">
          ${k.fehleranalyse.length || k.korrekturQuelle ? fehleranalyseHtml(k) : ""}
          ${klausurPunkteAktionenHtml(k)}
        </div>
      </li>`;
  }
  const farbstufe = typ === "abzuhaken" ? "hoch" : klausurFarbstufe(k.tage_bis);
  const geschrieben = typ === "abzuhaken"
    ? `<div class="zeile-aktion"><button type="button" class="btn btn-sekundaer btn-klein" data-aktion="klausur-status" data-status="abgeschlossen" data-klausur="${registriereKlausur(k)}">${icon("haken", 16)} Geschrieben</button></div>`
    : "";
  return `
    <li${geschrieben ? ` class="mit-aktion"` : ""}><button type="button" class="zeile" data-klausur-index="${index}" data-klausur-typ="${typ}">
      <span class="punkt ${ton(farbstufe)}"></span>
      <span class="zeile-text"><span class="zeile-titel">${esc(k.fach)} · ${esc(k.titel)}</span><span class="zeile-meta">${meta}</span></span>
      <span class="zahl ${ton(farbstufe)}">${esc(countdownText(k.tage_bis))}</span>
    </button>${geschrieben}</li>`;
}

// Punkte eintragen/aendern (0-15) + "Wieder oeffnen" bei vergangenen
// Klausuren - wie render_vergangene_klausur_karte am Desktop.
function klausurPunkteAktionenHtml(k) {
  const nr = registriereKlausur(k);
  const feldId = neueFeldId("klausur-punkte");
  const label = k.punkteZahl !== null ? "Punkte ändern" : "Punkte eintragen";
  return `
    <div class="vergangen-aktionen">
      <form class="formular punkte-form" data-klausur="${nr}" novalidate>
        <div class="feld feld-zeile"><label class="feld-label" for="${feldId}">${label} (0–15)</label>
          <input id="${feldId}" type="number" inputmode="numeric" min="0" max="15" step="1" class="punkte-eingabe" value="${k.punkteZahl ?? ""}" required></div>
        <button type="submit" class="btn btn-sekundaer">Speichern</button>
      </form>
      <button type="button" class="btn btn-sekundaer btn-klein" data-aktion="klausur-status" data-status="geplant" data-klausur="${nr}">${icon("rueckgaengig", 16)} Wieder öffnen</button>
    </div>`;
}

function renderKlausurenTab() {
  const { klausurenAnstehend, klausurenAbzuhaken, klausurenAbgeschlossen } = appDaten;
  const listen = { anstehend: klausurenAnstehend, abzuhaken: klausurenAbzuhaken, abgeschlossen: klausurenAbgeschlossen };
  let html = "";

  if (klausurenAbzuhaken.length) {
    html += listenKarteHtml(`Geschrieben?`, klausurenAbzuhaken, (k, i) => klausurKarteHtml(k, i, "abzuhaken"),
      { titelKlasse: "ton-hoch" });
  }
  html += listenKarteHtml("Anstehende Klausuren", klausurenAnstehend, (k, i) => klausurKarteHtml(k, i, "anstehend"),
    { leerText: "Keine anstehenden Klausuren." });
  html += `
    <section class="karte">
      <details open>
        <summary class="karte-kopf"><h2>${chevron()} Vergangene Klausuren <span class="zaehler">${klausurenAbgeschlossen.length}</span></h2></summary>
        ${klausurenAbgeschlossen.length
          ? `<ul class="liste">${klausurenAbgeschlossen.map((k, i) => klausurKarteHtml(k, i, "abgeschlossen")).join("")}</ul>`
          : `<p class="leer">Noch keine vergangenen Klausuren.</p>`}
      </details>
    </section>`;

  const container = document.getElementById("tab-klausuren");
  container.innerHTML = `<div class="stapel">${html}</div>`;
  container.querySelectorAll("[data-klausur-index]").forEach((el) => {
    el.addEventListener("click", () => {
      const liste = listen[el.dataset.klausurTyp] || [];
      const klausur = liste[Number(el.dataset.klausurIndex)];
      if (klausur) zeigeKlausurDetail(klausur);
    });
  });
}

const LERNSTAND_TON = { verstanden: "ton-mittel", teilweise: "ton-niedrig", offen: "ton-hoch" };

function zeigeKlausurDetail(k) {
  const overlay = document.getElementById("klausur-detail-overlay");
  const tage = diffTage(k.datum, appDaten.heute);
  const countdown = countdownText(tage);
  const nr = registriereKlausur(k);
  const aktionen = k.status === "abgeschlossen"
    ? `<section class="karte"><div class="karte-inhalt">${klausurPunkteAktionenHtml(k)}</div></section>`
    : `<div><button type="button" class="btn btn-sekundaer" data-aktion="klausur-status" data-status="abgeschlossen" data-klausur="${nr}">${icon("haken", 16)} Geschrieben</button></div>`;
  const themen = k.themen.map((thema) => {
    const e = k.lernstand[thema];
    return `
      <li class="thema">
        <div class="thema-kopf">
          <span class="punkt ${LERNSTAND_TON[e.status] || "ton-hoch"}"></span>
          <span class="zeile-text"><span class="zeile-titel">${esc(thema)}</span><span class="zeile-meta">${esc(e.status)}</span></span>
          <span class="zahl">${esc(formatiereMinuten(e.zeit_minuten))}</span>
        </div>
        ${e.sessions.length ? `
          <details class="aufklapper">
            <summary>${chevron()} Sessions <span class="zaehler">${e.sessions.length}</span></summary>
            <ul class="sessions-liste">${e.sessions.slice().reverse().map((s) => `<li>${esc(s.datum)} · ${esc(formatiereMinuten(s.minuten))}</li>`).join("")}</ul>
          </details>` : ""}
      </li>`;
  }).join("");

  offeneKlausurId = k.dateiId;
  overlay.innerHTML = `
    <div class="detail">
      <button type="button" class="zurueck-link" id="detail-zurueck">${icon("zurueck")} Zurück</button>
      <header class="detail-kopf">
        <div class="kopf-datum">${esc(k.fach)} · ${esc(formatiereDatumLang(k.datum))}</div>
        <h1>${esc(k.titel)}</h1>
        <div class="pill-reihe">
          <span class="pill ${tage >= 0 ? ton(klausurFarbstufe(tage)) : k.status === "abgeschlossen" ? "ton-niedrig" : "ton-hoch"}">${esc(countdown)}</span>
          <span class="pill">Status: ${esc(k.status || "offen")}</span>
          <span class="pill">Investiert <span class="mono">${esc(formatiereMinuten(klausurZeitGesamt(k)))}</span></span>
          ${k.status === "abgeschlossen" ? ergebnisBadgeHtml(k) : ""}
        </div>
      </header>
      <div class="stapel">
        ${aktionen}
        ${k.status === "abgeschlossen" && (k.fehleranalyse.length || k.korrekturQuelle) ? `<section class="karte"><div class="karte-inhalt">${fehleranalyseHtml(k)}</div></section>` : ""}
        ${karteHtml(`Themen <span class="zaehler">${k.themen.length}</span>`, k.themen.length ? `<ul class="liste">${themen}</ul>` : `<p class="leer">Keine Themen hinterlegt.</p>`, { meta: "Timer am Desktop" })}
      </div>
    </div>`;
  overlay.hidden = false;
  overlay.scrollTop = 0;
  const zurueck = document.getElementById("detail-zurueck");
  zurueck.focus();
  zurueck.addEventListener("click", () => { overlay.hidden = true; });
}

// Nach dem Neuladen (z.B. nach "Geschrieben" in der Detailansicht) die
// offene Detailansicht mit den frischen Daten neu zeichnen.
let offeneKlausurId = null;
function aktualisiereOffeneDetailansicht() {
  const overlay = document.getElementById("klausur-detail-overlay");
  if (overlay.hidden || !offeneKlausurId) return;
  const alle = [...appDaten.klausurenAnstehend, ...appDaten.klausurenAbzuhaken, ...appDaten.klausurenAbgeschlossen];
  const k = alle.find((x) => x.dateiId === offeneKlausurId);
  if (!k) { overlay.hidden = true; return; }
  const scroll = overlay.scrollTop;
  zeigeKlausurDetail(k);
  overlay.scrollTop = scroll;
}

// --- Punkte --------------------------------------------------------------------

function renderPunkteTab() {
  const { faecherListe, notenProFach, schriftlichProFach } = appDaten;
  if (!faecherListe.length) {
    document.getElementById("tab-punkte").innerHTML = `<section class="karte"><p class="leer">Keine Fächer gefunden.</p></section>`;
    return;
  }

  const html = faecherListe.map((fach) => {
    const schriftlichInfo = schriftlichProFach[fach];
    const muendlicheListe = (notenProFach[fach] || { muendlich: [] }).muendlich;
    const muendlich = muendlicheListe.length ? muendlicheListe[muendlicheListe.length - 1] : null;
    const schriftlichAvg = schriftlichInfo ? schriftlichInfo.durchschnitt : null;
    const gesamt = berechneGesamtpunktzahl(fach, schriftlichAvg, muendlich ? muendlich.punkte : null);
    const gewicht = LK_FAECHER.has(fach) ? GEWICHT_LK : GEWICHT_GK;
    const kursart = LK_FAECHER.has(fach) ? "LK" : "GK";
    return `
      <section class="karte">
        <div class="karte-kopf"><h2>${esc(fach)}</h2><span class="pill">${kursart} · ${Math.round(gewicht.schriftlich * 100)}/${Math.round(gewicht.muendlich * 100)}</span></div>
        <div class="karte-inhalt">
          <div class="werte">
            <div class="wert-zeile"><span class="label">Schriftlich</span><span>${schriftlichAvg !== null ? `<span class="wert">${schriftlichAvg.toFixed(1)}</span> <span class="hinweis-text">Ø aus ${schriftlichInfo.anzahl}</span>` : `<span class="hinweis-text">noch keine Note</span>`}</span></div>
            <div class="wert-zeile"><span class="label">Mündlich</span><span>${muendlich ? `<span class="wert">${muendlich.punkte}</span> <span class="hinweis-text">${esc(muendlich.bezeichnung)}</span>` : `<span class="hinweis-text">noch keine Eintragung</span>`}</span></div>
          </div>
          <div class="abschnitt-trenner">
            <div class="kpi-label">Gesamt</div>
            ${gesamt !== null
              ? `<div class="gesamt-zeile"><span class="gesamt">${Math.round(gesamt)}</span><span class="gesamt-genau">genau ${gesamt.toFixed(1)} von 15</span></div>`
              : `<p class="hinweis-text" style="margin-top:6px">Noch unvollständig – schriftliche und/oder mündliche Note fehlt.</p>`}
          </div>
          ${notenVerwaltungHtml(fach)}
        </div>
      </section>`;
  }).join("");

  const container = document.getElementById("tab-punkte");
  container.innerHTML = `<div class="raster">${html}</div>`;
  container.querySelectorAll(".hinzufuegen-form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      noteHinzufuegen(form.dataset.fach, form, form.querySelector("button[type=submit]"));
    });
  });
  container.querySelectorAll(".noten-eintrag[data-id]").forEach((zeile) => {
    const anzeige = zeile.querySelector(".eintrag-anzeige");
    const form = zeile.querySelector(".bearbeiten-form");
    const { fach, art, id } = zeile.dataset;
    const eintrag = () => appDaten.notenProFach[fach][art].find((e) => e.id === id);
    const umschalten = (bearbeiten) => {
      anzeige.hidden = bearbeiten;
      form.hidden = !bearbeiten;
      (bearbeiten ? form.querySelector(".bezeichnung-eingabe") : zeile.querySelector(".bearbeiten-btn")).focus();
    };
    zeile.querySelector(".bearbeiten-btn").addEventListener("click", () => umschalten(true));
    zeile.querySelector(".abbrechen-btn").addEventListener("click", () => umschalten(false));
    zeile.querySelector(".loeschen-btn").addEventListener("click", (e) => noteLoeschen(fach, art, eintrag(), e.currentTarget));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      noteBearbeiten(fach, art, eintrag(), form, form.querySelector("button[type=submit]"));
    });
  });
}

// Ein Noten-Eintrag mit Bearbeiten/Loeschen (wie render_note_eintrag am
// Desktop). Eintraege ohne id bleiben reine Anzeige.
function noteEintragHtml(fach, art, e, doppelt = false) {
  const doppeltHtml = doppelt ? ` <em class="doppelt-hinweis" title="Gleiches Datum wie eine Klausur mit Punkten – die Klausur hat Vorrang">(doppelt, zählt nicht)</em>` : "";
  const datum = e.datum ? ` <span class="hinweis-text">${esc(formatiereDatumKurz(parseDatumIso(e.datum)))}</span>` : "";
  const text = `${esc(e.bezeichnung)} · <span class="mono">${esc(e.punkte)}</span> P.${datum}${doppeltHtml}`;
  if (!e.id) {
    return `<li class="noten-eintrag"><span class="eintrag-text" title="Ohne id eingetragen – nur direkt in der Noten-Notiz bearbeitbar">${text} <span class="hinweis-text">(manuell in Notiz)</span></span></li>`;
  }
  const bezId = neueFeldId("note-bez");
  const pktId = neueFeldId("note-pkt");
  return `
    <li class="noten-eintrag" data-fach="${esc(fach)}" data-art="${art}" data-id="${esc(e.id)}">
      <div class="eintrag-anzeige">
        <span class="eintrag-text">${text}</span>
        <button type="button" class="btn btn-sekundaer btn-klein btn-icon bearbeiten-btn" aria-label="Bearbeiten: ${esc(e.bezeichnung)}" title="Bearbeiten">${icon("stift", 16)}</button>
        <button type="button" class="btn btn-sekundaer btn-klein btn-icon btn-gefahr loeschen-btn" aria-label="Löschen: ${esc(e.bezeichnung)}" title="Löschen">${icon("muell", 16)}</button>
      </div>
      <form class="formular bearbeiten-form" novalidate hidden>
        <div class="feld feld-breit"><label class="feld-label" for="${bezId}">Bezeichnung</label>
          <input id="${bezId}" type="text" class="bezeichnung-eingabe" value="${esc(e.bezeichnung)}" maxlength="120" required></div>
        <div class="feld"><label class="feld-label" for="${pktId}">Punkte</label>
          <input id="${pktId}" type="number" inputmode="numeric" min="0" max="15" step="1" class="punkte-eingabe" value="${esc(e.punkte)}" required></div>
        <button type="submit" class="btn btn-primaer btn-klein">Speichern</button>
        <button type="button" class="btn btn-sekundaer btn-klein abbrechen-btn">Abbrechen</button>
      </form>
    </li>`;
}

// Verlauf schriftlich (Klausur-Punkte nur lesend + manuelle Noten), Verlauf
// muendlich und "Note hinzufuegen" - wie render_fach_punkte_karte am Desktop
// (ohne Notenverlauf-Diagramm).
function notenVerwaltungHtml(fach) {
  const noten = appDaten.notenProFach[fach] || { schriftlich: [], muendlich: [] };
  const klausurenMitPunkten = appDaten.klausurenAbgeschlossen.filter((k) => k.fachOrdnerName === fach && k.punkteZahl !== null);
  const klausurDaten = new Set(klausurenMitPunkten.map((k) => isoDatum(k.datum)));

  const klausurZeilen = klausurenMitPunkten.map((k) =>
    `<li class="noten-eintrag"><span class="eintrag-text" title="Aus der Klausur-Notiz – im Klausuren-Tab ändern">Klausur ${esc(k.titel)} · <span class="mono">${k.punkteZahl}</span> P. <span class="hinweis-text">(aus Klausur)</span></span></li>`);
  const manuelleZeilen = noten.schriftlich.map((e) => noteEintragHtml(fach, "schriftlich", e, Boolean(e.datum && klausurDaten.has(e.datum)))).reverse();
  const schriftlich = [...klausurZeilen, ...manuelleZeilen];
  const muendlich = noten.muendlich.map((e) => noteEintragHtml(fach, "muendlich", e)).reverse();

  const artId = neueFeldId("art");
  const bezId = neueFeldId("bez");
  const pktId = neueFeldId("pkt");
  const datId = neueFeldId("dat");
  return `
    <div class="abschnitt-trenner">
      <details class="aufklapper">
        <summary>${chevron()} Verlauf schriftlich <span class="zaehler">${schriftlich.length}</span></summary>
        <div class="aufklapper-inhalt"><ul class="noten-liste">${schriftlich.join("") || `<li class="hinweis-text">Noch keine schriftliche Note (Punkte vergangener Klausuren zählen automatisch mit).</li>`}</ul></div>
      </details>
      <details class="aufklapper">
        <summary>${chevron()} Verlauf mündlich <span class="zaehler">${muendlich.length}</span></summary>
        <div class="aufklapper-inhalt"><ul class="noten-liste">${muendlich.join("") || `<li class="hinweis-text">Noch keine Eintragungen.</li>`}</ul></div>
      </details>
      <details class="aufklapper">
        <summary>${icon("plus", 16)} Note hinzufügen</summary>
        <form class="formular hinzufuegen-form" data-fach="${esc(fach)}" novalidate>
          <div class="feld"><label class="feld-label" for="${artId}">Art</label>
            <select id="${artId}" class="art-auswahl"><option value="schriftlich">Schriftlich (Klassenarbeit)</option><option value="muendlich">Mündlich</option></select></div>
          <div class="feld feld-breit"><label class="feld-label" for="${bezId}">Bezeichnung</label>
            <input id="${bezId}" type="text" class="bezeichnung-eingabe" placeholder="z.B. Klassenarbeit 2" maxlength="120" required></div>
          <div class="feld"><label class="feld-label" for="${pktId}">Punkte</label>
            <input id="${pktId}" type="number" inputmode="numeric" min="0" max="15" step="1" class="punkte-eingabe" required></div>
          <div class="feld"><label class="feld-label" for="${datId}">Datum (optional)</label>
            <input id="${datId}" type="date" class="datum-eingabe"></div>
          <button type="submit" class="btn btn-primaer">Hinzufügen</button>
        </form>
      </details>
    </div>`;
}

// --- Begleiter -------------------------------------------------------------------

function renderBegleiterTab() {
  const container = document.getElementById("tab-begleiter");
  const daten = appDaten.begleiter;
  if (!daten || daten.fehlt) {
    const details = daten
      ? `<div class="hinweis-details">Gesucht: <code>${esc(daten.pfad)}</code><br>Vault-Ordner-ID: <code>${esc(daten.vaultId)}</code><br>Schule-Ordner-ID: <code>${esc(daten.schuleId)}</code>${daten.fehler ? `<br>Fehler: ${esc(daten.fehler)}` : ""}</div>`
      : "";
    container.innerHTML = `<section class="karte"><div class="leer">Keine Begleiter-Übersicht gefunden. Sie wird von der Begleiter-Automatik (Mo–Fr 14 Uhr) in <code>Schule/${esc(BEGLEITER_DATEI_NAME)}</code> angelegt.${details}</div></section>`;
    return;
  }
  if (!daten.faecher.length) {
    container.innerHTML = `<section class="karte"><p class="leer">Die Begleiter-Übersicht enthält noch keine Fächer.</p></section>`;
    return;
  }

  const karten = daten.faecher.map((f) => {
    const zuletztText = f.zuletzt
      ? (f.tageSeit === 0 ? "heute aktualisiert" : f.tageSeit === 1 ? "gestern aktualisiert" : `aktualisiert am ${formatiereDatumKurz(f.zuletzt)}`)
      : "noch keine Updates";
    const updates = f.updates.length
      ? f.updates.map((u) => {
          const link = begleiterSeitenUrl(f.url, u.seite);
          const seite = u.seite
            ? (link ? `<a class="begleiter-seite" href="${esc(link)}" target="_blank" rel="noopener">S. ${u.seite} ${icon("extern", 13)}</a>` : `<span class="begleiter-seite">S. ${u.seite}</span>`)
            : "";
          const datum = u.datum ? `${String(u.datum.getDate()).padStart(2, "0")}.${String(u.datum.getMonth() + 1).padStart(2, "0")}.` : "";
          return `
            <div class="begleiter-update">
              <div class="begleiter-update-kopf"><span class="begleiter-datum">${datum}</span><span class="begleiter-thema">${esc(u.thema)}</span>${seite}</div>
              ${u.zusammenfassung ? `<div class="begleiter-text">${esc(u.zusammenfassung)}</div>` : ""}
            </div>`;
        }).join("")
      : `<p class="hinweis-text">Noch keine Updates.</p>`;
    return `
      <section class="karte">
        <div class="karte-kopf"><div><h2>${esc(f.fach)}</h2><div class="zeile-meta">${esc(zuletztText)}${f.seiten ? ` · ${f.seiten} Seiten` : ""}</div></div>${f.istNeu ? `<span class="pill">Neu</span>` : ""}</div>
        <div class="karte-inhalt">
          ${updates}
          ${f.url ? `<a class="btn btn-sekundaer btn-breit" href="${esc(f.url)}" target="_blank" rel="noopener">${icon("begleiter", 16)} Begleiter öffnen</a>` : ""}
        </div>
      </section>`;
  }).join("");

  container.innerHTML = `<div class="raster">${karten}</div>`;
}

// ===========================================================================
// UI-STEUERUNG (Login-Bereich <-> Inhalt, Tabs)
// ===========================================================================

function zeigeAnmeldeAnsicht() {
  document.getElementById("offen-chip").hidden = true;
  document.getElementById("seitentitel").textContent = "Schul-Dashboard";
  document.getElementById("anmelde-bereich").hidden = false;
  document.getElementById("inhalt-bereich").hidden = true;
  document.getElementById("tabs").hidden = true;
  document.getElementById("header-aktionen").hidden = true;
}

async function aufAnmeldungReagieren() {
  const aktiv = document.querySelector(".tab-btn.active");
  document.getElementById("seitentitel").textContent = aktiv ? aktiv.dataset.titel : "Heute";
  document.getElementById("anmelde-bereich").hidden = true;
  document.getElementById("inhalt-bereich").hidden = false;
  document.getElementById("tabs").hidden = false;
  document.getElementById("header-aktionen").hidden = false;
  try {
    await ladeAlleDaten();
  } catch (e) {
    console.error(e);
    setStatus(`Fehler: ${e.message}`);
  }
}

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.remove("active");
        b.removeAttribute("aria-current");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-current", "page");
      document.querySelectorAll(".tab-inhalt").forEach((t) => (t.hidden = true));
      document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
      document.getElementById("seitentitel").textContent = btn.dataset.titel;
      window.scrollTo(0, 0);
    });
  });
}

// Schreib-Bedienelemente per Event-Delegation (die Tabs werden bei jedem
// Neuladen komplett neu gerendert).
function initSchreibAktionen() {
  const bereich = document.getElementById("inhalt-bereich");
  bereich.addEventListener("change", (e) => {
    const box = e.target.closest(".aufgabe-check");
    if (!box) return;
    const aufgabe = aufgabeRegister[Number(box.dataset.aufgabe)];
    if (aufgabe) aufgabeUmschalten(aufgabe, box);
  });
  bereich.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-aktion="klausur-status"]');
    if (!btn) return;
    const klausur = klausurRegister[Number(btn.dataset.klausur)];
    if (klausur) klausurStatusSetzen(klausur, btn.dataset.status, btn);
  });
  bereich.addEventListener("submit", (e) => {
    const form = e.target.closest(".punkte-form");
    if (!form) return;
    e.preventDefault();
    const klausur = klausurRegister[Number(form.dataset.klausur)];
    if (klausur) klausurPunkteSetzen(klausur, form.querySelector(".punkte-eingabe"), form.querySelector("button[type=submit]"));
  });

  document.getElementById("meldung").addEventListener("click", (e) => { e.currentTarget.hidden = true; });
  document.getElementById("schreibrechte-btn").addEventListener("click", () => starteLogin({ zustimmung: true }));
}

window.addEventListener("DOMContentLoaded", () => {
  initAuth();
  initTabs();
  initSchreibAktionen();

  document.getElementById("anmelden-btn").addEventListener("click", () => {
    document.getElementById("anmelde-fehler").hidden = true;
    speicherSchreiben("local", "dashboard_abgemeldet", null);
    starteLogin();
  });

  document.getElementById("aktualisieren-btn").addEventListener("click", () => {
    ladeAlleDaten().catch((e) => {
      console.error(e);
      setStatus(`Fehler: ${e.message}`);
    });
  });

  document.getElementById("abmelden-btn").addEventListener("click", () => {
    // Token bei Google widerrufen (entzieht auch die erteilte Zustimmung)
    if (accessToken) {
      fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken }),
      }).catch(() => {});
    }
    clearTimeout(erneuerungsTimer);
    speicherSchreiben("local", "dashboard_abgemeldet", "1");
    speicherSchreiben("local", "dashboard_konto", null);
    accessToken = null;
    appDaten = null;
    zeigeAnmeldeAnsicht();
  });
});

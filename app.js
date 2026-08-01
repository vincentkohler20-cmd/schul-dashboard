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
const WIEDERHOLUNG_DIESE_WOCHE_TAGE = 7;
const LK_FAECHER = new Set(["Mathe-LK", "Physik-LK", "Geschichte"]);
const GEWICHT_LK = { schriftlich: 0.4, muendlich: 0.6 };
const GEWICHT_GK = { schriftlich: 0.3, muendlich: 0.7 };
const WOCHENTAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";

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
// GOOGLE DRIVE ZUGRIFF (nur lesend - GET, nie POST/PATCH/DELETE)
// ===========================================================================

let accessToken = null;
let tokenClient = null;
let erneuerungsTimer = null;
let autoLoginVersuch = false; // true waehrend eines automatischen (stillen) Login-Versuchs

function initAuth() {
  if (typeof google === "undefined" || !google.accounts) {
    // Google-Skript ist noch nicht fertig geladen - kurz erneut versuchen,
    // statt mit einem ReferenceError abzubrechen.
    setTimeout(initAuth, 100);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.OAUTH_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp.error) {
        // Beim automatischen Versuch beim App-Start ist ein Fehlschlag normal
        // (z.B. beim allerersten Aufruf, oder wenn der Zugriff widerrufen
        // wurde) - dann einfach den normalen Login-Button zeigen, keine
        // Fehlermeldung. Nur bei einem bewussten Klick zeigen wir den Fehler.
        if (!autoLoginVersuch) zeigeAnmeldeFehler(resp.error);
        return;
      }
      accessToken = resp.access_token;
      planeTokenErneuerung(resp.expires_in);
      aufAnmeldungReagieren();
    },
  });

  // Automatischer, stiller Login-Versuch direkt beim App-Start: Ist der
  // Nutzer in diesem Browser (bzw. dieser Home-Bildschirm-Verknuepfung)
  // noch bei Google angemeldet und hat frueher schon zugestimmt, bekommt
  // die App ohne Tap ein frisches Token - fuehlt sich wie "eingeloggt
  // bleiben" an, obwohl technisch bei jedem Start ein neues Token geholt wird.
  // Nach einem bewussten "Abmelden" wird das bewusst uebersprungen, sonst
  // waere man sofort wieder eingeloggt.
  if (localStorage.getItem("dashboard_abgemeldet") !== "1") {
    autoLoginVersuch = true;
    tokenClient.requestAccessToken({ prompt: "" });
  }
}

// Holt rechtzeitig vor Ablauf (2 Minuten Puffer) im Hintergrund ein neues
// Token, damit eine laenger offene Seite nicht mitten in der Nutzung auf
// den Login-Screen zurueckfaellt.
function planeTokenErneuerung(gueltigSekunden) {
  clearTimeout(erneuerungsTimer);
  const wartezeitMs = Math.max((gueltigSekunden || 3600) - 120, 30) * 1000;
  erneuerungsTimer = setTimeout(() => {
    autoLoginVersuch = true;
    tokenClient.requestAccessToken({ prompt: "" });
  }, wartezeitMs);
}

function zeigeAnmeldeFehler(fehler) {
  const el = document.getElementById("anmelde-fehler");
  el.textContent = `Anmeldung fehlgeschlagen: ${fehler}. Pruefe config.js (Client-ID) und die erlaubten Origins in der Google Cloud Console.`;
  el.hidden = false;
}

async function driveFetchJson(url) {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (resp.status === 401) {
    // Token abgelaufen (z.B. Handy war laenger im Standby) - der geplante
    // Refresh-Timer greift hier nicht mehr, also Login-Screen zeigen.
    clearTimeout(erneuerungsTimer);
    accessToken = null;
    zeigeAnmeldeAnsicht();
    throw new Error("Sitzung abgelaufen, bitte erneut anmelden.");
  }
  if (!resp.ok) throw new Error(`Drive-API-Fehler ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function driveListChildren(parentId, extraQuery = "") {
  let ergebnis = [];
  let pageToken = null;
  const q = `'${parentId}' in parents and trashed=false${extraQuery}`;
  do {
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await driveFetchJson(`${DRIVE_API}?${params.toString()}`);
    ergebnis = ergebnis.concat(data.files || []);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return ergebnis;
}

async function driveFindFolderByName(name, parentId) {
  const parentClause = parentId ? ` and '${parentId}' in parents` : "";
  const q = `name='${qEscape(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`;
  const params = new URLSearchParams({ q, fields: "files(id, name)", pageSize: "5" });
  const data = await driveFetchJson(`${DRIVE_API}?${params.toString()}`);
  if (!data.files || data.files.length === 0) {
    throw new Error(`Ordner '${name}' nicht gefunden (in Drive-Ordner ${parentId ?? "root"}).`);
  }
  return data.files[0];
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

    aufgaben.push({ titel, fach, deadline, prioritaet, status, beschreibung, dateiname });
  }
  return aufgaben;
}

function kategorisiereAufgaben(aufgaben, heute) {
  const kategorien = { ueberfaellig: [], heute: [], diese_woche: [], spaeter: [], abgeschlossen: [] };
  const wocheEnde = addTage(heute, DIESE_WOCHE_TAGE);

  for (const aufgabe of aufgaben) {
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
    liste.sort((a, b) => {
      const [pa, da] = sortierschluessel(a);
      const [pb, db] = sortierschluessel(b);
      const cmp = pa - pb || da - db;
      return name === "abgeschlossen" ? -cmp : cmp;
    });
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
    alleAufgaben = alleAufgaben.concat(parseAufgabenDatei(text, dateien[i].name));
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

function normalisiereWiederholung(wert) {
  if (typeof wert !== "object" || wert === null || Array.isArray(wert)) return null;
  const naechsteFaellig = parseKlausurDatum(wert.naechste_faellig);
  if (naechsteFaellig === null) return null;

  const intervallWochen = Number.isFinite(Number(wert.intervall_wochen)) ? Number(wert.intervall_wochen) : 2;

  const historie = [];
  for (const eintrag of wert.historie || []) {
    if (typeof eintrag !== "object" || eintrag === null) continue;
    const datumText = String(eintrag.datum || "").trim();
    const statusDanach = String(eintrag.status_danach || "").trim().toLowerCase();
    if (datumText && LERNSTAND_WERTE.has(statusDanach)) {
      historie.push({ datum: datumText, status_danach: statusDanach });
    }
  }
  return { naechste_faellig: naechsteFaellig, intervall_wochen: intervallWochen, historie };
}

function normalisiereLernstandEintrag(wert) {
  if (typeof wert === "string") {
    const status = wert.trim().toLowerCase();
    return { status: LERNSTAND_WERTE.has(status) ? status : "offen", zeit_minuten: 0, sessions: [], wiederholung: null };
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
      wiederholung: normalisiereWiederholung(wert.wiederholung),
    };
  }
  return { status: "offen", zeit_minuten: 0, sessions: [], wiederholung: null };
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
    if (klausur) klausuren.push(klausur);
  });
  return klausuren;
}

function sammleAlleKlausuren(klausuren, heute) {
  const anstehend = [];
  const abgeschlossen = [];
  for (const k of klausuren) {
    const eintrag = { ...k, tage_bis: diffTage(k.datum, heute) };
    if (k.status === "abgeschlossen") abgeschlossen.push(eintrag);
    else anstehend.push(eintrag);
  }
  anstehend.sort((a, b) => a.datum - b.datum);
  abgeschlossen.sort((a, b) => b.datum - a.datum);
  return [anstehend, abgeschlossen];
}

function sammleKlausurVorschau(klausuren, heute) {
  const ergebnis = [];
  for (const k of klausuren) {
    const tageBis = diffTage(k.datum, heute);
    if (tageBis >= 0 && tageBis <= KLAUSUR_VORSCHAU_TAGE) ergebnis.push({ ...k, tage_bis: tageBis });
  }
  ergebnis.sort((a, b) => a.datum - b.datum);
  return ergebnis;
}

// ===========================================================================
// PARSING: WIEDERHOLUNGEN (Spaced Repetition, basiert auf lernstand-Feld)
// ===========================================================================

function sammleWiederholungen(klausuren, heute) {
  const ergebnis = [];
  for (const k of klausuren) {
    if (k.status !== "abgeschlossen") continue;
    for (const [thema, eintrag] of Object.entries(k.lernstand)) {
      const w = eintrag.wiederholung;
      if (!w) continue;
      ergebnis.push({
        fach: k.fach,
        klausur_titel: k.titel,
        klausur_datum: k.datum,
        thema,
        status_damals: eintrag.status,
        naechste_faellig: w.naechste_faellig,
        tage_bis: diffTage(w.naechste_faellig, heute),
      });
    }
  }
  ergebnis.sort((a, b) => a.naechste_faellig - b.naechste_faellig);
  return ergebnis;
}

function kategorisiereWiederholungen(liste) {
  const kategorien = { ueberfaellig: [], diese_woche: [], kommt_bald: [] };
  for (const eintrag of liste) {
    if (eintrag.tage_bis < 0) kategorien.ueberfaellig.push(eintrag);
    else if (eintrag.tage_bis <= WIEDERHOLUNG_DIESE_WOCHE_TAGE) kategorien.diese_woche.push(eintrag);
    else kategorien.kommt_bald.push(eintrag);
  }
  return kategorien;
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
      const bezeichnung = String(eintrag.bezeichnung || "").trim();
      const punkte = Number(eintrag.punkte);
      if (bezeichnung && Number.isFinite(punkte)) ergebnis.push({ bezeichnung, punkte });
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
    notenProFach[dateien[i].parentName] = leseNotenAusText(text);
  });
  return notenProFach;
}

function sammleSchriftlichPunkteProFach(klausuren, notenProFach) {
  const wertProFach = {};
  for (const k of klausuren) {
    if (k.status !== "abgeschlossen") continue;
    const punkte = parseFloat(k.punkte);
    if (!Number.isFinite(punkte)) continue;
    (wertProFach[k.fachOrdnerName] ??= []).push(punkte);
  }
  for (const [fach, noten] of Object.entries(notenProFach)) {
    for (const eintrag of noten.schriftlich) (wertProFach[fach] ??= []).push(eintrag.punkte);
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

let appDaten = null; // zuletzt geladener Zustand, fuer Klick-Handler der Detailansicht

async function findeVaultOrdner() {
  const params = new URLSearchParams({
    q: `name='${qEscape(CONFIG.VAULT_ORDNER_NAME)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: "files(id, name)",
    pageSize: "5",
  });
  const data = await driveFetchJson(`${DRIVE_API}?${params.toString()}`);
  if (!data.files || data.files.length === 0) {
    throw new Error(`Vault-Ordner '${CONFIG.VAULT_ORDNER_NAME}' nicht in Google Drive gefunden.`);
  }
  return data.files[0].id;
}

async function ladeAlleDaten() {
  setStatus("Verbinde mit Google Drive ...");
  const vaultId = await findeVaultOrdner();

  setStatus("Suche Ordnerstruktur ...");
  const [aufgabenOrdner, schuleOrdner] = await Promise.all([
    driveFindFolderByName("Aufgaben", vaultId),
    driveFindFolderByName("Schule", vaultId),
  ]);
  const [klausurenOrdner, notenOrdner] = await Promise.all([
    driveFindFolderByName("Klausuren", schuleOrdner.id),
    driveFindFolderByName("Noten", schuleOrdner.id),
  ]);

  const heute = dateOnly(new Date());

  setStatus("Lade Aufgaben, Klausuren & Punkte ...");
  const [aufgaben, klausurenRoh, notenProFach, faecherOrdner] = await Promise.all([
    ladeAufgaben(aufgabenOrdner.id, heute),
    ladeKlausuren(klausurenOrdner.id),
    ladeNotenProFach(notenOrdner.id),
    driveListChildren(klausurenOrdner.id, ` and mimeType='${FOLDER_MIME}'`),
  ]);

  const [klausurenAnstehend, klausurenAbgeschlossen] = sammleAlleKlausuren(klausurenRoh, heute);
  const klausurVorschau = sammleKlausurVorschau(klausurenRoh, heute);
  const wiederholungen = kategorisiereWiederholungen(sammleWiederholungen(klausurenRoh, heute));
  const faecherListe = faecherOrdner.map((f) => f.name).sort();
  const schriftlichProFach = sammleSchriftlichPunkteProFach(klausurenRoh, notenProFach);

  appDaten = {
    heute,
    aufgaben: kategorisiereAufgaben(aufgaben, heute),
    klausurVorschau,
    klausurenAnstehend,
    klausurenAbgeschlossen,
    faecherListe,
    notenProFach,
    schriftlichProFach,
    wiederholungen,
  };

  setStatus(`Zuletzt aktualisiert: ${new Date().toLocaleTimeString("de-DE")}`);
  renderAlles();
}

function setStatus(text) {
  document.getElementById("status-zeile").textContent = text;
}

// ===========================================================================
// RENDERING
// ===========================================================================

function renderAlles() {
  renderAufgabenTab();
  renderKlausurenTab();
  renderPunkteTab();
  renderWiederholenTab();
}

function aufgabeKarteHtml(a) {
  return `
    <div class="karte prioritaet-${esc(a.prioritaet)}">
      <div class="titel">${esc(a.titel)}</div>
      <div class="deadline">${esc(formatiereDatumLang(a.deadline))}</div>
      <details class="details-dropdown">
        <summary>Details</summary>
        <div><strong>Fach:</strong> ${esc(a.fach)}</div>
        ${a.beschreibung ? `<div><strong>Beschreibung:</strong> ${esc(a.beschreibung)}</div>` : ""}
        <div><strong>Status:</strong> ${esc(a.status)}</div>
      </details>
    </div>`;
}

function abschnittHtml(titel, liste, renderKarte, { klasseZusatz = "", leerText = null } = {}) {
  if (liste.length === 0 && !leerText) return "";
  const inhalt = liste.length
    ? `<div class="karten-liste">${liste.map(renderKarte).join("")}</div>`
    : `<div class="leer-hinweis">${esc(leerText)}</div>`;
  return `
    <div class="abschnitt ${klasseZusatz}">
      <h2>${esc(titel)} <span class="zaehler">(${liste.length})</span></h2>
      ${inhalt}
    </div>`;
}

// Hero-Kachel ganz oben im Aufgaben-Tab: die zeitlich naechste anstehende
// Klausur mit grossem Countdown - Pendant zu render_naechste_klausur_kachel()
// im Desktop-Dashboard (dashboard.py), gleiches Design/gleiche Ampel-Logik.
function naechsteKlausurAbschnittHtml(klausurenAnstehend) {
  if (!klausurenAnstehend.length) {
    return `
      <div class="abschnitt">
        <div class="karte naechste-klausur-karte naechste-klausur-leer">
          <div class="leer-hinweis" style="padding:0">📅 Aktuell keine Klausur geplant.</div>
        </div>
      </div>`;
  }

  const k = klausurenAnstehend[0]; // bereits nach Datum sortiert, siehe sammleAlleKlausuren
  const tage = k.tage_bis;
  const farbstufe = klausurFarbstufe(tage);
  let tageZahlText, tageLabel;
  if (tage === 0) { tageZahlText = "Heute"; tageLabel = ""; }
  else if (tage === 1) { tageZahlText = "1"; tageLabel = "Tag"; }
  else { tageZahlText = String(tage); tageLabel = "Tage"; }

  const zeitGesamt = klausurZeitGesamt(k);
  let lernstandHtml = "";
  if (k.themen.length) {
    const zaehler = { verstanden: 0, teilweise: 0, offen: 0 };
    for (const eintrag of Object.values(k.lernstand)) zaehler[eintrag.status] = (zaehler[eintrag.status] || 0) + 1;
    lernstandHtml = `
      <div class="lernstand-text naechste-klausur-lernstand">
        <span class="badge badge-niedrig">✅ ${zaehler.verstanden}</span>
        <span class="badge badge-mittel">🟡 ${zaehler.teilweise}</span>
        <span class="badge badge-hoch">🔴 ${zaehler.offen}</span>
        · ${esc(formatiereMinuten(zeitGesamt))} investiert
      </div>`;
  }

  return `
    <div class="abschnitt">
      <div class="karte naechste-klausur-karte klickbar" id="naechste-klausur-karte">
        <div class="fach">Nächste Klausur · ${esc(k.fach)}</div>
        <div class="naechste-klausur-titel">${esc(k.titel)}</div>
        <div class="naechste-klausur-countdown">
          <span class="naechste-klausur-tage naechste-klausur-${esc(farbstufe)}">${esc(tageZahlText)}</span>
          ${tageLabel ? `<span class="naechste-klausur-tage-label">${esc(tageLabel)}</span>` : ""}
        </div>
        <div class="deadline">📅 ${esc(formatiereDatumLang(k.datum))}</div>
        ${lernstandHtml}
      </div>
    </div>`;
}

function renderAufgabenTab() {
  const { aufgaben, klausurVorschau, klausurenAnstehend } = appDaten;
  let html = "";
  html += naechsteKlausurAbschnittHtml(klausurenAnstehend);
  html += abschnittHtml("Überfällig", aufgaben.ueberfaellig, aufgabeKarteHtml, { klasseZusatz: "abschnitt-ueberfaellig" });
  html += abschnittHtml("Heute fällig", aufgaben.heute, aufgabeKarteHtml);
  html += abschnittHtml("Diese Woche", aufgaben.diese_woche, aufgabeKarteHtml);
  html += abschnittHtml("Später", aufgaben.spaeter, aufgabeKarteHtml);

  if (klausurVorschau.length) {
    html += abschnittHtml(
      "Nächste Klausuren (14 Tage)",
      klausurVorschau,
      (k) => `
        <div class="karte klausur-karte">
          <div class="fach-zeile">
            <span class="fach">${esc(k.fach)}</span>
            <span class="badge badge-${esc(klausurFarbstufe(k.tage_bis))}">${k.tage_bis} Tag(e)</span>
          </div>
          <div class="titel">${esc(k.titel)}</div>
          <div class="deadline">${esc(formatiereDatumKurz(k.datum))}</div>
        </div>`
    );
  }

  if (aufgaben.abgeschlossen.length) {
    html += `
      <details class="abschnitt">
        <summary style="cursor:pointer;color:var(--text-mild)">Vergangene Aufgaben (${aufgaben.abgeschlossen.length})</summary>
        <div class="karten-liste" style="margin-top:0.7rem">${aufgaben.abgeschlossen.map(aufgabeKarteHtml).join("")}</div>
      </details>`;
  }

  if (!html) html = `<div class="leer-hinweis">Keine offenen Aufgaben gefunden.</div>`;
  document.getElementById("tab-aufgaben").innerHTML = html;

  const naechsteKarte = document.getElementById("naechste-klausur-karte");
  if (naechsteKarte && klausurenAnstehend.length) {
    naechsteKarte.addEventListener("click", () => zeigeKlausurDetail(klausurenAnstehend[0]));
  }
}

function klausurZeitGesamt(k) {
  return Object.values(k.lernstand).reduce((s, e) => s + e.zeit_minuten, 0);
}

function klausurKarteHtml(k, index, istAbgeschlossen) {
  const badge = istAbgeschlossen
    ? `<span class="badge badge-niedrig">${esc(k.punkte || "-")} Pkt.</span>`
    : `<span class="badge badge-${esc(klausurFarbstufe(k.tage_bis))}">${k.tage_bis} Tag(e)</span>`;
  return `
    <div class="karte klausur-karte klickbar" data-klausur-index="${index}" data-klausur-typ="${istAbgeschlossen ? "abgeschlossen" : "anstehend"}">
      <div class="fach-zeile">
        <span class="fach">${esc(k.fach)}</span>
        ${badge}
      </div>
      <div class="titel">${esc(k.titel)}</div>
      <div class="deadline">${esc(formatiereDatumKurz(k.datum))} &middot; ${esc(formatiereMinuten(klausurZeitGesamt(k)))} investiert</div>
    </div>`;
}

function renderKlausurenTab() {
  const { klausurenAnstehend, klausurenAbgeschlossen } = appDaten;
  let html = abschnittHtml(
    "Anstehende Klausuren",
    klausurenAnstehend,
    (k, i) => klausurKarteHtml(k, klausurenAnstehend.indexOf(k), false)
  );

  if (klausurenAbgeschlossen.length) {
    html += `
      <details class="abschnitt">
        <summary style="cursor:pointer;color:var(--text-mild)">Abgeschlossene Klausuren (${klausurenAbgeschlossen.length})</summary>
        <div class="karten-liste" style="margin-top:0.7rem">
          ${klausurenAbgeschlossen.map((k) => klausurKarteHtml(k, klausurenAbgeschlossen.indexOf(k), true)).join("")}
        </div>
      </details>`;
  }

  if (!klausurenAnstehend.length && !klausurenAbgeschlossen.length) {
    html = `<div class="leer-hinweis">Keine Klausuren gefunden.</div>`;
  }

  const container = document.getElementById("tab-klausuren");
  container.innerHTML = html;
  container.querySelectorAll("[data-klausur-index]").forEach((el) => {
    el.addEventListener("click", () => {
      const typ = el.dataset.klausurTyp;
      const idx = Number(el.dataset.klausurIndex);
      const klausur = typ === "abgeschlossen" ? klausurenAbgeschlossen[idx] : klausurenAnstehend[idx];
      zeigeKlausurDetail(klausur);
    });
  });
}

function zeigeKlausurDetail(k) {
  const overlay = document.getElementById("klausur-detail-overlay");
  let html = `<a href="#" class="zurueck-link" id="detail-zurueck">&larr; Zurück</a>`;
  html += `<div class="fach">${esc(k.fach)}</div>`;
  html += `<h2 style="margin:0.2rem 0 1rem">${esc(k.titel)}</h2>`;
  html += `<div class="deadline" style="margin-bottom:1rem">${esc(formatiereDatumLang(k.datum))} &middot; Status: ${esc(k.status || "offen")}</div>`;

  for (const thema of k.themen) {
    const eintrag = k.lernstand[thema];
    html += `
      <div class="thema-block">
        <h3>${esc(thema)} <span class="badge badge-${esc(eintrag.status)}">${esc(eintrag.status)}</span></h3>
        <div class="thema-meta">${esc(formatiereMinuten(eintrag.zeit_minuten))} investiert</div>
        ${eintrag.sessions.length ? `
          <details class="details-dropdown">
            <summary>${eintrag.sessions.length} Session(s)</summary>
            ${eintrag.sessions.map((s) => `<div>${esc(s.datum)}: ${esc(formatiereMinuten(s.minuten))}</div>`).join("")}
          </details>` : ""}
        ${eintrag.wiederholung ? `
          <div class="thema-meta" style="margin-top:0.3rem">Nächste Wiederholung: ${esc(formatiereDatumKurz(eintrag.wiederholung.naechste_faellig))} (alle ${eintrag.wiederholung.intervall_wochen} Wochen)</div>` : ""}
      </div>`;
  }

  overlay.innerHTML = html;
  overlay.hidden = false;
  document.getElementById("detail-zurueck").addEventListener("click", (ev) => {
    ev.preventDefault();
    overlay.hidden = true;
  });
}

function renderPunkteTab() {
  const { faecherListe, notenProFach, schriftlichProFach } = appDaten;
  if (!faecherListe.length) {
    document.getElementById("tab-punkte").innerHTML = `<div class="leer-hinweis">Keine Fächer gefunden.</div>`;
    return;
  }

  const html = faecherListe
    .map((fach) => {
      const schriftlichInfo = schriftlichProFach[fach];
      const muendlicheListe = (notenProFach[fach] || { muendlich: [] }).muendlich;
      const muendlichPunkte = muendlicheListe.length ? muendlicheListe[muendlicheListe.length - 1].punkte : null;
      const schriftlichAvg = schriftlichInfo ? schriftlichInfo.durchschnitt : null;
      const gesamt = berechneGesamtpunktzahl(fach, schriftlichAvg, muendlichPunkte);

      return `
        <div class="karte">
          <div class="fach">${esc(fach)}</div>
          <div class="punkte-zeile">
            <span class="label">Schriftlich${schriftlichInfo ? ` (${schriftlichInfo.anzahl} Werte)` : ""}</span>
            <span>${schriftlichAvg !== null ? schriftlichAvg.toFixed(1) : "-"}</span>
          </div>
          <div class="punkte-zeile">
            <span class="label">Mündlich</span>
            <span>${muendlichPunkte !== null ? muendlichPunkte : "-"}</span>
          </div>
          <div class="punkte-zeile">
            <span class="label">Gesamt</span>
            <span class="punkte-gesamt">${gesamt !== null ? gesamt.toFixed(1) : "Noch unvollständig"}</span>
          </div>
        </div>`;
    })
    .join("");

  document.getElementById("tab-punkte").innerHTML = `<div class="karten-liste">${html}</div>`;
}

function renderWiederholenTab() {
  const { wiederholungen } = appDaten;
  const karteHtml = (e) => `
    <div class="karte">
      <div class="fach-zeile">
        <span class="fach">${esc(e.fach)}</span>
        <span class="badge badge-${esc(klausurFarbstufe(e.tage_bis))}">${e.tage_bis} Tag(e)</span>
      </div>
      <div class="titel">${esc(e.thema)}</div>
      <div class="deadline">aus: ${esc(e.klausur_titel)} &middot; damals: ${esc(e.status_damals)}</div>
    </div>`;

  let html = "";
  html += abschnittHtml("Überfällig", wiederholungen.ueberfaellig, karteHtml, { klasseZusatz: "abschnitt-ueberfaellig" });
  html += abschnittHtml("Diese Woche fällig", wiederholungen.diese_woche, karteHtml);
  html += abschnittHtml("Kommt bald", wiederholungen.kommt_bald, karteHtml);

  if (!html) html = `<div class="leer-hinweis">Keine fälligen Wiederholungen.</div>`;
  document.getElementById("tab-wiederholen").innerHTML = html;
}

// ===========================================================================
// UI-STEUERUNG (Login-Bereich <-> Inhalt, Tabs)
// ===========================================================================

function zeigeAnmeldeAnsicht() {
  document.getElementById("anmelde-bereich").hidden = false;
  document.getElementById("inhalt-bereich").hidden = true;
  document.getElementById("tabs").hidden = true;
  document.getElementById("header-aktionen").hidden = true;
}

async function aufAnmeldungReagieren() {
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
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-inhalt").forEach((t) => (t.hidden = true));
      document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
    });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  initAuth();
  initTabs();

  document.getElementById("anmelden-btn").addEventListener("click", () => {
    document.getElementById("anmelde-fehler").hidden = true;
    localStorage.removeItem("dashboard_abgemeldet");
    autoLoginVersuch = false;
    tokenClient.requestAccessToken();
  });

  document.getElementById("aktualisieren-btn").addEventListener("click", () => {
    ladeAlleDaten().catch((e) => {
      console.error(e);
      setStatus(`Fehler: ${e.message}`);
    });
  });

  document.getElementById("abmelden-btn").addEventListener("click", () => {
    if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
    clearTimeout(erneuerungsTimer);
    localStorage.setItem("dashboard_abgemeldet", "1");
    accessToken = null;
    appDaten = null;
    zeigeAnmeldeAnsicht();
  });
});

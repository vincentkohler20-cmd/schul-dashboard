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

// Sucht eine (Nicht-Ordner-)Datei per Name in einem Ordner. Gibt null
// zurueck statt zu werfen, wenn es sie (noch) nicht gibt.
async function driveFindFileByName(name, parentId) {
  const q = `name='${qEscape(name)}' and '${parentId}' in parents and mimeType!='${FOLDER_MIME}' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id, name)", pageSize: "5" });
  const data = await driveFetchJson(`${DRIVE_API}?${params.toString()}`);
  return data.files && data.files.length ? data.files[0] : null;
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
    if (klausur) klausuren.push(klausur);
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
      const bezeichnung = String(eintrag.bezeichnung || "").trim();
      const punkte = Number(eintrag.punkte);
      const datumRoh = eintrag.datum instanceof Date ? eintrag.datum.toISOString().slice(0, 10) : String(eintrag.datum ?? "").trim();
      const datum = /^\d{4}-\d{2}-\d{2}$/.test(datumRoh) ? datumRoh : null;
      if (bezeichnung && Number.isFinite(punkte)) ergebnis.push({ bezeichnung, punkte, datum });
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

// Primaer die feste Ordner-ID. Nur wenn die nicht erreichbar ist (geloescht,
// im Papierkorb, keine Rechte): Namenssuche, bei mehreren Treffern der
// zuletzt geaenderte Ordner plus sichtbarer Hinweis.
async function findeVaultOrdner() {
  try {
    const params = new URLSearchParams({ fields: "id, name, mimeType, trashed" });
    const ordner = await driveFetchJson(`${DRIVE_API}/${VAULT_FOLDER_ID}?${params.toString()}`);
    if (ordner && ordner.mimeType === FOLDER_MIME && !ordner.trashed) {
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

function renderAlles() {
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
    return `<li class="zeile"><span class="zeile-text"><span class="zeile-titel">${esc(a.titel)}</span></span><span class="faellig ${klasse}">${esc(faellig)}</span></li>`;
  }).join("");
  const mehr = eintraege.length > 6 ? `<p class="karte-fuss">+ ${eintraege.length - 6} weitere im Bereich Aufgaben</p>` : "";
  return karteHtml("Aufgaben", `<ul class="liste">${zeilen}</ul>${mehr}<p class="karte-fuss">Abhaken am Desktop</p>`, { meta: esc(teile.join(" · ") || "nichts dringend") });
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
    <li class="zeile aufgabe-zeile${erledigt ? " erledigt" : ""}">
      <span class="punkt ${erledigt ? "ton-niedrig" : ton(a.prioritaet)}" title="${esc(PRIORITAET_TEXT[a.prioritaet] || "")}"></span>
      <div class="zeile-text">
        <div class="zeile-titel">${esc(a.titel)}</div>
        <div class="zeile-meta">${fach}<span class="${ueberfaellig ? "ton-hoch" : ""}">${esc(formatiereDatumLang(a.deadline))}</span> · ${esc(PRIORITAET_TEXT[a.prioritaet] || a.prioritaet)}</div>
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
  let html = listenKarteHtml("Überfällig", aufgaben.ueberfaellig, (a) => aufgabeKarteHtml(a, { ueberfaellig: true }), { titelKlasse: "ton-hoch" });
  html += listenKarteHtml("Heute fällig", aufgaben.heute, (a) => aufgabeKarteHtml(a), { leerText: "Nichts heute fällig." });
  html += listenKarteHtml("Diese Woche", aufgaben.diese_woche, (a) => aufgabeKarteHtml(a), { leerText: "Nichts diese Woche fällig." });
  html += listenKarteHtml("Später", aufgaben.spaeter, (a) => aufgabeKarteHtml(a), { leerText: "Keine weiteren Aufgaben." });

  if (aufgaben.abgeschlossen.length) {
    html += `
      <section class="karte">
        <details>
          <summary class="karte-kopf"><h2>${chevron()} Vergangene Aufgaben <span class="zaehler">${aufgaben.abgeschlossen.length}</span></h2></summary>
          <ul class="liste">${aufgaben.abgeschlossen.map((a) => aufgabeKarteHtml(a, { erledigt: true })).join("")}</ul>
        </details>
      </section>`;
  }

  document.getElementById("tab-aufgaben").innerHTML = `<div class="stapel">${html}</div>`;
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
        ${k.fehleranalyse.length || k.korrekturQuelle ? `<div class="vergangen-extra">${fehleranalyseHtml(k)}</div>` : ""}
      </li>`;
  }
  const farbstufe = typ === "abzuhaken" ? "hoch" : klausurFarbstufe(k.tage_bis);
  return `
    <li><button type="button" class="zeile" data-klausur-index="${index}" data-klausur-typ="${typ}">
      <span class="punkt ${ton(farbstufe)}"></span>
      <span class="zeile-text"><span class="zeile-titel">${esc(k.fach)} · ${esc(k.titel)}</span><span class="zeile-meta">${meta}</span></span>
      <span class="zahl ${ton(farbstufe)}">${esc(countdownText(k.tage_bis))}</span>
    </button></li>`;
}

function renderKlausurenTab() {
  const { klausurenAnstehend, klausurenAbzuhaken, klausurenAbgeschlossen } = appDaten;
  const listen = { anstehend: klausurenAnstehend, abzuhaken: klausurenAbzuhaken, abgeschlossen: klausurenAbgeschlossen };
  let html = "";

  // Nur lesend: abhaken geht bewusst nur am Desktop (Mobile schreibt nie).
  if (klausurenAbzuhaken.length) {
    html += listenKarteHtml(`Geschrieben?`, klausurenAbzuhaken, (k, i) => klausurKarteHtml(k, i, "abzuhaken"),
      { titelKlasse: "ton-hoch", meta: "am Desktop abhaken" });
  }
  html += listenKarteHtml("Anstehende Klausuren", klausurenAnstehend, (k, i) => klausurKarteHtml(k, i, "anstehend"),
    { leerText: "Keine anstehenden Klausuren." });
  html += `
    <section class="karte">
      <details open>
        <summary class="karte-kopf"><h2>${chevron()} Vergangene Klausuren <span class="zaehler">${klausurenAbgeschlossen.length}</span></h2><span class="karte-meta">Punkte am Desktop</span></summary>
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
  let countdown = countdownText(tage);
  if (tage < 0 && k.status !== "abgeschlossen") countdown += " – am Desktop abhaken";
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
        </div>
      </section>`;
  }).join("");

  document.getElementById("tab-punkte").innerHTML = `<div class="raster">${html}</div>`;
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

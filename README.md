# Mobiles Schul-Dashboard

Rein clientseitige WebApp, die deinen Obsidian-Vault direkt aus deinem
Google Drive liest und Aufgaben, Klausuren, Punkte und Lernbegleiter anzeigt.
Seit 2026-09-27 kann sie auch **schreiben** (siehe „Schreibzugriff“ unten):
Aufgaben abhaken/wieder öffnen und neu anlegen, Klausuren als geschrieben
markieren/wieder öffnen und Punkte eintragen, Noten hinzufügen/bearbeiten/
löschen. Timer, „Minuten nachtragen“ und Lernstand-Status bleiben Desktop-only.

## Einmaliges Setup (ca. 5–10 Minuten)

### 1. Google Cloud Projekt + Drive API

1. Gehe zu [console.cloud.google.com](https://console.cloud.google.com/) und melde dich mit deinem Google-Konto an (dem, das auch den Vault-Ordner besitzt).
2. Oben links: neues Projekt erstellen (z.B. Name "Schul-Dashboard-Mobil").
3. Menü → "APIs & Dienste" → "Bibliothek" → nach **"Google Drive API"** suchen → **Aktivieren**.

### 2. OAuth-Consent-Screen

1. "APIs & Dienste" → "OAuth-Zustimmungsbildschirm".
2. Nutzertyp: **"Extern"** wählen (ist trotzdem nur für dich nutzbar, siehe unten).
3. App-Name (z.B. "Schul-Dashboard"), deine E-Mail als Support-E-Mail eintragen, speichern.
4. Scopes-Schritt: **„Scopes hinzufügen oder entfernen“** → `https://www.googleapis.com/auth/drive` (Google Drive, „Alle Dateien ansehen, bearbeiten, erstellen und löschen“) ergänzen → Aktualisieren → Speichern. Die App bleibt im Testing-Modus, ein Google-Review ist nicht nötig. (Bis 2026-09 stand hier nur `drive.readonly`.)
5. **Testnutzer** hinzufügen: trage deine eigene Google-Adresse ein. Damit bleibt die App im "Testing"-Status — kein Google-Review nötig, funktioniert aber nur für die eingetragenen Testnutzer (also dich).

### 3. OAuth-Client-ID erstellen

1. "APIs & Dienste" → "Anmeldedaten" → "+ Anmeldedaten erstellen" → **"OAuth-Client-ID"**.
2. Anwendungstyp: **"Weboberfläche"**.
3. Name frei wählbar.
4. **Autorisierte JavaScript-Quellen**: hier trägst du die URL ein, unter der die App später erreichbar ist, z.B. `https://DEINNAME.github.io`. Für lokale Tests kannst du zusätzlich `http://localhost:8000` eintragen.
   **Autorisierte Weiterleitungs-URIs** (seit 2026-09-27 Pflicht, die App meldet sich per Weiterleitung an): die volle App-Adresse **mit** Pfad und abschließendem `/`, z.B. `https://DEINNAME.github.io/schul-dashboard/` (für lokale Tests ggf. `http://localhost:8000/`).
5. Erstellen → die **Client-ID** (endet auf `.apps.googleusercontent.com`) kopieren.

### 4. Client-ID eintragen

Öffne [config.js](config.js) und trage die Client-ID bei `OAUTH_CLIENT_ID` ein.

### 5. Hosting auf GitHub Pages

1. Auf [github.com](https://github.com/) ein kostenloses Konto anlegen (falls noch nicht vorhanden).
2. "New repository" → Name frei wählbar (z.B. `schul-dashboard`), **Public**, ohne README (haben wir schon) → erstellen.
3. Im neuen Repo: "Add file" → "Upload files" → alle Dateien und den `icons/`-Ordner aus diesem Verzeichnis (`index.html`, `style.css`, `app.js`, `config.js`, `manifest.json`, `README.md`, `icons/`) per Drag & Drop hochladen → "Commit changes". Bei jedem späteren Update reicht es, die geänderten Dateien erneut hochzuladen — GitHub überschreibt automatisch.
4. Repo → "Settings" → "Pages" → unter "Build and deployment": Branch `main`, Ordner `/ (root)` → Speichern.
5. Nach ca. 1 Minute ist die App unter `https://DEINNAME.github.io/schul-dashboard/` erreichbar.
6. Falls diese URL nicht exakt der in Schritt 3 (Autorisierte JavaScript-Quellen) entspricht: in der Google Cloud Console nachtragen — Achtung, dort zählt nur der **Ursprung** ohne Pfad, also `https://DEINNAME.github.io` (ohne `/schul-dashboard/`).

### 6. Testen

App-URL auf dem Handy/iPad öffnen → "Mit Google anmelden" → deinen Account wählen → Warnung "Diese App wurde nicht von Google überprüft" erscheint (normal bei Testing-Apps) → "Erweitert" → "Zu [App-Name] (unsicher) wechseln" → Zugriff erlauben.

Tipp: Auf dem iPhone/iPad kannst du die Seite über Safari → Teilen → "Zum Home-Bildschirm" wie eine eigene App ablegen — dabei wird automatisch das Dashboard-Icon (dasselbe wie bei der Desktop-Verknüpfung) sowie der Name "Dashboard" übernommen, und die Seite öffnet sich ohne Browser-Adressleiste wie eine echte App.

## Wie es funktioniert

- Beim Anmelden fordert die App per [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/overview) ein Zugriffstoken mit dem Scope aus `DRIVE_SCOPE` in `app.js` an. Schreibfunktionen werden nur freigeschaltet, wenn das Token den vollen Scope `drive` (`SCHREIB_SCOPE`) hat; sonst bleibt die App lesend und zeigt „Bitte einmal neu anmelden, um Schreibrechte zu erteilen“ mit einem Button, der die Zustimmung einmalig neu anfragt.
- Die App sucht deinen Vault-Ordner (Name aus `config.js`, Standard `ObsidianVault`) in deinem Drive, dann darin `Aufgaben/`, `Schule/Klausuren/`, `Schule/Noten/`.
- Alle `.md`-Dateien werden **parallel** (nicht nacheinander) geladen und im Browser geparst (Frontmatter via [js-yaml](https://github.com/nodeca/js-yaml), fest Version 4.1.0) — dieselbe Logik wie im lokalen [dashboard.py](../obsidian-dashboard/dashboard.py).
- "🔄 Aktualisieren" lädt alle Daten neu (kein automatisches Polling, um die Drive-API-Quota zu schonen).

### Angemeldet bleiben

Das Zugriffstoken läuft nach ca. 1 Stunde ab. Seit 2026-09-27 meldet sich die App deshalb per **Weiterleitung** statt per Popup an: Beim Öffnen springt die Seite kurz zu Google (`prompt=none`, ohne Oberfläche) und mit frischem Token zurück — ohne Tippen, solange du im Browser bei Google angemeldet bist und schon einmal zugestimmt hast. (Vorher lief das über ein Popup, das Safari ohne Tap blockiert — deshalb musste man sich fast jedes Mal neu anmelden.) Kurz vor Ablauf bzw. beim Zurückkehren nach einer Pause wiederholt sie das automatisch, aber nie, während ein Dialog offen ist, gespeichert oder in ein Feld getippt wird.

- Das Token steht nur kurz im URL-Fragment, wird sofort entfernt und **nirgends gespeichert**; ein zufälliger `state`-Wert schützt gegen untergeschobene Antworten. Gespeichert wird nur deine Google-Adresse (`login_hint`, damit es auch mit mehreren Google-Konten ohne Kontoauswahl klappt).
- Klappt der stille Versuch nicht (bei Google abgemeldet, Cookies gelöscht), erscheint der normale „Mit Google anmelden“-Button; höchstens ein stiller Versuch pro Minute, damit es keine Weiterleitungs-Schleife gibt.
- Die Home-Bildschirm-App hat auf iOS eigene Cookies, getrennt von Safari: dort musst du dich einmal bei Google anmelden, danach klappt es auch dort still.

Über "Abmelden" (⏻-Icon) wird das Token bei Google widerrufen und das absichtlich respektiert: danach versucht die App beim nächsten Öffnen bewusst **nicht** mehr automatisch, dich wieder einzuloggen.

## Schreibzugriff (seit 2026-09-27)

**Voraussetzung:** In `app.js` muss `DRIVE_SCOPE` auf `https://www.googleapis.com/auth/drive` stehen und der Scope im OAuth-Consent-Screen eingetragen sein (Setup Schritt 2.4). Beim ersten Start danach einmal „Neu anmelden“ tippen und zustimmen.

- **Bestätigung:** Jede Änderung zeigt vorher einen Dialog, der konkret sagt, was passiert („Aufgabe ‚…‘ als erledigt markieren?“, „Punkte für Chemie Klausur-1 auf 11 setzen?“, „Note … löschen? Das lässt sich nicht rückgängig machen.“). Abbrechen, Esc oder Tippen daneben ändert nichts; ein Haken springt dann zurück.
- **Eine zentrale Schreibfunktion** (`schreibeDatei()` in `app.js`): Datei direkt vor der Änderung frisch laden, Änderung auf den frischen Text anwenden, unmittelbar vor dem Hochladen die Revision (`headRevisionId`) erneut prüfen, dann per `PATCH …/upload/drive/v3/files/{id}?uploadType=media` hochladen. Neue Dateien (neue Monats-Aufgabendatei, fehlende `Noten.md`) über `erstelleDatei()`.
- **Konfliktschutz:** Hat sich die Datei seit dem letzten Laden geändert (Obsidian am PC, Drive for Desktop, 14-Uhr-Aufgabe, WebUntis-Bot …), wird **nicht** geschrieben: „Datei wurde gerade woanders geändert – Daten neu geladen, bitte nochmal versuchen“.
- **Zeilengenau:** Es ändert sich nur die betroffene Zeile bzw. der betroffene Abschnitt — Zeilenenden (CRLF/LF) und ein evtl. BOM bleiben erhalten. Die Änderungen entsprechen byte-genau den Desktop-Endpunkten (`/api/aufgabe-status`, `/api/klausur-status`, `/api/klausur-punkte`, Noten-Endpunkte); `Noten.md` wird wie am Desktop per YAML neu erzeugt (gleiche Schreibweise wie PyYAML).
- **Selbstbeschränkung auf den Vault:** Der `drive`-Scope erlaubt technisch Schreibzugriff auf den ganzen Drive. Die App beschreibt aber nur Dateien, deren ID beim Laden aus dem Vault-Ordner (`VAULT_FOLDER_ID` und Unterordner) kam, und legt neue Dateien nur in bekannten Vault-Ordnern an.
- **Neue Aufgaben** landen als neuer Abschnitt am Ende von `Aufgaben/Aufgaben-JJJJ-MM.md` des Deadline-Monats (Datei wird bei Bedarf angelegt). Titel, die mit „Klausur“ beginnen, werden abgelehnt (Klausuren gehören in den Klausuren-Tab). Detail-Notizen in `Schule/Hausaufgaben/` legt die App nicht an.

### Auf fremden Geräten abmelden

Mit Schreibrechten kann jeder, der die geöffnete App in die Hände bekommt, deinen Vault ändern (und das Token erlaubt technisch Zugriff auf deinen ganzen Drive). Auf fremden/geteilten Geräten (z.B. Schul-iPad eines anderen) nach der Nutzung **immer über ⏻ abmelden** — das widerruft das Token und verhindert den automatischen Wieder-Login.

## Falls sich der Vault nochmal verschiebt

Die App findet den Vault-Ordner über seinen **Namen** (`ObsidianVault`), nicht über einen festen Pfad — ein erneuter Umzug zwischen Cloud-Anbietern (wie schon 2026-07-23 und 2026-08-01) bricht die App also nicht, solange der Ordnername gleich bleibt und weiterhin mit demselben Google-Konto verknüpft ist.

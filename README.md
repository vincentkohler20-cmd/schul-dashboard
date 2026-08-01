# Mobiles Schul-Dashboard (nur lesen)

Rein clientseitige WebApp, die deinen Obsidian-Vault direkt aus deinem
Google Drive liest (OAuth mit Nur-Lese-Scope) und Aufgaben, Klausuren,
Punkte und Wiederholungen anzeigt. **Es gibt keinen Schreib-Code** — nichts
lässt sich aus dieser App heraus abhaken oder ändern.

## Einmaliges Setup (ca. 5–10 Minuten)

### 1. Google Cloud Projekt + Drive API

1. Gehe zu [console.cloud.google.com](https://console.cloud.google.com/) und melde dich mit deinem Google-Konto an (dem, das auch den Vault-Ordner besitzt).
2. Oben links: neues Projekt erstellen (z.B. Name "Schul-Dashboard-Mobil").
3. Menü → "APIs & Dienste" → "Bibliothek" → nach **"Google Drive API"** suchen → **Aktivieren**.

### 2. OAuth-Consent-Screen

1. "APIs & Dienste" → "OAuth-Zustimmungsbildschirm".
2. Nutzertyp: **"Extern"** wählen (ist trotzdem nur für dich nutzbar, siehe unten).
3. App-Name (z.B. "Schul-Dashboard"), deine E-Mail als Support-E-Mail eintragen, speichern.
4. Scopes-Schritt: kannst du überspringen/leer lassen (wird im Code angefragt).
5. **Testnutzer** hinzufügen: trage deine eigene Google-Adresse ein. Damit bleibt die App im "Testing"-Status — kein Google-Review nötig, funktioniert aber nur für die eingetragenen Testnutzer (also dich).

### 3. OAuth-Client-ID erstellen

1. "APIs & Dienste" → "Anmeldedaten" → "+ Anmeldedaten erstellen" → **"OAuth-Client-ID"**.
2. Anwendungstyp: **"Weboberfläche"**.
3. Name frei wählbar.
4. **Autorisierte JavaScript-Quellen**: hier trägst du die URL ein, unter der die App später erreichbar ist, z.B. `https://DEINNAME.github.io`. Für lokale Tests kannst du zusätzlich `http://localhost:8000` eintragen.
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

- Beim Anmelden fordert die App per [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/overview) ein Zugriffstoken mit dem Scope `drive.readonly` an — das erlaubt **nur Lesen**, keine Schreib-API-Aufrufe sind damit überhaupt möglich.
- Die App sucht deinen Vault-Ordner (Name aus `config.js`, Standard `ObsidianVault`) in deinem Drive, dann darin `Aufgaben/`, `Schule/Klausuren/`, `Schule/Noten/`.
- Alle `.md`-Dateien werden **parallel** (nicht nacheinander) geladen und im Browser geparst (Frontmatter via [js-yaml](https://github.com/nodeca/js-yaml)) — dieselbe Logik wie im lokalen [dashboard.py](../obsidian-dashboard/dashboard.py), nur ohne die Schreib-Funktionen.
- "🔄 Aktualisieren" lädt alle Daten neu (kein automatisches Polling, um die Drive-API-Quota zu schonen).

### Angemeldet bleiben

Das Zugriffstoken läuft nach ca. 1 Stunde ab. Die App versucht deshalb bei jedem Öffnen automatisch und unsichtbar, ein neues Token zu holen (ohne dass du etwas tippen musst) — das klappt, solange du auf dem Gerät noch bei Google angemeldet bist und der Zugriff schon einmal erlaubt wurde. Zusätzlich holt sie sich während einer laufenden Sitzung selbstständig rechtzeitig vor Ablauf ein neues Token, damit du bei aktiver Nutzung nicht mittendrin rausfliegst.

**Ehrliche Einschränkung:** Browser blockieren automatisch geöffnete Login-Popups grundsätzlich (Popup-Blocker-Schutz) — das lässt sich bei einer rein clientseitigen App ohne eigenen Server nicht zu 100% umgehen. In der Praxis heißt das: meistens bleibst du eingeloggt, aber gelegentlich (z.B. nach längerer Pause oder je nach Browser/Gerät) siehst du kurz wieder den "Mit Google anmelden"-Button — ein Tap reicht dann aber, da die eigentliche Erlaubnis schon erteilt ist (keine erneute Rechte-Abfrage).

Über "Abmelden" (⏻-Icon) wird das absichtlich respektiert: danach versucht die App beim nächsten Öffnen bewusst **nicht** mehr automatisch, dich wieder einzuloggen.

## Falls sich der Vault nochmal verschiebt

Die App findet den Vault-Ordner über seinen **Namen** (`ObsidianVault`), nicht über einen festen Pfad — ein erneuter Umzug zwischen Cloud-Anbietern (wie schon 2026-07-23 und 2026-08-01) bricht die App also nicht, solange der Ordnername gleich bleibt und weiterhin mit demselben Google-Konto verknüpft ist.

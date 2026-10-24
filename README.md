# Helm Camera Streams

Server und Handy-App für die Bluetooth-Helmkamera (ESP32-CAM, Firmware aus
[ESP32-Flash](https://github.com/fredy060795/ESP32-Flash)).

```
Helmkamera ──Bluetooth──▶ Handy (Browser, bleibt im Internet) ──HTTPS──▶ dein Server ──▶ ATAK / WinTAK / Admin
```

- **Ein Link pro Stream:** `https://<domain>/<benutzer>/<streamId>` – diesen Link in ATAK/WinTAK als Videoquelle eintragen.
  Jeder Stream hat eine eigene zufällige Stream-ID, ein Benutzer kann mehrere Streams haben. So gibt es keine Konflikte,
  auch wenn viele Streams gleichzeitig laufen.
- **QR-Code für den Benutzer:** öffnet die Handy-App. Kamera per Bluetooth verbinden, „Stream starten“ – fertig.
- **Admin-Fenster** (eigene Domain möglich): Login, Passwort-Reset per E-Mail (SMTP), alle Streams mit Status, Link
  und QR-Code. „Ansehen“ öffnet frei bewegliche Video-Fenster (verschieben, Größe ändern, maximieren, minimieren,
  schließen). „Alle Streams stoppen“, einzelne Streams stoppen/freigeben, Handy **rauswerfen** oder Stream **löschen**.

## Links pro Stream

| Link | Format | Hinweis |
|---|---|---|
| `https://<domain>/<benutzer>/<streamId>` | MJPEG | Hauptlink, geringe Verzögerung, kein ffmpeg nötig |
| `https://<domain>/<benutzer>/<streamId>/index.m3u8` | HLS (H.264) | braucht ffmpeg auf dem Server, ca. 4–8 s Verzögerung; **für OpenTAKServer** |
| `https://<domain>/<benutzer>/<streamId>/stream.ts` | MPEG-TS (H.264) | braucht ffmpeg, fortlaufender HTTP-Stream |
| `https://<domain>/<benutzer>/<streamId>/snapshot.jpg` | JPEG | letztes Bild |

Welches Format dein ATAK/WinTAK am besten abspielt, am besten mit einem laufenden Stream ausprobieren – alle drei
liefern dasselbe Bild. Die Bildrate kommt von der Kamera über Bluetooth (bei 320x240 etwa 2–5 Bilder/s).

## In OpenTAKServer eintragen

OpenTAKServer nutzt MediaMTX. MediaMTX kann eine fremde Quelle abholen, aber kein MJPEG – deshalb dort den
**HLS-Link** verwenden (dafür muss ffmpeg auf dem Streams-Server installiert sein, im Docker-Image ist es dabei):

1. OpenTAKServer → **Videostreams** → **Add Video**.
2. Als Pfad einen Namen wählen (z. B. `helm_mueller`), als **Quelle** den Link
   `https://<domain>/<benutzer>/<streamId>/index.m3u8` eintragen.
3. Sobald das Handy sendet, steht der Stream bei OpenTAKServer auf „Bereit“ und ist in ATAK/WinTAK über die
   üblichen OTS-Links (RTSP/WebRTC/HLS) verfügbar.

## Bild ausrichten (jeder Helm ist anders montiert)

Ausrichten kann der Nutzer am Handy selbst (Karte „Ausrichten“) und der Admin im Ansehen-Fenster – beide sehen dieselbe Einstellung.

- **Ansehen** → **∠ Ausrichten**: Regler für jeden Winkel von 0 bis 359,5° (im Uhrzeigersinn), Feinschritte
  −90/−5/−1/+1/+5/+90°, 0°, **Spiegeln** und bei schrägen Winkeln **Füllen** (Rand wird abgeschnitten, keine schwarzen
  Ecken) oder **Ganzes Bild** (schwarze Ecken). Das Ergebnis ist nach etwa einer Sekunde im Live-Bild zu sehen.
- In der Liste steht der Winkel jedes Streams und kann dort auch direkt eingetippt werden.
- **Einstellungen → Bild drehen:** Grundwinkel für neue Streams (z. B. 90°, wenn die Kamera quer im Gehäuse liegt),
  optional auf alle bestehenden Streams anwenden.

Das Handy dreht jedes Bild, bevor es gesendet wird. Dadurch liefern alle Links (MJPEG, HLS, MPEG-TS, Einzelbild)
und damit auch OpenTAKServer/ATAK schon das ausgerichtete Bild – beim Import muss nichts mehr angepasst werden.
Ab 45° wird das Bild hochkant; HLS/MPEG-TS starten beim Wechsel quer/hoch kurz neu.

## Ablauf

1. Im Admin-Fenster oben den **QR-Code für alle Nutzer** groß anzeigen oder drucken (ein Code für alle).
2. Der Nutzer scannt ihn, gibt **Name** und **Einheit** ein → er bekommt automatisch einen eigenen Stream
   (z. B. `https://<domain>:5036/max-mueller/qugzu48s8q`). Das Handy merkt sich die Anmeldung.
3. Quelle wählen: **Handy-Kamera** (Rückkamera) oder **Helmkamera (Bluetooth)** → **Stream starten**.
4. Der Stream erscheint sofort in der Admin-Liste – dort ausrichten, Link für ATAK/OpenTAKServer kopieren,
   stoppen, rauswerfen oder löschen.

Bildschirm des Handys anlassen, App im Vordergrund lassen (sonst stoppt das Handy Kamera und Bluetooth).

**Bildgröße** legt der Admin fest – pro Stream in der Liste oder im Ansehen-Fenster, Standard für neue Streams unter
Einstellungen (vorbelegt **160x120, sehr schnell**). Auswahl: 160x120, 320x240, 640x480, 1280x720 (nur Handy-Kamera
sinnvoll). Änderungen gelten sofort am Handy, auch während des Streams; der Nutzer sieht die Bildgröße nur an.

**Handy-Kamera:** geht in jedem Handy-Browser über HTTPS – auch Safari am iPhone. Etwa 5 Bilder/s. Unter **Kamera** lassen sich alle Kameras auswählen, die das Gerät meldet: Rück-/Frontkamera
und angesteckte **USB/UVC-Kameras** (Windows/macOS/Linux, iPad mit USB-C, manche Android-Geräte; iPhone nicht).
Das Handy merkt sich die Auswahl.

**Ausrichten am Handy:** Nach dem Verbinden zeigt die Seite eine Vorschau und die Karte **Ausrichten**
(⟲/⟳ 90°, ±5°, ±1°, 0°, Spiegeln). Die Vorschau zeigt genau das Bild, das gesendet wird – also vor
„Stream starten“ ausrichten. Die Einstellung gilt für Handy- und Helmkamera, wird am Server gespeichert und ist im
Admin sichtbar; der Admin kann sie dort jederzeit ändern.

**Helmkamera (Bluetooth):** Android mit **Chrome** (nicht Samsung Internet/Firefox). Auf dem iPhone kann kein Browser
Bluetooth – dort die kostenlose App **Bluefy** verwenden; die Seite zeigt den Weg („Link für Bluefy kopieren“).

**Adresse des Servers** (im Admin oben): legt fest, welche Adresse in QR-Codes und allen Links steht, z. B.
`https://tak.example.com:5036`. Leer bzw. „Automatisch“ = `PUBLIC_URL` oder die aufgerufene Adresse. Die Einstellung
gilt vor `PUBLIC_URL` und bleibt nach einem Neustart erhalten.

**Selbst-Anmeldung erlaubt** (Schalter oben im Admin) sperrt bei Bedarf neue Anmeldungen; laufende Streams bleiben.
Wer gelöscht wird, kann sich mit dem allgemeinen QR-Code neu anmelden – soll das nicht gehen, die Selbst-Anmeldung
sperren. Optional lassen sich Streams weiterhin manuell mit eigenem QR-Code anlegen.

## Admin

- Erster Login: **admin / admin123**. Danach muss sofort ein eigener Benutzername und ein neues Passwort festgelegt
  werden (vorher ist nichts anderes möglich).
- **Einstellungen:** Admin-E-Mail und SMTP-Server eintragen, „Test-Mail senden“. Danach funktioniert
  „Passwort vergessen?“ auf der Login-Seite: Der Link zum Zurücksetzen kommt an die Admin-E-Mail und gilt 1 Stunde.
- Nach 10 falschen Passwörtern ist der Login für diese IP 15 Minuten gesperrt.

## Test am Windows-PC

1. Repository herunterladen (**Code → Download ZIP**) und entpacken.
2. **start.bat** doppelklicken. Fehlt Node.js, bietet das Fenster die Installation an (winget); danach start.bat
   erneut starten. Beim ersten Start werden die Pakete installiert (braucht Internet).
3. Beim ersten Start erzeugt start.bat **eigene HTTPS-Zertifikate** (Test-CA in `data\certs`) und trägt die
   Test-CA in Windows ein – Windows fragt dabei nach, **„Ja“** wählen. Chrome und Edge vertrauen der Seite dann ohne
   Warnung (falls doch noch eine kommt: Browser neu starten).
4. Das Admin-Fenster öffnet sich unter `https://<IP-des-PCs>:5036/admin/` (erster Login admin / admin123).
   Fragt Windows nach der Firewall, „Zugriff zulassen“ wählen.
5. Stream anlegen → **QR / Links**. Dort gibt es zusätzlich den QR-Code **„Zertifikat fürs Handy“**:
   einmal pro Handy scannen, Datei laden und installieren
   - Android: Einstellungen → Sicherheit → Verschlüsselung & Anmeldedaten → Zertifikat installieren →
     CA-Zertifikat → Datei wählen
   - iPhone: Profil laden, unter Einstellungen → Allgemein → VPN & Geräteverwaltung installieren und unter
     Info → Zertifikatsvertrauenseinstellungen „volles Vertrauen“ einschalten
6. Danach den QR-Code für alle Nutzer scannen → anmelden → Kamera wählen → Stream starten.

Lädt die Seite am Handy nicht: Handy im selben WLAN (kein Gäste-WLAN, keine mobilen Daten)? start.bat gibt Port 5036 und
Node.js in der Windows-Firewall frei und entfernt Sperr-Regeln für Node.js (fragt einmal nach Administrator-Rechten).
Klappt das nicht, **firewall.bat** doppelklicken und „Ja“ wählen (Details in `firewall.log`); zeigt das Fenster weitere
Adressen des PCs an, eine davon probieren.

Die Test-CA bleibt erhalten; ändert sich die IP des PCs, wird nur das Server-Zertifikat neu erzeugt (Handys müssen
nichts neu installieren). Läuft noch ein alter Server auf Port 5036, beendet start.bat ihn automatisch.
Für HLS/MPEG-TS am PC ffmpeg installieren (`winget install Gyan.FFmpeg`) oder nach `tools\ffmpeg\bin\` legen.
Alle Meldungen stehen zusätzlich in `start.log`.

Die Test-Zertifikate sind nur für den PC-Test gedacht. Auf dem Server im Internet ein echtes Zertifikat
verwenden (Let's Encrypt, siehe unten).

## Installation auf dem Server

### Mit Docker (empfohlen) – Port 5036

Der Server läuft auf **Port 5036** mit HTTPS (nötig für Kamera und Bluetooth im Handy-Browser). Am einfachsten mit dem
Zertifikat, das auf dem Server schon vorhanden ist (z. B. Let's Encrypt des TAK-Servers):

1. In `docker-compose.yml` `tak.example.com` durch die eigene Domain ersetzen (bei `PUBLIC_URL` und den
   Zertifikatspfaden).
2. Port 5036 in der Firewall freigeben.
3. `docker compose up -d`
4. `https://<domain>:5036/admin/` öffnen, mit admin / admin123 anmelden.

Stream-Links sehen dann so aus: `https://<domain>:5036/<benutzer>/<streamId>`. Erneuerte Zertifikate werden
automatisch übernommen.

Sind die Ports 80/443 frei, kann stattdessen Caddy die Zertifikate holen: `docker compose --profile caddy up -d`
(Domains in `deploy/Caddyfile` eintragen, `TLS_CERT`/`TLS_KEY` in `docker-compose.yml` entfernen).

### Ohne Docker

Voraussetzungen: Node.js 18 oder neuer, ffmpeg (für HLS/MPEG-TS, optional) und ein Zertifikat. Der Dienst
`deploy/helm-camera.service` startet den Server mit HTTPS direkt auf Port 5036; alternativ hinter einem
Reverse-Proxy (Beispiele: `deploy/Caddyfile`, `deploy/nginx.conf`).

```sh
sudo useradd --system helmcam
sudo git clone https://github.com/fredy060795/Wintak_video_streams_ESP32 /opt/helm-camera
cd /opt/helm-camera && sudo npm ci --omit=dev
sudo cp deploy/helm-camera.service /etc/systemd/system/   # Domains darin anpassen
sudo systemctl daemon-reload && sudo systemctl enable --now helm-camera
```

### Einstellungen (Umgebungsvariablen)

| Variable | Bedeutung | Standard |
|---|---|---|
| `PUBLIC_URL` | Öffentliche Adresse für Links, QR-Codes und Reset-Mails, z. B. `https://tak.example.com:5036` – **setzen**, sonst gibt es keine Reset-Mails | aus der Anfrage |
| `ADMIN_HOST` | Admin nur unter dieser Domain erreichbar, z. B. `admin.example.com` | Admin auf jeder Domain |
| `ADMIN_URL` | Adresse für Links in Reset-Mails | aus `PUBLIC_URL` (mit `ADMIN_HOST` als Domain) |
| `PORT` / `BIND` | Port und Adresse des Servers | `5036` / `0.0.0.0` |
| `DATA_DIR` | Datenordner (Admin, SMTP, Streams) | `./data` |
| `FFMPEG_PATH` | Pfad zu ffmpeg | `ffmpeg` |
| `TLS_CERT` / `TLS_KEY` | HTTPS direkt im Server statt Reverse-Proxy | – |
| `TEST_CA_FILE` | nur Test: CA-Datei, die unter `/ca.crt` zum Download angeboten wird (setzt start.bat) | – |
| `TRUST_PROXY` | `1` = X-Forwarded-Header vom Reverse-Proxy auswerten | `1`, mit `TLS_CERT` `0` |

Alle Daten liegen in `DATA_DIR/db.json` (Passwort nur als scrypt-Hash).

## Für Entwickler

```sh
npm install
npm start      # http://localhost:5036/admin/
npm test       # Ende-zu-Ende-Tests (Admin, Handy-WebSocket, MJPEG, HLS/TS, Drehung, Stoppen/Rauswerfen, SMTP-Reset)
```

Handy → Server: WebSocket `wss://<domain>/ws/publish?u=<benutzer>&s=<streamId>&k=<schlüssel>`, jede Binärnachricht
ist ein JPEG. Der Server antwortet mit JSON (`welcome`, `config` mit Drehung, `stats`, `stopped`, `revoked`, `removed`,
`replaced`, `invalid`).
Kamera → Handy: Bluetooth-Protokoll siehe `PROTOCOL.md` im Repository ESP32-Flash.

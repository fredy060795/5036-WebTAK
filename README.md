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

Das Ausrichten macht nur der Admin – der Benutzer scannt nur den QR-Code und startet den Stream.

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

1. Im Admin-Fenster Benutzer eintragen (z. B. `mueller`) → **Neuer Stream**. Es erscheinen QR-Code und Links.
2. QR-Code dem Benutzer geben (anzeigen, drucken oder Bild schicken). Den Stream-Link in ATAK/WinTAK eintragen.
3. Benutzer scannt den QR-Code → Handy-App öffnet sich → **Kamera verbinden** (Helmkamera auswählen) → **Stream starten**.
4. Bildschirm des Handys anlassen, App im Vordergrund lassen (sonst trennt das Handy Bluetooth).

Handy-Browser: **Android mit Chrome**. iPhone: App **Bluefy** (Safari kann kein Bluetooth). Die Seite muss über
**HTTPS** laufen, sonst erlaubt der Browser kein Bluetooth.

Der QR-Code enthält einen geheimen Zugangsschlüssel. **Rauswerfen** erzeugt einen neuen Schlüssel: Das Handy wird
sofort getrennt, der alte QR-Code gilt nicht mehr, der Stream-Link für ATAK bleibt gleich. Pro Stream sendet immer
nur ein Handy; verbindet sich ein zweites mit demselben QR-Code, wird das erste getrennt.

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
3. Das Admin-Fenster öffnet sich unter `http://<IP-des-PCs>:5036/admin/` (erster Login admin / admin123).
   Handys im selben WLAN erreichen den Server unter derselben Adresse; fragt Windows nach der Firewall,
   „Zugriff zulassen“ wählen.
4. Stream anlegen → **QR / Links** → QR-Code mit dem Handy scannen (oder den Link am PC öffnen).

Bluetooth im Browser braucht eigentlich HTTPS. Zum Testen über die PC-IP in Chrome (PC und Android) einmalig
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` öffnen, `http://<IP-des-PCs>:5036` eintragen, auf
„Enabled“ stellen und Chrome neu starten. Am PC selbst geht es auch ohne Flag über `http://localhost:5036`.

Für HLS/MPEG-TS am PC ffmpeg installieren (`winget install Gyan.FFmpeg`) oder nach `tools\ffmpeg\bin\` legen.
Alle Meldungen stehen zusätzlich in `start.log`.

## Installation auf dem Server

### Mit Docker (empfohlen) – Port 5036

Der Server läuft auf **Port 5036** mit HTTPS (nötig für Bluetooth im Handy-Browser). Am einfachsten mit dem
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

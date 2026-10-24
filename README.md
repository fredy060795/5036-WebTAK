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

## Bild drehen (Kamera liegt quer im Gehäuse)

Die Drehung wird pro Stream im Admin-Fenster eingestellt: in der Liste unter **Drehung** oder im Ansehen-Fenster mit
⟲ / ⟳ (90° links/rechts) und ⇋ (spiegeln). Unter **Einstellungen** gibt es eine Standard-Drehung für neue Streams
(optional auf alle bestehenden anwenden).

Das Handy dreht jedes Bild, bevor es gesendet wird. Dadurch liefern alle Links (MJPEG, HLS, MPEG-TS, Einzelbild)
und damit auch OpenTAKServer/ATAK schon das richtige Bild – beim Import muss nichts mehr angepasst werden. Eine
Änderung wirkt sofort, auch während der Stream läuft; HLS/MPEG-TS starten dabei kurz neu, wenn das Bild von quer
auf hoch wechselt.

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

## Installation auf dem Server

### Mit Docker (empfohlen)

1. Zwei DNS-Einträge auf den Server zeigen lassen, z. B. `cam.example.com` (Streams + Handy-App) und
   `admin.example.com` (Admin).
2. Domains in `docker-compose.yml` und `deploy/Caddyfile` eintragen.
3. `docker compose up -d` – Caddy holt die HTTPS-Zertifikate automatisch.
4. `https://admin.example.com/admin/` öffnen, mit admin / admin123 anmelden.

### Ohne Docker

Voraussetzungen: Node.js 18 oder neuer, ffmpeg (für HLS/MPEG-TS, optional), ein Reverse-Proxy mit HTTPS
(Beispiele: `deploy/Caddyfile`, `deploy/nginx.conf`).

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
| `PUBLIC_URL` | Öffentliche Adresse für Links und QR-Codes, z. B. `https://cam.example.com` | aus der Anfrage |
| `ADMIN_HOST` | Admin nur unter dieser Domain erreichbar, z. B. `admin.example.com` | Admin auf jeder Domain |
| `ADMIN_URL` | Adresse für Links in Reset-Mails | `https://<ADMIN_HOST>` |
| `PORT` / `BIND` | Port und Adresse des Servers | `8080` / `0.0.0.0` |
| `DATA_DIR` | Datenordner (Admin, SMTP, Streams) | `./data` |
| `FFMPEG_PATH` | Pfad zu ffmpeg | `ffmpeg` |
| `TLS_CERT` / `TLS_KEY` | HTTPS direkt im Server statt Reverse-Proxy | – |
| `TRUST_PROXY` | `0` = X-Forwarded-Header ignorieren (wenn kein Proxy davor) | `1` |

Alle Daten liegen in `DATA_DIR/db.json` (Passwort nur als scrypt-Hash).

## Für Entwickler

```sh
npm install
npm start      # http://localhost:8080/admin/
npm test       # Ende-zu-Ende-Tests (Admin, Handy-WebSocket, MJPEG, HLS/TS, Drehung, Stoppen/Rauswerfen, SMTP-Reset)
```

Handy → Server: WebSocket `wss://<domain>/ws/publish?u=<benutzer>&s=<streamId>&k=<schlüssel>`, jede Binärnachricht
ist ein JPEG. Der Server antwortet mit JSON (`welcome`, `config` mit Drehung, `stats`, `stopped`, `revoked`, `removed`,
`replaced`, `invalid`).
Kamera → Handy: Bluetooth-Protokoll siehe `PROTOCOL.md` im Repository ESP32-Flash.

# WebTAK

**WebTAK** = TAK im Browser (Web-App), TAK-Zugänge mit Registrierung und Freigabe (OpenTAKServer) und
Kamera-Streams, die automatisch im TAK-Server landen. Dazu Server und Handy-App für die Bluetooth-Helmkamera (ESP32-CAM, Firmware aus
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
  schließen). „Alle Streams sperren“, einzelne Streams stoppen/freigeben, Handy **rauswerfen** oder Stream **löschen**.

## Links pro Stream

| Link | Format | Hinweis |
|---|---|---|
| `https://<domain>/<benutzer>/<streamId>` | MJPEG | Hauptlink, geringe Verzögerung, kein ffmpeg nötig. Im Browser geöffnet: Vollbild-Ansicht (Tippen: füllen/ganzes Bild) |
| `https://<domain>/<benutzer>/<streamId>/index.m3u8` | HLS (H.264) | braucht ffmpeg auf dem Server, ca. 4–8 s Verzögerung; **für OpenTAKServer** |
| `https://<domain>/<benutzer>/<streamId>/stream.ts` | MPEG-TS (H.264) | braucht ffmpeg, fortlaufender HTTP-Stream |
| `https://<domain>/<benutzer>/<streamId>/snapshot.jpg` | JPEG | letztes Bild |

Welches Format dein ATAK/WinTAK am besten abspielt, am besten mit einem laufenden Stream ausprobieren – alle drei
liefern dasselbe Bild. Die Bildrate kommt von der Kamera über Bluetooth (bei 320x240 etwa 2–5 Bilder/s).

## Automatisch im TAK-Server (OpenTAKServer)

Sobald im Admin unter **TAK-Zugänge → Einstellungen** der OpenTAKServer verbunden ist, trägt der Server jeden
Kamera-Stream **automatisch** als Video-Feed in OTS ein – von Hand ist nichts mehr nötig:

- Neue Streams (Selbst-Anmeldung, EUD, manuell angelegt) bekommen einen Pfad aus dem Namen, z. B. `cam/alpha-10`.
- OTS/MediaMTX holt das Bild bei Bedarf selbst über den **HLS-Link** (`…/index.m3u8`, `sourceOnDemand`) –
  dafür braucht der Streams-Server ffmpeg (im Docker-Image dabei) und eine öffentliche Adresse
  (Admin → Links & QR-Codes → Adresse dieses Servers, oder `PUBLIC_URL`).
- In ATAK/WinTAK erscheint der Stream unter **Video** als `rtsp://<TAK-Server>:8554/<pfad>`.
- Sperren, Abschalten (Häkchen in der Spalte „TAK-Pfad“) oder Löschen trägt den Stream wieder aus.

Im Admin gibt es dafür **einen** Bereich **Video-Feeds**: oben die Kameras aus WebTAK (Handy/Helmkamera – wer in
WebTAK Video startet, ist sofort ein OTS-Feed `cam/<rufname>`), darunter **alle Feeds im TAK-Server** mit Herkunft
(„WebTAK: …“ oder „extern“), ATAK-Link zum Kopieren und dem Formular für weitere Feeds (Pfad + Quelle
rtsp/rtmp/srt/udp/HLS, MediaMTX holt das Bild bei Bedarf). Bei den Kameras wird hauptsächlich der **Pfad** gepflegt: Feld in der Spalte „TAK-Pfad“
ändern und Enter – der alte Pfad wird in OTS entfernt, der neue angelegt (leer = wieder automatisch). Der Punkt zeigt
den Stand (grün = eingetragen, gelb = wartet, rot = Fehler mit Erklärung beim Darüberfahren). Weitere Schalter:
„Neue Streams automatisch“, „nur solange die Kamera sendet“ (sonst: solange freigegeben), Pfad-Präfix und
**⟳ Abgleichen** (passiert zusätzlich beim Start und alle 10 Minuten).

Wer OTS nicht verbindet, kann den HLS-Link (Knopf „QR / Links“) weiterhin von Hand in OTS unter
**Videostreams → Add Video** als Quelle eintragen.

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
3. Quelle wählen: **Handy-Kamera** (Rückkamera) oder **Helmkamera (Bluetooth)** und ausrichten. Die Seite zeigt
   **„Bereit“** – es wird noch nichts gesendet.
4. Du schaltest im Admin mit **▶ Live** ein (Liste oder Ansehen-Fenster); das Handy vibriert kurz und sendet.
   **■ Live aus** bzw. **Alle auf Bereit** schaltet zurück auf „Bereit“.
5. In der Admin-Liste: ausrichten, Bildgröße, TAK-Pfad pflegen, sperren, rauswerfen oder löschen.

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

**Admin schaltet live** (Schalter oben im Admin, Standard an): Nutzer warten nach dem Verbinden auf „▶ Live“. Aus =
Nutzer starten den Stream selbst mit „Stream starten“. Die Seite muss geöffnet bleiben – Browser stoppen Kamera und
Bluetooth, wenn die Seite in den Hintergrund geht. Auf Android ATAK und die Seite im **geteilten Bildschirm** nutzen.

**Nutzer dürfen selbst starten** (nur bei „Admin schaltet live“): Nutzer sehen zusätzlich „Stream starten“. Der Admin
kann jederzeit „■ Live aus“ drücken.

**Hinweise:** Meldet sich jemand an, aktiviert die Kamera oder startet selbst, erscheint im Admin ein Popup mit Ton
(„Ansehen“, „▶ Live“). Mit **🔔 Hinweise** zusätzlich Desktop-Benachrichtigungen erlauben – die kommen auch, wenn das
Admin-Fenster im Hintergrund ist.

**Selbst-Anmeldung erlaubt** (Schalter oben im Admin) sperrt bei Bedarf neue Anmeldungen; laufende Streams bleiben.
Wer gelöscht wird, kann sich mit dem allgemeinen QR-Code neu anmelden – soll das nicht gehen, die Selbst-Anmeldung
sperren. Optional lassen sich Streams weiterhin manuell mit eigenem QR-Code anlegen.

## WebTAK-App (Karte + Lagebild auf dem Handy)

Unter `https://<server>/eud/` gibt es **WebTAK**, einen schlanken TAK-Client als Web-App (PWA) auf ATAK-CoT-Niveau,
Oberfläche auf **Englisch** (multinational). Läuft auf Android und iPhone (Safari → Teilen → „Zum
Home-Bildschirm“). Aufbau wie ATAK:

- **Leiste oben:** Karten (Layers), Marker, Chat, Video, Tools (Menü als Kachel-Raster wie ATAK:
  Servers, Contacts & Markers, Clear Content, Data Packages, Maps, Overlays, Data Sync, Video, R&B Line, Chat, Settings).
- **Contacts & Markers** wie der ATAK Overlay Manager nach Art getrennt: **Contacts** (Nutzer), Marker
  **Friendly / Hostile / Neutral / Unknown** (nach 2525-Zugehörigkeit), sonstige Punkte, Zeichnungen & Routen –
  jede Gruppe auf- und zuklappbar und mit 🗑 einzeln bereinigen. **Clear Content** räumt mehrere Gruppen auf
  einmal ab, dazu Overlays und Chat; auf Wunsch werden eigene Marker auch beim TAK-Server gelöscht.
- **Links:** Kompass (antippen = Blickrichtung oben „HDG“, erneut = Nord oben „N“; ohne Sensor nach
  GPS-Kurs), darunter „auf mich zoomen“.
- **Rechts:** Schieberegler zum Kippen (Doppeltippen = flach). Gekippt zeigt WebTAK eine **echte 3D-Karte** wie
  WinTAK (MapLibre GL): Gelände mit Höhen, Himmel und Horizont, Neigung bis **88°**, Symbole stehen aufrecht mit
  Namen, Routen/Flächen liegen auf dem Gelände, eigene Marker lassen sich auch in 3D verschieben und antippen.
  Bei 0° geht es zurück zur flachen Karte (zum Zeichnen, Messen, Korridor) – mit gleichem Ausschnitt und gleicher
  Drehung. **3D ist Standard** (Karte → 3D MAP: abschaltbar, „Start in 3D view“, Geländehöhe 1–3×). Höhendaten:
  frei nutzbare *AWS Terrain Tiles* (Terrarium) über den eigenen Kachel-Zwischenspeicher; „Save for offline use“
  speichert sie mit. Ohne WebGL 2 oder ohne Höhendaten: flach gekippt (bis 60°) bzw. 3D ohne Gelände.
- **Unten rechts:** Verbindungsanzeige (grün = verbunden, gelb = nur ein Teil, rot = offline; antippen =
  Server) und die eigene Position: Rufname, MGRS, Höhe, Richtung, Tempo, Genauigkeit. Unten links Maßstab.
- **Marker** (Marker-Knopf oben): Name-Präfix + Index wie ATAK; Zugehörigkeit (Unbekannt/Neutral/Feind/
  Freund), Dimension (Ground, Air, Sea, Sub, Space) und MIL-STD-2525-Symbol wählen (z. B. Infanterie,
  Panzer, Artillerie, Hubschrauber, Jäger, Drohne/UAV, Schiff, U-Boot, Satellit), dann die Stelle antippen.
- **Eigene Position unten rechts antippen** öffnet das Callsign-Menü.
- Alle Fenster öffnen als Sheet unten (im Querformat rechts), immer nur eines gleichzeitig.

**Kernfunktionen**

1. **Marker** setzen (s. o.). Eigene Marker per **Drag & Drop verschieben**, im Popup **umbenennen**
   oder löschen – die Änderung geht wie bei ATAK mit gleicher UID an alle Server.
2. **Server verbinden** – Menü → Servers. **Mehrere TAK-Server gleichzeitig**, alles auf einer Karte.
   Je Server: QR-Code (ATAK-Enrollment `tak://…/enroll?…`, iTAK `Name,Host,Port,ssl`), Datenpaket (.zip),
   Zertifikat (.p12), Truststore oder von Hand (Adresse, Port, SSL/TCP/UDP, Benutzer + Passwort →
   „Request certificate“, Port 8446). Unbekannte Server-Zertifikate erst nach Bestätigung des Fingerabdrucks.
3. **Chat** – Chat „All“ (GeoChat); Fenster lässt sich minimieren und schließen.
4. **Videostream** – „Phone camera“ oder „Helmet camera (Bluetooth, Android/Chrome)“ antippen: der Stream
   startet sofort (auch wenn im Admin „Admin schaltet live“ eingestellt ist – der Admin bekommt einen
   Hinweis). Der Link steht in der eigenen Position, ATAK-Nutzer sehen ihn beim Kontakt. Eigene Vorschau
   minimieren oder ausblenden (Stream läuft weiter). **Streams ansehen:** alle Streams im Lagebild und die
   Feeds des TAK-Servers im Viewer (MJPEG/HLS; RTSP wird kopiert). Der Viewer verhält sich wie der Chat: unten
   angedockt (quer: rechts), Minimieren = nur die Kopfzeile, Kopfzeile antippen = wieder groß, Vollbild, schließen;
   Video und Chat stapeln sich, statt sich zu überdecken.
   **Feeds anderer Systeme:** HLS (`.m3u8`) spielt WebTAK auch in Chrome/Edge (hls.js). RTSP-Feeds von
   OpenTAKServer/MediaMTX (`rtsp://host:8554/pfad`, wie sie ATAK/iTAK abspielen) holt WebTAK automatisch über den
   HLS-Ausgang von MediaMTX (`http://host:8888/pfad/index.m3u8`). Das läuft über den eigenen Server
   (`/api/eud/media`: nur Video-Dateien, Ziel wie bei der TAK-Durchreiche geprüft) – kein Mixed Content, kein CORS.
   Geht es trotzdem nicht: Hinweis und Knopf „im neuen Tab öffnen“ bzw. „Adresse für VLC kopieren“.

**TAK-Daten** (Menü → TAK Data, über den API-Port 8443 mit dem Client-Zertifikat):
Datenpakete vom Server laden, **Data Sync** (Missionen abonnieren – auch passwortgeschützte –, Inhalte
werden bei Änderungen automatisch aktualisiert, ⟳ lädt sofort neu; bei OpenTAKServer werden auch die in ATAK
angelegten Missionen mit `tool=public` gefunden, und Punkte, für die der Server nur Metadaten liefert, erscheinen
trotzdem auf der Karte), **Overlays** (KML/KMZ aus Paketen, Missionen oder vom
Gerät, auch Rasterkarten mit mehreren Detailstufen; bleiben offline gespeichert).
**Auto-Push wie bei ATAK:** schickt der TAK-Server ein Datenpaket an das Gerät oder lädt es in eine
Mission ein, wird beides automatisch geladen bzw. abonniert. Fehler beim Abruf stehen im Server-Log
(„EUD TAK-API … Fehler“).

**Karte** (Menü → Map): Quelle wählen (OpenStreetMap, OpenTopoMap, Esri Satellit/Topo oder eigene
URL mit `{z}/{x}/{y}`). Kacheln laufen über diesen Server und werden dort unter `DATA_DIR/tiles`
zwischengespeichert. **Offline speichern:** sichtbaren Ausschnitt oder einen gezeichneten **Korridor**
(Breite in m) mit Zoom von/bis; gespeicherte Bereiche lassen sich anzeigen und löschen. Bitte nur
benötigte Bereiche laden – die freien Kartendienste erlauben kein Massen-Herunterladen.

**Ohne Internet:** App, gespeicherte Kacheln, Lagebild und Overlays bleiben auf dem Gerät. GPS läuft
weiter, Marker und Chats warten im Ausgang und gehen raus, sobald die Verbindung wieder steht.

**Grenzen einer Web-App:** Ein TAK-Server auf dem Handy selbst (z. B. in der Meshtastic-App,
`127.0.0.1:8088`) ist für eine Web-App nicht erreichbar – Browser können keine TCP/TLS-Verbindungen
öffnen. Dafür braucht es die EUD als installierte App. iOS pausiert Web-Apps im Hintergrund;
Bluetooth gibt es in Safari nicht (Helmkamera am iPhone nur über die App „Bluefy“).

**Sicherheit:** Dieser Server reicht die Daten nur durch (`/ws/tak`, `/api/eud/marti`). Zertifikate und
Schlüssel liegen nur auf dem Handy. Im Admin unter „Erlaubte TAK-Server“ den eigenen TAK-Server
eintragen, damit niemand den Server als offene Durchreiche benutzt. Ohne Eintrag sind alle Server
erlaubt – außer dem Server-Rechner selbst (`localhost`) und Link-Local-Adressen.

## TAK-Zugänge (OpenTAKServer)

Nutzer beantragen hier echte TAK-Zugänge; nach der Freigabe legt die App das Konto auf dem
**OpenTAKServer (OTS)** an und der Nutzer bekommt Zugangsdaten, QR-Codes und eine bebilderte Anleitung.

**Ablauf**

1. Nutzer öffnet `https://<server>/join/` (QR-Code im Admin: „Benutzer & Anfragen“ → „Registrierungs-QR“), liest
   kurz, was TAK kann, und stellt eine Anfrage (Name, Einheit, Wunsch-Rufname, E-Mail; optional Codewort,
   optional E-Mail-Bestätigung über SMTP). Er bekommt sofort eine Eingangsbestätigung per E-Mail
   („WebTAK – registration request received“, mit seinem persönlichen Statuslink) und sieht nach dem Absenden,
   wie es weitergeht. Die **Statusseite** zeigt eine Zeitleiste (Anfrage → ggf. E-Mail bestätigt → Freigabe →
   Zugangsdaten), aktualisiert sich selbst und sagt, ob die Freigabe per E-Mail kommt. Der Admin bekommt bei jeder neuen Anfrage eine E-Mail.
2. Der Admin sieht die Anfrage (Hinweis + Liste „Offen“) und gibt sie frei – **nichts passiert ohne
   Freigabe**. Dabei legt er **Rufname** (überschreibt z. B. „Horst“ mit „ALPHA 10“), **Team** und **Rolle** fest.
3. Die App legt das OTS-Konto an (Rolle „user“, Benutzername aus dem Rufnamen, Passwort laut Einstellung –
   Standard `atakatak`, leer = zufällig je Nutzer; danach prüft sie, dass die Anmeldung damit klappt), setzt ggf. die
   Team-Gruppen und erzeugt den ATAK-Enrollment-QR-Code. Der Nutzer bekommt eine E-Mail (falls SMTP)
   bzw. der Admin gibt ihm den angezeigten Link.
4. Auf der Zugangsseite `/access/` (englisch, für multinationale Nutzer): Rufname, Team, Rolle, Server,
   Benutzer, Passwort, **Truststore-Download**, QR-Codes und Schritt-für-Schritt-Anleitung für
   **ATAK** (Android), **iTAK** (iPhone) und **WebTAK** (QR öffnet die EUD mit allen Daten, das
   Zertifikat wird automatisch angefordert).

**Verwaltung** (Admin → TAK-Zugänge): suchen/filtern, freigeben, ablehnen, bearbeiten, sperren/entsperren
(OTS-Konto wird deaktiviert), neues Passwort, neuer ATAK-QR, Zugangslink kopieren, löschen (auch auf OTS).

**Rufname, Team und Rolle überschreiben:** Die App setzt für jedes Gerät des Nutzers OTS-Geräte-Profile
(`locationCallsign`, `locationTeam`, `atakRoleType`). **ATAK** übernimmt sie beim (nächsten) Verbinden mit
dem Server; neue Geräte werden alle 2 Minuten erkannt („Mit OTS abgleichen“ erzwingt es sofort). In der
**Web-EUD** gilt die Zuweisung sofort und ist gesperrt; die Durchreiche setzt sie auch in der gesendeten
Position durch. **iTAK** übernimmt keine Server-Profile – dort stellt der Nutzer Rufname/Team laut Zugangsseite ein.

**ATAK ohne Tippen:** Der ATAK-QR-Code auf der Zugangsseite ist ein normaler https-Link – mit der Handy-Kamera
scannen, Seite öffnet sich, **ATAK-Einrichtungspaket** (`.zip`) laden und mit ATAK öffnen. Das Paket enthält Server,
Benutzer, Passwort, Rufname, Team, Rolle und den Truststore von OTS (Passwort einstellbar, Standard `atakatak`);
ATAK importiert es, fordert sein Zertifikat an und verbindet sich. Das funktioniert auch mit selbstsigniertem
Server-Zertifikat. Der `tak://…/enroll`-QR von OTS bleibt als Alternative – laut OTS klappt er nur mit öffentlich
vertrauenswürdigem Zertifikat (z. B. Let's Encrypt), und viele Kamera-Apps öffnen `tak://`-Links gar nicht.
Das Paket lässt sich auch mit iTAK öffnen.

**Teams und Sichtbarkeit:** Standard: alle sehen alle – dann bekommen freigegebene Nutzer in OTS **keine Gruppe**,
genau wie von Hand angelegte Benutzer; OTS nimmt dafür seine Standardgruppe `__ANON__`, und alle (auch WinTAK/ATAK
ohne Gruppe) sehen sich. Erst wenn in der Matrix „Wer sieht wen?“ ein Haken entfernt wird, legt WebTAK je Team eine
OTS-Gruppe an (`TEAM_<NAME>`): das Team liest die Gruppe des anderen nicht mehr, OTS stellt dann dessen Positionen,
Marker und Chats nicht zu. Mit Geräten ohne Gruppe (`__ANON__`) wird dabei weiter ausgetauscht (abschaltbar);
ein ausgeblendetes Team sendet nicht nach `__ANON__`, sonst wäre es dort doch sichtbar. Beim Start und mit
„Mit OTS abgleichen“ werden die Gruppen aller Nutzer auf diesen Stand gebracht; Geräte verbinden sich danach neu. So können mehrere Einheiten einen Server
nutzen, ohne sich zu stören. (Voraussetzung: OTS mit Kanälen/Gruppen, Standard `OTS_ENABLE_CHANNELS=True`,
kein LDAP.)

**Einrichtung:** Admin → TAK-Zugänge → Einstellungen:
- Adresse der OTS-Weboberfläche/API (z. B. `https://ots.example.com`, oder intern `http://127.0.0.1:8081`
  wenn beide auf demselben Rechner laufen), OTS-Admin-Benutzer und Passwort (**ohne Zwei-Faktor**).
- Öffentliche TAK-Adresse für die Geräte (wird in die QR-Codes eingesetzt) und Ports (8089/8446/8443).
- „Verbindung testen“, dann Registrierung öffnen und den QR-Code zur Registrierung verteilen.

**Sicherheit:** Die Passwörter der TAK-Konten und das OTS-Admin-Passwort liegen in `DATA_DIR/db.json`
(Dateirechte 600), damit die Zugangsseite die Daten zeigen kann; der Zugangslink ist geheim (48 Zeichen) und
nach dem Sperren/Löschen wertlos. Registrierungen sind auf 5 pro Stunde und IP begrenzt.

## TAK-Server verwalten (im WebTAK-Admin)

Unter **TAK-Server** in der Seitenleiste verwaltet WebTAK den OpenTAKServer wie dessen eigene Oberfläche:

- **OTS-Benutzer:** alle Konten aus OTS – auch die, die direkt in OTS angelegt wurden – mit Rolle, aktiv/gesperrt,
  Gruppen, Geräten und letzter Anmeldung. **Neuer Benutzer** legt ein Konto ohne Registrierung an (Rufname, optional
  Benutzername/Passwort/E-Mail, Team, Rolle, OTS-Administrator) und zeigt den Zugangslink. **Übernehmen** verwaltet
  einen vorhandenen OTS-Benutzer zusätzlich in WebTAK (Rufname, Team, Zugangsseite; optional neues Passwort und
  Team-Gruppen). Außerdem: Rolle User/Administrator, sperren/aktivieren, Passwort setzen, Gruppen (IN/OUT) pflegen, löschen.
- **Gruppen:** anlegen, löschen (`__ANON__` bleibt).
- **Missionen (Data Sync):** anlegen (Beschreibung, Passwort, Gruppen; OTS verlangt ein bekanntes Gerät als
  Ersteller – vorausgewählt), auflisten, löschen.
- **Meshtastic:** Kanäle anlegen (Name, Funk-Voreinstellung, Region, Schlüssel erzeugen, Up-/Downlink) oder per
  Meshtastic-Link übernehmen, Link kopieren, löschen.

Benutzer & Anfragen zeigt standardmäßig **alle** WebTAK-Nutzer (offene Anfragen oben) – freigegebene Nutzer
verschwinden nicht mehr aus der Liste.

## Admin

**WebTAK Admin** im dunklen ATAK-Stil mit Seitenleiste – oben das Tagesgeschäft, unten die einmaligen Einstellungen:
- **TAK:** *Benutzer & Anfragen* (Zahl offener Anfragen, Knopf „Registrierungs-QR“), *Teams & Sichtbarkeit*,
  *Links & QR-Codes* – **eine** Server-Adresse für alle Links und QR-Codes (Registrierung, WebTAK-App, alte
  Kamera-App eingeklappt); Änderung wirkt sofort überall, auch für die Video-Feeds, die OTS abholt
- **TAK-Server:** *OTS-Benutzer*, *Gruppen*, *Missionen*, *Meshtastic*
- **Video:** *Video-Feeds* (WebTAK-Kameras und alle OTS-Feeds; Schalter „Video erlaubt“, „Admin schaltet live“), *Stream anlegen*
- **Einstellungen:** *OpenTAKServer & Registrierung* (Verbindung, Passwörter, Registrierung – einmal einrichten),
  *WebTAK-App*, *System* (Admin-Zugang, SMTP, Standard für neue Streams)

- Erster Login: **admin / admin123**. Danach muss sofort ein eigener Benutzername und ein neues Passwort festgelegt
  werden (vorher ist nichts anderes möglich).
- **System:** Admin-E-Mail und SMTP-Server eintragen, „Test-Mail senden“. SSL/TLS wird bei den Ports 465
  (SSL/TLS) und 587/25 (STARTTLS) automatisch richtig gewählt – das behebt „wrong version number“. Danach funktioniert
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

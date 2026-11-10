# 🎯 Vorlesungs-Bingo

Multiplayer-Bingo für Vorlesungen: Jemand erstellt eine Lobby, alle anderen treten mit dem Code bei
und spielen mit **denselben Feldern in unterschiedlicher, zufälliger Anordnung**. Sobald jemand
Bingo hat, sehen es alle.

## Funktionen

- **Lehrer verwalten** – beliebig viele Lehrer mit ihren Standard-Feldern anlegen
  (z. B. „Sagt *sozusagen*“, „Zeigt einen Kartentrick“). Wird dauerhaft gespeichert.
- **Lobby** mit 5-stelligem Code und Einladungslink (`/?lobby=CODE`).
- **Öffentlich oder privat**: Öffentliche Lobbys stehen live auf der Startseite unter
  „Offene Bingos“ und man tritt mit einem Klick bei (auch wenn die Runde schon läuft).
  Private Lobbys sind nicht gelistet – dafür braucht man den Code. Der Host kann das in der Lobby umstellen.
- **Eigene Felder** vor dem Start hinzufügen – zusätzlich zu den Standard-Feldern des Lehrers.
- **Abstimmung**: Jedes Feld kann per 👎 rausgewählt werden. Sobald die Mehrheit der
  verbundenen Spieler dafür ist, fliegt es raus.
- Eigene Felder, die beim Spielstart noch drin sind, werden **dauerhaft beim Lehrer gespeichert**
  und sind in der nächsten Lobby automatisch dabei.
- **3×3, 4×4 oder 5×5**, optional mit freiem Feld in der Mitte.
- Jeder bekommt ein eigenes, zufällig gemischtes Spielfeld; der Server prüft Bingo
  (Reihe, Spalte, Diagonale) und meldet es allen inklusive Platzierung.
- **All-Time-Bestenliste** (nach Spielername): 1. Platz 5 Punkte, 2. Platz 3, 3. Platz 2,
  jedes weitere Bingo 1 Punkt. Dazu Siege, Bingos und gespielte Runden.
- **Admin-Login**: Nur der Admin kann Lehrer und Felder löschen, Bestenliste-Einträge löschen
  und Wörter sperren. **Hinzufügen kann immer jeder.**
- **Gesperrte Felder 🔒**: Alle Lehrer-Felder sind anfangs gesperrt und können in einer Lobby nicht
  für die Runde rausgewählt werden. Der Admin kann einzelne (oder alle) entsperren – auch live in der Lobby.
- **Dauerhaft löschen per Abstimmung**: Unter „Lehrer verwalten“ kann jeder per 👎 dafür stimmen, ein
  Feld beim Lehrer zu löschen. Bei 5 Stimmen (`DELETE_VOTES`) ist es weg – auch wenn es gesperrt ist.
- **Regeln**: Fetter Hinweis überall dort, wo man Felder schreibt (Lobby, Lehrer verwalten), und eine
  Bestätigung beim ersten Besuch, dass beleidigende, rassistische oder sexistische Inhalte nicht
  geduldet werden. Der Admin sieht, wer welches Feld hinzugefügt hat.
- **Feedback 💬**: Jeder kann (auch anonym) Feedback schicken; es landet in der Feedback-Inbox im
  Admin-Bereich (gelesen/ungelesen, löschen). Höchstens 5 Nachrichten pro Gerät in 10 Minuten.
- **Gesperrte Wörter 🚫**: Felder, Lehrer- und Spielernamen mit diesen Wörtern werden abgelehnt.
- Man sieht nicht, welche Felder andere schon abgehakt haben – verpasst ist verpasst.
- Host kann Spieler entfernen und eine neue Runde starten. Bei Verbindungsabbruch
  (z. B. Handy gesperrt) kommt man automatisch wieder ins gleiche Spiel.

## Lokal starten

Voraussetzung: Node.js 18 oder neuer.

```bash
npm install
npm start
```

Dann <http://localhost:3000> öffnen.

## Vom eigenen PC im lokalen Netzwerk (WLAN) hosten

1. [Node.js](https://nodejs.org) (LTS) installieren.
2. Im Projektordner einmalig `npm install` ausführen, danach `npm start`.
3. In der Konsole stehen dann die Adressen, z. B.:
   ```
   Bingo läuft auf http://localhost:3000
   Im Netzwerk:  http://192.168.178.42:3000
   ```
4. Die Adresse hinter „Im Netzwerk“ an die anderen schicken – sie müssen im selben WLAN sein.
5. **Windows:** Beim ersten Start fragt die Firewall nach – „Private Netzwerke“ erlauben.
   Kommt keine Abfrage und es klappt nicht, in PowerShell (als Administrator):
   ```powershell
   New-NetFirewallRule -DisplayName "Bingo" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
   ```
   **macOS:** Bei der Abfrage „Eingehende Verbindungen erlauben“ zustimmen.

Hinweis: Uni-WLANs wie eduroam blockieren oft Verbindungen zwischen Geräten. Dann klappt es z. B.
über einen Handy-Hotspot, mit dem sich alle verbinden.

Anderer Port: `PORT=8080 npm start` (Windows PowerShell: `$env:PORT=8080; npm start`).

## Auf einem Server hosten

### Mit Docker (empfohlen)

```bash
docker compose up -d --build
```

Die App läuft dann auf Port 3000. Die Lehrer-Daten liegen im Docker-Volume `bingo-data`
und bleiben bei Updates erhalten.

### Ohne Docker

```bash
npm ci --omit=dev
PORT=3000 node server.js
```

Am besten mit einem Prozessmanager wie `pm2` oder einem systemd-Dienst dauerhaft laufen lassen.

### Hinter einem Reverse-Proxy (HTTPS)

Die App nutzt WebSockets (Socket.IO). Beispiel für **Caddy** (holt automatisch ein HTTPS-Zertifikat):

```
bingo.deine-domain.de {
    reverse_proxy localhost:3000
}
```

Beispiel für **nginx**:

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

### Umgebungsvariablen

| Variable   | Standard  | Bedeutung                              |
|------------|-----------|----------------------------------------|
| `PORT`     | `3000`    | Port des Servers                       |
| `DATA_DIR` | `./data`  | Ordner für `teachers.json`, `leaderboard.json`, `feedback.json` und `settings.json` |
| `DELETE_VOTES` | `5` | Stimmen, ab denen ein Feld beim Lehrer dauerhaft gelöscht wird |
| `ADMIN_PASSWORD` | – | Admin-Passwort. Ohne diese Variable wird beim ersten Start eins erzeugt, in `data/settings.json` gespeichert und in der Konsole angezeigt. |

## Hinweise

- Lobbys liegen nur im Arbeitsspeicher – nach einem Neustart des Servers sind laufende Spiele weg,
  Lehrer und Bestenliste bleiben erhalten.
- **Admin-Passwort**: steht beim Start in der Konsole (`Admin-Passwort: …`). Ändern kannst du es in
  `data/settings.json` (`adminPassword`, danach neu starten) oder per Umgebungsvariable
  `ADMIN_PASSWORD`. Nach einem Neustart muss man sich als Admin neu anmelden.
- Lehrer anlegen und Felder hinzufügen kann jeder – Löschen nur der Admin.

## Test

```bash
npm test
```

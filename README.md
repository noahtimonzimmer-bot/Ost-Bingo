# 🎯 Vorlesungs-Bingo

Multiplayer-Bingo für Vorlesungen: Jemand erstellt eine Lobby, alle anderen treten mit dem Code bei
und spielen mit **denselben Feldern in unterschiedlicher, zufälliger Anordnung**. Sobald jemand
Bingo hat, sehen es alle.

## Funktionen

- **Lehrer verwalten** – beliebig viele Lehrer mit ihren Standard-Feldern anlegen
  (z. B. „Sagt *sozusagen*“, „Zeigt einen Kartentrick“). Wird dauerhaft gespeichert.
- **Lobby** mit 5-stelligem Code und Einladungslink (`/?lobby=CODE`).
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
| `DATA_DIR` | `./data`  | Ordner für `teachers.json` und `leaderboard.json` |

## Hinweise

- Lobbys liegen nur im Arbeitsspeicher – nach einem Neustart des Servers sind laufende Spiele weg,
  Lehrer und Bestenliste bleiben erhalten.
- Es gibt keine Anmeldung: Jeder mit Zugriff auf die Seite kann Lehrer anlegen und löschen.
  Wenn du das einschränken willst, sichere die Seite z. B. per Passwort im Reverse-Proxy ab.

## Test

```bash
npm test
```

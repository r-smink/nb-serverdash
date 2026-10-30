# NextBuzz ServerDash

Eigen monitoringdashboard voor de Ubuntu/Plesk-servers, de nameserver en de shared database server.

- **Overzicht**: één tegel per server met CPU, RAM, disk, load, een CPU-sparkline van het laatste uur, netwerk en uptime.
  Servers met een probleem worden oranje (waarschuwing) of rood (kritiek). Kritieke servers worden vergroot en bovenaan getoond.
- **Detailpagina** (klik op een server): grafieken voor CPU, load, geheugen/swap, disk I/O, disk-belasting, netwerk,
  schijfruimte per mount en processen/mailwachtrij over 1 uur tot 30 dagen. Je kunt inzoomen door te slepen.
  **Klik op een moment in een grafiek** om de processen van dat moment te zien (snapshots worden 72 uur bewaard).
- **Processen**: tabbladen CPU, geheugen, disk I/O, CPU-tijd en *langlopend*. Plus verbruik per systeemgebruiker,
  en dus per Plesk-abonnement.
- **Services**: bewaking van ingeschakelde Plesk-services (sw-cp-server, sw-engine, nginx, apache2, mariadb, postfix,
  dovecot, named, fail2ban, php-fpm-pools…) en van alle gefaalde systemd-units.
- **Meldingen**: statuswijzigingen komen in het meldingenlog en kunnen optioneel naar een webhook (Slack, Mattermost,
  Discord, Teams-workflow).
- **Websites**: bewaak losse websites op een van de Plesk-servers. Per site zie je:
  - **Bereikbaarheid**: elke minuut controleert het dashboard de site. Je ziet responstijd, uptime over 24 uur, 7 en
    30 dagen, de HTTP-status, een optioneel sleutelwoord op de pagina en hoe lang het SSL-certificaat nog geldig is.
  - **Wat de site van de server vraagt**: CPU, geheugen, disk I/O en het aantal processen. De agent rekent alle
    processen van de PHP-FPM-pool en de Plesk-systeemgebruiker mee (cron, CLI-scripts, queue-workers). Je ziet dit ook
    als aandeel van de hele server.
  - **Verkeer** uit de Plesk-logs (`/var/www/vhosts/system/<domein>/logs`): requests per minuut, 4xx/5xx-fouten,
    bandbreedte, populairste URL's, de IP-adressen met de meeste requests en user-agents (zo herken je bots).
  - **Schijfruimte** van de webruimte (wordt elke 6 uur op de achtergrond gemeten met `du`).
- **Beheer**: servers toevoegen, bewerken, pauzeren (onderhoud) en verwijderen, en de drempelwaarden instellen.

## Architectuur

```
[server 1..n]  nb-agent (python3, systemd)  --HTTPS POST elke 30s-->  ServerDash (Node.js + SQLite)  <-- browser
```

De agent **pusht** de data. Op de servers hoeven dus geen poorten open, en het dashboard heeft geen SSH-toegang nodig.
Elke server krijgt een eigen token; in de database staat alleen de hash daarvan.

| Onderdeel | Bestand |
|---|---|
| Agent (alleen standaardbibliotheek, Python 3.6+) | `agent/nb-agent.py` |
| Installatiescript agent | `agent/install.sh` |
| API, auth, statusbewaking | `server/index.js`, `server/status.js` |
| Opslag (ingebouwde `node:sqlite`) | `server/db.js` |
| Frontend (vanilla JS + uPlot) | `public/` |
| Demo-simulator | `scripts/simulate.js` |

## Lokaal draaien / demo

Vereist Node.js 22.13 of nieuwer.

```bash
npm install
cp .env.example .env        # vul ADMIN_PASSWORD in
npm start                   # http://127.0.0.1:8080
npm run demo                # in een tweede terminal: 26 demo-servers met 7 dagen historie
npm run demo:clean          # demo-servers weer verwijderen
```

## Productie-installatie (dashboard)

Bijvoorbeeld op een kleine aparte VPS. Zet het dashboard bij voorkeur niet op een van de bewaakte servers:
als die uitvalt, wil je dat nog kunnen zien.

```bash
# Node.js 22 installeren (NodeSource) en code neerzetten in /opt/serverdash
cd /opt/serverdash && npm ci --omit=dev
cp .env.example .env && nano .env     # ADMIN_PASSWORD, PUBLIC_URL=https://monitor.nextbuzz.nl
```

`/etc/systemd/system/serverdash.service`:

```ini
[Unit]
Description=NextBuzz ServerDash
After=network.target

[Service]
WorkingDirectory=/opt/serverdash
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=always
User=serverdash

[Install]
WantedBy=multi-user.target
```

Daarvoor nginx of Caddy met HTTPS als reverse proxy naar `127.0.0.1:8080`. Zet in `.env` dan
`TRUST_PROXY=1` en `SECURE_COOKIE=1`. Voorbeeld met Caddy:

```
monitor.nextbuzz.nl {
    reverse_proxy 127.0.0.1:8080
}
```

## Agent installeren op een server

1. Ga in het dashboard naar **Beheer → + Server toevoegen**.
2. Kopieer het commando dat verschijnt en voer het als root uit op de server:
   ```bash
   curl -fsSL https://monitor.nextbuzz.nl/agent/install.sh | sudo bash -s -- --url https://monitor.nextbuzz.nl --token <TOKEN>
   ```
3. Het script installeert `/opt/nb-agent/nb-agent.py`, `/etc/nb-agent.conf` (chmod 600) en de service `nb-agent`.
   Het doet eerst een testmeting. Binnen een minuut verschijnt de server in het dashboard.

Handig:

```bash
systemctl status nb-agent
journalctl -u nb-agent -f
python3 /opt/nb-agent/nb-agent.py --print    # toon wat de agent meet, zonder te versturen
# verwijderen:
curl -fsSL https://monitor.nextbuzz.nl/agent/install.sh | sudo bash -s -- --uninstall
```

Bijwerken naar een nieuwe agentversie (bijvoorbeeld 1.1 voor websitestatistieken): voer het installatiecommando
opnieuw uit. Een nieuw token is dan niet nodig; het token staat al in `/etc/nb-agent.conf`:

```bash
curl -fsSL https://monitor.nextbuzz.nl/agent/install.sh | sudo bash -s -- --url https://monitor.nextbuzz.nl --token "$(grep ^token= /etc/nb-agent.conf | cut -d= -f2)"
```

Het dashboard geeft in elke response door welke websites er op die server bewaakt worden. De agent hoeft daarvoor dus
niet opnieuw ingesteld te worden.

De agent draait als root, omdat hij alleen zo de I/O-statistieken van processen van alle gebruikers kan lezen.
Hij draait met `Nice=10`, idle I/O-prioriteit en een geheugenlimiet van 128 MB.

## Statusregels (standaard, aanpasbaar in Beheer)

| Meting | Waarschuwing | Kritiek |
|---|---|---|
| CPU (gem. 3 min) | 85% | 95% |
| Load per core (gem. 3 min) | 1,5 | 3 |
| IO-wait (gem. 3 min) | 20% | 40% |
| Geheugen | 90% | 97% |
| Swap | 60% | 90% |
| Schijf / inodes per mount | 85% | 95% |
| Postfix-mailwachtrij | 500 | 2000 |
| Website: responstijd | 2000 ms | 5000 ms |
| Website: SSL verloopt binnen | 21 dagen | 7 dagen |
| Website: 5xx-fouten | 5% | 20% |
| Website: CPU (gem. 3 min) | 150% van 1 core | 300% van 1 core |
| Website: 2 checks achter elkaar mislukt | – | onbereikbaar (kritiek) |
| Bewaakte service niet actief | – | kritiek |
| Andere gefaalde systemd-unit | waarschuwing | – |
| Geen data > 180 s | – | offline (kritiek) |

## Opslag en bewaartermijnen

- Metrics: 30 dagen (`RETENTION_DAYS`), opgeslagen in `data/serverdash.db`.
- Processnapshots: elke 60 s per server, gecomprimeerd, 72 uur bewaard.
- Meldingen: 90 dagen.

Reken voor 26 servers op ongeveer 0,5–1 GB schijfruimte.

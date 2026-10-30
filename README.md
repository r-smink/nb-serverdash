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
- **Websites**: bewaak losse websites op een van de Plesk-servers. Per site zie je:
  - **Bereikbaarheid**: elke minuut controleert het dashboard de site. Je ziet responstijd, uptime over 24 uur, 7 en
    30 dagen, de HTTP-status, een optioneel sleutelwoord op de pagina en hoe lang het SSL-certificaat nog geldig is.
  - **Wat de site van de server vraagt**: CPU, geheugen, disk I/O en het aantal processen. De agent rekent alle
    processen van de PHP-FPM-pool en de Plesk-systeemgebruiker mee (cron, CLI-scripts, queue-workers). Je ziet dit ook
    als aandeel van de hele server.
  - **Verkeer** uit de Plesk-logs (`/var/www/vhosts/system/<domein>/logs`): requests per minuut, 4xx/5xx-fouten,
    bandbreedte, populairste URL's, de IP-adressen met de meeste requests en user-agents (zo herken je bots).
  - **Schijfruimte** van de webruimte (wordt elke 6 uur op de achtergrond gemeten met `du`).
- **Verbruik**: top-verbruikers over alle servers (24 uur, 7 of 30 dagen): CPU-uren, gemiddeld aantal cores, RAM en
  disk-I/O per Plesk-abonnement, requests en bandbreedte per domein, en welke servers nog ruimte hebben.
- **Onderhoud**: back-ups per server (leeftijd, resultaat, grootte), openstaande (security-)updates, Plesk-versies
  (achterlopende servers gemarkeerd), schijfvoorspelling ("vol over 9 dagen") en een WordPress-overzicht met verouderde
  core, plugins en thema's.
- **Beveiliging**: Fail2ban-blokkades per jail, mislukte SSH-logins, ModSecurity-blokkades en brute force op
  `wp-login.php` en `xmlrpc.php`, per server en per site, met een grafiek van de afgelopen 7 dagen.
- **Database**: op servers met MySQL/MariaDB (vooral de shared databaseserver) zie je verbindingen ten opzichte van
  `max_connections`, queries per seconde, trage queries, de buffer-pool hit ratio, lopende (langlopende) queries,
  verbindingen per gebruiker, de grootste databases en de replicatie-achterstand.
- **Incidenten**: elk probleem wordt automatisch een incident, met begin- en eindtijd, notities, een oorzaakveld en
  "bevestigen" (dat stopt de herhaalmeldingen).
- **Meldingen**: webhook (Slack, Mattermost, Discord, Teams), e-mail (SMTP), Pushover, ntfy en SMS via Twilio. Per kanaal
  kies je "waarschuwing + kritiek" of "alleen kritiek". Zolang een probleem niet bevestigd is, komt er elke 30 minuten
  (instelbaar) een herinnering.
- **Bereikbaarheid**: het dashboard doet elke minuut een TCP-check op de servers. Zo zie je het verschil tussen "agent
  gestopt" (waarschuwing) en "server onbereikbaar" (kritiek).
- **Tv-modus** (`#/tv`): schermvullend voor op kantoor, met problemen groot in beeld en alle servers compact eronder.
- **Gebruikers & 2FA**: beheerders en kijkers (alleen lezen), tweestapsverificatie met een authenticator-app.
- **Beheer**: servers en websites toevoegen, bewerken, pauzeren (onderhoud) en verwijderen; websites automatisch ontdekken
  uit Plesk; drempelwaarden, meldingskanalen en gebruikers.

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
| HTTP-server en achtergrondtaken | `server/index.js` |
| API-routes | `server/api.js` |
| Verwerking agentdata, status, HTTP- en TCP-checks | `server/monitor.js`, `server/status.js`, `server/checker.js` |
| Gebruikers, sessies, 2FA | `server/auth.js` |
| Meldingen en incidenten | `server/alerts.js` |
| Schijfvoorspelling, WordPress-versies | `server/insights.js` |
| Opslag (ingebouwde `node:sqlite`) | `server/db.js` |
| Frontend (vanilla JS + uPlot) | `public/` |
| Demo-simulator | `scripts/simulate.js` |
| Externe bewaking van het dashboard | `scripts/watchdog.sh` |

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

Bijwerken naar een nieuwe agentversie (bijvoorbeeld 1.2 voor back-ups, updates, beveiliging, database en WordPress): voer het installatiecommando
opnieuw uit. Een nieuw token is dan niet nodig; het token staat al in `/etc/nb-agent.conf`:

```bash
curl -fsSL https://monitor.nextbuzz.nl/agent/install.sh | sudo bash -s -- --url https://monitor.nextbuzz.nl --token "$(grep ^token= /etc/nb-agent.conf | cut -d= -f2)"
```

Het dashboard geeft in elke response door welke websites er op die server bewaakt worden. De agent hoeft daarvoor dus
niet opnieuw ingesteld te worden.

### Wat de agent 1.2 meet en hoe vaak

| Wat | Hoe | Interval |
|---|---|---|
| CPU, RAM, disk, netwerk, processen, services | `/proc`, `systemctl` | elke meting (30 s) |
| Requests, fouten en inlogpogingen per domein | nieuwe regels in `/var/www/vhosts/system/*/logs/(proxy_)access*_log` | elke meting |
| SSH-pogingen, ModSecurity | nieuwe regels in `/var/log/auth.log`, `/var/log/modsec_audit.log` | elke meting |
| MySQL/MariaDB-status, lopende queries, replicatie | `mysql`-client (op Plesk via het admin-account, anders `/etc/mysql/debian.cnf`) | elke meting |
| Fail2ban | `fail2ban-client status` | 5 min |
| Back-ups | `/var/lib/psa/dumps` en Plesk-back-upsessies, plus eigen mappen (`backup_paths`) | 10 min |
| Updates | `apt-check` / `apt-get -s upgrade` | 1 uur |
| Plesk-domeinen (voor "ontdekken") | `plesk bin site --list` | 1 uur |
| Databasegroottes | `information_schema` | 6 uur |
| WordPress | leest `wp-includes/version.php` en plugin-/thema-headers (voert geen PHP uit) | 6 uur |

Optionele instellingen in `/etc/nb-agent.conf`:

```ini
backup_paths=/backup,/srv/dumps      # eigen back-upmappen (bijv. mariabackup op de databaseserver)
mysql_defaults=/root/.my.cnf         # eigen MySQL-inloggegevens
wordpress=0                          # WordPress-scan uitschakelen
```

> **Let op bij back-ups.** De agent herkent Plesk-back-ups aan de bestanden in `/var/lib/psa/dumps` en aan de
> resultaatbestanden van Plesk-back-upsessies. Bewaar je back-ups alleen extern (FTP/S3) zonder lokale kopie, controleer
> dan op één server of de laatste back-up goed wordt herkend. Gaat dat niet goed, zet back-upbewaking voor die server
> uit (Beheer → Bewerken) of geef met `backup_paths` een map op.

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
| Geen data > 180 s, server wel bereikbaar via TCP | agent gestopt | – |
| Geen data > 180 s, TCP-check mislukt | – | onbereikbaar |
| Laatste back-up ouder dan | 26 uur | 50 uur (of mislukt) |
| Schijf vol binnen (trend 7 dagen) | 14 dagen | 3 dagen |
| Database-verbindingen | 80% | 95% van `max_connections` |
| Replicatie-achterstand | 60 s | 600 s (of gestopt) |
| Langlopende query | 5 min | 30 min |
| Security-updates | alleen tonen (instelbaar) | – |

## Gebruikers en tweestapsverificatie

- Bij de eerste start wordt een beheerder aangemaakt uit `ADMIN_USER` en `ADMIN_PASSWORD` in `.env`. Daarna beheer je
  gebruikers onder **Beheer → Gebruikers**. Wijzigingen in `.env` hebben dan geen effect meer.
- Rollen: **Beheerder** (alles) en **Alleen lezen** (meekijken, bijv. collega's of een tv-scherm).
- 2FA zet je per gebruiker aan onder **Account** (👤 rechtsboven): scan de QR-code met een authenticator-app.
- Wachtwoord van de beheerder kwijt? Zet `RESET_ADMIN_PASSWORD=1` in `.env`, herstart, en zet het daarna weer op `0`.

## Het dashboard zelf bewaken

Als het dashboard uitvalt, krijg je via het dashboard geen meldingen meer. Kies minstens één van deze twee:

1. **Heartbeat** (Beheer → Algemeen): het dashboard roept elke minuut een URL aan van bijvoorbeeld healthchecks.io of een
   Uptime Kuma push-monitor. Blijven de pings uit, dan stuurt die dienst een melding.
2. **Watchdog op een andere server**: `scripts/watchdog.sh` controleert `/api/health`. Die geeft HTTP 503 als er
   5 minuten geen agentdata binnenkomt. Het script meldt via ntfy, e-mail of een webhook:
   ```bash
   */2 * * * * DASH_URL=https://monitor.nextbuzz.nl NTFY_URL=https://ntfy.sh/nextbuzz-alerts-x7k2 /usr/local/bin/serverdash-watchdog.sh
   ```

## Opslag en bewaartermijnen

- Metrics: de eerste 7 dagen (`COMPACT_AFTER_DAYS`) per meting, daarna samengevat tot uurgemiddelden. In totaal worden
  ze 365 dagen bewaard (`RETENTION_DAYS`) in `data/serverdash.db`.
- Processnapshots: elke 60 s per server, gecomprimeerd, 72 uur bewaard.
- Verbruik per abonnement/domein en beveiligingstellers: per uur, 90 dagen.
- Incidenten en meldingen: 365 dagen.
- Wachtwoorden en tokens voor meldingskanalen staan in de database. Zorg dus dat `data/` alleen leesbaar is voor de
  dashboardgebruiker.

Reken voor 26 servers op ongeveer 1–2 GB schijfruimte.

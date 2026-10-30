# ServerDash installeren op een DigitalOcean-droplet met Docker

Deze handleiding zet ServerDash op een eigen droplet. Het dashboard draait in Docker achter Caddy, dat automatisch
een HTTPS-certificaat van Let's Encrypt regelt. Reken op ongeveer een uur, inclusief het koppelen van de eerste server.

```
 Plesk-servers (24×), ns1, db01                      Droplet (Ubuntu 24.04)
 ┌───────────────┐   HTTPS POST /api/ingest   ┌──────────────────────────────────────┐
 │ nb-agent      │ ─────────────────────────▶ │ Caddy :443 ──▶ serverdash :8080       │
 └───────────────┘                            │                 └─ ./data/serverdash.db│
        ▲             TCP-checks (22/443/…)   │                                      │
        └──────────────────────────────────── │                                      │
                                              └──────────────────────────────────────┘
```

**Waarom een droplet en geen App Platform?** ServerDash bewaart alles in één SQLite-bestand. Daarvoor is een vaste
schijf nodig, en die heeft App Platform niet.

**Waarom niet op een van de Plesk-servers?** Als die server uitvalt, wil je dat nog kunnen zien.

## Wat je nodig hebt

- Een DigitalOcean-account.
- Een (sub)domein waarvan je de DNS beheert, bijvoorbeeld `monitor.nextbuzz.nl`.
- Toegang tot de GitHub-repository `r-smink/nb-serverdash`.
- Een SSH-sleutel op je eigen computer. Nog geen sleutel? `ssh-keygen -t ed25519`.

In de voorbeelden staat `monitor.nextbuzz.nl` en IP-adres `203.0.113.10`. Vervang die door je eigen waarden.

---

## 1. Droplet aanmaken

In het DigitalOcean-panel: **Create → Droplets**.

| Instelling | Keuze |
|---|---|
| Image | **Ubuntu 24.04 (LTS) x64** |
| Type | Basic, Regular SSD |
| Grootte | **2 GB RAM / 1 vCPU / 50 GB** (ongeveer $12 per maand). Ruim genoeg voor 26 servers en een jaar historie. |
| Regio | Amsterdam (AMS3). Staan jullie Plesk-servers zelf ook bij DigitalOcean in AMS3? Kies dan liever Frankfurt (FRA1) of Londen (LON1), zodat een storing in één datacenter niet ook het dashboard raakt. |
| Authenticatie | **SSH Key** (geen wachtwoord) |
| Backups | Aanzetten (wekelijks, ongeveer +20% van de dropletprijs) |
| Monitoring | Aanvinken (gratis) |
| Hostname | `serverdash` |

Daarna, onder **Networking → Reserved IPs**: koppel een reserved IP aan de droplet. Dat is gratis zolang het
gekoppeld is. Het voordeel: als je de droplet ooit vervangt, blijft het IP-adres gelijk. Dan hoef je de DNS en de
firewall-uitzonderingen op de Plesk-servers niet aan te passen. Gebruik in de rest van deze handleiding dit IP-adres.

## 2. DNS instellen

Maak bij je DNS-beheerder een **A-record** aan:

```
monitor.nextbuzz.nl.   A   203.0.113.10
```

Controleer op je eigen computer dat het record werkt (dit kan een paar minuten duren):

```bash
nslookup monitor.nextbuzz.nl
```

Doe dit vóór stap 7. Caddy vraagt het certificaat aan bij de eerste start, en dat lukt alleen als het domein al naar
de droplet wijst.

## 3. Droplet beveiligen

Log in als root:

```bash
ssh root@203.0.113.10
```

Systeem bijwerken, tijdzone instellen en automatische beveiligingsupdates aanzetten:

```bash
apt update && apt -y full-upgrade
timedatectl set-timezone Europe/Amsterdam
apt -y install unattended-upgrades git
dpkg-reconfigure -plow unattended-upgrades     # kies "Yes"
```

Een eigen beheergebruiker aanmaken met jouw SSH-sleutel:

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
passwd deploy                                  # wachtwoord voor sudo
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

Firewall: alleen SSH, HTTP en HTTPS open.

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw enable
```

Swap toevoegen. Bij 2 GB RAM voorkomt dit dat het bouwen van de Docker-image vastloopt.

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**Test eerst in een tweede terminal** of `ssh deploy@203.0.113.10` werkt en of `sudo -v` lukt. Zet daarna inloggen
als root en met wachtwoorden uit:

```bash
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
EOF
systemctl restart ssh
```

Vanaf hier werk je als `deploy`.

## 4. Docker installeren

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
exit        # opnieuw inloggen, zodat de groep actief wordt
```

Controleer na opnieuw inloggen:

```bash
docker --version
docker compose version
```

> Lid zijn van de groep `docker` staat gelijk aan root-rechten. Voeg alleen beheerders aan deze groep toe.

> Docker zet zijn eigen firewallregels en gaat daarbij langs ufw. Daarom publiceert `docker-compose.yml` alleen de
> poorten 80 en 443 (Caddy). Het dashboard zelf (poort 8080) is alleen bereikbaar binnen Docker.

## 5. Code ophalen

De repository is privé. Geef de droplet daarom een **deploy key**: een SSH-sleutel die alleen deze ene repository mag
lezen.

```bash
ssh-keygen -t ed25519 -C "serverdash-droplet" -f ~/.ssh/github_serverdash -N ""
cat ~/.ssh/github_serverdash.pub
```

Plak de publieke sleutel in GitHub: **repository → Settings → Deploy keys → Add deploy key**. Laat "Allow write
access" **uit**.

Dan clonen:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_serverdash
EOF
sudo mkdir -p /opt/serverdash && sudo chown deploy:deploy /opt/serverdash
git clone git@github.com:r-smink/nb-serverdash.git /opt/serverdash
cd /opt/serverdash
```

## 6. Configuratie (`.env`)

Genereer eerst een sterk wachtwoord voor de eerste beheerder:

```bash
openssl rand -base64 18
```

Maak dan `/opt/serverdash/.env` aan:

```bash
cp .env.example .env
nano .env
```

Vul deze waarden in. De rest mag blijven staan.

```ini
ADMIN_USER=admin
ADMIN_PASSWORD=<het gegenereerde wachtwoord>
RESET_ADMIN_PASSWORD=0

PUBLIC_URL=https://monitor.nextbuzz.nl
DOMAIN=monitor.nextbuzz.nl
ACME_EMAIL=beheer@nextbuzz.nl
```

`HOST`, `PORT`, `DATA_DIR`, `TRUST_PROXY` en `SECURE_COOKIE` zet `docker-compose.yml` zelf goed; wat er in `.env` staat
wordt voor die waarden genegeerd.

Rechten instellen. De container draait als gebruiker `node` (uid 1000) en moet in `data/` kunnen schrijven.

```bash
chmod 600 .env
mkdir -p data && sudo chown 1000:1000 data && sudo chmod 700 data
```

> `data/` bevat de database, met daarin ook de wachtwoorden en tokens van de meldingskanalen. Kopieer **niet** de
> `data/` van je eigen computer: daar staat de demo-data van de simulator in. Begin op de droplet met een lege map.

## 7. Starten

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

In de logs zie je `ServerDash draait op http://0.0.0.0:8080`. Van Caddy zie je `certificate obtained successfully`.
Stop het meekijken met Ctrl+C.

Controleer van buitenaf:

```bash
curl -s https://monitor.nextbuzz.nl/api/health
# {"ok":true,"servers":0,...}
```

Open nu `https://monitor.nextbuzz.nl` en log in met `admin` en het wachtwoord uit `.env`. Doe meteen het volgende:

1. **Account** (rechtsboven): zet tweestapsverificatie aan.
2. **Beheer → Gebruikers**: maak accounts aan voor je collega's. Gebruik "Alleen lezen" voor wie alleen meekijkt.
3. Haal `ADMIN_PASSWORD` uit `.env` (laat het leeg). Het is alleen nodig bij de allereerste start.

## 8. Servers koppelen

Doe dit per server.

1. In het dashboard: **Beheer → + Server toevoegen**. Kies het type (Plesk, nameserver, database) en kopieer het
   installatiecommando dat verschijnt.
2. Voer het commando uit op de server zelf, als root:
   ```bash
   curl -fsSL https://monitor.nextbuzz.nl/agent/install.sh | sudo bash -s -- --url https://monitor.nextbuzz.nl --token <TOKEN>
   ```
3. Binnen 30 seconden wordt de tegel groen. Om te zien wat de agent meet: `python3 /opt/nb-agent/nb-agent.py --print`.

Begin met **één** Plesk-server en controleer daar de panelen Back-ups, Updates, Database en Beveiliging. Klopt
alles, rol de agent dan uit naar de rest.

### Firewall en Fail2ban op de bewaakte servers

De agent stuurt zelf data naar buiten (uitgaand verkeer naar poort 443). Daarvoor hoeft er op de servers niets open.

Het dashboard doet daarnaast elke minuut een **TCP-check** op de servers. Dit zijn de standaardpoorten per type:

| Type | Poorten |
|---|---|
| Plesk | 443, 8443 |
| Nameserver | 53 |
| Database | 3306 |
| Overig | 22 |

Doe daarom op elke server het volgende:

- **Fail2ban:** zet het IP-adres van de droplet bij de vertrouwde adressen, zodat de checks nooit tot een ban leiden.
  In Plesk: **Tools & Settings → IP Address Banning → Trusted IP Addresses**. Zonder Plesk: voeg het IP toe aan
  `ignoreip` in `/etc/fail2ban/jail.local`.
- **Firewall:** staat 3306 op de databaseserver alleen open voor de webservers (dat is goed), sta dan ook het
  droplet-IP toe op 3306. Of verander bij die server de check-poorten naar `22` (**Beheer → Bewerken →
  Bereikbaarheid & back-ups**). Hetzelfde geldt voor 8443 als jullie het Plesk-panel afschermen.

Zonder deze aanpassing meldt het dashboard "onbereikbaar", terwijl de server gewoon draait.

## 9. Meldingen en bewaking van het dashboard zelf

**Meldingen** (**Beheer → Meldingen**): vul minstens één kanaal in, bijvoorbeeld e-mail of ntfy. Klik op **Test versturen** om
te controleren of het werkt.

Valt het dashboard zelf uit, dan krijg je via het dashboard geen meldingen meer. Zet daarom **allebei** het volgende
aan:

1. **Heartbeat.** Maak een gratis check aan op [healthchecks.io](https://healthchecks.io) (periode 1 minuut, grace
   5 minuten). Plak de ping-URL in **Beheer → Algemeen → Heartbeat-URL**. Stopt het dashboard, dan mailt
   healthchecks.io je.
2. **Watchdog vanaf een andere server**, bijvoorbeeld de nameserver. Deze controleert ook of er nog agentdata
   binnenkomt:
   ```bash
   sudo curl -fsSL -o /usr/local/bin/serverdash-watchdog.sh \
     https://raw.githubusercontent.com/r-smink/nb-serverdash/main/scripts/watchdog.sh   # of kopieer het bestand met scp
   sudo chmod +x /usr/local/bin/serverdash-watchdog.sh
   sudo crontab -e
   # toevoegen:
   */2 * * * * DASH_URL=https://monitor.nextbuzz.nl NTFY_URL=https://ntfy.sh/<geheim-topic> /usr/local/bin/serverdash-watchdog.sh
   ```
   Omdat de repository privé is, werkt de `raw.githubusercontent.com`-link niet zonder token. Kopieer het bestand dan
   met `scp` vanaf de droplet (`/opt/serverdash/scripts/watchdog.sh`).

## 10. Back-ups van de database

DigitalOcean Backups (stap 1) maakt wekelijks een kopie van de hele droplet. Een kopie kan dus tot een week oud zijn.
Maak daarom ook elke nacht een kopie van de database:

```bash
crontab -e
# toevoegen (03:15 elke nacht, bewaar de laatste 14 kopieën):
15 3 * * * cd /opt/serverdash && docker compose exec -T serverdash node scripts/backup.js 14 >> /opt/serverdash/backup.log 2>&1
```

Test het eenmalig met de hand:

```bash
cd /opt/serverdash && docker compose exec -T serverdash node scripts/backup.js
ls -lh data/backups/
```

De kopieën staan in `data/backups/`. Die map zit dus ook in de wekelijkse droplet-back-up. Wil je ze ook buiten
DigitalOcean bewaren? Kopieer ze dan met `rclone` naar een Space of een andere opslag.

**Terugzetten:**

```bash
cd /opt/serverdash
docker compose stop serverdash
sudo cp data/backups/serverdash-20261030-0315.db data/serverdash.db
sudo rm -f data/serverdash.db-wal data/serverdash.db-shm
sudo chown 1000:1000 data/serverdash.db
docker compose start serverdash
```

## 11. Updaten

Als er een nieuwe versie in GitHub staat:

```bash
cd /opt/serverdash
git pull
docker compose up -d --build
docker image prune -f
```

Het dashboard is daarbij een paar seconden offline. De agents proberen het dan bij de volgende ronde gewoon opnieuw;
er gaat hooguit één meting verloren.

Is `agent/nb-agent.py` gewijzigd? Voer dan op elke server het installatiecommando opnieuw uit. Het bestaande token
blijft geldig:

```bash
curl -fsSL https://monitor.nextbuzz.nl/agent/install.sh | sudo bash -s -- --url https://monitor.nextbuzz.nl \
  --token "$(grep ^token= /etc/nb-agent.conf | cut -d= -f2)"
```

## 12. Handige commando's

Alle commando's voer je uit vanuit `/opt/serverdash`.

| Wat | Commando |
|---|---|
| Status van de containers | `docker compose ps` |
| Logs van het dashboard | `docker compose logs -f serverdash` |
| Logs van Caddy (certificaten) | `docker compose logs -f caddy` |
| Dashboard herstarten | `docker compose restart serverdash` |
| Ruimte die de database inneemt | `sudo du -sh data/` |
| Vrije schijfruimte | `df -h /` |

**Beheerderswachtwoord kwijt?**

1. Zet in `.env` `ADMIN_PASSWORD=<nieuw wachtwoord>` en `RESET_ADMIN_PASSWORD=1`.
2. Voer `docker compose up -d` uit. De container start opnieuw met de nieuwe instellingen. 2FA staat daarna uit
   voor dit account.
3. Log in en zet 2FA weer aan.
4. Zet `RESET_ADMIN_PASSWORD=0`, haal het wachtwoord weer uit `.env` en voer nogmaals `docker compose up -d` uit.

## 13. Problemen oplossen

| Probleem | Oorzaak en oplossing |
|---|---|
| Caddy krijgt geen certificaat | Het A-record wijst nog niet naar de droplet, of poort 80 of 443 is dicht. Controleer `nslookup` en `sudo ufw status`, en bekijk `docker compose logs caddy`. |
| Browser toont "502 Bad Gateway" | De container `serverdash` draait niet. Bekijk `docker compose logs serverdash`. Vaak is het een rechtenprobleem op `data/` (zie stap 6). |
| `SQLITE_CANTOPEN` of `permission denied` in de logs | Voer `sudo chown -R 1000:1000 data` uit. |
| Inloggen lukt, maar je komt steeds terug op het loginscherm | Je opent het dashboard via `http://` of via het IP-adres. Gebruik `https://monitor.nextbuzz.nl`. |
| Agent geeft `401` in `journalctl -u nb-agent` | Het token klopt niet, of de server is in het dashboard verwijderd. Klik in Beheer op **Nieuw token** en installeer opnieuw. |
| Server staat op "agent stopt" | De TCP-check werkt, maar er komt geen data. Bekijk op die server `systemctl status nb-agent` en `journalctl -u nb-agent -n 50`. |
| Server staat op "onbereikbaar", terwijl hij draait | De firewall of Fail2ban blokkeert het droplet-IP (zie stap 8), of de check-poorten kloppen niet. |
| `/api/health` geeft 503 | Er is 5 minuten geen agentdata binnengekomen. Controleer of de droplet uitgaand kan verbinden en of de agents draaien. |
| Bouwen van de image stopt met "Killed" | Te weinig geheugen. Controleer of er swap is (`free -h`, zie stap 3). |

## Checklist

- [ ] Droplet met SSH-sleutel, Backups aan, reserved IP gekoppeld
- [ ] A-record wijst naar het reserved IP
- [ ] ufw actief (22, 80, 443); inloggen als root en met wachtwoord uitgeschakeld
- [ ] `.env` ingevuld, `chmod 600`; `data/` eigendom van 1000:1000
- [ ] `https://monitor.nextbuzz.nl` werkt met een geldig certificaat
- [ ] 2FA aan voor de beheerder; collega's hebben een eigen account
- [ ] `ADMIN_PASSWORD` weer uit `.env` gehaald
- [ ] Eerste Plesk-server gekoppeld en gecontroleerd, daarna de rest
- [ ] Droplet-IP vertrouwd in Fail2ban en waar nodig toegestaan in de firewall op de servers
- [ ] Minstens één meldingskanaal getest
- [ ] Heartbeat (healthchecks.io) en watchdog ingesteld
- [ ] Nachtelijke database-back-up in cron, één keer met de hand getest

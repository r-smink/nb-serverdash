#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NextBuzz ServerDash agent.

Verzamelt elke <interval> seconden systeemstatistieken uit /proc, systemd, de
Plesk-logs en (indien aanwezig) MySQL/MariaDB en stuurt die als JSON naar het
dashboard. Trage controles (updates, back-ups, WordPress, databasegroottes)
draaien in een achtergrondthread. Geen externe afhankelijkheden; werkt met de
standaard python3 van Ubuntu 18.04 en nieuwer.

Gebruik:
  nb-agent.py            draai als service (doorlopend)
  nb-agent.py --once     verzamel en verstuur één meting (test)
  nb-agent.py --print    verzamel één meting incl. trage controles en toon de JSON (niets versturen)

Optionele instellingen in /etc/nb-agent.conf:
  backup_paths=/backup,/srv/dumps     mappen met eigen back-ups (nieuwste bestand telt)
  mysql_defaults=/root/.my.cnf        inloggegevens voor MySQL/MariaDB
  wordpress=0                         WordPress-scan uitschakelen
"""
import collections
import glob
import json
import os
import platform
import pwd
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

VERSION = '1.2.0'
CONF_FILE = os.environ.get('NB_AGENT_CONF', '/etc/nb-agent.conf')
HZ = os.sysconf('SC_CLK_TCK')
PAGE = os.sysconf('SC_PAGE_SIZE')

REAL_FS = {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'jfs', 'reiserfs', 'f2fs'}
SKIP_DISKS = re.compile(r'^(loop|ram|zram|sr|fd|dm-|md|nbd)')
SKIP_NICS = ('lo', 'veth', 'docker', 'br-', 'virbr')
WATCH_SERVICES = {
    'sw-cp-server', 'sw-engine', 'nginx', 'apache2', 'httpd', 'mariadb', 'mysql', 'mysqld', 'postgresql',
    'postfix', 'dovecot', 'named', 'bind9', 'named-chroot', 'pdns', 'fail2ban', 'cron', 'ssh', 'sshd',
    'psa-spamassassin', 'spamassassin', 'clamav-daemon', 'redis-server', 'memcached',
}
PHP_FPM_RE = re.compile(r'^(plesk-php\d+-fpm|php\d+\.\d+-fpm)$')
MAILQ_DIRS = ['/var/spool/postfix/deferred', '/var/spool/postfix/active',
              '/var/spool/postfix/incoming', '/var/spool/postfix/maildrop']
MAILQ_CAP = 100000
VHOSTS = '/var/www/vhosts'
VHOST_SKIP = {'system', 'default', 'chroot', 'fs', 'fs-passwd', '.skel'}
DOMAIN_RE = re.compile(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
# Combined log format: ip - - [tijd] "METHOD pad HTTP/x" status bytes "referer" "user-agent"
LOG_RE = re.compile(r'^(\S+) \S+ \S+ \[[^\]]*\] "(?:(\S+) (\S+)[^"]*|[^"]*)" (\d{3}) (\d+|-)(?: "[^"]*" "([^"]*)")?')
LOG_MAX_BYTES = 20 * 1024 * 1024   # max. per logbestand per meting
DU_INTERVAL = 6 * 3600
AUTH_LOGS = ['/var/log/auth.log', '/var/log/secure']
SSH_FAIL_RE = re.compile(r'sshd\[\d+\]: (Failed password|Invalid user|Failed publickey)')
MODSEC_LOGS = ['/var/log/modsec_audit.log', '/var/log/apache2/modsec_audit.log']
MODSEC_ENTRY_RE = re.compile(r'^--[0-9a-f]+-A--$|"transaction":')
WP_SKIP_DIRS = {'wp-content', 'wp-includes', 'wp-admin', 'node_modules', 'vendor', '.git', 'logs', 'cgi-bin',
                'error_docs', '.cache', 'tmp', 'cache', 'backup', 'backups', 'private'}
HEAVY_RESEND = 6 * 3600


def log(msg):
    sys.stderr.write('[nb-agent] %s\n' % msg)
    sys.stderr.flush()


def read(path):
    with open(path) as f:
        return f.read()


def read_head(path, size=8192):
    with open(path, 'rb') as f:
        return f.read(size).decode('utf-8', 'replace')


def run2(args, timeout=15, env=None):
    """Voert een commando uit; geeft (returncode, stdout, stderr)."""
    try:
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, env=env)
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err
    except subprocess.TimeoutExpired:
        p.kill()
        return -1, '', 'timeout'
    except Exception as e:  # commando bestaat niet, etc.
        return -1, '', str(e)


def run(args, timeout=15):
    return run2(args, timeout)[1]


def load_conf():
    conf = {'url': '', 'token': '', 'interval': '30', 'insecure': '0'}
    try:
        content = read(CONF_FILE)
    except (IOError, OSError):
        sys.exit('Configuratiebestand %s niet gevonden' % CONF_FILE)
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        conf[k.strip().lower()] = v.strip().strip('"\'')
    if not conf['url'] or not conf['token']:
        sys.exit('url en token zijn verplicht in %s' % CONF_FILE)
    conf['url'] = conf['url'].rstrip('/')
    conf['interval'] = max(10, int(conf['interval']))
    conf['insecure'] = conf['insecure'].lower() in ('1', 'true', 'yes')
    return conf


def load_conf_optional():
    try:
        return load_conf()
    except SystemExit:
        return {}


class Collector(object):
    def __init__(self, conf=None):
        self.conf = conf or {}
        self.prev_t = None
        self.prev_cpu = None
        self.prev_disk = None
        self.prev_net = None
        self.prev_procs = {}
        self.prev_mysql = None
        self.usernames = {}
        self.enabled = set()
        self.enabled_at = 0
        self.cpu_model = self._cpu_model()
        self.sites = []            # domeinen die het dashboard gedetailleerd wil meten
        self.last_rows = []
        self.log_pos = {}          # logbestand -> (inode, offset)
        self.site_info = {}        # domein -> (tijd, gebruiker, docroot)
        self.du_cache = {}         # pad -> (tijd, bytes)
        self.du_paths = []
        self.du_busy = False
        self.slow = SlowTasks(self)

    # ---------- statische info ----------

    @staticmethod
    def _cpu_model():
        try:
            for line in read('/proc/cpuinfo').splitlines():
                if line.startswith('model name'):
                    return line.split(':', 1)[1].strip()
        except (IOError, OSError):
            pass
        return ''

    @staticmethod
    def system_info(uptime):
        info = {
            'hostname': socket.getfqdn() or platform.node(),
            'kernel': platform.release(),
            'os': '',
            'plesk': None,
            'uptime': int(uptime),
            'reboot_required': os.path.exists('/var/run/reboot-required'),
        }
        try:
            for line in read('/etc/os-release').splitlines():
                if line.startswith('PRETTY_NAME='):
                    info['os'] = line.split('=', 1)[1].strip('"')
        except (IOError, OSError):
            pass
        try:
            info['plesk'] = read('/usr/local/psa/version').split()[0]
        except (IOError, OSError, IndexError):
            pass
        return info

    # ---------- tellers ----------

    @staticmethod
    def cpu_times():
        parts = read('/proc/stat').splitlines()[0].split()[1:9]
        return [int(x) for x in parts] + [0] * (8 - len(parts))

    @staticmethod
    def disk_counters():
        out = {}
        for line in read('/proc/diskstats').splitlines():
            f = line.split()
            if len(f) < 14 or SKIP_DISKS.match(f[2]) or not os.path.exists('/sys/block/%s' % f[2]):
                continue
            # reads, sectors read, writes, sectors written, ms doing io
            out[f[2]] = (int(f[3]), int(f[5]), int(f[7]), int(f[9]), int(f[12]))
        return out

    @staticmethod
    def net_counters():
        rx = tx = 0
        for line in read('/proc/net/dev').splitlines()[2:]:
            name, data = line.split(':', 1)
            name = name.strip()
            if name.startswith(SKIP_NICS):
                continue
            f = data.split()
            rx += int(f[0])
            tx += int(f[8])
        return rx, tx

    # ---------- metingen ----------

    @staticmethod
    def memory():
        m = {}
        for line in read('/proc/meminfo').splitlines():
            k, v = line.split(':', 1)
            m[k] = int(v.split()[0]) * 1024
        total = m.get('MemTotal', 0)
        avail = m.get('MemAvailable', m.get('MemFree', 0) + m.get('Cached', 0))
        used = total - avail
        swap_total = m.get('SwapTotal', 0)
        swap_used = swap_total - m.get('SwapFree', 0)
        return {
            'total': total, 'used': used, 'available': avail, 'buffers': m.get('Buffers', 0),
            'cached': m.get('Cached', 0) + m.get('SReclaimable', 0),
            'pct': round(used * 100.0 / total, 1) if total else 0,
            'swap_total': swap_total, 'swap_used': swap_used,
            'swap_pct': round(swap_used * 100.0 / swap_total, 1) if swap_total else 0,
        }

    @staticmethod
    def disks():
        res = []
        seen = set()
        for line in read('/proc/mounts').splitlines():
            f = line.split()
            if len(f) < 3 or f[2] not in REAL_FS:
                continue
            dev, mnt = f[0], f[1].replace('\\040', ' ')
            if dev in seen or mnt.startswith('/snap'):
                continue
            seen.add(dev)
            try:
                st = os.statvfs(mnt)
            except OSError:
                continue
            total = st.f_blocks * st.f_frsize
            used = (st.f_blocks - st.f_bfree) * st.f_frsize
            avail = st.f_bavail * st.f_frsize
            if total <= 0:
                continue
            ipct = None
            if st.f_files > 0:
                ipct = round((st.f_files - st.f_ffree) * 100.0 / st.f_files, 1)
            res.append({
                'mount': mnt, 'device': dev, 'fs': f[2], 'total': total, 'used': used,
                'pct': round(used * 100.0 / (used + avail), 1) if used + avail else 0, 'inodes_pct': ipct,
            })
        return res

    def username(self, uid):
        if uid not in self.usernames:
            try:
                self.usernames[uid] = pwd.getpwuid(uid).pw_name
            except KeyError:
                self.usernames[uid] = str(uid)
        return self.usernames[uid]

    def processes(self, dt, uptime, mem_total):
        cur = {}
        rows = []
        running = 0
        for entry in os.listdir('/proc'):
            if not entry.isdigit():
                continue
            pid = int(entry)
            try:
                stat = read('/proc/%d/stat' % pid)
                rp = stat.rfind(')')
                comm = stat[stat.find('(') + 1:rp]
                f = stat[rp + 2:].split()
                state, ppid = f[0], int(f[1])
                ticks = int(f[11]) + int(f[12])
                threads, start, rss = int(f[17]), int(f[19]), int(f[21]) * PAGE
                uid = os.stat('/proc/%d' % pid).st_uid
                with open('/proc/%d/cmdline' % pid, 'rb') as fh:
                    cmd = fh.read(1024).replace(b'\0', b' ').decode('utf-8', 'replace').strip()
            except (IOError, OSError, IndexError, ValueError):
                continue
            rio = wio = None
            try:
                for line in read('/proc/%d/io' % pid).splitlines():
                    if line.startswith('read_bytes:'):
                        rio = int(line.split()[1])
                    elif line.startswith('write_bytes:'):
                        wio = int(line.split()[1])
            except (IOError, OSError, ValueError):
                pass

            age = max(0.0, uptime - start / float(HZ))
            cpu = rrate = wrate = 0.0
            prev = self.prev_procs.get(pid)
            if prev and prev[0] == start and dt > 0:
                cpu = max(0.0, (ticks - prev[1]) * 100.0 / HZ / dt)
                if rio is not None and prev[2] is not None:
                    rrate = max(0.0, (rio - prev[2]) / dt)
                if wio is not None and prev[3] is not None:
                    wrate = max(0.0, (wio - prev[3]) / dt)
            elif dt > 0 and 0 < age < dt:
                # gestart tijdens dit interval: gemiddelde sinds start
                cpu = ticks * 100.0 / HZ / age
                rrate = (rio or 0) / age
                wrate = (wio or 0) / age
            cur[pid] = (start, ticks, rio, wio)

            kernel_thread = not cmd and (ppid == 2 or pid == 2)
            if kernel_thread and cpu < 1:
                continue
            if state == 'R':
                running += 1
            rows.append({
                'pid': pid, 'ppid': ppid, 'user': self.username(uid), 'name': comm,
                'cmd': (cmd or '[%s]' % comm)[:400], 'cpu': round(cpu, 1), 'rss': rss,
                'mem': round(rss * 100.0 / mem_total, 1) if mem_total else 0,
                'rio': round(rrate), 'wio': round(wrate), 'ctime': round(ticks / float(HZ), 1),
                'age': int(age), 'thr': threads, 'st': state,
            })
        self.prev_procs = cur
        self.last_rows = rows

        # Selectie die we meesturen: zwaarste processen op verschillende assen.
        def top(key, n, cond=None):
            src = [r for r in rows if cond is None or cond(r)]
            return sorted(src, key=key, reverse=True)[:n]

        selected = {}
        groups = (
            top(lambda r: r['cpu'], 25),
            top(lambda r: r['rss'], 15),
            top(lambda r: r['rio'] + r['wio'], 10),
            top(lambda r: r['ctime'], 10),
            top(lambda r: r['age'], 15, lambda r: r['age'] >= 600 and (r['cpu'] >= 1 or r['rio'] + r['wio'] >= 1024)),
        )
        for group in groups:
            for r in group:
                selected[r['pid']] = r

        users = {}
        for r in rows:
            u = users.setdefault(r['user'], {'user': r['user'], 'procs': 0, 'cpu': 0.0, 'rss': 0, 'rio': 0, 'wio': 0})
            u['procs'] += 1
            u['cpu'] += r['cpu']
            u['rss'] += r['rss']
            u['rio'] += r['rio']
            u['wio'] += r['wio']
        user_list = sorted(users.values(), key=lambda u: (u['cpu'], u['rss']), reverse=True)[:40]
        for u in user_list:
            u['cpu'] = round(u['cpu'], 1)

        return {'total': len(rows), 'running': running, 'list': list(selected.values()), 'users': user_list}

    def services(self):
        now = time.time()
        if now - self.enabled_at > 300:
            enabled = set()
            for line in run(['systemctl', 'list-unit-files', '--type=service', '--no-legend', '--no-pager']).splitlines():
                f = line.split()
                if len(f) >= 2 and f[1] in ('enabled', 'enabled-runtime') and f[0].endswith('.service'):
                    enabled.add(f[0][:-8])
            self.enabled = enabled
            self.enabled_at = now

        states = {}
        failed = []
        for line in run(['systemctl', 'list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain']).splitlines():
            f = line.split()
            if len(f) < 4 or not f[0].endswith('.service'):
                continue
            states[f[0][:-8]] = f[2]
            if f[2] == 'failed':
                failed.append(f[0])

        watched = {}
        for name in sorted(self.enabled):
            if name in WATCH_SERVICES or PHP_FPM_RE.match(name):
                state = states.get(name)
                if state is None:  # alias (bijv. mysql -> mariadb): los opvragen
                    state = run(['systemctl', 'is-active', name + '.service']).strip() or 'unknown'
                watched[name] = state
        return watched, failed

    @staticmethod
    def mailq():
        if not os.path.isdir('/var/spool/postfix'):
            return None
        n = 0
        for d in MAILQ_DIRS:
            for _, _, files in os.walk(d):
                n += len(files)
                if n >= MAILQ_CAP:
                    return n
        return n

    # ---------- logbestanden ----------

    def read_new_lines(self, path):
        """Nieuwe regels sinds de vorige meting. De eerste keer begint hij aan het eind."""
        try:
            st = os.stat(path)
        except OSError:
            return [], False
        prev = self.log_pos.get(path)
        if prev is None:
            self.log_pos[path] = (st.st_ino, st.st_size)
            return [], False
        ino, pos = prev
        if st.st_ino != ino or st.st_size < pos:   # logrotatie
            pos = 0
        if st.st_size == pos:
            return [], False
        truncated = st.st_size - pos > LOG_MAX_BYTES
        if truncated:
            pos = st.st_size - LOG_MAX_BYTES
        with open(path, 'rb') as fh:
            fh.seek(pos)
            data = fh.read(st.st_size - pos)
        end = data.rfind(b'\n')
        if end < 0:
            self.log_pos[path] = (st.st_ino, pos)
            return [], truncated
        self.log_pos[path] = (st.st_ino, pos + end + 1)
        return data[:end].decode('utf-8', 'replace').splitlines(), truncated

    def scan_logs(self, dt):
        """Leest de nieuwe regels uit de access-logs van alle Plesk-domeinen.

        Per domein: requests, bytes, statuscodes en inlogpogingen op WordPress.
        Voor de domeinen die het dashboard bewaakt ook populairste URL's, IP's en user-agents.
        """
        base = os.path.join(VHOSTS, 'system')
        try:
            domains = os.listdir(base)
        except OSError:
            return {}
        detailed = set(self.sites)
        result = {}
        for domain in domains:
            if not DOMAIN_RE.match(domain):
                continue
            logdir = os.path.join(base, domain, 'logs')
            # nginx (proxy_*) ziet alle requests, ook statische bestanden; anders de Apache-logs
            files = [os.path.join(logdir, f) for f in ('proxy_access_ssl_log', 'proxy_access_log')]
            if not any(os.path.exists(f) for f in files):
                files = [os.path.join(logdir, f) for f in ('access_ssl_log', 'access_log')]
            detail = domain in detailed
            st = {'req': 0, 'bytes': 0, 'status': [0, 0, 0, 0], 'wpl': 0, 'xml': 0, 'truncated': False,
                  'log': os.path.basename(files[0]).replace('_ssl', '')}
            if detail:
                st['paths'] = collections.Counter()
                st['ips'] = collections.Counter()
                st['agents'] = collections.Counter()
            for f in files:
                lines, trunc = self.read_new_lines(f)
                st['truncated'] = st['truncated'] or trunc
                for line in lines:
                    m = LOG_RE.match(line)
                    if not m:
                        continue
                    ip, method, path, code, size, agent = m.groups()
                    st['req'] += 1
                    code = int(code)
                    if 200 <= code < 600:
                        st['status'][code // 100 - 2] += 1
                    if size != '-':
                        st['bytes'] += int(size)
                    if method == 'POST' and path:
                        if path.startswith('/wp-login.php'):
                            st['wpl'] += 1
                        elif path.startswith('/xmlrpc.php'):
                            st['xml'] += 1
                    if detail:
                        st['ips'][ip] += 1
                        if path:
                            st['paths'][path.split('?', 1)[0][:200]] += 1
                        if agent:
                            st['agents'][agent[:160]] += 1
            result[domain] = st
        return result

    def count_new(self, paths, regex):
        n = 0
        found = False
        for p in paths:
            if not os.path.exists(p):
                continue
            found = True
            lines, _ = self.read_new_lines(p)
            n += sum(1 for line in lines if regex.search(line))
        return n if found else None

    # ---------- websites (Plesk) ----------

    def site_meta(self, domain):
        """Systeemgebruiker en documentroot van een Plesk-domein (10 min gecachet)."""
        cached = self.site_info.get(domain)
        if cached and time.time() - cached[0] < 600:
            return cached[1], cached[2]
        user = docroot = None
        try:
            text = read(os.path.join(VHOSTS, 'system', domain, 'conf', 'last_httpd.conf'))
            m = re.search(r'(?:SuexecUserGroup|AssignUserID)\s+"?([\w.-]+)', text)
            if m:
                user = m.group(1)
            m = re.search(r'DocumentRoot\s+"?([^"\s]+)', text)
            if m:
                docroot = m.group(1)
        except (IOError, OSError):
            pass
        if not user:
            pools = glob.glob('/opt/plesk/php/*/etc/php-fpm.d/%s.conf' % domain) + glob.glob('/etc/php/*/fpm/pool.d/%s.conf' % domain)
            for pool in pools:
                try:
                    m = re.search(r'^\s*user\s*=\s*(\S+)', read(pool), re.M)
                    if m:
                        user = m.group(1)
                        break
                except (IOError, OSError):
                    pass
        if not user:
            try:
                uid = os.stat(os.path.join(VHOSTS, domain)).st_uid
                if uid:
                    user = self.username(uid)
            except OSError:
                pass
        self.site_info[domain] = (time.time(), user, docroot)
        return user, docroot

    def _du_worker(self, paths):
        try:
            for p in paths:
                out = run(['nice', '-n', '19', 'ionice', '-c3', 'du', '-sb', p], timeout=900)
                try:
                    self.du_cache[p] = (time.time(), int(out.split()[0]))
                except (IndexError, ValueError):
                    self.du_cache[p] = (time.time(), None)
        finally:
            self.du_busy = False

    def refresh_disk_usage(self):
        """Start op de achtergrond `du` voor sites waarvan de meting ouder is dan 6 uur."""
        now = time.time()
        stale = [p for p in self.du_paths if now - self.du_cache.get(p, (0, None))[0] > DU_INTERVAL]
        if stale and not self.du_busy:
            self.du_busy = True
            t = threading.Thread(target=self._du_worker, args=(stale,))
            t.daemon = True
            t.start()

    def site_stats(self, dt, logs):
        out = {}
        du_paths = []
        per_min = 60.0 / dt if dt > 0 else 0
        for domain in [d for d in self.sites if DOMAIN_RE.match(d)]:
            if not os.path.isdir(os.path.join(VHOSTS, 'system', domain)):
                out[domain] = {'found': False}
                continue
            user, docroot = self.site_meta(domain)
            pool = 'pool %s' % domain
            procs = [r for r in self.last_rows
                     if r['cmd'].endswith(pool) or (pool + ' ') in r['cmd']
                     or (user and r['user'] == user and 'php-fpm: pool' not in r['cmd'])]
            home = os.path.join(VHOSTS, domain)
            disk_path = home if os.path.isdir(home) and not os.path.islink(home) else docroot
            if disk_path:
                du_paths.append(disk_path)
            lg = logs.get(domain) or {'req': 0, 'bytes': 0, 'status': [0, 0, 0, 0], 'log': None, 'truncated': False}
            out[domain] = {
                'found': True, 'user': user, 'docroot': docroot,
                'cpu': round(sum(r['cpu'] for r in procs), 1),
                'rss': sum(r['rss'] for r in procs),
                'rio': sum(r['rio'] for r in procs), 'wio': sum(r['wio'] for r in procs),
                'procs': len(procs),
                'top': sorted(procs, key=lambda r: (r['cpu'], r['rss']), reverse=True)[:15],
                'disk': self.du_cache.get(disk_path, (0, None))[1] if disk_path else None,
                'req': lg['req'], 'rpm': round(lg['req'] * per_min, 1),
                'bw': round(lg['bytes'] / dt) if dt > 0 else 0,
                's2': round(lg['status'][0] * per_min, 1), 's3': round(lg['status'][1] * per_min, 1),
                's4': round(lg['status'][2] * per_min, 1), 's5': round(lg['status'][3] * per_min, 1),
                'paths': lg['paths'].most_common(15) if 'paths' in lg else [],
                'ips': lg['ips'].most_common(15) if 'ips' in lg else [],
                'agents': lg['agents'].most_common(8) if 'agents' in lg else [],
                'log': lg['log'], 'log_truncated': lg['truncated'],
            }
        self.du_paths = du_paths
        self.refresh_disk_usage()
        return out

    # ---------- MySQL / MariaDB ----------

    def mysql_cmd(self, sql, vertical=False, timeout=20):
        args = ['mysql']
        env = None
        if self.conf.get('mysql_defaults'):
            args.append('--defaults-file=%s' % self.conf['mysql_defaults'])
        elif os.path.exists('/etc/psa/.psa.shadow'):
            env = dict(os.environ, MYSQL_PWD=read('/etc/psa/.psa.shadow').strip())
            args.append('-uadmin')
        elif os.path.exists('/etc/mysql/debian.cnf'):
            args.append('--defaults-file=/etc/mysql/debian.cnf')
        args.append('--connect-timeout=5')
        args += ['-e', sql] if vertical else ['-N', '-B', '-e', sql]
        rc, out, err = run2(args, timeout, env)
        if rc != 0:
            lines = [l for l in (err or '').strip().splitlines() if l.strip()]
            raise RuntimeError(lines[-1][:200] if lines else 'mysql gaf foutcode %s' % rc)
        return out

    def mysql(self, dt):
        if not any(r['name'] in ('mysqld', 'mariadbd') for r in self.last_rows):
            return None
        try:
            status = {}
            for line in self.mysql_cmd(
                    "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Questions',"
                    "'Slow_queries','Uptime','Aborted_connects','Innodb_buffer_pool_reads',"
                    "'Innodb_buffer_pool_read_requests','Max_used_connections')").splitlines():
                if '\t' in line:
                    k, v = line.split('\t', 1)
                    status[k] = v.strip()
            variables = {}
            for line in self.mysql_cmd("SHOW GLOBAL VARIABLES WHERE Variable_name IN "
                                       "('max_connections','version','slow_query_log','long_query_time')").splitlines():
                if '\t' in line:
                    k, v = line.split('\t', 1)
                    variables[k] = v.strip()
            questions = int(status.get('Questions', 0))
            slow = int(status.get('Slow_queries', 0))
            qps = slow_rate = 0.0
            if self.prev_mysql and dt > 0:
                qps = max(0.0, (questions - self.prev_mysql[0]) / dt)
                slow_rate = max(0.0, (slow - self.prev_mysql[1]) * 60.0 / dt)
            self.prev_mysql = (questions, slow)
            reads = float(status.get('Innodb_buffer_pool_reads', 0))
            requests = float(status.get('Innodb_buffer_pool_read_requests', 0)) or 1.0

            long_q = []
            for line in self.mysql_cmd(
                    "SELECT ID, USER, IFNULL(DB,''), TIME, IFNULL(STATE,''), "
                    "LEFT(REPLACE(REPLACE(REPLACE(IFNULL(INFO,''),'\\n',' '),'\\r',' '),'\\t',' '),300) "
                    "FROM information_schema.PROCESSLIST WHERE COMMAND NOT IN ('Sleep','Daemon','Binlog Dump','Binlog Dump GTID') "
                    "AND USER NOT IN ('system user','event_scheduler') AND ID <> CONNECTION_ID() ORDER BY TIME DESC LIMIT 15").splitlines():
                f = line.split('\t')
                if len(f) >= 6:
                    long_q.append({'id': int(f[0]), 'user': f[1], 'db': f[2], 'time': int(f[3] or 0), 'state': f[4], 'info': f[5]})
            users = []
            for line in self.mysql_cmd("SELECT USER, COUNT(*) FROM information_schema.PROCESSLIST "
                                       "GROUP BY USER ORDER BY 2 DESC LIMIT 15").splitlines():
                f = line.split('\t')
                if len(f) == 2:
                    users.append([f[0], int(f[1])])

            repl = None
            try:
                vert = self.mysql_cmd('SHOW SLAVE STATUS\\G', vertical=True)
            except RuntimeError:
                try:
                    vert = self.mysql_cmd('SHOW REPLICA STATUS\\G', vertical=True).replace('Replica_', 'Slave_').replace('Source_', 'Master_').replace('Behind_Source', 'Behind_Master')
                except RuntimeError:
                    vert = ''
            if vert.strip():
                kv = {}
                for line in vert.splitlines():
                    if ':' in line and not line.strip().startswith('*'):
                        k, v = line.split(':', 1)
                        kv[k.strip()] = v.strip()
                lag = kv.get('Seconds_Behind_Master')
                repl = {'io': kv.get('Slave_IO_Running', '?'), 'sql': kv.get('Slave_SQL_Running', '?'),
                        'lag': int(lag) if lag and lag.isdigit() else None,
                        'master': kv.get('Master_Host'), 'error': kv.get('Last_Error') or kv.get('Last_IO_Error') or ''}
            return {
                'version': variables.get('version'),
                'conns': int(status.get('Threads_connected', 0)),
                'running': int(status.get('Threads_running', 0)),
                'max_conn': int(variables.get('max_connections', 0)) or None,
                'max_used': int(status.get('Max_used_connections', 0)),
                'qps': round(qps, 1), 'slow': round(slow_rate, 2),
                'slow_log': variables.get('slow_query_log'), 'long_query_time': variables.get('long_query_time'),
                'uptime': int(status.get('Uptime', 0)), 'aborted': int(status.get('Aborted_connects', 0)),
                'hit': round((1 - reads / requests) * 100, 2),
                'long': long_q, 'users': users, 'repl': repl,
            }
        except Exception as e:
            return {'error': str(e)[:200]}

    # ---------- alles samen ----------

    def collect(self):
        now = time.time()
        uptime = float(read('/proc/uptime').split()[0])
        cpu_t = self.cpu_times()
        disk_t = self.disk_counters()
        net_t = self.net_counters()
        dt = now - self.prev_t if self.prev_t else 0

        cpu = {'pct': 0.0, 'user': 0.0, 'system': 0.0, 'iowait': 0.0, 'steal': 0.0,
               'cores': os.cpu_count() or 1, 'model': self.cpu_model}
        if self.prev_cpu:
            d = [a - b for a, b in zip(cpu_t, self.prev_cpu)]
            total = float(sum(d)) or 1.0
            cpu['user'] = round((d[0] + d[1]) * 100 / total, 2)
            cpu['system'] = round((d[2] + d[5] + d[6]) * 100 / total, 2)
            cpu['iowait'] = round(d[4] * 100 / total, 2)
            cpu['steal'] = round(d[7] * 100 / total, 2)
            cpu['pct'] = round(max(0.0, 100 - (d[3] + d[4]) * 100 / total), 2)

        diskio = {'read': 0, 'write': 0, 'util': 0.0, 'riops': 0.0, 'wiops': 0.0}
        if self.prev_disk and dt > 0:
            for name, c in disk_t.items():
                p = self.prev_disk.get(name)
                if not p:
                    continue
                diskio['riops'] += (c[0] - p[0]) / dt
                diskio['read'] += (c[1] - p[1]) * 512 / dt
                diskio['wiops'] += (c[2] - p[2]) / dt
                diskio['write'] += (c[3] - p[3]) * 512 / dt
                diskio['util'] = max(diskio['util'], min(100.0, (c[4] - p[4]) / (dt * 10.0)))
            diskio = {k: round(max(0, v), 1) for k, v in diskio.items()}

        net = {'rx': 0, 'tx': 0}
        if self.prev_net and dt > 0:
            net['rx'] = round(max(0, net_t[0] - self.prev_net[0]) / dt)
            net['tx'] = round(max(0, net_t[1] - self.prev_net[1]) / dt)

        mem = self.memory()
        services, failed = self.services()
        procs = self.processes(dt, uptime, mem['total'])
        logs = self.scan_logs(dt)

        security = {
            'ssh_fail': self.count_new(AUTH_LOGS, SSH_FAIL_RE) or 0,
            'modsec': self.count_new(MODSEC_LOGS, MODSEC_ENTRY_RE) or 0,
            'wpl': sum(l['wpl'] for l in logs.values()),
            'xml': sum(l['xml'] for l in logs.values()),
            'f2b': self.slow.get('f2b'),
        }
        usage = {}
        for domain, l in logs.items():
            if l['req'] or l['wpl'] or l['xml']:
                usage[domain] = [l['req'], l['bytes'], l['status'][3], l['wpl'], l['xml']]

        payload = {
            'agent': VERSION,
            'ts': int(now),
            'dt': round(dt, 1),
            'system': self.system_info(uptime),
            'cpu': cpu,
            'load': [round(x, 2) for x in os.getloadavg()],
            'mem': mem,
            'disks': self.disks(),
            'diskio': diskio,
            'net': net,
            'procs': procs,
            'services': services,
            'failed': failed,
            'mailq': self.mailq(),
            'security': security,
            'usage': {'domains': usage},
        }
        mysql = self.mysql(dt)
        if mysql is not None:
            payload['mysql'] = mysql
        if self.sites:
            payload['sites'] = self.site_stats(dt, logs)
        payload['_heavy'] = self.slow.pending(payload)
        self.prev_t, self.prev_cpu, self.prev_disk, self.prev_net = now, cpu_t, disk_t, net_t
        return payload


class SlowTasks(object):
    """Trage controles in een achtergrondthread; resultaten gaan mee zodra ze veranderen (of elke 6 uur)."""

    def __init__(self, collector):
        self.c = collector
        self.lock = threading.Lock()
        self.results = {}      # naam -> resultaat
        self.versions = {}     # naam -> versienummer van het resultaat
        self.sent = {}         # naam -> (versie, tijd) laatst succesvol verstuurd
        self.next_run = {}
        self.thread = None

    def tasks(self):
        t = [('f2b', 300, self.task_f2b), ('backups', 600, self.task_backups), ('updates', 3600, self.task_updates),
             ('domains', 3600, self.task_domains), ('dbs', 21600, self.task_dbs)]
        if self.c.conf.get('wordpress', '1') not in ('0', 'false', 'no'):
            t.append(('wordpress', 21600, self.task_wordpress))
        return t

    def set(self, name, value):
        with self.lock:
            if self.results.get(name) != value:
                self.versions[name] = self.versions.get(name, 0) + 1
            self.results[name] = value

    def get(self, name):
        with self.lock:
            return self.results.get(name)

    def run_all(self):
        for name, _, fn in self.tasks():
            self.run_task(name, fn)

    def run_task(self, name, fn):
        try:
            res = fn()
            if name == 'domains':
                if res is not None:
                    self.set('domains', res[0])
                    self.set('user_domains', res[1])
            else:
                self.set(name, res)
        except Exception as e:
            log('controle %s mislukt: %s' % (name, e))

    def start(self):
        def loop():
            time.sleep(10)
            while True:
                now = time.time()
                for name, interval, fn in self.tasks():
                    if now >= self.next_run.get(name, 0):
                        self.next_run[name] = now + interval
                        self.run_task(name, fn)
                time.sleep(15)
        self.thread = threading.Thread(target=loop)
        self.thread.daemon = True
        self.thread.start()

    def pending(self, payload):
        """Voegt nieuwe of al lang niet verstuurde resultaten toe aan de payload."""
        heavy = {}
        now = time.time()
        with self.lock:
            for name in ('backups', 'updates', 'domains', 'user_domains', 'dbs', 'wordpress'):
                if name not in self.results:
                    continue
                version = self.versions.get(name, 0)
                sent = self.sent.get(name)
                if sent and sent[0] == version and now - sent[1] < HEAVY_RESEND:
                    continue
                payload[name] = self.results[name]
                heavy[name] = version
        return heavy

    def ack(self, heavy):
        now = time.time()
        with self.lock:
            for name, version in heavy.items():
                self.sent[name] = (version, now)

    # ---------- taken ----------

    @staticmethod
    def task_f2b():
        rc, out, _ = run2(['fail2ban-client', 'status'], 20)
        if rc != 0:
            return None
        m = re.search(r'Jail list:\s*(.*)', out)
        jails = []
        for name in [j.strip() for j in (m.group(1) if m else '').split(',') if j.strip()]:
            o = run(['fail2ban-client', 'status', name], 20)
            cur = re.search(r'Currently banned:\s*(\d+)', o)
            tot = re.search(r'Total banned:\s*(\d+)', o)
            jails.append({'name': name, 'banned': int(cur.group(1)) if cur else 0, 'total': int(tot.group(1)) if tot else 0})
        return {'jails': jails, 'banned': sum(j['banned'] for j in jails)}

    @staticmethod
    def task_updates():
        total = security = None
        rc, out, err = run2(['/usr/lib/update-notifier/apt-check'], 180)
        m = re.match(r'^(\d+);(\d+)', (err or out or '').strip())
        if m:
            total, security = int(m.group(1)), int(m.group(2))
        packages = []
        out = run(['apt-get', '-s', '-o', 'Debug::NoLocking=1', 'upgrade'], 300)
        for line in out.splitlines():
            if line.startswith('Inst '):
                parts = line.split()
                packages.append([parts[1], '-security' in line])
        if total is None:
            total = len(packages)
            security = sum(1 for _, s in packages if s)
        packages.sort(key=lambda p: (not p[1], p[0]))
        return {'total': total, 'security': security, 'packages': packages[:80], 'checked': int(time.time())}

    def task_backups(self):
        result = {'checked': int(time.time()), 'source': None, 'last': None, 'count': 0}
        candidates = []   # (tijd, grootte, status, naam, bron)

        # Plesk: metadata van server- en abonnementsback-ups in /var/lib/psa/dumps
        dumps = '/var/lib/psa/dumps'
        if os.path.isdir(dumps):
            result['source'] = 'plesk'
            infos = glob.glob(os.path.join(dumps, 'backup_info_*.xml')) + \
                glob.glob(os.path.join(dumps, 'clients', '*', 'domains', '*', 'backup_info_*.xml')) + \
                glob.glob(os.path.join(dumps, 'domains', '*', 'backup_info_*.xml'))
            result['count'] = len(infos)
            if infos:
                newest = max(infos, key=os.path.getmtime)
                m = re.search(r'_(\d{10})\.xml$', newest)
                size = 0
                if m:
                    token = m.group(1)
                    for root, _, files in os.walk(dumps):
                        for f in files:
                            if token in f:
                                try:
                                    size += os.path.getsize(os.path.join(root, f))
                                except OSError:
                                    pass
                candidates.append([int(os.path.getmtime(newest)), size or None, 'unknown', os.path.basename(newest), 'plesk'])

        # Plesk: resultaat van de laatste back-upsessie (succes / waarschuwingen / fout)
        sessions = sorted(glob.glob('/usr/local/psa/PMM/sessions/*'), key=os.path.getmtime, reverse=True)[:30]
        for sess in sessions:
            status = None
            for f in glob.glob(os.path.join(sess, '*')):
                if not os.path.isfile(f) or os.path.getsize(f) > 5 * 1024 * 1024:
                    continue
                try:
                    head = read_head(f, 65536)
                except (IOError, OSError):
                    continue
                m = re.search(r'<execution-result[^>]*status="(\w+)"', head)
                if m:
                    status = m.group(1).lower()
                    break
            if status:
                ts = int(os.path.getmtime(sess))
                if candidates and abs(candidates[0][0] - ts) < 6 * 3600:
                    candidates[0][2] = 'error' if status == 'error' else 'warnings' if status == 'warnings' else 'success'
                    candidates[0][0] = max(candidates[0][0], ts) if status != 'error' else candidates[0][0]
                elif not candidates:
                    candidates.append([ts, None, 'error' if status == 'error' else 'warnings' if status == 'warnings' else 'success',
                                       os.path.basename(sess), 'plesk'])
                break

        # Eigen back-upmappen uit de configuratie (bijv. mariabackup op de databaseserver)
        for path in [p.strip() for p in self.c.conf.get('backup_paths', '').split(',') if p.strip()]:
            result['source'] = result['source'] or 'paths'
            newest = None
            seen = 0
            for root, dirs, files in os.walk(path):
                depth = root[len(path):].count(os.sep)
                if depth >= 3:
                    dirs[:] = []
                for f in files:
                    seen += 1
                    full = os.path.join(root, f)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    if not newest or st.st_mtime > newest[0]:
                        newest = (st.st_mtime, st.st_size, full)
                if seen > 20000:
                    break
            if newest:
                candidates.append([int(newest[0]), newest[1], 'success', newest[2], 'paths'])

        if candidates:
            best = max(candidates, key=lambda c: c[0])
            result['last'] = {'ts': best[0], 'size': best[1], 'status': best[2], 'name': best[3], 'source': best[4]}
        return result if result['source'] else None

    @staticmethod
    def task_domains():
        domains = []
        rc, out, _ = run2(['plesk', 'bin', 'site', '--list'], 120)
        if rc == 0:
            domains = [l.strip().lower() for l in out.splitlines() if DOMAIN_RE.match(l.strip().lower())]
        if not domains:
            try:
                domains = [d for d in os.listdir(os.path.join(VHOSTS, 'system')) if DOMAIN_RE.match(d)]
            except OSError:
                return None
        user_domains = {}
        try:
            for d in sorted(os.listdir(VHOSTS)):
                full = os.path.join(VHOSTS, d)
                if d in VHOST_SKIP or not DOMAIN_RE.match(d) or os.path.islink(full) or not os.path.isdir(full):
                    continue
                uid = os.stat(full).st_uid
                if uid:
                    try:
                        user_domains.setdefault(pwd.getpwuid(uid).pw_name, d)
                    except KeyError:
                        pass
        except OSError:
            pass
        return sorted(set(domains)), user_domains

    def task_dbs(self):
        if not any(r['name'] in ('mysqld', 'mariadbd') for r in self.c.last_rows):
            return None
        out = self.c.mysql_cmd(
            "SELECT table_schema, SUM(data_length + index_length), SUM(data_free), COUNT(*) FROM information_schema.TABLES "
            "WHERE table_schema NOT IN ('information_schema','performance_schema','sys','mysql') "
            "GROUP BY table_schema ORDER BY 2 DESC LIMIT 50", timeout=600)
        dbs = []
        for line in out.splitlines():
            f = line.split('\t')
            if len(f) == 4:
                dbs.append([f[0], int(float(f[1] or 0)), int(float(f[2] or 0)), int(f[3] or 0)])
        return {'list': dbs, 'checked': int(time.time())}

    @staticmethod
    def wp_header(text, key):
        m = re.search(r'^[ \t/*#@]*' + key + r':\s*(.+)$', text, re.M | re.I)
        return m.group(1).strip()[:40] if m else None

    def task_wordpress(self):
        """Zoekt WordPress-installaties en leest core-, plugin- en themaversies (zonder PHP uit te voeren)."""
        if not os.path.isdir(VHOSTS):
            return None
        sites = []
        started = time.time()
        for vhost in sorted(os.listdir(VHOSTS)):
            if vhost in VHOST_SKIP or not DOMAIN_RE.match(vhost):
                continue
            base = os.path.join(VHOSTS, vhost)
            if os.path.islink(base) or not os.path.isdir(base):
                continue
            for root, dirs, files in os.walk(base):
                rel = os.path.relpath(root, base)
                depth = 0 if rel == '.' else rel.count(os.sep) + 1
                dirs[:] = [d for d in dirs if d not in WP_SKIP_DIRS and not d.startswith('.')] if depth < 3 else []
                if 'wp-config.php' not in files and not os.path.exists(os.path.join(root, 'wp-includes', 'version.php')):
                    continue
                try:
                    vtext = read(os.path.join(root, 'wp-includes', 'version.php'))
                except (IOError, OSError):
                    continue
                m = re.search(r"\$wp_version\s*=\s*'([^']+)'", vtext)
                if not m:
                    continue
                dirs[:] = []
                domain = vhost
                for part in ([] if rel == '.' else rel.split(os.sep)):
                    if DOMAIN_RE.match(part):
                        domain = part
                plugins = []
                pdir = os.path.join(root, 'wp-content', 'plugins')
                for slug in sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []:
                    sdir = os.path.join(pdir, slug)
                    if not os.path.isdir(sdir):
                        continue
                    for php in sorted(glob.glob(os.path.join(sdir, '*.php')))[:25]:
                        try:
                            head = read_head(php)
                        except (IOError, OSError):
                            continue
                        if re.search(r'Plugin Name:', head, re.I):
                            plugins.append([slug, self.wp_header(head, 'Version')])
                            break
                themes = []
                tdir = os.path.join(root, 'wp-content', 'themes')
                for slug in sorted(os.listdir(tdir)) if os.path.isdir(tdir) else []:
                    css = os.path.join(tdir, slug, 'style.css')
                    if os.path.isfile(css):
                        try:
                            themes.append([slug, self.wp_header(read_head(css), 'Version')])
                        except (IOError, OSError):
                            pass
                sites.append({'domain': domain, 'path': os.path.join(vhost, rel) if rel != '.' else vhost,
                              'version': m.group(1), 'plugins': plugins, 'themes': themes})
            if time.time() - started > 1200:   # max. 20 minuten per ronde
                break
        return {'sites': sites, 'checked': int(time.time())}


def send(conf, payload):
    body = dict(payload)
    body.pop('_heavy', None)
    data = json.dumps(body, separators=(',', ':')).encode('utf-8')
    req = urllib.request.Request(conf['url'] + '/api/ingest', data=data, headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + conf['token'],
        'User-Agent': 'nb-agent/' + VERSION,
    })
    ctx = ssl.create_default_context()
    if conf['insecure']:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
        try:
            return json.loads(r.read().decode('utf-8') or '{}')
        except ValueError:
            return {}


def main():
    once = '--once' in sys.argv
    show = '--print' in sys.argv
    conf = load_conf_optional() if show else load_conf()

    collector = Collector(conf)
    collector.collect()            # nulmeting voor de delta's
    if show:
        collector.slow.run_all()
    time.sleep(3 if (once or show) else 5)

    if show:
        payload = collector.collect()
        payload.pop('_heavy', None)
        print(json.dumps(payload, indent=2))
        return

    if not once:
        collector.slow.start()
    log('gestart, versie %s, interval %ss, dashboard %s' % (VERSION, conf['interval'], conf['url']))
    queue = []
    while True:
        started = time.time()
        try:
            queue.append(collector.collect())
        except Exception as e:  # nooit stoppen door één mislukte meting
            log('fout bij verzamelen: %s' % e)
        queue = queue[-20:]        # max 20 metingen bufferen bij storing
        while queue:
            try:
                resp = send(conf, queue[0])
                collector.slow.ack(queue[0].get('_heavy') or {})
                queue.pop(0)
                if isinstance(resp.get('sites'), list):
                    collector.sites = [str(d).lower() for d in resp['sites']][:200]
            except urllib.error.HTTPError as e:
                log('dashboard antwoordde HTTP %s: %s' % (e.code, e.read()[:200]))
                if e.code in (400, 401, 403, 413):
                    queue.pop(0)   # heeft geen zin om opnieuw te proberen
                break
            except Exception as e:
                log('versturen mislukt: %s' % e)
                break
        if once:
            if queue:
                sys.exit('Test mislukt, zie fout hierboven')
            print('OK — meting verstuurd naar %s' % conf['url'])
            return
        time.sleep(max(1.0, conf['interval'] - (time.time() - started)))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass

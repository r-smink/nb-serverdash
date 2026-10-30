#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NextBuzz ServerDash agent.

Verzamelt elke <interval> seconden systeemstatistieken uit /proc en systemd en
stuurt die als JSON naar het dashboard. Geen externe afhankelijkheden; werkt
met de standaard python3 van Ubuntu 18.04 en nieuwer.

Gebruik:
  nb-agent.py            draai als service (doorlopend)
  nb-agent.py --once     verzamel en verstuur één meting (test)
  nb-agent.py --print    verzamel één meting en toon de JSON (niets versturen)
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

VERSION = '1.1.0'
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
DOMAIN_RE = re.compile(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
# Combined log format: ip - - [tijd] "METHOD pad HTTP/x" status bytes "referer" "user-agent"
LOG_RE = re.compile(r'^(\S+) \S+ \S+ \[[^\]]*\] "(?:\S+ (\S+)[^"]*|[^"]*)" (\d{3}) (\d+|-)(?: "[^"]*" "([^"]*)")?')
LOG_MAX_BYTES = 20 * 1024 * 1024   # max. per logbestand per meting
DU_INTERVAL = 6 * 3600


def log(msg):
    sys.stderr.write('[nb-agent] %s\n' % msg)
    sys.stderr.flush()


def read(path):
    with open(path) as f:
        return f.read()


def run(args, timeout=15):
    try:
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
        out, _ = p.communicate(timeout=timeout)
        return out
    except Exception:
        return ''


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


class Collector(object):
    def __init__(self):
        self.prev_t = None
        self.prev_cpu = None
        self.prev_disk = None
        self.prev_net = None
        self.prev_procs = {}
        self.usernames = {}
        self.enabled = set()
        self.enabled_at = 0
        self.cpu_model = self._cpu_model()
        self.sites = []            # domeinen die het dashboard wil meten
        self.last_rows = []
        self.log_pos = {}          # logbestand -> (inode, offset)
        self.site_info = {}        # domein -> (tijd, gebruiker, docroot)
        self.du_cache = {}         # pad -> (tijd, bytes)
        self.du_paths = []
        self.du_busy = False

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
        user_list = sorted(users.values(), key=lambda u: (u['cpu'], u['rss']), reverse=True)[:25]
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

    def log_stats(self, domain, dt):
        logdir = os.path.join(VHOSTS, 'system', domain, 'logs')
        # nginx (proxy_*) ziet alle requests, ook statische bestanden; anders de Apache-logs
        files = [os.path.join(logdir, f) for f in ('proxy_access_ssl_log', 'proxy_access_log')]
        if not any(os.path.exists(f) for f in files):
            files = [os.path.join(logdir, f) for f in ('access_ssl_log', 'access_log')]
        req = size = 0
        status = [0, 0, 0, 0]
        paths = collections.Counter()
        ips = collections.Counter()
        agents = collections.Counter()
        truncated = False
        for f in files:
            lines, trunc = self.read_new_lines(f)
            truncated = truncated or trunc
            for line in lines:
                m = LOG_RE.match(line)
                if not m:
                    continue
                req += 1
                code = int(m.group(3))
                if 200 <= code < 600:
                    status[code // 100 - 2] += 1
                if m.group(4) != '-':
                    size += int(m.group(4))
                ips[m.group(1)] += 1
                if m.group(2):
                    paths[m.group(2).split('?', 1)[0][:200]] += 1
                if m.group(5):
                    agents[m.group(5)[:160]] += 1
        per_min = 60.0 / dt if dt > 0 else 0
        return {
            'req': req, 'rpm': round(req * per_min, 1), 'bw': round(size / dt) if dt > 0 else 0,
            's2': round(status[0] * per_min, 1), 's3': round(status[1] * per_min, 1),
            's4': round(status[2] * per_min, 1), 's5': round(status[3] * per_min, 1),
            'paths': paths.most_common(15), 'ips': ips.most_common(15), 'agents': agents.most_common(8),
            'log': os.path.basename(files[0]).replace('_ssl', ''), 'log_truncated': truncated,
        }

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

    def site_stats(self, dt):
        out = {}
        du_paths = []
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
            stats = {
                'found': True, 'user': user, 'docroot': docroot,
                'cpu': round(sum(r['cpu'] for r in procs), 1),
                'rss': sum(r['rss'] for r in procs),
                'rio': sum(r['rio'] for r in procs), 'wio': sum(r['wio'] for r in procs),
                'procs': len(procs),
                'top': sorted(procs, key=lambda r: (r['cpu'], r['rss']), reverse=True)[:15],
                'disk': self.du_cache.get(disk_path, (0, None))[1] if disk_path else None,
            }
            stats.update(self.log_stats(domain, dt))
            out[domain] = stats
        self.du_paths = du_paths
        self.refresh_disk_usage()
        return out

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
        payload = {
            'agent': VERSION,
            'ts': int(now),
            'system': self.system_info(uptime),
            'cpu': cpu,
            'load': [round(x, 2) for x in os.getloadavg()],
            'mem': mem,
            'disks': self.disks(),
            'diskio': diskio,
            'net': net,
            'procs': self.processes(dt, uptime, mem['total']),
            'services': services,
            'failed': failed,
            'mailq': self.mailq(),
        }
        if self.sites:
            payload['sites'] = self.site_stats(dt)
        self.prev_t, self.prev_cpu, self.prev_disk, self.prev_net = now, cpu_t, disk_t, net_t
        return payload


def send(conf, payload):
    data = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    req = urllib.request.Request(conf['url'] + '/api/ingest', data=data, headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + conf['token'],
        'User-Agent': 'nb-agent/' + VERSION,
    })
    ctx = ssl.create_default_context()
    if conf['insecure']:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
        try:
            return json.loads(r.read().decode('utf-8') or '{}')
        except ValueError:
            return {}


def main():
    once = '--once' in sys.argv
    show = '--print' in sys.argv
    conf = None if show else load_conf()

    collector = Collector()
    collector.collect()            # nulmeting voor de delta's
    time.sleep(3 if (once or show) else 5)

    if show:
        print(json.dumps(collector.collect(), indent=2))
        return

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

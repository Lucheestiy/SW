# hvac.lucheestiy.com deployment notes

Updated: 2026-05-07 (America/New_York)
Host: `mik-EQ` (`/root`)

## Layout

- Site source: `/root/hvac.lucheestiy.com/site`
- Pi exporter source: `/root/hvac.lucheestiy.com/pi/export_snapshot.py`
- Local sync job: `/root/scripts/sync_hvac_data.py`
- Served webroot: `/var/www/hvac.lucheestiy.com`
- Local nginx site: `/etc/nginx/sites-available/hvac.lucheestiy.com-local`
- Reverse tunnel: `/etc/systemd/system/reverse-tunnel-hvac.service`
- Data sync service/timer:
  - `/etc/systemd/system/hvac-data-sync.service`
  - `/etc/systemd/system/hvac-data-sync.timer`
- Data backup service/timer:
  - `/etc/systemd/system/hvac-data-backup.service`
  - `/etc/systemd/system/hvac-data-backup.timer`
- VPS nginx site: `/etc/nginx/sites-available/hvac.lucheestiy.com.conf`

## Publishing path

- Raspberry Pi `hvacsw` continuously logs sewer readings to `/root/sewer-monitor/data.db`
- This server SSHes to the Pi using `/root/.ssh/id_ed25519_hvac_pi`
- `sync_hvac_data.py` runs every minute and writes:
  - `/var/www/hvac.lucheestiy.com/data/dashboard.json`
  - `/var/www/hvac.lucheestiy.com/data/sync.json`
- `backup_hvac_data.py` runs daily and writes:
  - `/root/backups/hvac-sewer/raw/logs/*.csv`
  - `/root/backups/hvac-sewer/raw/config.json`
  - `/root/backups/hvac-sewer/raw/alerts.log`
  - `/root/backups/hvac-sewer/raw/faults.log`
  - `/root/backups/hvac-sewer/sqlite/latest/data.db`
  - `/root/backups/hvac-sewer/manifest.json`
  - `/var/www/hvac.lucheestiy.com/data/backup.json`
- Backup retention is configured for 731 days, roughly two years.
- The two-year retained history is the raw daily CSV log set plus config/alert/fault logs.
- The SQLite backup is a rolling latest consistent snapshot for fast restore, not 731 full database copies.
- Offsite backup mirrors the local backup tree to `inyp-vps:/root/backups/hvac-sewer`.
- The VPS currently has about 18 GB free; add storage if the dashboard backup panel shows sustained growth toward that limit.
- Local nginx serves the dashboard on `127.0.0.1:8094`
- `autossh` exposes it to the VPS as `127.0.0.1:18094`
- VPS nginx publishes `https://hvac.lucheestiy.com`

## Useful commands

```bash
systemctl status nginx reverse-tunnel-hvac.service hvac-data-sync.timer hvac-data-backup.timer --no-pager
systemctl restart nginx reverse-tunnel-hvac.service
systemctl restart hvac-data-sync.service
systemctl start hvac-data-backup.service
curl -s http://127.0.0.1:8094/data/sync.json | jq
curl -s http://127.0.0.1:8094/data/backup.json | jq
curl -I https://hvac.lucheestiy.com/
```

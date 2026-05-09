# sw.lucheestiy.com deployment notes

Updated: 2026-05-08 (America/New_York)
Host: `mik-EQ` (`/root`)

Sewer Watch is the public dashboard for the Raspberry Pi sewer monitor.
The Pi writes a local dashboard snapshot once per minute, this server pulls
that JSON into the SW webroot, and nginx publishes it through
`https://sw.lucheestiy.com`.

## Layout

- Site source: `/root/sw.lucheestiy.com/site`
- Pi snapshot writer source: `/root/sw.lucheestiy.com/deploy/scripts/pi_write_snapshot.py`
- Local runtime scripts:
  - `/root/scripts/sync_sewer_data.py`
  - `/root/scripts/backup_sewer_data.py`
  - `/root/scripts/check_sewer_health.py`
- Served webroot: `/var/www/sw.lucheestiy.com`
- Public data files: `/var/www/sw.lucheestiy.com/data/*.json`
- Local nginx site: `/etc/nginx/sites-available/sw.lucheestiy.com-local`
- Reverse tunnel: `/etc/systemd/system/reverse-tunnel-sw.service`
- VPS nginx site: `/etc/nginx/sites-available/sw.lucheestiy.com.conf`

## Services

- Pi snapshot service/timer:
  - `/etc/systemd/system/sewer-dashboard-snapshot.service`
  - `/etc/systemd/system/sewer-dashboard-snapshot.timer`
- Local sync service/timer:
  - `/etc/systemd/system/sw-data-sync.service`
  - `/etc/systemd/system/sw-data-sync.timer`
- Local backup service/timer:
  - `/etc/systemd/system/sw-data-backup.service`
  - `/etc/systemd/system/sw-data-backup.timer`
- Local health service/timer:
  - `/etc/systemd/system/sw-health-check.service`
  - `/etc/systemd/system/sw-health-check.timer`

## Data Path

- The Raspberry Pi records monitor readings under `/root/sewer-monitor`.
- The Pi writes `/root/sewer-monitor/public/dashboard.json` every minute at second `:05`.
- This server pulls that snapshot with `rsync` every minute at second `:20`.
- The sync job writes:
  - `/var/www/sw.lucheestiy.com/data/dashboard.json`
  - `/var/www/sw.lucheestiy.com/data/sync.json`
- The backup job writes:
  - `/root/backups/sewer-monitor`
  - `/var/www/sw.lucheestiy.com/data/backup.json`
- The health check writes:
  - `/var/www/sw.lucheestiy.com/data/health.json`

## Updating The Site

```bash
rsync -a --delete --exclude /data/ /root/sw.lucheestiy.com/site/ /var/www/sw.lucheestiy.com/
chown -R www-data:www-data /var/www/sw.lucheestiy.com
```

## Useful Commands

```bash
systemctl status nginx reverse-tunnel-sw.service sw-data-sync.timer sw-data-backup.timer sw-health-check.timer --no-pager
systemctl restart sw-data-sync.service sw-health-check.service
ssh sewer-pi systemctl status sewer-dashboard-snapshot.timer --no-pager
curl -s https://sw.lucheestiy.com/data/sync.json | jq
curl -s https://sw.lucheestiy.com/data/health.json | jq
curl -I https://sw.lucheestiy.com/
```

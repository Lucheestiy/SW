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
- VPS nginx site: `/etc/nginx/sites-available/hvac.lucheestiy.com.conf`

## Publishing path

- Raspberry Pi `hvacsw` continuously logs sewer readings to `/root/sewer-monitor/data.db`
- This server SSHes to the Pi using `/root/.ssh/id_ed25519_hvac_pi`
- `sync_hvac_data.py` runs every minute and writes:
  - `/var/www/hvac.lucheestiy.com/data/dashboard.json`
  - `/var/www/hvac.lucheestiy.com/data/sync.json`
- Local nginx serves the dashboard on `127.0.0.1:8094`
- `autossh` exposes it to the VPS as `127.0.0.1:18094`
- VPS nginx publishes `https://hvac.lucheestiy.com`

## Useful commands

```bash
systemctl status nginx reverse-tunnel-hvac.service hvac-data-sync.timer --no-pager
systemctl restart nginx reverse-tunnel-hvac.service
systemctl restart hvac-data-sync.service
curl -s http://127.0.0.1:8094/data/sync.json | jq
curl -I https://hvac.lucheestiy.com/
```

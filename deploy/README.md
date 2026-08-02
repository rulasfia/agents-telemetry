# Homeserver telemetry stack

This is the homeserver deployment for Pi metrics. It replaces the development-only `demo/` stack: no host networking, no default Grafana password, no anonymous Grafana access, and Prometheus is not exposed on a host port.

## Services

- **OTel Collector** receives Pi metrics over OTLP/HTTP on TCP 4318 and exposes a Prometheus scrape endpoint only on the internal Docker network.
- **Prometheus** retains metrics in its named volume for 30 days by default.
- **Grafana** is provisioned with the Pi dashboard and binds to loopback by default.

## Deploy

On the homeserver, clone this repository and run:

```bash
cd pi-otlp/deploy
cp .env.example .env
chmod 600 .env
# Edit .env: set a unique GRAFANA_ADMIN_PASSWORD.
docker compose pull
docker compose up -d
docker compose ps
```

Allow TCP 4318 only from the Pi machine or your private VPN/LAN in the homeserver firewall. Do **not** expose or port-forward it. Grafana binds to `127.0.0.1:3000`; access it with an SSH tunnel, VPN, or authenticated reverse proxy.

## Connect Pi

Replace `homeserver.lan` with the homeserver's private DNS name or IP, then start (or restart) Pi from PowerShell:

```powershell
$env:PI_OTLP_ENABLE = "1"
$env:OTEL_METRICS_EXPORTER = "otlp"
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://homeserver.lan:4318"
$env:PI_OTLP_DEVICE_NAME = "desktop" # Use a distinct name on each machine.
pi
```

`OTEL_EXPORTER_OTLP_ENDPOINT` is a base URL; this fork appends `/v1/metrics`. To use a non-standard path, set the complete URL with `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` instead.

## Verify

1. Send a Pi prompt, then run `/otlp-status` in Pi.
2. On the homeserver, confirm Prometheus has metrics:
   ```bash
   docker compose exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=pi_session_count_total'
   ```
3. Tunnel Grafana if needed:
   ```bash
   ssh -L 3000:127.0.0.1:3000 your-homeserver
   ```
   Then open <http://localhost:3000> and sign in with the credentials in `.env`.

## Maintenance

Review image releases and update the pinned versions in `.env` deliberately. Before upgrading, run `docker compose pull` and inspect the release notes. Prometheus labels every Pi metric with `session.id`; it is high-cardinality, so avoid long retention if usage grows substantially.

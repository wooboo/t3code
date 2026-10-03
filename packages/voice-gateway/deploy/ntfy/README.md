# Self-hosted UnifiedPush with ntfy

This optional push server is independent of T3. Other UnifiedPush apps can use it,
and T3 can use another compatible distributor without rebuilding the mobile app.
No Firebase account or FCM forwarding is involved in this setup.

## Start

1. Copy `.env.example` to `.env` and set `NTFY_HOSTNAME` to a DNS name reachable
   from both the phone and T3 host. Use a valid HTTPS certificate.
2. With an existing reverse proxy, run `docker compose up -d ntfy` and proxy that
   hostname to port 8180 on this host. Preserve streaming/WebSocket connections.
   For a standalone host with DNS pointing to it and ports 80/443 available,
   run `docker compose --profile tls up -d`; Caddy handles HTTPS.
3. Create the phone's account (the command prompts for its password):

   ```sh
   docker compose exec ntfy ntfy user add phone
   docker compose exec ntfy ntfy access phone 'up*' read-write
   ```

4. Install the ntfy Android app, add this server and account, and select this
   server for UnifiedPush in ntfy's settings. Allow ntfy unrestricted battery
   usage and notifications. Then open T3 → Settings → Voice → Oddzwanianie,
   enable callbacks, and choose ntfy if Android asks for a distributor.

T3 registers its own encrypted subscription automatically. Do not manually
create a topic or copy a topic URL into T3. The phone's ntfy account credentials
stay in ntfy; T3 receives only its push endpoint and encryption parameters.
The anonymous write-only `up*` ACL is required by ntfy's UnifiedPush integration;
reading topics requires the phone account. Treat subscription URLs as secrets.

## Verify and operate

`curl https://YOUR_HOSTNAME/v1/health` should report healthy before registering
the phone. After T3 reports successful registration, ask an authorized thread
agent to call `call_user`. Test screen-off delivery, Doze, Wi-Fi/mobile network
changes and reconnects. A push acknowledgement alone does not prove ringing.
Do not use Android's Force stop when simulating an ordinary closed app.

The `ntfy-data` volume contains accounts and cached encrypted messages. Back it
up before upgrades. The ntfy image is pinned; update its tag deliberately. The
optional Caddy image tracks its supported major version. Back up Caddy volumes
when retaining certificate state. `docker compose down` stops the service and
retains data; avoid `down -v` unless intentionally deleting it.

# DNS-01 (Cloudflare) instructions

Use this method when your server is not reachable on port 80/443 (or you keep Cloudflare proxy enabled).

1) Create a Cloudflare API token

- Go to Cloudflare dashboard -> My Profile -> API Tokens -> Create Token.
- Use a template or custom token with the following permission: `Zone.DNS:Edit` scoped to the zone `emilvinod.com`.

2) Save token on the Pi (secure file)

```bash
sudo tee /etc/letsencrypt/cloudflare.ini > /dev/null <<EOF
dns_cloudflare_api_token = <YOUR_CLOUDFLARE_API_TOKEN>
EOF
sudo chmod 600 /etc/letsencrypt/cloudflare.ini
sudo chown root:root /etc/letsencrypt/cloudflare.ini
```

3) Install Certbot DNS plugin and request cert

```bash
sudo apt update
sudo apt install -y python3-certbot-dns-cloudflare
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d cloud.emilvinod.com
```

4) After issuance

- Ensure nginx uses `/etc/letsencrypt/live/cloud.emilvinod.com/fullchain.pem` and `privkey.pem` (the repo nginx config does by default).
- Test and reload nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Security note: never commit your real API token into the repo. Keep `/etc/letsencrypt/cloudflare.ini` mode 600.

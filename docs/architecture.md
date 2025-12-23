# Architecture

Client → Cloudflare Tunnel → Nginx (Reverse Proxy) → Flask API

- **UI**: Static HTML/CSS/JS served by Nginx at `/cloud/`
- **API**: Flask app proxied via `/cloud/api/`
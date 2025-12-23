# API Endpoints

## Auth
- `POST /verify_google` - Verify Google OAuth token
- `POST /verify_turnstile` - Verify Cloudflare Turnstile
- `GET /oauth/start` - Start OAuth flow
- `GET /oauth/callback` - OAuth callback
- `GET /config` - Get client config

## System
- `GET /health` - Service health
- `GET /metrics` - System metrics (CPU, memory, disk)
- `POST /restart` - Restart service

## Files
- `GET /files` - List files
- `GET /files/download` - Download file
- `GET /files/preview` - Preview file
- `POST /files/upload` - Upload file
- `DELETE /files` - Delete file
- `POST /files/rename` - Rename file
- `POST /files/mkdir` - Create directory
- `POST /files/move` - Move file

## Network
- `GET /network/scan` - Scan LAN devices
- `GET /network/device/<ip>/ports` - Scan device ports
- `GET /network/info` - Network info
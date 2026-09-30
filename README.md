# Soundlane Server

Soundlane routes audio from a lightweight Windows desktop app to a Discord voice
channel. This repository contains the public relay backend and Discord bot.

The server accepts an authenticated 48 kHz stereo PCM stream from the desktop
app, forwards it to the paired Discord bot, and can also fan it out to browser
extension listeners. Pairing codes are short-lived, while stored access tokens
are represented only by SHA-256 hashes.

## Features

- Discord slash commands: `/join`, `/leave`, and `/help`
- One-time pairing codes for linking the desktop app to a Discord server
- Authenticated WebSocket audio ingestion
- Discord voice playback through `@discordjs/voice`
- Optional browser-extension listener fan-out
- Persistent pairing state and audit events
- Small Docker image suitable for Northflank

## Requirements

- Node.js 22 or newer
- A Discord application with a bot token
- Discord bot permissions to Connect and Speak

## Local development

```powershell
npm install
$env:DISCORD_TOKEN="your-discord-bot-token"
$env:DISCORD_CLIENT_ID="your-discord-application-id"
$env:PUBLIC_BASE_URL="http://localhost:8080"
$env:DOWNLOAD_URL="https://github.com/nonuser35/soundlane-server/releases/latest"
$env:DATA_DIR="./data"
npm start
```

Run the tests with:

```powershell
npm test
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Secret Discord bot token. Never commit this value. |
| `DISCORD_CLIENT_ID` | Yes | Discord application ID used for command registration and invites. |
| `PUBLIC_BASE_URL` | Yes in production | Public HTTPS URL of this service. |
| `DOWNLOAD_URL` | No | Desktop app download page shown by the bot. |
| `PORT` | No | HTTP port. Defaults to `8080`. |
| `DATA_DIR` | No | Persistent state directory. Defaults to `./data`. |

## HTTP and WebSocket endpoints

- `GET /health`
- `POST /api/v1/pairings`
- `GET /api/v1/pairings/:id`
- `WS /api/v1/stream?access_token=...`
- `WS /api/v1/listen?code=...`

## Docker

```bash
docker build -t soundlane-server .
docker run --rm -p 8080:8080 \
  -e DISCORD_TOKEN=... \
  -e DISCORD_CLIENT_ID=... \
  -e PUBLIC_BASE_URL=http://localhost:8080 \
  soundlane-server
```

Mount `/data` as persistent storage in production. The included Dockerfile sets
`DATA_DIR=/data` automatically.

## Security notes

- Keep `DISCORD_TOKEN` only in your hosting provider's secret manager.
- Do not commit `.env`, `data/`, or `node_modules/`.
- Pairing access tokens are returned once and stored only as hashes.
- Deploy the public service behind HTTPS/WSS.

## Project status

Soundlane is under active development. The relay protocol and pairing API may
change before the first stable release.

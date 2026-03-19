## Bot Telegram: Video downloader (personal)

A simple personal Telegram bot that **downloads a video from a link** you send it, then **uploads the video back** to you.

## Features

- **Polling mode** (no webhook).
- **Single-user access**: only `OWNER_ID` is allowed; everyone else is ignored.
- **Zero/low command surface**:
  - Optional `/start` → “Send me a link”
  - Any message containing `http` is treated as a download request.
- **Choose output type**:
  - Default: **MP4** (send a link)
  - Audio-only: **MP3** using `/mp3 <link>`
  - Explicit video: **MP4** using `/mp4 <link>`
- **Auto cleanup**: downloaded file is deleted after uploading.

## Tech stack

- Node.js
- `node-telegram-bot-api`
- `yt-dlp-exec`
- Built-ins: `fs`, `path`

## Prerequisites

- **Node.js** (recommended: latest LTS)
- **A Telegram bot token** from BotFather
- **Your Telegram numeric user id** (used as `OWNER_ID`)

## Setup

1) Install dependencies

```bash
npm install
```

2) Set environment variables

- **Windows PowerShell (example)**:

```powershell
$env:BOT_TOKEN="123456:ABC..."
$env:OWNER_ID="123456789"
node index.js
```

- **Or** create a `.env` file (if your code loads it) with:

```env
BOT_TOKEN=123456:ABC...
OWNER_ID=123456789
```

3) Run

```bash
node index.js
```

## Usage

- Send the bot a message containing a link (any text including `http`) for **MP4**.
- Or use:
  - `/mp3 https://...` to receive **MP3**
  - `/mp4 https://...` to receive **MP4**
- The bot replies:
  - “Downloading...”
  - “Uploading...”
- Then it sends the downloaded media back to you.

## Project structure

```
index.js
downloads/
```

## Dependencies

- `node-telegram-bot-api`
- `yt-dlp-exec`

## Implementation spec (requirements)

1) **Polling only**

- Do not implement webhooks.

2) **Owner-only access**

- Allow only the user whose Telegram numeric id equals `OWNER_ID`.
- Ignore all other users (no replies).

3) **Message handling**

- Optional `/start` → reply: “Send me a link”
- For any other message:
  - If it contains `http`, treat it as a download request.
  - Otherwise, do nothing (or a minimal hint, if desired).

4) **Download logic**

- Extract the URL from the message text.
- Use `yt-dlp` via `yt-dlp-exec` to download.
- Select best quality **under 50MB**.
- Save into `./downloads`.
- Ensure `./downloads` exists (create if missing).

5) **User feedback**

- Before downloading: send “Downloading...”
- After download: send “Uploading...” then upload via `sendVideo` (MP4) or `sendAudio` (MP3)

6) **Cleanup**

- After sending: delete the downloaded file from disk.

7) **Error handling**

- Invalid URL → “Invalid link”
- Download fails → “Download failed”
- File size > 50MB → “File too large”

## Notes

- If downloads fail on some sites, you may need `ffmpeg` installed and available on `PATH` (depends on what `yt-dlp` needs for the target site/format).

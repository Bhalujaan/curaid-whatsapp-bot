# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install           # Install dependencies (required after switching to Baileys)
npm start             # Start the bot (node index.js)
node test_gemini.js   # Verify Groq API key works
node test_list.js     # List available Gemini models via REST
```

## Environment

Requires a `.env` file with:
- `GROQ_API_KEY` — Groq API key (get one free at console.groq.com)
- `PORT` — optional, defaults to 3000

## Architecture

This is a single-file Node.js WhatsApp bot (`index.js`) written in ESM (`"type": "module"`). Three integrated systems:

**WhatsApp layer** — `@whiskeysockets/baileys` connects directly to WhatsApp Web via WebSocket (no Chromium/Puppeteer). Auth state is persisted as JSON files in `auth_info_baileys/` via `useMultiFileAuthState`. On first run a QR code is printed to the terminal and saved as `qr.png`. On disconnect the bot automatically reconnects unless the phone explicitly logged out. Only direct (non-group) messages are processed.

**AI layer** — Groq (`llama-3.3-70b-versatile`, pinned) with `knowledge.txt` loaded as the system instruction at startup. Per-user conversation history is stored as a plain `Content[]` array in a `Map<userId, session>`. The Gemini `ChatSession` is rebuilt from history on every message (keeps state serialisable). Sessions are evicted after 7 days of inactivity (hourly cleanup); history is capped at 20 turns per user.

**History persistence** — On startup `chat_history.json` is read back into the sessions Map. History flushes to disk every 5 minutes and on graceful shutdown (`SIGTERM`/`SIGINT`).

**Message queue** — Each user session holds a `queue: Promise` that chains incoming messages sequentially, preventing concurrent Gemini calls and out-of-order replies.

**Document delivery** — Gemini is instructed (via `knowledge.txt` §7) to embed `[SEND_FILE: KEY]` in its response. `index.js` strips the tag, sends the text reply, then sends the PDF via Baileys' document message. The document map is a plain `DOCUMENTS` config object at the top of `index.js`.

**Keep-alive server** — A minimal Express server (`GET /`) runs on `PORT` to prevent free-tier cloud hosts from sleeping the process. Pair with a free UptimeRobot monitor pinging the URL every 14 minutes.

## Key constraints

- **`knowledge.txt` is the sole source of bot behavior.** All persona rules, scheme data, crisis protocols, and the magic-keyword contract live there. Changes to bot behavior go in that file, not in code.
- Adding a new sendable document requires: (1) placing the PDF in `documents/`, (2) adding one entry to the `DOCUMENTS` object at the top of `index.js`, and (3) documenting the `[SEND_FILE: KEY]` tag in `knowledge.txt`.
- The project is ESM — all files use `import/export`. Do not use `require()`.
- Baileys auth (`auth_info_baileys/`) and `chat_history.json` are gitignored. On Render's free tier the filesystem is ephemeral — both are lost on redeploys (re-scan QR after each deploy). A Render Persistent Disk ($1/month) eliminates this.

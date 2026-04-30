import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import fs from 'fs';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import Groq from 'groq-sdk';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const MODEL_NAME    = 'llama-3.3-70b-versatile';
const SESSION_TTL   = 7 * 24 * 60 * 60 * 1000;
const MAX_TURNS     = 20;
const HISTORY_FILE  = join(__dirname, 'chat_history.json');
const AUTH_DIR      = join(__dirname, 'auth_info_baileys');

// To add a new sendable document: drop the PDF in documents/ and add one line here.
const DOCUMENTS = {
    UDID_FORM:     join(__dirname, 'documents', 'udid_form.pdf'),
    NIRAMAYA_FORM: join(__dirname, 'documents', 'niramaya_form.pdf'),
};

// ── Groq ──────────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const systemInstruction = fs.readFileSync(join(__dirname, 'knowledge.txt'), 'utf-8');

// ── Session store ─────────────────────────────────────────────────────────────
// userId → { history: Content[], lastActive: number, queue: Promise }
const sessions = new Map();

function getSession(userId) {
    if (!sessions.has(userId)) {
        sessions.set(userId, { history: [], lastActive: Date.now(), queue: Promise.resolve() });
        console.log(`[Session] New: ${userId}`);
    }
    return sessions.get(userId);
}

// ── History persistence ───────────────────────────────────────────────────────
function loadHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return;
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        for (const [userId, entry] of Object.entries(data)) {
            sessions.set(userId, {
                history:    entry.history    || [],
                lastActive: entry.lastActive || Date.now(),
                queue:      Promise.resolve(),
            });
        }
        console.log(`[Session] Restored ${sessions.size} session(s)`);
    } catch (e) {
        console.error('[Session] Load failed:', e.message);
    }
}

function saveHistory() {
    const data = {};
    for (const [userId, s] of sessions) {
        data[userId] = { history: s.history, lastActive: s.lastActive };
    }
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(data)); }
    catch (e) { console.error('[Session] Save failed:', e.message); }
}

setInterval(saveHistory, 5 * 60 * 1000);

// ── Session TTL cleanup ───────────────────────────────────────────────────────
function cleanupSessions() {
    const cutoff = Date.now() - SESSION_TTL;
    let removed = 0;
    for (const [userId, s] of sessions) {
        if (s.lastActive < cutoff) { sessions.delete(userId); removed++; }
    }
    if (removed > 0) { console.log(`[Session] Evicted ${removed}`); saveHistory(); }
}
setInterval(cleanupSessions, 60 * 60 * 1000);

// ── Core message handler ──────────────────────────────────────────────────────
async function handleMessage(sock, jid, text) {
    const session = getSession(jid);
    session.lastActive = Date.now();

    const isFirstMessage = session.history.length === 0;
    const systemPrompt = isFirstMessage
        ? systemInstruction + '\n\nCRITICAL INSTRUCTION: This is the user\'s VERY FIRST message ever. You MUST greet them warmly and ask for their language preference (English or Hindi/Hinglish) BEFORE addressing their question. Do not skip this under any circumstances.'
        : systemInstruction;

    const completion = await groq.chat.completions.create({
        model: MODEL_NAME,
        messages: [
            { role: 'system', content: systemPrompt },
            ...session.history.map(h => ({
                role:    h.role === 'model' ? 'assistant' : 'user',
                content: h.parts[0].text,
            })),
            { role: 'user', content: text },
        ],
        max_tokens: 1024,
    });
    let responseText = completion.choices[0].message.content;

    const fileMatch = responseText.match(/\[SEND_FILE:\s*([A-Z_]+)\]/i);
    if (fileMatch) {
        const key = fileMatch[1].toUpperCase();
        responseText = responseText.replace(fileMatch[0], '').trim();
        await sock.sendMessage(jid, { text: responseText });

        const filePath = DOCUMENTS[key];
        if (filePath && fs.existsSync(filePath)) {
            await sock.sendMessage(jid, {
                document: fs.readFileSync(filePath),
                mimetype: 'application/pdf',
                fileName: basename(filePath),
            });
            console.log(`[File] Sent ${key} → ${jid}`);
        } else {
            console.error(`[File] No file for key: ${key}`);
        }
    } else {
        await sock.sendMessage(jid, { text: responseText });
    }

    session.history.push(
        { role: 'user',  parts: [{ text }] },
        { role: 'model', parts: [{ text: responseText }] }
    );
    if (session.history.length > MAX_TURNS * 2) session.history.splice(0, 2);
}

// ── WhatsApp connection state (shared with Express) ───────────────────────────
let latestQR      = null;
let botConnected  = false;

const noop = () => {};
const silentLogger = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
silentLogger.child = () => silentLogger;

async function connectToWhatsApp() {
    console.log('[WA] Loading auth state...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    console.log('[WA] Auth loaded. Fetching latest WA version...');

    const { version } = await fetchLatestBaileysVersion();
    console.log(`[WA] Using version ${version.join('.')}. Creating socket...`);

    const sock = makeWASocket({
        version,
        auth:                   state,
        logger:                 silentLogger,
        browser:                ['Curaid AI', 'Chrome', '120.0.0'],
        connectTimeoutMs:       60_000,
        keepAliveIntervalMs:    30_000,
    });
    console.log('[WA] Socket created. Waiting for connection...');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR     = qr;
            botConnected = false;
            console.log('[WhatsApp] QR ready — visit your Render URL to scan');
        }

        if (connection === 'open') {
            latestQR     = null;
            botConnected = true;
            console.log('Curaid Bot is ready.');
        }

        if (connection === 'close') {
            botConnected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                console.warn('[WhatsApp] Logged out — clearing auth and regenerating QR...');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            } else {
                console.warn(`[WhatsApp] Disconnected (${code}). Reconnecting in 5s...`);
            }
            setTimeout(connectToWhatsApp, 5000);
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const jid = msg.key.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue;

            const text = (
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                ''
            ).trim();

            if (!text) continue;

            console.log(`[msg] ${jid}: ${text}`);

            const session = getSession(jid);
            sock.sendPresenceUpdate('composing', jid).catch(() => {});

            session.queue = session.queue
                .then(() => handleMessage(sock, jid, text))
                .catch(async (err) => {
                    console.error(`[Error] ${jid}:`, err);
                    const isRateLimit = err.status === 429 || err.message?.includes('RESOURCE_EXHAUSTED');
                    await sock.sendMessage(jid, {
                        text: isRateLimit
                            ? "I'm receiving too many messages right now — please wait a minute. 💙"
                            : "I'm having trouble connecting right now. Please try again in a moment.",
                    }).catch(() => {});
                });
        }
    });
}

// ── Web server ────────────────────────────────────────────────────────────────
const app = express();

app.get('/', async (_req, res) => {
    if (botConnected) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f9f9f9">
                <h2 style="color:#2e7d32">✅ Curaid AI is live</h2>
                <p style="color:#555">Bot is connected and responding on WhatsApp.</p>
            </body></html>
        `);
    }
    if (latestQR) {
        try {
            const qrImage = await QRCode.toDataURL(latestQR);
            return res.send(`
                <html>
                <head><meta http-equiv="refresh" content="18"></head>
                <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f9f9f9">
                    <h2 style="color:#1565c0">Connect Curaid AI to WhatsApp</h2>
                    <img src="${qrImage}" style="width:280px;height:280px;display:block;margin:20px auto;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.15)"/>
                    <p style="color:#333">Open WhatsApp → <b>Linked Devices</b> → <b>Link a Device</b></p>
                    <p style="color:#888;font-size:13px">Page auto-refreshes every 18s for a fresh QR.</p>
                </body></html>
            `);
        } catch (e) {
            return res.send('QR generation failed. Check logs.');
        }
    }
    res.send(`
        <html>
        <head><meta http-equiv="refresh" content="3"></head>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#f9f9f9">
            <h2 style="color:#555">Curaid AI is starting up...</h2>
            <p style="color:#888">This page refreshes automatically.</p>
        </body></html>
    `);
});

app.listen(process.env.PORT || 3000, () =>
    console.log(`Server on port ${process.env.PORT || 3000}`)
);

// ── Boot ──────────────────────────────────────────────────────────────────────
loadHistory();
connectToWhatsApp().catch((err) => {
    console.error('[Fatal] connectToWhatsApp crashed:', err);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
    console.log('[Shutdown] Saving history...');
    saveHistory();
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

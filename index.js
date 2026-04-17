require('dotenv').config();
const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const express = require('express');

// 1. Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const systemInstruction = fs.readFileSync(path.join(__dirname, 'knowledge.txt'), 'utf-8');
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest", systemInstruction: systemInstruction });

// 2. State & Memory
const userChats = new Map();
let botReady = false;
let client;

// Memory-optimized Puppeteer settings
const puppeteerOptions = {
    headless: true,
    executablePath: process.env.CHROME_PATH || null, // Allow custom chrome path
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--js-flags="--max-old-space-size=400"', // Limit V8 heap memory
        '--disable-extensions',
        '--disable-default-apps',
        '--no-pings'
    ],
};

// 3. Bot Initialization Logic
async function initializeBot() {
    if (process.env.MONGODB_URI) {
        console.log('🌐 [Cloud Mode] Initializing...');
        console.log('⏳ Connecting to MongoDB Atlas...');
        try {
            await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
            console.log('✅ MongoDB Connected.');
            const store = new MongoStore({ mongoose: mongoose });
            client = new Client({
                authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 }),
                puppeteer: puppeteerOptions
            });
        } catch (err) {
            console.error('❌ MongoDB Error:', err.message);
            process.exit(1);
        }
    } else {
        console.log('🏠 Local Mode: Using LocalAuth.');
        client = new Client({ authStrategy: new LocalAuth(), puppeteer: puppeteerOptions });
    }

    setupClientEvents();
    console.log('🚀 Launching WhatsApp Client...');
    client.initialize();
}

function setupClientEvents() {
    client.on('qr', (qr) => {
        qrcodeTerminal.generate(qr, {small: true});
        qrcode.toFile(path.join(__dirname, 'qr.png'), qr, (err) => {
            if (err) console.error('QR Save Error:', err);
        });
    });

    client.on('ready', async () => {
        botReady = true;
        console.log('✅ Curaid Bot is ONLINE!');
        
        // --- MEMORY OPTIMIZATION ---
        // Block images, styles, and fonts to save RAM
        try {
            const page = await client.pupPage;
            if (page) {
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });
                console.log('🧠 Memory Optimization: Heavy assets blocked successfully.');
            }
        } catch (e) {
            console.warn('⚠️ Could not set up request interception, but bot is still running.');
        }
    });

    client.on('remote_session_saved', () => console.log('💾 Session saved to MongoDB!'));

    client.on('message', async (msg) => {
        if (msg.from.includes('@g.us') || msg.from === 'status@broadcast' || msg.isStatus) return;
        
        try {
            console.log(`\n💬 Message from ${msg.from}`);
            const chatWindow = await msg.getChat();
            await chatWindow.sendStateTyping();

            let chatSession = userChats.get(msg.from);
            if (!chatSession) {
                chatSession = model.startChat({ history: [] });
                userChats.set(msg.from, chatSession);
                
                // Keep chat history lean - remove very old sessions if memory is tight
                if (userChats.size > 100) {
                    const firstKey = userChats.keys().next().value;
                    userChats.delete(firstKey);
                }
            }

            const result = await chatSession.sendMessage(msg.body);
            let responseText = result.response.text();

            const fileMatch = responseText.match(/\[SEND_FILE:\s*([A-Z_]+)\]/i);
            if (fileMatch) {
                const fileNameKey = fileMatch[1].toUpperCase();
                let filePath = '';
                if (fileNameKey === 'UDID_FORM') filePath = path.join(__dirname, 'documents', 'udid_form.pdf');
                else if (fileNameKey === 'NIRAMAYA_FORM') filePath = path.join(__dirname, 'documents', 'niramaya_form.pdf');

                responseText = responseText.replace(fileMatch[0], '').trim();
                await msg.reply(responseText);
                if (filePath && fs.existsSync(filePath)) {
                    await msg.reply(MessageMedia.fromFilePath(filePath));
                }
            } else {
                await msg.reply(responseText);
            }
        } catch (error) {
            console.error("Gemini Error:", error);
        }
    });

    // Handle Auth Failures
    client.on('auth_failure', () => {
        console.error('❌ Auth failure. You might need to re-scan.');
        botReady = false;
    });

    process.on('SIGINT', async () => {
        if (client) await client.destroy();
        process.exit(0);
    });
}

// 4. Web Server Logic (Memory Lean)
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    if (botReady) {
        res.send(`<body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0f2f5;"><h1 style="color:#25d366;">✅ Curaid Bot Online</h1></body>`);
    } else {
        const qrPath = path.join(__dirname, 'qr.png');
        if (fs.existsSync(qrPath)) {
            res.send(`<body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0f2f5;"><h1>📱 WhatsApp Scan Required</h1><img src="/qr" style="width:300px;" /><p>Refreshes every 30s.</p><script>setTimeout(()=>location.reload(),30000);</script></body>`);
        } else {
            res.send(`<body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0f2f5;"><h1>⏳ Preparing...</h1><script>setTimeout(()=>location.reload(),5000);</script></body>`);
        }
    }
});

app.get('/qr', (req, res) => {
    const qrPath = path.join(__dirname, 'qr.png');
    if (fs.existsSync(qrPath)) res.sendFile(qrPath);
    else res.status(404).end();
});

app.listen(port, () => console.log(`🌍 Server on port ${port}`));

// 5. Start!
initializeBot();

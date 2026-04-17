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

const puppeteerOptions = {
    headless: true,
    args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu'
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
            else console.log('✅ QR Code updated and saved to qr.png');
        });
    });

    client.on('ready', () => {
        botReady = true;
        console.log('✅ Curaid Bot is ONLINE!');
    });

    client.on('remote_session_saved', () => console.log('💾 Session saved to MongoDB!'));

    client.on('message', async (msg) => {
        if (msg.from.includes('@g.us') || msg.from === 'status@broadcast' || msg.isStatus) return;
        try {
            console.log(`\n💬 Message from ${msg.from}: ${msg.body}`);
            const chatWindow = await msg.getChat();
            await chatWindow.sendStateTyping();

            let chatSession = userChats.get(msg.from);
            if (!chatSession) {
                chatSession = model.startChat({ history: [] });
                userChats.set(msg.from, chatSession);
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
            msg.reply("I'm having trouble connecting right now. Please try later.");
        }
    });

    process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down...');
        if (client) await client.destroy();
        process.exit(0);
    });
}

// 4. Web Server Logic (To view QR in browser)
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    if (botReady) {
        res.send(`
            <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #f0f2f5;">
                <h1 style="color: #25d366;">✅ Curaid Bot is ONLINE</h1>
                <p>The bot is logged in and listening for messages.</p>
                <div style="font-size: 50px;">🤖</div>
            </body>
        `);
    } else {
        const qrPath = path.join(__dirname, 'qr.png');
        if (fs.existsSync(qrPath)) {
            res.send(`
                <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #f0f2f5;">
                    <h1 style="color: #075e54;">📱 WhatsApp Login Required</h1>
                    <p>Scan this QR code with your WhatsApp app (Linked Devices) to start the bot.</p>
                    <div style="background: white; display: inline-block; padding: 20px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                        <img src="/qr" style="width: 300px; height: 300px;" />
                    </div>
                    <p style="color: #666;"><small>Auto-refreshes every 30s. Last updated: ${new Date().toLocaleTimeString()}</small></p>
                    <script>setTimeout(() => location.reload(), 30000);</script>
                </body>
            `);
        } else {
            res.send(`
                <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #f0f2f5;">
                    <h1>⏳ Preparing WhatsApp Bot...</h1>
                    <p>Generating QR code, please wait a few seconds and refresh.</p>
                    <script>setTimeout(() => location.reload(), 5000);</script>
                </body>
            `);
        }
    }
});

app.get('/qr', (req, res) => {
    const qrPath = path.join(__dirname, 'qr.png');
    if (fs.existsSync(qrPath)) res.sendFile(qrPath);
    else res.status(404).send('QR not generated yet');
});

app.listen(port, () => console.log(`🌍 Web interface: http://localhost:${port}`));

// 5. Start!
initializeBot();

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
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
        '--single-process', '--disable-gpu', '--js-flags="--max-old-space-size=350"'
    ],
};

// 3. Bot Initialization Logic
async function initializeBot() {
    console.log('🧪 Testing Gemini API connection...');
    try {
        const testResult = await model.generateContent("Hello?");
        console.log('✅ Gemini API is alive and responsive!');
    } catch (e) {
        console.error('❌ Gemini API Error: Please check your API key!', e.message);
    }

    if (process.env.MONGODB_URI) {
        console.log('🌐 [Cloud Mode] Initializing...');
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
        qrcode.toFile(path.join(__dirname, 'qr.png'), qr, (err) => { if (err) console.error('QR Save Error:', err); });
    });

    client.on('ready', async () => {
        botReady = true;
        console.log('✅ Curaid Bot is ONLINE!');
        try {
            const page = await client.pupPage;
            if (page) {
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                    else req.continue();
                });
                console.log('🧠 Asset Blocking: OK.');
            }
        } catch (e) { console.warn('⚠️ Interception skipped.'); }
    });

    client.on('message', async (msg) => {
        console.log(`\n📥 [NEW MESSAGE] From: ${msg.from} Body: "${msg.body}"`);
        
        if (msg.from.includes('@g.us') || msg.from === 'status@broadcast' || msg.isStatus) {
            console.log('⏭ [SKIP] Ignoring group/status message.');
            return;
        }
        
        try {
            console.log(`⏳ Triggering typing indicator...`);
            const chatWindow = await msg.getChat();
            await chatWindow.sendStateTyping();

            console.log(`🧠 Consultation Gemini for response...`);
            let chatSession = userChats.get(msg.from);
            if (!chatSession) {
                chatSession = model.startChat({ history: [] });
                userChats.set(msg.from, chatSession);
                if (userChats.size > 50) {
                    const firstKey = userChats.keys().next().value;
                    userChats.delete(firstKey);
                }
            }

            const result = await chatSession.sendMessage(msg.body);
            let responseText = result.response.text();
            console.log(`📤 [GEMINI REPLY] Length: ${responseText.length} chars`);

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
            console.log(`✅ [SUCCESS] Reply sent to ${msg.from}`);

        } catch (error) {
            console.error("❌ Message Error:", error.message);
            // Inform the user via WhatsApp that something went wrong
            msg.reply(`I'm sorry, I encountered an error while processing your request: ${error.message}`);
        }
    });

    process.on('SIGINT', async () => {
        if (client) await client.destroy();
        process.exit(0);
    });
}

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
    if (botReady) res.send(`✅ Bot Online - ${new Date().toLocaleTimeString()}`);
    else {
        const qrPath = path.join(__dirname, 'qr.png');
        if (fs.existsSync(qrPath)) res.send(`📱 Scan Required<br><img src="/qr" width="300"/><script>setTimeout(()=>location.reload(),30000);</script>`);
        else res.send(`⏳ Preparing...<script>setTimeout(()=>location.reload(),5000);</script>`);
    }
});
app.get('/qr', (req, res) => {
    const qrPath = path.join(__dirname, 'qr.png');
    if (fs.existsSync(qrPath)) res.sendFile(qrPath);
    else res.status(404).end();
});
app.listen(port, () => console.log(`Server: ${port}`));

setInterval(() => {
    const memory = process.memoryUsage().rss / 1024 / 1024;
    console.log(`📊 Memory: ${Math.round(memory)}MB/512MB`);
    if (memory > 450) { 
        console.log('⛔ MEMORY CRITICAL! Restarting...');
        process.exit(1); 
    }
}, 60000);

initializeBot();

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

// 2. Load the external knowledge base
const systemInstruction = fs.readFileSync(path.join(__dirname, 'knowledge.txt'), 'utf-8');

const model = genAI.getGenerativeModel({ 
    model: "gemini-flash-latest", 
    systemInstruction: systemInstruction 
});

// 3. User Chats Memory (Stores conversation history per user)
const userChats = new Map();

// 4. Initialize WhatsApp Client
let client;

const puppeteerOptions = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
    ],
};

async function initializeBot() {
    if (process.env.MONGODB_URI) {
        console.log('🌐 Cloud Mode: Connecting to MongoDB for session storage...');
        try {
            await mongoose.connect(process.env.MONGODB_URI);
            const store = new MongoStore({ mongoose: mongoose });
            
            client = new Client({
                authStrategy: new RemoteAuth({
                    store: store,
                    backupSyncIntervalMs: 300000
                }),
                puppeteer: puppeteerOptions
            });
            console.log('✅ RemoteAuth initialized.');
        } catch (err) {
            console.error('❌ MongoDB Connection Error:', err);
            process.exit(1);
        }
    } else {
        console.log('🏠 Local Mode: Using LocalAuth (Saving session to disk).');
        client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: puppeteerOptions
        });
    }

    setupClientEvents();
    client.initialize();
}

function setupClientEvents() {
    client.on('qr', (qr) => {
        // Generate QR in terminal
        qrcodeTerminal.generate(qr, {small: true});
        
        // Also save it as an image file
        qrcode.toFile('qr.png', qr, function (err) {
            if (err) console.error('QR Save Error:', err);
            else console.log('✅ QR Code saved as "qr.png" and displayed in the terminal!');
        });
    });

    client.on('ready', () => {
        console.log('✅ Curaid Bot is Ready and listening!');
    });

    client.on('remote_session_saved', () => {
        console.log('💾 Session successfully saved to MongoDB!');
    });

    client.on('message', async (msg) => {
        // Only respond to direct messages, ignore group chats and statuses
        if (msg.from.includes('@g.us') || msg.from === 'status@broadcast' || msg.isStatus) return;

        try {
            console.log(`\n💬 Received message from ${msg.from}: ${msg.body}`);

            // Typing indicator
            const chatWindow = await msg.getChat();
            await chatWindow.sendStateTyping();

            // Retrieve or create chat session for this user memory
            let chatSession = userChats.get(msg.from);
            if (!chatSession) {
                chatSession = model.startChat({
                    history: [],
                });
                userChats.set(msg.from, chatSession);
                console.log(`[Memory] Started new chat memory session for ${msg.from}`);
            }

            // Pass message to Gemini with memory attached
            const result = await chatSession.sendMessage(msg.body);
            let responseText = result.response.text();

            // MAGIC KEYWORD / FILE SENDING LOGIC
            const fileMatch = responseText.match(/\[SEND_FILE:\s*([A-Z_]+)\]/i);
            
            if (fileMatch) {
                const fileNameKey = fileMatch[1].toUpperCase();
                let filePath = '';
                
                if (fileNameKey === 'UDID_FORM') {
                    filePath = path.join(__dirname, 'documents', 'udid_form.pdf');
                } else if (fileNameKey === 'NIRAMAYA_FORM') {
                    filePath = path.join(__dirname, 'documents', 'niramaya_form.pdf');
                }

                responseText = responseText.replace(fileMatch[0], '').trim();
                await msg.reply(responseText);

                if (filePath && fs.existsSync(filePath)) {
                    const media = MessageMedia.fromFilePath(filePath);
                    await msg.reply(media);
                    console.log(`📄 [FILE SENT] Successfully sent ${fileNameKey} to ${msg.from}`);
                }
            } else {
                await msg.reply(responseText);
            }

        } catch (error) {
            console.error("Error communicating with Gemini: ", error);
            if (error.status === 429 || error.message.includes('429')) {
                msg.reply("I am receiving too many messages right now! Please wait 1 minute. 💙");
            } else {
                msg.reply("I'm sorry, I seem to be having a little trouble connecting right now.");
            }
        }
    });

    // 6. Graceful Shutdown
    process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down gracefully...');
        await client.destroy();
        console.log('✅ Client destroyed. Goodbye!');
        process.exit(0);
    });
}

// 5. Dummy Web Server (Required for Render)
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Curaid AI WhatsApp Bot is running!'));
app.listen(port, () => console.log(`🌍 Cloud Web Server listening on port ${port}`));

// Launch!
initializeBot();

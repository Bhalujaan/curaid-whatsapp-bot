require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

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

// 4. Initialize WhatsApp Client (With Cloud Server Support)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Critical for cloud servers
    }
});

// 5. Dummy Web Server (REQUIRED for free cloud hosting like Render to not crash)
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Curaid AI WhatsApp Bot is running flawlessly!'));
app.listen(port, () => console.log(`🌍 Cloud Web Server is listening on port ${port}`));

client.on('qr', (qr) => {
    // Generate QR in terminal for cloud server scanning
    qrcodeTerminal.generate(qr, {small: true});
    
    // Also save it as an image file just in case it's run locally
    qrcode.toFile('qr.png', qr, function (err) {
        if (err) throw err;
        console.log('✅ QR Code saved as "qr.png" and displayed in the terminal above!');
    });
});

client.on('ready', () => {
    console.log('✅ Curaid Bot is Ready! The "beast" is now online and listening with memory enabled.');
});

// 5. Handle Incoming Messages
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
                history: [], // Context is dynamically provided by the model systemInstruction
            });
            userChats.set(msg.from, chatSession);
            console.log(`[Memory] Started new chat memory session for ${msg.from}`);
        }

        // Pass message to Gemini with memory attached
        const result = await chatSession.sendMessage(msg.body);
        let responseText = result.response.text();

        // ==========================================
        // MAGIC KEYWORD / FILE SENDING LOGIC
        // ==========================================
        const fileMatch = responseText.match(/\[SEND_FILE:\s*([A-Z_]+)\]/i);
        
        if (fileMatch) {
            const fileNameKey = fileMatch[1].toUpperCase();
            let filePath = '';
            
            if (fileNameKey === 'UDID_FORM') {
                filePath = path.join(__dirname, 'documents', 'udid_form.pdf');
            } else if (fileNameKey === 'NIRAMAYA_FORM') {
                filePath = path.join(__dirname, 'documents', 'niramaya_form.pdf');
            }

            // Clean the response text from the magic tag
            responseText = responseText.replace(fileMatch[0], '').trim();

            // Send textual response
            await msg.reply(responseText);

            // Send document instantly
            if (filePath && fs.existsSync(filePath)) {
                const media = MessageMedia.fromFilePath(filePath);
                await msg.reply(media);
                console.log(`📄 [FILE SENT] Successfully sent ${fileNameKey} document to ${msg.from}`);
            } else {
                console.log(`❌ [FILE ERROR] Placeholder file not found for ${fileNameKey}`);
            }
        } else {
            // Normal text reply
            await msg.reply(responseText);
        }

    } catch (error) {
        console.error("Error communicating with Gemini: ", error);
        
        // Handle Google API Rate Limit / Quota Exceeded errors gracefully
        if (error.status === 429 || error.message.includes('429')) {
            msg.reply("I am receiving too many messages right now and need to catch my breath! Please wait 1 minute and try again. 💙");
        } else {
            msg.reply("I'm sorry, I seem to be having a little trouble connecting right now. Please try again later.");
        }
    }
});

client.initialize();

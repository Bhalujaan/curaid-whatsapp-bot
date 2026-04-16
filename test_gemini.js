require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-flash-latest", 
    systemInstruction: "You are a bot"
});
async function run() {
    try {
        const result = await model.generateContent("Hello");
        console.log(result.response.text());
    } catch (e) {
        console.error(e.status, e.statusText, e.message);
    }
}
run();

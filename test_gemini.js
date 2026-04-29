import 'dotenv/config';
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function run() {
    try {
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: 'Hello' }],
        });
        console.log(completion.choices[0].message.content);
    } catch (e) {
        console.error(e.status, e.message);
    }
}
run();

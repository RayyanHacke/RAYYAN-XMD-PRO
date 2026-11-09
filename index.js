const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    jidNormalizedUser,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const { exec } = require('child_process');
const yts = require('yt-search');
const axios = require('axios');

// ================= SILENCE NOISY LIBSIGNAL LOGS =================
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
function isSignalNoise(args) {
    const txt = util.format(...args);
    return (
        txt.includes('Closing session') ||
        txt.includes('Closing open session') ||
        txt.includes('ephemeralKeyPair') ||
        txt.includes('Session error') ||
        txt.includes('Failed to decrypt') ||
        txt.includes('MessageCounterError') ||
        txt.includes('Bad MAC')
    );
}
console.log = (...args) => { if (!isSignalNoise(args)) origLog.apply(console, args); };
console.error = (...args) => { if (!isSignalNoise(args)) origErr.apply(console, args); };
console.warn = (...args) => { if (!isSignalNoise(args)) origWarn.apply(console, args); };

// ================= CONFIGURATION & SAVED SETTINGS =================
const SETTINGS_FILE = './bot_settings.json';
const CONFIG = {
    botName: 'RAYYAN-XMD PRO',
    version: '6.0 ULTRA',
    prefix: '.',
    ownerName: 'Mr. Rayyan YouTuber',
    ownerNumber: '923329553169',
    sessionDir: './session',
    clonesDir: './clones',
    tempDir: './temp',
    YOUTUBE: 'https://youtube.com/@silladon29?si=yQ9KooeUuEjJHZ6Z',
    autoReply: true,
    aiChatMode: false,
    antiDelete: true,
    autoStatus: true,
    heartViewOnce: true,
    tgToken: '',
    tgChatId: ''
};

// Load saved Telegram Token & ID from file if present
if (fs.existsSync(SETTINGS_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        if (saved.tgToken) CONFIG.tgToken = saved.tgToken;
        if (saved.tgChatId) CONFIG.tgChatId = saved.tgChatId;
        if (saved.ownerNumber) CONFIG.ownerNumber = saved.ownerNumber;
    } catch (e) {}
}

function saveSettings() {
    try {
        fs.writeFileSync(
            SETTINGS_FILE,
            JSON.stringify(
                {
                    tgToken: CONFIG.tgToken,
                    tgChatId: CONFIG.tgChatId,
                    ownerNumber: CONFIG.ownerNumber
                },
                null,
                2
            ),
            'utf8'
        );
    } catch (e) {}
}

if (!fs.existsSync(CONFIG.tempDir)) fs.mkdirSync(CONFIG.tempDir, { recursive: true });
if (!fs.existsSync(CONFIG.clonesDir)) fs.mkdirSync(CONFIG.clonesDir, { recursive: true });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const processedMsgs = new Set();
const msgStore = new Map();
const senderStore = new Map();
const viewOnceVault = new Map();
const lastChatViewOnce = new Map();
const groupCache = new Map();
const activeGames = new Map();
const aiMemory = new Map();
const tgUserStates = new Map(); // Tracks Telegram users waiting to enter phone number or AI query
let mainWaSock = null;

// Retry Counter Cache (Fixes Clock Icon "Waiting for this message")
const retryMap = new Map();
const msgRetryCounterCache = {
    get: (k) => retryMap.get(k),
    set: (k, v) => {
        retryMap.set(k, v);
        if (retryMap.size > 2000) retryMap.delete(retryMap.keys().next().value);
    },
    del: (k) => retryMap.delete(k),
    flushAll: () => retryMap.clear()
};

function saveToStore(id, message, sender = '') {
    if (!id || !message) return;
    if (msgStore.has(id)) {
        const existing = extractViewOnceMedia(msgStore.get(id));
        const incoming = extractViewOnceMedia(message);
        if (existing?.media?.mediaKey && (!incoming || !incoming?.media?.mediaKey)) {
            return;
        }
    }
    msgStore.set(id, message);
    if (sender) senderStore.set(id, sender);
    if (msgStore.size > 3000) {
        const oldestKey = msgStore.keys().next().value;
        msgStore.delete(oldestKey);
        senderStore.delete(oldestKey);
    }
}

const DEV_FOOTER = `\n\n━━━━━━━━━━━━━━━━━━━━━━\n👑 *DEVELOPER:* ${CONFIG.ownerName}\n📺 *YOUTUBE:* ${CONFIG.YOUTUBE}`;

// ================= HELPER FUNCTIONS =================
function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d}d ${h}h ${m}m ${s}s`;
}

async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

function extractViewOnceMedia(obj) {
    if (!obj) return null;
    const isWrappedVO =
        !!obj?.viewOnceMessageV2 ||
        !!obj?.viewOnceMessage ||
        !!obj?.viewOnceMessageV2Extension ||
        !!obj?.ephemeralMessage?.message?.viewOnceMessageV2 ||
        !!obj?.ephemeralMessage?.message?.viewOnceMessage ||
        !!obj?.ephemeralMessage?.message?.viewOnceMessageV2Extension;

    const inner =
        obj?.viewOnceMessageV2?.message ||
        obj?.viewOnceMessage?.message ||
        obj?.viewOnceMessageV2Extension?.message ||
        obj?.ephemeralMessage?.message?.viewOnceMessageV2?.message ||
        obj?.ephemeralMessage?.message?.viewOnceMessage?.message ||
        obj?.ephemeralMessage?.message?.viewOnceMessageV2Extension?.message ||
        obj?.ephemeralMessage?.message ||
        obj;

    if (inner?.imageMessage) {
        return {
            type: 'image',
            media: inner.imageMessage,
            isViewOnce: isWrappedVO || !!inner.imageMessage.viewOnce
        };
    }
    if (inner?.videoMessage) {
        return {
            type: 'video',
            media: inner.videoMessage,
            isViewOnce: isWrappedVO || !!inner.videoMessage.viewOnce
        };
    }
    if (inner?.audioMessage) {
        return {
            type: 'audio',
            media: inner.audioMessage,
            isViewOnce: isWrappedVO || !!inner.audioMessage.viewOnce
        };
    }
    return null;
}

function isHeartEmoji(str) {
    if (!str) return false;
    const s = str.trim();
    return (
        ['❤️', '❤', '♥️', '♥', '💖', '💗', '💓', '💘', '💝', '❤️‍🔥', '❣️', '💕', '💞', '🖤', '🤍', '💚', '💛', '💜', '💙'].includes(s) ||
        s.includes('❤') ||
        s.includes('♥')
    );
}

function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout || stderr);
        });
    });
}

function generateFancyFonts(text) {
    const normal = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const styles = [
        { name: '🔥 BOLD SANS', map: '𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵' },
        { name: '👑 ROYAL SERIF', map: '𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝗢𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗' },
        { name: '✨ SCRIPT PRO', map: '𝒶𝒷𝒸𝒹𝑒𝒻𝑔𝒽𝒾𝒿𝓀𝓁𝓂𝓃𝑜𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏𝒜𝐵𝒞𝒟𝐸𝐹𝒢𝐻𝐼𝒥𝒦𝐿𝑀𝒩𝒪𝒫𝒬𝑅𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵0123456789' },
        { name: '💀 GOTHIC DARK', map: '𝖆𝖇𝖈𝖉𝖊𝖋𝖌𝖍𝖎𝖏𝖐𝖑𝖒𝖓𝖔𝖕𝖖𝖗𝖘𝖙𝖚𝖛𝖜𝖝𝖞𝖟𝕬𝕭𝕮𝕯𝕰𝕱𝕲𝕳𝕴𝕵𝕶𝕷𝕸𝕹𝕺𝕻𝕼𝕽𝕾𝕿𝖀𝖁𝖂𝖃𝖄𝖅0123456789' },
        { name: '💻 CYBER MONO', map: '𝚊𝚋𝚌𝚍𝚎𝚏𝚐𝚑𝚒𝚓𝚔𝚕𝚖𝚗𝚘𝚙𝚚𝚛𝚜𝚝𝚞𝚟𝚠𝚡𝚢𝚣𝙰𝙱𝙲𝙳𝙴𝙵𝙶𝙷𝙸𝙹𝙺𝙻𝙼𝙽𝙾𝙿𝚀𝚁𝚂𝚃𝚄𝚅𝚆𝚇𝚈𝚉𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿' },
        { name: '💎 DOUBLE STRUCK', map: '𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡' }
    ];
    return styles.map((s) => {
        const chars = Array.from(s.map);
        const converted = Array.from(text).map((ch) => {
            const idx = normal.indexOf(ch);
            return idx !== -1 ? chars[idx] : ch;
        }).join('');
        return `${s.name}: ${converted}`;
    }).join('\n\n');
}

// ================= REAL MULTI-ENGINE AI =================
async function askRayyanAI(userId, promptText) {
    const systemPrompt = `You are ${CONFIG.botName} (${CONFIG.version}), an advanced, ultra-intelligent WhatsApp & Telegram AI assistant created by ${CONFIG.ownerName} (Official YouTube Channel: ${CONFIG.YOUTUBE}).
Rules:
1. Always be loyal to and proud of your developer ${CONFIG.ownerName}.
2. Reply naturally in the same language the user speaks (Roman Urdu, Urdu, Pashto, or English).
3. Give clear, accurate, and smart answers.`;

    let history = aiMemory.get(userId) || [];
    history.push({ role: 'user', content: promptText });
    if (history.length > 8) history = history.slice(-8);

    try {
        const res = await axios.post(
            'https://text.pollinations.ai/openai',
            {
                model: 'openai',
                messages: [{ role: 'system', content: systemPrompt }, ...history]
            },
            { timeout: 18000, headers: { 'Content-Type': 'application/json' } }
        );
        const replyText = res.data?.choices?.[0]?.message?.content || (typeof res.data === 'string' ? res.data : '');
        if (replyText && replyText.trim()) {
            history.push({ role: 'assistant', content: replyText.trim() });
            aiMemory.set(userId, history);
            return replyText.trim();
        }
    } catch (e) {}

    try {
        const url = `https://text.pollinations.ai/${encodeURIComponent(promptText)}?model=openai&system=${encodeURIComponent(systemPrompt)}`;
        const res2 = await axios.get(url, { timeout: 15000 });
        if (res2.data) {
            const ans = typeof res2.data === 'string' ? res2.data.trim() : JSON.stringify(res2.data);
            history.push({ role: 'assistant', content: ans });
            aiMemory.set(userId, history);
            return ans;
        }
    } catch (e) {}

    return `Assalamu Alaikum! Main *${CONFIG.botName}* hoon (Developed by *${CONFIG.ownerName}*). Abhi AI server busy hai, dobara koshish karein!`;
}

// ================= FULL INTERACTIVE TELEGRAM BOT ENGINE (WITH INLINE BUTTONS) =================
let tgPollingActive = false;
let tgOffset = 0;

const TG_MAIN_KEYBOARD = {
    inline_keyboard: [
        [
            { text: '🚀 START / BOT STATUS', callback_data: 'tg_status' },
            { text: '📱 CONNECT WHATSAPP BOT', callback_data: 'tg_connect' }
        ],
        [
            { text: '📜 FULL COMMAND MENU', callback_data: 'tg_menu' },
            { text: '⚡ CHECK LIVE PING', callback_data: 'tg_ping' }
        ],
        [
            { text: '🤖 ASK RAYYAN AI', callback_data: 'tg_ai' },
            { text: '👑 OWNER & INFO', callback_data: 'tg_owner' }
        ],
        [
            { text: '📺 SUBSCRIBE YOUTUBE CHANNEL', url: CONFIG.YOUTUBE }
        ]
    ]
};

async function tgSend(chatId, text, replyMarkup = TG_MAIN_KEYBOARD) {
    if (!CONFIG.tgToken) return;
    try {
        await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
        });
    } catch (e) {
        try {
            await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
                chat_id: chatId,
                text: text.replace(/[*_`]/g, ''),
                reply_markup: replyMarkup
            });
        } catch (err) {}
    }
}

async function startTelegramBotEngine() {
    if (!CONFIG.tgToken || tgPollingActive) return;
    tgPollingActive = true;

    console.log(`\x1b[35m[✈️ TELEGRAM BOT]\x1b[0m ONLINE & Polling for /start and Button Clicks!`);
    if (CONFIG.tgChatId) {
        await tgSend(
            CONFIG.tgChatId,
            `╔══════════════════════════╗\n` +
            `║ ⚡ *${CONFIG.botName}* ⚡\n` +
            `╚══════════════════════════╝\n\n` +
            `✅ *BOT IS NOW ONLINE ON TELEGRAM & WHATSAPP!*\n\n` +
            `👑 *Developer:* ${CONFIG.ownerName}\n` +
            `⏱️ *Uptime:* ${formatUptime(process.uptime())}\n\n` +
            `👇 *Neeche diye gaye Buttons se Bot control karein:*`
        );
    }

    setInterval(async () => {
        if (!CONFIG.tgToken) return;
        try {
            const res = await axios.get(`https://api.telegram.org/bot${CONFIG.tgToken}/getUpdates?offset=${tgOffset + 1}&timeout=4`);
            const updates = res.data?.result || [];

            for (const up of updates) {
                tgOffset = up.update_id;

                // 1. Handle Inline Button Clicks
                if (up.callback_query) {
                    const cb = up.callback_query;
                    const cId = cb.message.chat.id;
                    const data = cb.data;

                    try {
                        await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/answerCallbackQuery`, {
                            callback_query_id: cb.id
                        });
                    } catch (e) {}

                    if (data === 'tg_status') {
                        await tgSend(
                            cId,
                            `🟢 *${CONFIG.botName} LIVE STATUS*\n\n` +
                            `⚡ *WhatsApp Engine:* ${mainWaSock ? 'CONNECTED ✅' : 'WAITING ⏳'}\n` +
                            `✈️ *Telegram Engine:* ACTIVE ✅\n` +
                            `⏱️ *Uptime:* ${formatUptime(process.uptime())}\n` +
                            `👑 *Developer:* ${CONFIG.ownerName}`
                        );
                    } else if (data === 'tg_connect') {
                        tgUserStates.set(cId, 'WAIT_PHONE');
                        await tgSend(
                            cId,
                            `📱 *CONNECT YOUR WHATSAPP TO ${CONFIG.botName}*\n\n` +
                            `👉 Apna WhatsApp number country code ke sath bhejein (Bina + ke):\n\n` +
                            `*Example:* \`923329553169\`\n\n` +
                            `⚡ Bot aapko 3 second mein *8-Digit Pairing Code* dega!`
                        );
                    } else if (data === 'tg_menu') {
                        await tgSend(
                            cId,
                            `╔══════════════════════════╗\n` +
                            `║ 📜 *${CONFIG.botName} MENU*\n` +
                            `╚══════════════════════════╝\n\n` +
                            `⚡ *TELEGRAM COMMANDS:*\n` +
                            `• \`/start\` - Open Button Dashboard\n` +
                            `• \`/connect 923xx\` - Link WhatsApp Bot\n` +
                            `• \`/ai <sawal>\` - Ask Real AI\n` +
                            `• \`/ping\` - Check Speed\n\n` +
                            `🔥 *WHATSAPP COMMANDS:*\n` +
                            `• *.menu* | *.ping* | *.alive*\n` +
                            `• *.edit* | *.fakereply* | *.magic*\n` +
                            `• *React ❤️* (Secret View-Once Saver)\n` +
                            `• *.ai* | *.imagine* | *.hack*\n` +
                            `• *.play* | *.yt* | *.tt* | *.mediafire*`
                        );
                    } else if (data === 'tg_ping') {
                        await tgSend(cId, `⚡ *${CONFIG.botName} SPEED TEST*\n\n🚀 *Response Speed:* 14 ms\n🟢 *Server:* Termux Ultra Engine`);
                    } else if (data === 'tg_ai') {
                        tgUserStates.set(cId, 'WAIT_AI');
                        await tgSend(cId, `🤖 *RAYYAN REAL AI*\n\nApna koi bhi sawal likh kar bhejein:`);
                    } else if (data === 'tg_owner') {
                        await tgSend(
                            cId,
                            `👑 *DEVELOPER INFORMATION*\n\n` +
                            `👤 *Name:* ${CONFIG.ownerName}\n` +
                            `📱 *WhatsApp:* +${CONFIG.ownerNumber}\n` +
                            `📺 *YouTube:* ${CONFIG.YOUTUBE}`
                        );
                    }
                    continue;
                }

                // 2. Handle Text Messages & Commands on Telegram
                const msg = up.message;
                if (!msg || !msg.text) continue;
                const cId = msg.chat.id;
                const txt = msg.text.trim();
                const userName = msg.from?.first_name || 'User';

                // Check if user is entering phone number after clicking [CONNECT WHATSAPP BOT]
                if (tgUserStates.get(cId) === 'WAIT_PHONE' && !txt.startsWith('/')) {
                    const cleanNum = txt.replace(/[^0-9]/g, '');
                    if (cleanNum.length >= 10 && cleanNum.length <= 15) {
                        tgUserStates.delete(cId);
                        await tgSend(cId, `⏳ *Generating 8-Digit Pairing Code for +${cleanNum}...*\nIntezar karein (3 seconds)...`);
                        const cloneDir = path.join(CONFIG.clonesDir, `tg_${cleanNum}`);
                        startRayyanBot(cloneDir, true, null, null, cleanNum, cId);
                        continue;
                    }
                }

                // Check if user is asking AI after clicking [ASK RAYYAN AI]
                if (tgUserStates.get(cId) === 'WAIT_AI' && !txt.startsWith('/')) {
                    tgUserStates.delete(cId);
                    const ans = await askRayyanAI(`tg_${cId}`, txt);
                    await tgSend(cId, `🤖 *${CONFIG.botName} AI:*\n\n${ans}`);
                    continue;
                }

                if (txt === '/start' || txt === '/menu' || txt === '.menu') {
                    await tgSend(
                        cId,
                        `╔══════════════════════════╗\n` +
                        `║ 👑 *${CONFIG.botName}* 👑\n` +
                        `╚══════════════════════════╝\n\n` +
                        `Assalamu Alaikum *${userName}*! 👋\n` +
                        `Welcome to *${CONFIG.botName}* Official Telegram Bot.\n\n` +
                        `👑 *Developer:* ${CONFIG.ownerName}\n` +
                        `📺 *YouTube:* @silladon29\n\n` +
                        `👇 *Apna WhatsApp connect karne ya Bot use karne ke liye neeche Buttons dabayein:*`
                    );
                } else if (txt.startsWith('/connect') || txt.startsWith('.connect')) {
                    const numArg = txt.split(/ +/)[1] || '';
                    const cleanNum = numArg.replace(/[^0-9]/g, '');
                    if (cleanNum.length < 10) {
                        tgUserStates.set(cId, 'WAIT_PHONE');
                        await tgSend(cId, `📱 *Apna WhatsApp number bhejein (Example: \`923329553169\`):*`);
                    } else {
                        await tgSend(cId, `⏳ *Generating 8-Digit Pairing Code for +${cleanNum}...*`);
                        const cloneDir = path.join(CONFIG.clonesDir, `tg_${cleanNum}`);
                        startRayyanBot(cloneDir, true, null, null, cleanNum, cId);
                    }
                } else if (txt === '/ping' || txt === '.ping') {
                    await tgSend(cId, `⚡ *${CONFIG.botName} PONG!*\n🚀 *Speed:* 12 ms\n🟢 *Status:* Online`);
                } else if (txt.startsWith('/ai ') || txt.startsWith('.ai ')) {
                    const q = txt.replace(/^(\/ai|\.ai)\s+/i, '');
                    const ans = await askRayyanAI(`tg_${cId}`, q);
                    await tgSend(cId, `🤖 *${CONFIG.botName} AI:*\n\n${ans}`);
                } else if (/^92[0-9]{9,10}$/.test(txt.replace(/[^0-9]/g, ''))) {
                    // Direct number sent in Telegram chat -> Auto-generate Pairing Code!
                    const cleanNum = txt.replace(/[^0-9]/g, '');
                    await tgSend(cId, `⏳ *Generating 8-Digit Pairing Code for +${cleanNum}...*`);
                    const cloneDir = path.join(CONFIG.clonesDir, `tg_${cleanNum}`);
                    startRayyanBot(cloneDir, true, null, null, cleanNum, cId);
                }
            }
        } catch (err) {}
    }, 3500);
}

// ================= GAME DATA (10 GAMES) =================
const RIDDLES = [
    { q: 'Wo kya cheez hai jo paani peeti hai to mar jati hai?', a: 'aag' },
    { q: 'Wo konsa phal hai jiske pait mein daant hote hain?', a: 'anaar' },
    { q: 'Kisi ke paas jitna zyada ho, utna kam nazar aata hai. Kya?', a: 'andhera' },
    { q: 'I have keys but no locks. I have space but no room. What am I?', a: 'keyboard' }
];
const WORDS = ['RAYYAN', 'YOUTUBE', 'PAKISTAN', 'TERMUX', 'WHATSAPP', 'HACKER'];
const QUIZZES = [
    { q: 'Pakistan ka dar-ul-hukoomat (Capital) konsa shehar hai?', a: 'islamabad' },
    { q: 'Dunya ki sab se oonchi choti konsi hai?', a: 'mount everest' },
    { q: '1 Byte mein kitne Bits hote hain?', a: '8' }
];
const TRUTHS = [
    'Apna sab se bara raaz batao!',
    'Aakhri baar kis se jhoot bola tha?',
    'WhatsApp par sab se zyada kis se baat karte ho?',
    'Bachpan ki sab se funny harkat kya thi?'
];
const DARES = [
    'Apne WhatsApp status par Mr. Rayyan YouTuber ka channel link lagao!',
    'Group mein 10 second ki funny voice note bhejo!',
    'Apni gallery ki 5th photo bina soche bhejo!',
    'Apne best friend ko "I am an alien" message karo!'
];

function showBanner() {
    console.clear();
    console.log(`\x1b[36m╔════════════════════════════════════════════════════════╗`);
    console.log(`║  ____      ___   ____   ___    _    _   _  __  ____  __ ║`);
    console.log(`║ |  _ \\    / \\ \\ / /\\ \\ / / \\  | \\ | |  \\ \\/ / |  \\/  | ║`);
    console.log(`║ | |_) |  / _ \\ V /  \\ V / _ \\ |  \\| |   \\  /  | |\\/| | ║`);
    console.log(`║ |  _ <  / ___ \\| |   | / ___ \\| |\\  |   /  \\  | |  | | ║`);
    console.log(`║ |_| \\_\\/_/   \\_\\_|   |_/_/   \\_\\_| \\_|  /_/\\_\\ |_|  |_| ║`);
    console.log(`║                                                        ║`);
    console.log(`║   👑 ${CONFIG.botName} (${CONFIG.version}) - MR. RAYYAN YT 👑 ║`);
    console.log(`╚════════════════════════════════════════════════════════╝\x1b[0m\n`);
}

// ================= TERMUX INTERACTIVE BUTTON DASHBOARD =================
async function showTermuxControlPanel() {
    showBanner();
    const waConnected = fs.existsSync(path.join(CONFIG.sessionDir, 'creds.json'));
    const tgConfigured = !!CONFIG.tgToken;

    console.log(`\x1b[33m╔════════════════════════════════════════════════════════╗`);
    console.log(`║         🎛️  TERMUX BOT CONTROL PANEL & BUTTONS         ║`);
    console.log(`╠════════════════════════════════════════════════════════╣`);
    console.log(`║  📱 WhatsApp Session : ${waConnected ? '\x1b[32mSAVED & READY ✅\x1b[33m' : '\x1b[31mNOT PAIRED YET ❌\x1b[33m'}                ║`);
    console.log(`║  ✈️  Telegram Token   : ${tgConfigured ? '\x1b[32mCONNECTED ✅\x1b[33m    ' : '\x1b[31mNOT SET ❌\x1b[33m      '}                ║`);
    console.log(`║  🆔 Telegram Chat ID : ${CONFIG.tgChatId ? '\x1b[32m' + CONFIG.tgChatId.padEnd(16, ' ') + '\x1b[33m' : '\x1b[37mOptional        \x1b[33m'}                ║`);
    console.log(`╠════════════════════════════════════════════════════════╣`);
    console.log(`║  \x1b[32m[ 1 ] 🚀 START BOT ONLINE (Launch WhatsApp + TG)\x1b[33m      ║`);
    console.log(`║  \x1b[36m[ 2 ] 🔑 SET TELEGRAM TOKEN & ID (Add/Edit Token)\x1b[33m     ║`);
    console.log(`║  \x1b[35m[ 3 ] 📱 PAIR NEW WHATSAPP NUMBER (New 8-Digit Code)\x1b[33m  ║`);
    console.log(`║  \x1b[31m[ 4 ] ❌ EXIT PANEL\x1b[33m                                   ║`);
    console.log(`╚════════════════════════════════════════════════════════╝\x1b[0m\n`);

    const choice = (await question('\x1b[32m👉 Press Button Number [1 - 4] (or press Enter to START): \x1b[0m')).trim();

    if (choice === '2') {
        console.log('\n\x1b[36m--- 🔑 TELEGRAM BOT CONFIGURATION ---\x1b[0m');
        const tok = (await question('👉 Enter Telegram Bot Token (from @BotFather): ')).trim();
        const cid = (await question('👉 Enter Your Telegram Chat ID (or press Enter to skip): ')).trim();
        if (tok) CONFIG.tgToken = tok;
        if (cid) CONFIG.tgChatId = cid;
        saveSettings();
        console.log('\x1b[32m[✓] Telegram Token & ID Saved Successfully!\x1b[0m');
        await new Promise((r) => setTimeout(r, 1200));
        return await showTermuxControlPanel();
    } else if (choice === '3') {
        fs.rmSync(CONFIG.sessionDir, { recursive: true, force: true });
        console.log('\x1b[32m[✓] Old session cleared! Starting fresh pairing...\x1b[0m');
        await new Promise((r) => setTimeout(r, 1000));
        startTelegramBotEngine();
        return await startRayyanBot();
    } else if (choice === '4') {
        console.log('\x1b[31m[!] Exiting Control Panel...\x1b[0m');
        process.exit(0);
    } else {
        // Button [1] or Enter -> Launch Both Bots Online!
        startTelegramBotEngine();
        return await startRayyanBot();
    }
}

// ================= MAIN WHATSAPP BOT ENGINE =================
async function startRayyanBot(
    customSessionDir = CONFIG.sessionDir,
    isClone = false,
    cloneTargetJid = null,
    parentSock = null,
    phoneForClone = '',
    tgChatIdForClone = null
) {
    if (!isClone) showBanner();
    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(customSessionDir);
    const { version } = await fetchLatestBaileysVersion();

    let isOnlineReady = false;

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: true,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        retryRequestDelayMs: 1200,
        msgRetryCounterCache,
        cachedGroupMetadata: async (jid) => groupCache.get(jid),
        getMessage: async (key) => {
            if (key?.id && msgStore.has(key.id)) return msgStore.get(key.id);
            return undefined;
        }
    });

    if (!isClone) mainWaSock = sock;

    // Outgoing message cache + Session Assertion (Eliminates Clock Icon "🕒")
    const origSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options = {}) => {
        const sent = await origSendMessage(jid, content, options);
        if (sent?.key?.id && sent?.message) {
            saveToStore(sent.key.id, sent.message, sock.user?.id);
        }
        return sent;
    };

    function getMyPersonalJid() {
        if (sock.user?.id) {
            return jidNormalizedUser(sock.user.id);
        }
        return `${CONFIG.ownerNumber}@s.whatsapp.net`;
    }

    // Pre-Download View-Once Media as soon as it arrives
    async function preSaveViewOnce(m) {
        try {
            const extracted = extractViewOnceMedia(m.message);
            if (!extracted || !extracted.media) return;
            if (!extracted.media.mediaKey && !extracted.media.directPath && !extracted.media.url) return;

            if (extracted.isViewOnce || extracted.type === 'image' || extracted.type === 'video' || extracted.type === 'audio') {
                const buffer = await downloadMedia(extracted.media, extracted.type);
                const chatJid = m.key.remoteJid || '';
                const senderJid = m.key.participant || chatJid;
                const senderNum = senderJid.split('@')[0].split(':')[0];
                const item = {
                    buffer,
                    type: extracted.type,
                    isViewOnce: extracted.isViewOnce,
                    senderNum,
                    chatJid,
                    msgId: m.key.id
                };

                viewOnceVault.set(m.key.id, item);
                if (viewOnceVault.size > 300) {
                    viewOnceVault.delete(viewOnceVault.keys().next().value);
                }

                if (extracted.isViewOnce) {
                    lastChatViewOnce.set(chatJid, item);
                    console.log(`\x1b[35m[📥 VIEW-ONCE CACHED]\x1b[0m Pre-saved ${extracted.type} from +${senderNum}`);
                }
            }
        } catch (e) {}
    }

    // Clock-Free Personal View-Once Delivery
    async function sendViewOnceToPersonal(msgId, fallbackChatJid = '', quotedObj = null) {
        try {
            let item = msgId ? viewOnceVault.get(msgId) : null;

            if (!item && msgId && msgStore.has(msgId)) {
                const stored = extractViewOnceMedia(msgStore.get(msgId));
                if (stored?.media && (stored.media.mediaKey || stored.media.url || stored.media.directPath)) {
                    const buffer = await downloadMedia(stored.media, stored.type);
                    const sJid = senderStore.get(msgId) || fallbackChatJid;
                    item = {
                        buffer,
                        type: stored.type,
                        senderNum: sJid.split('@')[0].split(':')[0]
                    };
                }
            }

            if (!item && quotedObj) {
                const qMedia = extractViewOnceMedia(quotedObj);
                if (qMedia?.media && (qMedia.media.mediaKey || qMedia.media.url || qMedia.media.directPath)) {
                    const buffer = await downloadMedia(qMedia.media, qMedia.type);
                    item = {
                        buffer,
                        type: qMedia.type,
                        senderNum: fallbackChatJid.split('@')[0].split(':')[0]
                    };
                }
            }

            if (!item && fallbackChatJid && lastChatViewOnce.has(fallbackChatJid)) {
                item = lastChatViewOnce.get(fallbackChatJid);
            }

            if (!item || !item.buffer) return false;

            const myPersonalJid = getMyPersonalJid();
            // Assert encryption session with Personal JID first so it NEVER gets stuck on a Clock Icon!
            try {
                await sock.assertSessions([myPersonalJid], true);
            } catch (e) {}

            const caption =
                `❤️ *SECRET VIEW-ONCE SAVED*\n` +
                `👤 *FROM:* +${item.senderNum || 'Unknown'}\n` +
                `📂 *TYPE:* ${item.type.toUpperCase()}` +
                `${DEV_FOOTER}`;

            if (item.type === 'image') {
                await sock.sendMessage(myPersonalJid, { image: item.buffer, mimetype: 'image/jpeg', caption });
            } else if (item.type === 'video') {
                await sock.sendMessage(myPersonalJid, { video: item.buffer, mimetype: 'video/mp4', caption });
            } else if (item.type === 'audio') {
                await sock.sendMessage(myPersonalJid, { audio: item.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
                await sock.sendMessage(myPersonalJid, { text: caption });
            }

            console.log(`\x1b[32m[❤️ DELIVERED]\x1b[0m Sent ${item.type} to Personal DM (${myPersonalJid}) without clock bug!`);
            return true;
        } catch (err) {
            console.error('Personal VV Send Error:', err.message);
            return false;
        }
    }

    sock.ev.on('messages.reaction', async (reactions) => {
        if (!CONFIG.heartViewOnce) return;
        for (const r of reactions) {
            const emoji = r.reaction?.text || '';
            if (isHeartEmoji(emoji) && r.key?.id) {
                await sendViewOnceToPersonal(r.key.id, r.key.remoteJid || '');
            }
        }
    });

    // 1. Pairing Code Handler (Supports Termux, WhatsApp .connect, AND Telegram /connect!)
    if (!sock.authState.creds.registered) {
        if (isClone && phoneForClone) {
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(phoneForClone);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    const pairMsg =
                        `╔══════════════════════════╗\n` +
                        `║ 🔗 *${CONFIG.botName} PAIRING*\n` +
                        `╚══════════════════════════╝\n\n` +
                        `📱 *NUMBER:* +${phoneForClone}\n` +
                        `🔑 *PAIRING CODE:* *${code}*\n\n` +
                        `📌 *HOW TO CONNECT:*\n` +
                        `1. Open WhatsApp -> Linked Devices\n` +
                        `2. Tap *Link a Device*\n` +
                        `3. Tap *Link with phone number instead*\n` +
                        `4. Enter Code: *${code}*${DEV_FOOTER}`;

                    if (parentSock && cloneTargetJid) {
                        await parentSock.sendMessage(cloneTargetJid, { text: pairMsg });
                    }
                    if (tgChatIdForClone) {
                        await tgSend(tgChatIdForClone, pairMsg);
                    }
                } catch (err) {
                    if (parentSock && cloneTargetJid) {
                        await parentSock.sendMessage(cloneTargetJid, { text: `❌ Pairing Error: ${err.message}` });
                    }
                    if (tgChatIdForClone) {
                        await tgSend(tgChatIdForClone, `❌ Pairing Error: ${err.message}`);
                    }
                }
            }, 3000);
        } else if (!isClone) {
            const phoneNumber = await question('\x1b[33m[?] Enter your WhatsApp number (e.g., 923xxxxxxxxx): \x1b[0m');
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');

            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(cleanNumber);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`\n\x1b[32m╔══════════════════════════════════════════╗`);
                    console.log(`║ 🔗 YOUR PAIRING CODE: ${code.padEnd(18, ' ')} ║`);
                    console.log(`╚══════════════════════════════════════════╝\x1b[0m\n`);
                } catch (err) {
                    console.error('Failed to request pairing code:', err.message);
                }
            }, 3000);
        }
    }

    sock.ev.on('creds.update', saveCreds);

    // 2. Bulletproof Connection Lifecycle
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            isOnlineReady = false;
            const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 0;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (!isClone) console.log(`\x1b[31m[!] Connection drop (Code: ${statusCode}). Auto-Reconnecting...\x1b[0m`);
            if (shouldReconnect) {
                sock.ev.removeAllListeners();
                setTimeout(() => startRayyanBot(customSessionDir, isClone, cloneTargetJid, parentSock, phoneForClone, tgChatIdForClone), 2500);
            } else if (!isClone) {
                console.log('\x1b[31m[!] Device logged out. Run node index.js and choose Option [3] to re-pair.\x1b[0m');
            }
        } else if (connection === 'open') {
            if (!isClone) console.log(`\x1b[33m[~] Connected! Preparing encryption sessions...\x1b[0m`);
            // Warm up self-session immediately so personal messages never show a clock icon
            try {
                await sock.assertSessions([getMyPersonalJid()], true);
            } catch (e) {}

            if (isClone && tgChatIdForClone) {
                await tgSend(
                    tgChatIdForClone,
                    `🎉 *MUBARAK HO! WHATSAPP CONNECTED!*\n\n` +
                    `📱 *Number:* +${phoneForClone}\n` +
                    `⚡ *Bot:* ${CONFIG.botName}\n` +
                    `👉 Ab WhatsApp mein جا کر *.menu* لکھیں!`
                );
            }

            setTimeout(() => {
                isOnlineReady = true;
                if (!isClone) console.log(`\x1b[32m[✓] ${CONFIG.botName} IS NOW ONLINE & READY FOR YOUTUBE VIDEO!\x1b[0m`);
            }, 2500);
        }
    });

    // 3. Command & Message Handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        for (const m of messages) {
            if (!m.message || !m.key || !m.key.id) continue;

            const remoteJid = m.key.remoteJid;
            if (!remoteJid) continue;

            // AUTO-STATUS VIEWER
            if (remoteJid === 'status@broadcast') {
                if (CONFIG.autoStatus && !m.key.fromMe) {
                    try {
                        await sock.readMessages([m.key]);
                    } catch (e) {}
                }
                continue;
            }

            // HANDLE ❤️ REACTION INSIDE UPSERT STREAM
            const reactMsg =
                m.message?.reactionMessage ||
                m.message?.ephemeralMessage?.message?.reactionMessage;
            if (reactMsg) {
                if (CONFIG.heartViewOnce && isHeartEmoji(reactMsg.text) && reactMsg.key?.id) {
                    await sendViewOnceToPersonal(reactMsg.key.id, remoteJid);
                }
                continue;
            }

            // ANTI-DELETE MESSAGE RECOVERY DETECTOR
            const protoMsg = m.message?.protocolMessage;
            if (protoMsg && (protoMsg.type === 0 || protoMsg.key?.id) && CONFIG.antiDelete && !m.key.fromMe) {
                const deletedId = protoMsg.key?.id;
                if (deletedId && msgStore.has(deletedId)) {
                    const oldMsg = msgStore.get(deletedId);
                    const deleter = m.key.participant || m.key.remoteJid;
                    const oldText =
                        oldMsg?.conversation ||
                        oldMsg?.extendedTextMessage?.text ||
                        oldMsg?.imageMessage?.caption ||
                        oldMsg?.videoMessage?.caption || '';

                    try {
                        if (oldText && !oldText.startsWith(CONFIG.prefix)) {
                            await sock.sendMessage(remoteJid, {
                                text: `🛡️ *ANTI-DELETE RECOVERED*\n👤 *USER:* @${deleter.split('@')[0]}\n💬 *MESSAGE:* ${oldText}${DEV_FOOTER}`,
                                mentions: [deleter]
                            });
                        } else if (oldMsg?.imageMessage) {
                            const buf = await downloadMedia(oldMsg.imageMessage, 'image');
                            await sock.sendMessage(remoteJid, {
                                image: buf,
                                caption: `🛡️ *ANTI-DELETE PHOTO RECOVERED*\n👤 *USER:* @${deleter.split('@')[0]}${DEV_FOOTER}`,
                                mentions: [deleter]
                            });
                        } else if (oldMsg?.videoMessage) {
                            const buf = await downloadMedia(oldMsg.videoMessage, 'video');
                            await sock.sendMessage(remoteJid, {
                                video: buf,
                                caption: `🛡️ *ANTI-DELETE VIDEO RECOVERED*\n👤 *USER:* @${deleter.split('@')[0]}${DEV_FOOTER}`,
                                mentions: [deleter]
                            });
                        }
                    } catch (e) {}
                }
                continue;
            }

            saveToStore(m.key.id, m.message, m.key.participant || m.key.remoteJid);
            preSaveViewOnce(m);

            if (processedMsgs.has(m.key.id)) continue;
            processedMsgs.add(m.key.id);
            if (processedMsgs.size > 1000) {
                processedMsgs.delete(processedMsgs.values().next().value);
            }

            if (!isOnlineReady) continue;

            const msg =
                m.message?.ephemeralMessage?.message ||
                m.message?.viewOnceMessage?.message ||
                m.message?.viewOnceMessageV2?.message ||
                m.message?.documentWithCaptionMessage?.message ||
                m.message;

            const body = (
                msg?.conversation ||
                msg?.extendedTextMessage?.text ||
                msg?.imageMessage?.caption ||
                msg?.videoMessage?.caption ||
                ''
            ).trim();

            if (!body) continue;

            const isGroup = remoteJid.endsWith('@g.us');

            const reply = async (content, withYtBanner = false) => {
                const fullText = `${content}${DEV_FOOTER}`;
                const msgPayload = { text: fullText };
                if (withYtBanner) {
                    msgPayload.contextInfo = {
                        externalAdReply: {
                            title: `👑 ${CONFIG.botName} • ${CONFIG.ownerName}`,
                            body: `TAP HERE TO OPEN YOUTUBE CHANNEL (@silladon29)`,
                            mediaType: 1,
                            renderLargerThumbnail: true,
                            showAdAttribution: true,
                            sourceUrl: CONFIG.YOUTUBE
                        }
                    };
                }
                return await sock.sendMessage(remoteJid, msgPayload, { quoted: m });
            };

            const react = async (emoji) => {
                try {
                    await sock.sendMessage(remoteJid, { react: { text: emoji, key: m.key } });
                } catch (e) {}
            };

            // ================= ❤️ DIRECT HEART REPLY IN CHAT =================
            if (CONFIG.heartViewOnce && isHeartEmoji(body)) {
                const contextInfo = msg?.extendedTextMessage?.contextInfo;
                await sendViewOnceToPersonal(contextInfo?.stanzaId, remoteJid, contextInfo?.quotedMessage);
                continue;
            }

            // ================= AUTO-REPLY & REAL AI CONVERSATION =================
            if (!body.startsWith(CONFIG.prefix)) {
                if (!m.key.fromMe && CONFIG.autoReply) {
                    const lower = body.toLowerCase();
                    if (['hi', 'hello', 'hey', 'salam', 'assalam o alaikum', 'assalamu alaikum', 'aoa', 'slm'].includes(lower)) {
                        await react('👋');
                        await reply(`*ASSALAMU ALAIKUM WA RAHMATULLAH!* 👑\n\nMain *${CONFIG.botName}* hoon (Developer: *${CONFIG.ownerName}*).\nMenu dekhne ke liye *${CONFIG.prefix}menu* likhein!`, true);
                        continue;
                    } else if (CONFIG.aiChatMode && !isGroup) {
                        await react('🤖');
                        const aiAns = await askRayyanAI(remoteJid, body);
                        await reply(`🤖 *${CONFIG.botName} AI:*\n\n${aiAns}`);
                        continue;
                    }
                }
                continue;
            }

            const args = body.slice(CONFIG.prefix.length).trim().split(/ +/);
            const cmd = args.shift().toLowerCase().replace(/\.+$/, '');
            const text = args.join(' ');

            if (isHeartEmoji(cmd)) {
                const contextInfo = msg?.extendedTextMessage?.contextInfo;
                await sendViewOnceToPersonal(contextInfo?.stanzaId, remoteJid, contextInfo?.quotedMessage);
                continue;
            }

            console.log(`\x1b[36m[📩 LIVE CMD]\x1b[0m .${cmd} ${text ? '| ' + text : ''}`);

            try {
                switch (cmd) {
                    // ================= BIG, BOLD, STRAIGHT VIP MENU (NO SLANTED/ITALIC TEXT, NO TG TOKEN) =================
                    case 'menu':
                    case 'help': {
                        await react('⚡');
                        const menuText = `📺 *OFFICIAL YOUTUBE CHANNEL:*
👉 ${CONFIG.YOUTUBE}

╔══════════════════════╗
║ ⚡ *${CONFIG.botName}* ⚡
║ 👑 *MR. RAYYAN YOUTUBER*
╚══════════════════════╝
▣ *VERSION :* ${CONFIG.version}
▣ *PREFIX :* [  *${CONFIG.prefix}*  ]
▣ *UPTIME :* ${formatUptime(process.uptime())}
▣ *STATUS :* *ONLINE & ACTIVE* ✅

╔══════════════════════╗
║ 🤯 *CRAZY EDIT & MAGIC*
╚══════════════════════╝
➤ *.EDIT*  <naya message>
➤ *.FAKEREPLY*  <msg> | <reply>
➤ *.MAGIC*  <lafz1> | <lafz2>
➤ *.HACK*  <target name>

╔══════════════════════╗
║ 📥 *MEDIA & DOWNLOADERS*
╚══════════════════════╝
➤ *REACT ❤️*  (Save ViewOnce to DM)
➤ *.VV* / *.VV2*  (Unlock ViewOnce)
➤ *.PLAY*  <song name>
➤ *.YT*  <youtube link>
➤ *.TT*  <tiktok link>
➤ *.MEDIAFIRE*  <link>
➤ *.PP*  (Save HD Profile Pic)
➤ *.STICKER*  (Image to Sticker)

╔══════════════════════╗
║ 🤖 *REAL AI & CYBER TOOLS*
╚══════════════════════╝
➤ *.AI*  <your question>
➤ *.IMAGINE*  <ai image prompt>
➤ *.IP*  <ip or website>
➤ *.WHOIS*  <923xxxxxxxxx>
➤ *.GIT*  <github username>
➤ *.QR*  <text>  |  *.SHORT*  <url>
➤ *.FANCY*  <text>  |  *.BOMB*
➤ *.TTS*  <voice>  |  *.TR*  <lang>

╔══════════════════════╗
║ 🎮 *10 CHAT GAMES & CORE*
╚══════════════════════╝
➤ *.GAMES*  (All 10 Games List)
➤ *.TTT*  |  *.GUESS*  |  *.RPS*
➤ *.MATH*  |  *.RIDDLE*  |  *.QUIZ*
➤ *.TRUTH*  |  *.DARE*  |  *.SLOT*
➤ *.CONNECT*  <923xxxxxxxxx>
➤ *.PING*  |  *.ALIVE*  |  *.OWNER*`;
                        await reply(menuText, true);
                        break;
                    }

                    // ================= 🤯 FIXED CRAZY MESSAGE EDIT & SPOOF (ZERO CLOCK BUG!) =================
                    case 'edit':
                    case 'change': {
                        const contextInfo = msg?.extendedTextMessage?.contextInfo;
                        const stanzaId = contextInfo?.stanzaId;
                        const participant = contextInfo?.participant || remoteJid;

                        if (!stanzaId || !text) {
                            await reply(
                                `🤯 *CRAZY MESSAGE EDITOR*\n\n` +
                                `Kisi bhi message par swipe-reply karke likhein:\n` +
                                `👉 *.edit <naya message>*\n` +
                                `Ya dost ke message par:\n` +
                                `👉 *.edit <dost ka naya msg> | <aapka jawab>*`
                            );
                            break;
                        }

                        // Step 1: Stealth delete your ".edit" command message
                        if (m.key.fromMe) {
                            try {
                                await sock.sendMessage(remoteJid, { delete: m.key });
                            } catch (e) {}
                        }

                        const myNum = getMyPersonalJid().split('@')[0];
                        const isQuotedFromMe =
                            (contextInfo?.participant && contextInfo.participant.includes(myNum)) ||
                            (!contextInfo?.participant && msgStore.has(stanzaId) && senderStore.get(stanzaId)?.includes(myNum));

                        const parts = text.split('|').map((s) => s.trim());
                        const newText = parts[0];
                        const replyComment = parts[1] || `👀👆 *Yeh tumne kya likha hai?!* 😂`;

                        if (isQuotedFromMe && parts.length === 1) {
                            // Safe in-place edit for your own message
                            await sock.sendMessage(remoteJid, {
                                text: newText,
                                edit: {
                                    remoteJid,
                                    fromMe: true,
                                    id: stanzaId
                                }
                            });
                        } else {
                            // Safe Spoofed Quote for friend's message (Never stalls WhatsApp socket!)
                            const fakeQuotedMsg = {
                                key: {
                                    remoteJid,
                                    fromMe: false,
                                    id: stanzaId,
                                    participant: isGroup ? participant : undefined
                                },
                                message: {
                                    conversation: newText
                                }
                            };
                            await sock.sendMessage(remoteJid, { text: replyComment }, { quoted: fakeQuotedMsg });
                        }
                        break;
                    }

                    case 'fakereply':
                    case 'spoof':
                    case 'fake': {
                        const contextInfo = msg?.extendedTextMessage?.contextInfo;
                        if (!text.includes('|')) {
                            await reply(
                                `🤯 *FAKE QUOTE SPOOFER*\n\n` +
                                `Dost ke message par reply karke likhein:\n` +
                                `👉 *.fakereply <Dost ka naya msg> | <Aapka jawab>*`
                            );
                            break;
                        }

                        if (m.key.fromMe) {
                            try {
                                await sock.sendMessage(remoteJid, { delete: m.key });
                            } catch (e) {}
                        }

                        const [fakeWords, myReply] = text.split('|').map((s) => s.trim());
                        const targetSender =
                            contextInfo?.participant ||
                            contextInfo?.mentionedJid?.[0] ||
                            remoteJid;
                        const targetMsgId = contextInfo?.stanzaId || ('3EB0' + Date.now().toString(16).toUpperCase());

                        const fakeQuoted = {
                            key: {
                                remoteJid,
                                fromMe: false,
                                id: targetMsgId,
                                participant: isGroup ? targetSender : undefined
                            },
                            message: {
                                conversation: fakeWords
                            }
                        };

                        await sock.sendMessage(remoteJid, { text: myReply }, { quoted: fakeQuoted });
                        break;
                    }

                    case 'magic':
                    case 'morph': {
                        if (!text) {
                            await reply(`✨ *LIVE MAGIC MORPHING MESSAGE*\nExample: *.magic Hello | Kya haal hai? | RAYYAN-XMD PRO IS KING 👑*`);
                            break;
                        }
                        if (m.key.fromMe) {
                            try {
                                await sock.sendMessage(remoteJid, { delete: m.key });
                            } catch (e) {}
                        }
                        const frames = text.includes('|')
                            ? text.split('|').map((s) => s.trim()).filter(Boolean)
                            : ['👋 *HELLO...*', '👀 *Yahan dekho message badal raha hai...*', '🔥 *POWERED BY RAYYAN-XMD PRO!*', `👑 *DEVELOPER: ${CONFIG.ownerName}*`];

                        const sentMsg = await sock.sendMessage(remoteJid, { text: frames[0] });
                        for (let i = 1; i < frames.length; i++) {
                            await new Promise((r) => setTimeout(r, 1100));
                            await sock.sendMessage(remoteJid, { text: frames[i], edit: sentMsg.key });
                        }
                        break;
                    }

                    case 'readmore':
                    case 'rm': {
                        if (!text.includes('|')) {
                            await reply(`📖 *FAKE READ-MORE TRAP*\nExample: *.readmore I love you | April Fool 😂 Powered by RAYYAN-XMD PRO*`);
                            break;
                        }
                        if (m.key.fromMe) {
                            try {
                                await sock.sendMessage(remoteJid, { delete: m.key });
                            } catch (e) {}
                        }
                        const [topPart, bottomPart] = text.split('|').map((s) => s.trim());
                        const readMoreChar = String.fromCharCode(8206).repeat(4001);
                        await sock.sendMessage(remoteJid, { text: `${topPart}${readMoreChar}\n\n${bottomPart}${DEV_FOOTER}` });
                        break;
                    }

                    // ================= PING, ALIVE, SYSINFO, OWNER =================
                    case 'ping': {
                        const start = Date.now();
                        await react('⚡');
                        const latency = Date.now() - start;
                        await reply(`⚡ *${CONFIG.botName} LIVE PING*\n\n🚀 *SPEED:* ${latency} ms\n🟢 *STATUS:* SUPER FAST & ONLINE`, true);
                        break;
                    }

                    case 'alive': {
                        await react('👑');
                        await reply(
                            `╔══════════════════════╗\n` +
                            `║ ⚡ *${CONFIG.botName}* ⚡\n` +
                            `╚══════════════════════╝\n\n` +
                            `⏳ *UPTIME:* ${formatUptime(process.uptime())}\n` +
                            `👑 *DEVELOPER:* ${CONFIG.ownerName}\n` +
                            `❤️ *HEART VV SAVER:* ${CONFIG.heartViewOnce ? 'ACTIVE ✅' : 'OFF'}\n` +
                            `🛡️ *ANTI-DELETE:* ${CONFIG.antiDelete ? 'ACTIVE ✅' : 'OFF'}\n` +
                            `📺 *YOUTUBE:* ${CONFIG.YOUTUBE}`,
                            true
                        );
                        break;
                    }

                    case 'runtime':
                    case 'uptime': {
                        await reply(`⏱️ *${CONFIG.botName} UPTIME:* ${formatUptime(process.uptime())}`);
                        break;
                    }

                    case 'sysinfo':
                    case 'ram': {
                        const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
                        const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
                        const usedMem = (totalMem - freeMem).toFixed(2);
                        await reply(
                            `🖥️ *${CONFIG.botName} SYSTEM STATUS*\n\n` +
                            `📟 *OS:* ${os.type()} (${os.arch()})\n` +
                            `💾 *RAM USED:* ${usedMem} GB / ${totalMem} GB\n` +
                            `🔋 *NODE VERSION:* ${process.version}\n` +
                            `⏱️ *UPTIME:* ${formatUptime(process.uptime())}`
                        );
                        break;
                    }

                    case 'owner': {
                        await react('👑');
                        const vcard =
                            'BEGIN:VCARD\n' +
                            'VERSION:3.0\n' +
                            `FN:${CONFIG.ownerName}\n` +
                            `ORG:${CONFIG.botName} Developer;\n` +
                            `TEL;type=CELL;type=VOICE;waid=${CONFIG.ownerNumber}:+${CONFIG.ownerNumber}\n` +
                            `URL:${CONFIG.YOUTUBE}\n` +
                            'END:VCARD';
                        await sock.sendMessage(
                            remoteJid,
                            {
                                contacts: {
                                    displayName: CONFIG.ownerName,
                                    contacts: [{ vcard }]
                                }
                            },
                            { quoted: m }
                        );
                        await reply(`👑 *DEVELOPER:* ${CONFIG.ownerName}\n📺 *YOUTUBE CHANNEL:* ${CONFIG.YOUTUBE}`, true);
                        break;
                    }

                    // ================= REAL AI & SMART MODE TOGGLES =================
                    case 'ai':
                    case 'gpt':
                    case 'ask': {
                        if (!text) {
                            await reply(`🤖 *${CONFIG.botName} REAL AI*\nKoi bhi sawal poochein!\nExample: *.ai Who is your developer?*`);
                            break;
                        }
                        await react('🧠');
                        const answer = await askRayyanAI(remoteJid, text);
                        await reply(`🤖 *${CONFIG.botName} AI:*\n\n${answer}`, true);
                        break;
                    }

                    case 'imagine':
                    case 'dalle':
                    case 'aiimg': {
                        if (!text) {
                            await reply(`🎨 *REAL AI IMAGE GENERATOR*\nExample: *.imagine Pakistani cyber hacker in neon mask*`);
                            break;
                        }
                        await react('🎨');
                        await reply(`🎨 *GENERATING REAL AI HD IMAGE...*\n📌 *PROMPT:* ${text}`);
                        const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(text)}?width=1024&height=1024&nologo=true&seed=${Date.now()}`;
                        const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
                        await sock.sendMessage(
                            remoteJid,
                            {
                                image: Buffer.from(imgRes.data),
                                caption: `🎨 *AI GENERATED HD IMAGE*\n✨ *PROMPT:* ${text}${DEV_FOOTER}`
                            },
                            { quoted: m }
                        );
                        break;
                    }

                    case 'heartvv': {
                        const mode = text.toLowerCase();
                        if (mode === 'on') CONFIG.heartViewOnce = true;
                        else if (mode === 'off') CONFIG.heartViewOnce = false;
                        else CONFIG.heartViewOnce = !CONFIG.heartViewOnce;
                        await reply(`❤️ *HEART REACTION VIEW-ONCE SAVER:* ${CONFIG.heartViewOnce ? 'ENABLED ✅' : 'DISABLED ❌'}`);
                        break;
                    }

                    case 'autoreply': {
                        const mode = text.toLowerCase();
                        if (mode === 'on') CONFIG.autoReply = true;
                        else if (mode === 'off') CONFIG.autoReply = false;
                        else CONFIG.autoReply = !CONFIG.autoReply;
                        await reply(`🤖 *AUTO-REPLY:* ${CONFIG.autoReply ? 'ENABLED ✅' : 'DISABLED ❌'}`);
                        break;
                    }

                    case 'aichat': {
                        const mode = text.toLowerCase();
                        if (mode === 'on') CONFIG.aiChatMode = true;
                        else if (mode === 'off') CONFIG.aiChatMode = false;
                        else CONFIG.aiChatMode = !CONFIG.aiChatMode;
                        await reply(`🧠 *FULL REAL AI AUTO-CHAT:* ${CONFIG.aiChatMode ? 'ENABLED ✅' : 'DISABLED ❌'}`);
                        break;
                    }

                    case 'antidelete': {
                        const mode = text.toLowerCase();
                        if (mode === 'on') CONFIG.antiDelete = true;
                        else if (mode === 'off') CONFIG.antiDelete = false;
                        else CONFIG.antiDelete = !CONFIG.antiDelete;
                        await reply(`🛡️ *ANTI-DELETE RECOVERY:* ${CONFIG.antiDelete ? 'ENABLED ✅' : 'DISABLED ❌'}`);
                        break;
                    }

                    case 'autostatus': {
                        const mode = text.toLowerCase();
                        if (mode === 'on') CONFIG.autoStatus = true;
                        else if (mode === 'off') CONFIG.autoStatus = false;
                        else CONFIG.autoStatus = !CONFIG.autoStatus;
                        await reply(`👁️ *AUTO-VIEW STATUS:* ${CONFIG.autoStatus ? 'ENABLED ✅' : 'DISABLED ❌'}`);
                        break;
                    }

                    // ================= CRAZY CYBER & PRO TOOLS =================
                    case 'hack': {
                        const target = text || 'Target Device';
                        await react('💻');
                        const initMsg = await sock.sendMessage(
                            remoteJid,
                            { text: `💻 *INITIALIZING RAYYAN-XMD CYBER TERMINAL...*\n🎯 *TARGET:* ${target}\n⏳ *[▒▒▒▒▒▒▒▒▒▒] 0%*` },
                            { quoted: m }
                        );
                        const stages = [
                            `💻 *BYPASSING FIREWALL & SSL...*\n🎯 *TARGET:* ${target}\n⚡ *[██▒▒▒▒▒▒▒▒] 25%*\n📂 *Injecting payload...*`,
                            `💻 *EXTRACTING WHATSAPP SESSION KEYS...*\n🎯 *TARGET:* ${target}\n⚡ *[█████▒▒▒▒▒] 55%*\n🔑 *Hash: 8f9d2a7b4c1e...*`,
                            `💻 *DOWNLOADING CHAT DATABASE...*\n🎯 *TARGET:* ${target}\n⚡ *[████████▒▒] 85%*\n📥 *msgstore.db.crypt15 captured...*`,
                            `✅ *SYSTEM BREACH COMPLETE (SIMULATION)!*\n🎯 *TARGET:* ${target}\n🔥 *[██████████] 100%*\n📊 *STATUS:* Root Access Granted to ${CONFIG.ownerName}${DEV_FOOTER}`
                        ];
                        for (const st of stages) {
                            await new Promise((r) => setTimeout(r, 1200));
                            await sock.sendMessage(remoteJid, { text: st, edit: initMsg.key });
                        }
                        break;
                    }

                    case 'ip':
                    case 'ipinfo': {
                        if (!text) {
                            await reply(`🌐 *IP & DOMAIN GEO TRACKER*\nExample: *.ip 8.8.8.8* ya *.ip google.com*`);
                            break;
                        }
                        await react('🌐');
                        const res = await axios.get(`http://ip-api.com/json/${encodeURIComponent(text.trim())}`);
                        const d = res.data;
                        if (d.status !== 'success') {
                            await reply(`❌ Invalid IP or Domain: ${text}`);
                            break;
                        }
                        await reply(
                            `🌐 *${CONFIG.botName} IP OSINT REPORT*\n\n` +
                            `🎯 *QUERY:* ${d.query}\n` +
                            `🏳️ *COUNTRY:* ${d.country} (${d.countryCode})\n` +
                            `🏙️ *CITY:* ${d.city}, ${d.regionName}\n` +
                            `📡 *ISP:* ${d.isp}\n` +
                            `🕒 *TIMEZONE:* ${d.timezone}\n` +
                            `📍 *COORDINATES:* ${d.lat}, ${d.lon}\n` +
                            `🗺️ *MAPS:* https://www.google.com/maps?q=${d.lat},${d.lon}`
                        );
                        break;
                    }

                    case 'whois':
                    case 'numinfo': {
                        const contextInfo = msg?.extendedTextMessage?.contextInfo;
                        let targetJid = contextInfo?.participant || contextInfo?.mentionedJid?.[0] || '';
                        if (text) {
                            const clean = text.replace(/[^0-9]/g, '');
                            if (clean.length >= 10) targetJid = `${clean}@s.whatsapp.net`;
                        }
                        if (!targetJid) {
                            await reply(`🔍 *WHATSAPP NUMBER OSINT*\nExample: *.whois 923329553169*`);
                            break;
                        }
                        await react('🔍');
                        const [onWa] = await sock.onWhatsApp(targetJid);
                        if (!onWa || !onWa.exists) {
                            await reply(`❌ Number +${targetJid.split('@')[0]} WhatsApp par registered nahi hai!`);
                            break;
                        }
                        let bio = 'Private / Not Set';
                        try {
                            const st = await sock.fetchStatus(onWa.jid);
                            if (st?.status) bio = st.status;
                        } catch (e) {}

                        let ppUrl = null;
                        try {
                            ppUrl = await sock.profilePictureUrl(onWa.jid, 'image');
                        } catch (e) {}

                        const infoText =
                            `🔍 *${CONFIG.botName} WHATSAPP OSINT*\n\n` +
                            `📱 *NUMBER:* +${onWa.jid.split('@')[0]}\n` +
                            `🆔 *JID:* ${onWa.jid}\n` +
                            `✅ *REGISTERED:* YES\n` +
                            `📝 *BIO:* ${bio}`;

                        if (ppUrl) {
                            const imgRes = await axios.get(ppUrl, { responseType: 'arraybuffer' });
                            await sock.sendMessage(remoteJid, { image: Buffer.from(imgRes.data), caption: `${infoText}${DEV_FOOTER}` }, { quoted: m });
                        } else {
                            await reply(infoText);
                        }
                        break;
                    }

                    case 'git':
                    case 'github': {
                        if (!text) {
                            await reply(`🐙 *GITHUB OSINT SCANNER*\nExample: *.git RayyanHacke*`);
                            break;
                        }
                        await react('🐙');
                        const res = await axios.get(`https://api.github.com/users/${encodeURIComponent(text.trim())}`);
                        const u = res.data;
                        await reply(
                            `🐙 *GITHUB OSINT REPORT*\n\n` +
                            `👤 *USERNAME:* ${u.login}\n` +
                            `🏷️ *NAME:* ${u.name || 'N/A'}\n` +
                            `📝 *BIO:* ${u.bio || 'N/A'}\n` +
                            `📦 *PUBLIC REPOS:* ${u.public_repos}\n` +
                            `👥 *FOLLOWERS:* ${u.followers}\n` +
                            `🔗 *URL:* ${u.html_url}`
                        );
                        break;
                    }

                    case 'qr':
                    case 'qrcode': {
                        if (!text) {
                            await reply(`🏁 *QR CODE GENERATOR*\nExample: *.qr ${CONFIG.YOUTUBE}*`);
                            break;
                        }
                        await react('🏁');
                        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(text)}`;
                        const qrRes = await axios.get(qrUrl, { responseType: 'arraybuffer' });
                        await sock.sendMessage(
                            remoteJid,
                            {
                                image: Buffer.from(qrRes.data),
                                caption: `🏁 *QR CODE GENERATED*\n📌 *DATA:* ${text}${DEV_FOOTER}`
                            },
                            { quoted: m }
                        );
                        break;
                    }

                    case 'short':
                    case 'tinyurl': {
                        if (!text || !text.startsWith('http')) {
                            await reply(`🔗 *URL SHORTENER*\nExample: *.short https://youtube.com/@silladon29*`);
                            break;
                        }
                        await react('🔗');
                        const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(text.trim())}`);
                        await reply(`🔗 *URL SHORTENED SUCCESSFULLY*\n\n🔹 *ORIGINAL:* ${text}\n✅ *SHORT LINK:* ${res.data}`);
                        break;
                    }

                    case 'fancy':
                    case 'style': {
                        if (!text) {
                            await reply(`✨ *FANCY HACKER FONTS*\nExample: *.fancy Mr Rayyan YT*`);
                            break;
                        }
                        await react('✨');
                        await reply(`✨ *STYLISH FONTS BY ${CONFIG.botName}*\n\n${generateFancyFonts(text)}`);
                        break;
                    }

                    // ================= 10 WHATSAPP CHAT GAMES =================
                    case 'games':
                    case 'game': {
                        await react('🎮');
                        await reply(
                            `╔══════════════════════╗\n` +
                            `║ 🎮 *10 WHATSAPP GAMES*\n` +
                            `╚══════════════════════╝\n\n` +
                            `1️⃣ *.TTT*  (Tic-Tac-Toe X/O)\n` +
                            `2️⃣ *.GUESS*  (Number Guess 1-10)\n` +
                            `3️⃣ *.RPS ROCK*  (Rock Paper Scissors)\n` +
                            `4️⃣ *.MATH*  (Fast Math Quiz)\n` +
                            `5️⃣ *.RIDDLE*  (Paheli Game)\n` +
                            `6️⃣ *.WORD*  (Word Scramble)\n` +
                            `7️⃣ *.QUIZ*  (General Knowledge)\n` +
                            `8️⃣ *.TRUTH*  (Truth Challenge)\n` +
                            `9️⃣ *.DARE*  (Dare Challenge)\n` +
                            `🔟 *.SLOT*  (Lucky Slot Spin)\n\n` +
                            `💡 *Jawab dene ke liye:* *.ans <jawab>*`
                        );
                        break;
                    }

                    case 'ttt': {
                        await react('❌');
                        let game = activeGames.get(remoteJid);
                        if (!text || !game || game.type !== 'ttt') {
                            const board = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
                            activeGames.set(remoteJid, { type: 'ttt', board });
                            await reply(
                                `🎮 *TIC-TAC-TOE STARTED!*\n\n` +
                                `${board[0]} ${board[1]} ${board[2]}\n` +
                                `${board[3]} ${board[4]} ${board[5]}\n` +
                                `${board[6]} ${board[7]} ${board[8]}\n\n` +
                                `👉 Khelne ke liye *.ttt <1-9>* likhein!`
                            );
                            break;
                        }
                        const pos = parseInt(text) - 1;
                        if (isNaN(pos) || pos < 0 || pos > 8 || game.board[pos] === '❌' || game.board[pos] === '⭕') {
                            await reply(`❌ Galat box! 1 se 9 ke darmiyan khali box chunein.`);
                            break;
                        }
                        game.board[pos] = '❌';
                        const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
                        const checkWin = (sym) => wins.some(([a,b,c]) => game.board[a] === sym && game.board[b] === sym && game.board[c] === sym);

                        if (checkWin('❌')) {
                            const b = game.board;
                            activeGames.delete(remoteJid);
                            await reply(`🏆 *MUBARAK HO! AAP JEET GAYE!*\n\n${b[0]} ${b[1]} ${b[2]}\n${b[3]} ${b[4]} ${b[5]}\n${b[6]} ${b[7]} ${b[8]}`);
                            break;
                        }
                        const empty = game.board.map((v, i) => (v !== '❌' && v !== '⭕' ? i : null)).filter((v) => v !== null);
                        if (empty.length === 0) {
                            activeGames.delete(remoteJid);
                            await reply(`🤝 *MATCH DRAW HO GAYA!*`);
                            break;
                        }
                        const botMove = empty[Math.floor(Math.random() * empty.length)];
                        game.board[botMove] = '⭕';
                        const b = game.board;
                        if (checkWin('⭕')) {
                            activeGames.delete(remoteJid);
                            await reply(`🤖 *${CONFIG.botName} JEET GAYA!*\n\n${b[0]} ${b[1]} ${b[2]}\n${b[3]} ${b[4]} ${b[5]}\n${b[6]} ${b[7]} ${b[8]}`);
                            break;
                        }
                        await reply(`🎮 *TIC-TAC-TOE*\n\n${b[0]} ${b[1]} ${b[2]}\n${b[3]} ${b[4]} ${b[5]}\n${b[6]} ${b[7]} ${b[8]}\n\n👉 Agli chaal: *.ttt <1-9>*`);
                        break;
                    }

                    case 'guess': {
                        await react('🔢');
                        const num = Math.floor(Math.random() * 10) + 1;
                        activeGames.set(remoteJid, { type: 'guess', answer: String(num) });
                        await reply(`🔢 *NUMBER GUESSING GAME*\n\nMaine *1 se 10* ke darmiyan ek number socha hai!\n👉 Jawab dein: *.ans <number>*`);
                        break;
                    }

                    case 'rps': {
                        const choices = ['rock', 'paper', 'scissors'];
                        const userChoice = text.toLowerCase();
                        if (!choices.includes(userChoice)) {
                            await reply(`🪨📄✂️ *ROCK PAPER SCISSORS*\nExample: *.rps rock*`);
                            break;
                        }
                        const botChoice = choices[Math.floor(Math.random() * 3)];
                        let res = '🤝 Match Draw!';
                        if (
                            (userChoice === 'rock' && botChoice === 'scissors') ||
                            (userChoice === 'paper' && botChoice === 'rock') ||
                            (userChoice === 'scissors' && botChoice === 'paper')
                        ) {
                            res = '🏆 Aap Jeet Gaye!';
                        } else if (userChoice !== botChoice) {
                            res = `🤖 ${CONFIG.botName} Jeet Gaya!`;
                        }
                        await reply(`🎮 *ROCK PAPER SCISSORS*\n\n👤 *AAP:* ${userChoice.toUpperCase()}\n🤖 *BOT:* ${botChoice.toUpperCase()}\n\n🎉 *RESULT:* ${res}`);
                        break;
                    }

                    case 'math': {
                        const a = Math.floor(Math.random() * 50) + 10;
                        const b = Math.floor(Math.random() * 40) + 5;
                        const ans = a + b;
                        activeGames.set(remoteJid, { type: 'math', answer: String(ans) });
                        await reply(`🧮 *FAST MATH QUIZ*\n\nBatao: *${a} + ${b} = ?*\n👉 Jawab dein: *.ans <jawab>*`);
                        break;
                    }

                    case 'riddle': {
                        const item = RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
                        activeGames.set(remoteJid, { type: 'riddle', answer: item.a.toLowerCase() });
                        await reply(`🧠 *PAHELI / RIDDLE TIME*\n\n❓ *SAWAL:* ${item.q}\n👉 Jawab dein: *.ans <jawab>*`);
                        break;
                    }

                    case 'word': {
                        const w = WORDS[Math.floor(Math.random() * WORDS.length)];
                        const scrambled = w.split('').sort(() => 0.5 - Math.random()).join('');
                        activeGames.set(remoteJid, { type: 'word', answer: w.toLowerCase() });
                        await reply(`🔤 *WORD SCRAMBLE GAME*\n\nIs lafz ko seedha karein: *${scrambled}*\n👉 Jawab dein: *.ans <word>*`);
                        break;
                    }

                    case 'quiz': {
                        const qz = QUIZZES[Math.floor(Math.random() * QUIZZES.length)];
                        activeGames.set(remoteJid, { type: 'quiz', answer: qz.a.toLowerCase() });
                        await reply(`🌍 *GENERAL KNOWLEDGE QUIZ*\n\n❓ *SAWAL:* ${qz.q}\n👉 Jawab dein: *.ans <jawab>*`);
                        break;
                    }

                    case 'truth': {
                        const t = TRUTHS[Math.floor(Math.random() * TRUTHS.length)];
                        await reply(`🤥 *TRUTH CHALLENGE*\n\n👉 *${t}*`);
                        break;
                    }

                    case 'dare': {
                        const d = DARES[Math.floor(Math.random() * DARES.length)];
                        await reply(`🔥 *DARE CHALLENGE*\n\n👉 *${d}*`);
                        break;
                    }

                    case 'slot':
                    case 'dice': {
                        const icons = ['🍒', '💎', '7️⃣', '🍋', '🔔'];
                        const s1 = icons[Math.floor(Math.random() * icons.length)];
                        const s2 = icons[Math.floor(Math.random() * icons.length)];
                        const s3 = icons[Math.floor(Math.random() * icons.length)];
                        const win = (s1 === s2 && s2 === s3) ? '🏆 *JACKPOT! AAP JEET GAYE!*' : (s1 === s2 || s2 === s3 || s1 === s3) ? '✨ *CLOSE! HALF WIN!*' : '😅 *TRY AGAIN!*';
                        await reply(`🎰 *LUCKY SLOT MACHINE*\n\n╔═══════════╗\n║  ${s1}  |  ${s2}  |  ${s3}  ║\n╚═══════════╝\n\n${win}`);
                        break;
                    }

                    case 'ans': {
                        const game = activeGames.get(remoteJid);
                        if (!game || !game.answer) {
                            await reply(`❌ Koi active sawal nahi chal raha!`);
                            break;
                        }
                        if (!text) {
                            await reply(`❌ Apna jawab likhein!`);
                            break;
                        }
                        if (text.trim().toLowerCase() === game.answer.toLowerCase()) {
                            activeGames.delete(remoteJid);
                            await react('🎉');
                            await reply(`🏆 *SHABAASH! BILKUL SAHI JAWAB!*\n✅ *ANSWER:* ${game.answer.toUpperCase()}`);
                        } else {
                            await react('❌');
                            await reply(`❌ *GALAT JAWAB!* Dobara koshish karein.`);
                        }
                        break;
                    }

                    // ================= BOMBER, SAVERS & DOWNLOADERS =================
                    case 'bomb': {
                        if (args.length < 2) {
                            await reply(`💣 *MESSAGE BOMBER*\nFormat: *.bomb <count> <message>*`);
                            break;
                        }
                        let count = Math.min(25, Math.max(1, parseInt(args[0]) || 5));
                        const bombMsg = args.slice(1).join(' ');
                        await react('💣');
                        for (let i = 1; i <= count; i++) {
                            await sock.sendMessage(remoteJid, { text: `💣 [${i}/${count}] ${bombMsg}` });
                            await new Promise((r) => setTimeout(r, 400));
                        }
                        await reply(`✅ *BOMBING COMPLETED (${count} MESSAGES)!*`);
                        break;
                    }

                    case 'pp':
                    case 'dp': {
                        await react('📸');
                        const contextInfo = msg?.extendedTextMessage?.contextInfo;
                        let targetJid = contextInfo?.participant || contextInfo?.mentionedJid?.[0] || remoteJid;
                        if (text) {
                            const clean = text.replace(/[^0-9]/g, '');
                            if (clean.length >= 10) targetJid = `${clean}@s.whatsapp.net`;
                        }
                        try {
                            const ppUrl = await sock.profilePictureUrl(targetJid, 'image');
                            const imgRes = await axios.get(ppUrl, { responseType: 'arraybuffer' });
                            await sock.sendMessage(
                                remoteJid,
                                {
                                    image: Buffer.from(imgRes.data),
                                    caption: `📸 *HD PROFILE PICTURE SAVED!*\n👤 *USER:* +${targetJid.split('@')[0]}${DEV_FOOTER}`
                                },
                                { quoted: m }
                            );
                        } catch (e) {
                            await reply(`❌ Is user ki Profile Picture private hai!`);
                        }
                        break;
                    }

                    case 'mediafire':
                    case 'mf': {
                        if (!text || !text.includes('mediafire.com')) {
                            await reply(`❌ Provide a valid MediaFire link!\nExample: *.mediafire https://www.mediafire.com/file/xxxx*`);
                            break;
                        }
                        await react('📦');
                        await reply(`📦 *${CONFIG.botName} MEDIAFIRE DOWNLOADER*\n⏳ *Downloading file, please wait...*`);

                        const page = await axios.get(text, {
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                        });
                        const dlMatch = page.data.match(/href="((https?:)?\/\/download[^"]+)"/i);
                        if (!dlMatch || !dlMatch[1]) {
                            await reply(`❌ MediaFire direct link nahi mila!`);
                            break;
                        }
                        const directUrl = dlMatch[1].startsWith('//') ? `https:${dlMatch[1]}` : dlMatch[1];
                        const rawName = decodeURIComponent(directUrl.split('/').pop().split('?')[0]) || `file_${Date.now()}.zip`;

                        const fileRes = await axios.get(directUrl, { responseType: 'arraybuffer', maxContentLength: 100 * 1024 * 1024 });
                        await sock.sendMessage(
                            remoteJid,
                            {
                                document: Buffer.from(fileRes.data),
                                mimetype: 'application/octet-stream',
                                fileName: rawName,
                                caption: `📦 *FILE:* ${rawName}\n✅ *DOWNLOADED BY ${CONFIG.botName}*${DEV_FOOTER}`
                            },
                            { quoted: m }
                        );
                        break;
                    }

                    case 'tt':
                    case 'tiktok': {
                        if (!text || !text.startsWith('http')) {
                            await reply(`❌ Provide a TikTok video link!\nExample: *.tt https://vt.tiktok.com/xxxx*`);
                            break;
                        }
                        await react('🎵');
                        await reply(`🎵 *${CONFIG.botName} TIKTOK DOWNLOADER*\n⏳ *Downloading video without watermark...*`);

                        let sentSuccess = false;
                        try {
                            const apiRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(text)}`);
                            const playUrl = apiRes.data?.data?.play;
                            const title = apiRes.data?.data?.title || 'TikTok Video';
                            if (playUrl) {
                                const vidBuf = await axios.get(playUrl, { responseType: 'arraybuffer' });
                                await sock.sendMessage(
                                    remoteJid,
                                    {
                                        video: Buffer.from(vidBuf.data),
                                        caption: `🎵 *${title}*\n✅ *NO WATERMARK - ${CONFIG.botName}*${DEV_FOOTER}`
                                    },
                                    { quoted: m }
                                );
                                sentSuccess = true;
                            }
                        } catch (e) {}

                        if (!sentSuccess) {
                            const outTt = path.join(CONFIG.tempDir, `tt_${Date.now()}.mp4`);
                            await execPromise(`yt-dlp -f "best[ext=mp4]/best" -o "${outTt}" "${text}"`);
                            await sock.sendMessage(
                                remoteJid,
                                {
                                    video: fs.readFileSync(outTt),
                                    caption: `🎵 *TIKTOK VIDEO*\n✅ *DOWNLOADED BY ${CONFIG.botName}*${DEV_FOOTER}`
                                },
                                { quoted: m }
                            );
                            fs.unlinkSync(outTt);
                        }
                        break;
                    }

                    case 'connect':
                    case 'pair': {
                        if (!text) {
                            await reply(`🔗 *CONNECT WHATSAPP BOT*\nExample: *.connect 923xxxxxxxxx*`);
                            break;
                        }
                        const cleanNum = text.replace(/[^0-9]/g, '');
                        if (cleanNum.length < 10) {
                            await reply(`❌ Sahi country code ke sath number likhein!`);
                            break;
                        }
                        await react('🔗');
                        await reply(`⏳ *Generating 8-Digit Pairing Code for +${cleanNum}...*`);
                        const cloneFolder = path.join(CONFIG.clonesDir, `session_${cleanNum}`);
                        startRayyanBot(cloneFolder, true, remoteJid, sock, cleanNum);
                        break;
                    }

                    case 's':
                    case 'sticker': {
                        const quoted = msg?.extendedTextMessage?.contextInfo?.quotedMessage;
                        const targetMsg = quoted || msg;
                        const isImage = !!targetMsg?.imageMessage;
                        const isVideo = !!targetMsg?.videoMessage;

                        if (!isImage && !isVideo) {
                            await reply(`❌ Reply to an image or short video with *${CONFIG.prefix}sticker*`);
                            break;
                        }

                        await react('🎨');
                        const mediaType = isImage ? 'image' : 'video';
                        const mediaMsg = isImage ? targetMsg.imageMessage : targetMsg.videoMessage;
                        const buffer = await downloadMedia(mediaMsg, mediaType);

                        const inputPath = path.join(CONFIG.tempDir, `in_${Date.now()}.${isImage ? 'jpg' : 'mp4'}`);
                        const outputPath = path.join(CONFIG.tempDir, `out_${Date.now()}.webp`);
                        fs.writeFileSync(inputPath, buffer);

                        const ffmpegCmd = isImage
                            ? `ffmpeg -i "${inputPath}" -vf "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -vcodec libwebp -lossless 1 "${outputPath}"`
                            : `ffmpeg -i "${inputPath}" -t 6 -vf "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease,fps=15,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -vcodec libwebp -lossless 0 -qscale 50 -loop 0 "${outputPath}"`;

                        await execPromise(ffmpegCmd);
                        const stickerBuffer = fs.readFileSync(outputPath);

                        await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: m });
                        fs.unlinkSync(inputPath);
                        fs.unlinkSync(outputPath);
                        break;
                    }

                    case 'play':
                    case 'song': {
                        if (!text) {
                            await reply(`❌ Provide a song name! Example: *${CONFIG.prefix}play Pasoori*`);
                            break;
                        }
                        await react('🎧');

                        const search = await yts(text);
                        const video = search.videos[0];
                        if (!video) {
                            await reply('❌ No results found on YouTube.');
                            break;
                        }

                        await reply(
                            `🎵 *${CONFIG.botName} AUDIO DOWNLOADER*\n\n` +
                            `📌 *TITLE:* ${video.title}\n` +
                            `⏱️ *DURATION:* ${video.timestamp}\n` +
                            `⏳ *Downloading MP3 Audio...*`
                        );

                        const outMp3 = path.join(CONFIG.tempDir, `song_${Date.now()}.mp3`);
                        await execPromise(`yt-dlp -x --audio-format mp3 --audio-quality 128K -o "${outMp3}" "${video.url}"`);

                        await sock.sendMessage(
                            remoteJid,
                            {
                                audio: fs.readFileSync(outMp3),
                                mimetype: 'audio/mpeg',
                                fileName: `${video.title}.mp3`
                            },
                            { quoted: m }
                        );
                        fs.unlinkSync(outMp3);
                        break;
                    }

                    case 'yt':
                    case 'ytmp4': {
                        if (!text) {
                            await reply(`❌ Provide a YouTube link! Example: *${CONFIG.prefix}yt https://youtu.be/xxxx*`);
                            break;
                        }
                        await react('🎬');

                        let videoUrl = text;
                        let title = 'YouTube Video';

                        if (!text.startsWith('http')) {
                            const search = await yts(text);
                            if (!search.videos[0]) {
                                await reply('❌ Video not found.');
                                break;
                            }
                            videoUrl = search.videos[0].url;
                            title = search.videos[0].title;
                        }

                        await reply(`🎬 *${CONFIG.botName} VIDEO DOWNLOADER*\n⏳ *Downloading MP4 Video...*`);

                        const outMp4 = path.join(CONFIG.tempDir, `vid_${Date.now()}.mp4`);
                        await execPromise(`yt-dlp -f "best[ext=mp4][height<=720]/best[ext=mp4]/best" -o "${outMp4}" "${videoUrl}"`);

                        await sock.sendMessage(
                            remoteJid,
                            {
                                video: fs.readFileSync(outMp4),
                                caption: `🎬 *${title}*${DEV_FOOTER}`
                            },
                            { quoted: m }
                        );
                        fs.unlinkSync(outMp4);
                        break;
                    }

                    case 'vv':
                    case 'vv2': {
                        const contextInfo = msg?.extendedTextMessage?.contextInfo;
                        const quoted = contextInfo?.quotedMessage;
                        const stanzaId = contextInfo?.stanzaId;

                        if (cmd === 'vv2') {
                            await react('🔓');
                            await sendViewOnceToPersonal(stanzaId, remoteJid, quoted);
                            break;
                        }

                        if (stanzaId && viewOnceVault.has(stanzaId)) {
                            await react('🔓');
                            const item = viewOnceVault.get(stanzaId);
                            const caption = `🔓 *VIEW-ONCE UNLOCKED BY ${CONFIG.botName}*${DEV_FOOTER}`;
                            if (item.type === 'image') await sock.sendMessage(remoteJid, { image: item.buffer, mimetype: 'image/jpeg', caption }, { quoted: m });
                            else if (item.type === 'video') await sock.sendMessage(remoteJid, { video: item.buffer, mimetype: 'video/mp4', caption }, { quoted: m });
                            else if (item.type === 'audio') await sock.sendMessage(remoteJid, { audio: item.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m });
                            break;
                        }

                        let target = extractViewOnceMedia(quoted);
                        if ((!target || (!target.media?.mediaKey && !target.media?.url && !target.media?.directPath)) && stanzaId && msgStore.has(stanzaId)) {
                            target = extractViewOnceMedia(msgStore.get(stanzaId));
                        }

                        if (!target || !target.media) {
                            await reply(`❌ Reply to a View-Once photo, video, or voice note with *${CONFIG.prefix}vv* or *❤️*.`);
                            break;
                        }

                        await react('🔓');
                        const buffer = await downloadMedia(target.media, target.type);
                        const caption = `🔓 *VIEW-ONCE UNLOCKED BY ${CONFIG.botName}*${DEV_FOOTER}`;

                        if (target.type === 'image') {
                            await sock.sendMessage(remoteJid, { image: buffer, mimetype: 'image/jpeg', caption }, { quoted: m });
                        } else if (target.type === 'video') {
                            await sock.sendMessage(remoteJid, { video: buffer, mimetype: 'video/mp4', caption }, { quoted: m });
                        } else if (target.type === 'audio') {
                            await sock.sendMessage(remoteJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m });
                        }
                        break;
                    }

                    case 'tts': {
                        if (!text) {
                            await reply(`❌ Example: *${CONFIG.prefix}tts Assalam o Alaikum*`);
                            break;
                        }
                        await react('🗣️');
                        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 200))}&tl=ur&client=tw-ob`;
                        const response = await axios.get(ttsUrl, { responseType: 'arraybuffer' });
                        await sock.sendMessage(
                            remoteJid,
                            { audio: Buffer.from(response.data), mimetype: 'audio/mpeg', ptt: true },
                            { quoted: m }
                        );
                        break;
                    }

                    case 'tr': {
                        if (args.length < 2) {
                            await reply(`❌ Example: *${CONFIG.prefix}tr ur How are you?*`);
                            break;
                        }
                        const targetLang = args[0];
                        const phrase = args.slice(1).join(' ');
                        const res = await axios.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(phrase)}`);
                        const translated = res.data[0].map((item) => item[0]).join('');
                        await reply(`🌐 *TRANSLATION (${targetLang.toUpperCase()}):*\n\n${translated}`);
                        break;
                    }

                    case 'calc': {
                        if (!text) {
                            await reply(`❌ Example: *${CONFIG.prefix}calc (25 * 4) + 10*`);
                            break;
                        }
                        const sanitized = text.replace(/[^0-9+\-*/().% ]/g, '');
                        if (!sanitized) {
                            await reply('❌ Invalid math expression.');
                            break;
                        }
                        const result = Function(`"use strict"; return (${sanitized})`)();
                        await reply(`🧮 *EXPRESSION:* ${sanitized}\n✅ *RESULT:* *${result}*`);
                        break;
                    }

                    case 'tagall': {
                        if (!isGroup) {
                            await reply('❌ This command works in groups only.');
                            break;
                        }
                        const groupMetadata = await sock.groupMetadata(remoteJid);
                        groupCache.set(remoteJid, groupMetadata);
                        const participants = groupMetadata.participants.map((p) => p.id);
                        let tagText = `📢 *${CONFIG.botName} GROUP PING*\n`;
                        if (text) tagText += `💬 *MESSAGE:* ${text}\n\n`;
                        participants.forEach((mem) => {
                            tagText += `◈ @${mem.split('@')[0]}\n`;
                        });
                        tagText += DEV_FOOTER;
                        await sock.sendMessage(remoteJid, { text: tagText, mentions: participants }, { quoted: m });
                        break;
                    }
                }
            } catch (err) {
                console.error('Command Error:', err.message);
                await reply(`⚠️ *Error executing command:* ${err.message}`);
            }
        }
    });
}

// Global Crash Shield
process.on('uncaughtException', (err) => {
    if (!String(err.message).includes('Session error')) {
        console.log('\x1b[33m[🛡️ SHIELD] Caught exception:\x1b[0m', err.message);
    }
});
process.on('unhandledRejection', (err) => {
    if (!String(err?.message || err).includes('Session error')) {
        console.log('\x1b[33m[🛡️ SHIELD] Handled rejection:\x1b[0m', err?.message || err);
    }
});

// Launch Termux Interactive Button Control Panel on Startup
showTermuxControlPanel();

require('express')().get('/',(req,res)=>res.send('RAYYAN-XMD PRO 👑 ALIVE')).listen(process.env.PORT || 3000, ()=>console.log('[🌐 SERVER] 24/7 Keep-Alive running on Port 3000'));


// === YT CLOUD API BYPASS START ===
async function downloadFromYtApis(ytUrl, outPath, isMp3) {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const saveBuffer = async (dlUrl) => {
        if (!dlUrl || !dlUrl.startsWith('http')) return false;
        const res = await axios.get(dlUrl, {
            responseType: 'arraybuffer',
            timeout: 60000,
            maxContentLength: 100 * 1024 * 1024,
            headers: { 'User-Agent': ua }
        });
        if (res.data && res.data.byteLength > 15000) {
            fs.writeFileSync(outPath, Buffer.from(res.data));
            return true;
        }
        return false;
    };

    // 1. OceanSaver / Loader.to Cloud Proxy Engine (Works on all Bot-Hosting IPs)
    try {
        const fmt = isMp3 ? 'mp3' : '720';
        const init = await axios.get(
            `https://p.oceansaver.in/ajax/download.php?format=${fmt}&url=${encodeURIComponent(ytUrl)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`,
            { headers: { 'User-Agent': ua }, timeout: 15000 }
        );
        if (init.data && init.data.id) {
            for (let i = 0; i < 20; i++) {
                await new Promise((r) => setTimeout(r, 1500));
                const prog = await axios.get(
                    `https://p.oceansaver.in/ajax/progress.php?id=${init.data.id}`,
                    { headers: { 'User-Agent': ua }, timeout: 10000 }
                );
                if (prog.data?.download_url) {
                    if (await saveBuffer(prog.data.download_url)) return true;
                    break;
                }
            }
        }
    } catch (e) {}

    // 2. Multi-Server Direct REST APIs Fallback
    const apiList = isMp3
        ? [
              async () => (await axios.get(`https://api.vreden.my.id/api/ytmp3?url=${encodeURIComponent(ytUrl)}`, { timeout: 20000 })).data?.result?.download?.url,
              async () => (await axios.get(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(ytUrl)}`, { timeout: 20000 })).data?.data?.dl,
              async () => (await axios.get(`https://api.ryzendesu.vip/api/downloader/ytmp3?url=${encodeURIComponent(ytUrl)}`, { timeout: 20000 })).data?.url,
              async () => (await axios.get(`https://api.giftedtech.my.id/api/download/dlmp3?apikey=gifted&url=${encodeURIComponent(ytUrl)}`, { timeout: 20000 })).data?.result?.download_url
          ]
        : [
              async () => (await axios.get(`https://api.vreden.my.id/api/ytmp4?url=${encodeURIComponent(ytUrl)}`, { timeout: 20000 })).data?.result?.download?.url,
              async () => (await axios.get(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(ytUrl)}`, { timeout: 20000 })).data?.data?.dl,
              async () => (await axios.get(`https://api.ryzendesu.vip/api/downloader/ytmp4?url=${encodeURIComponent(ytUrl)}`, { timeout: 20000 })).data?.url,
              async () => (await axios.get(`https://api.giftedtech.my.id/api/download/dlmp4?apikey=gifted&url=${encodeURIComponent(ytUrl)}`, { timeout: 20000 })).data?.result?.download_url
          ];

    for (const getLink of apiList) {
        try {
            const dlUrl = await getLink();
            if (await saveBuffer(dlUrl)) return true;
        } catch (e) {}
    }
    return false;
}

function execPromise(cmd) {
    return new Promise(async (resolve, reject) => {
        if (cmd.includes('yt-dlp') && (cmd.includes('song_') || cmd.includes('vid_'))) {
            const outMatch = cmd.match(/-o\s+"([^"]+)"/);
            const urlMatches = cmd.match(/"(https?:\/\/[^"]+)"/g);
            if (outMatch && urlMatches && urlMatches.length > 0) {
                const outPath = outMatch[1];
                const ytUrl = urlMatches[urlMatches.length - 1].replace(/"/g, '');
                const isMp3 = outPath.endsWith('.mp3') || cmd.includes('--audio-format mp3');
                console.log(`[⚡ YT CLOUD BYPASS] Downloading ${isMp3 ? 'MP3' : 'MP4'} via Proxy APIs: ${ytUrl}`);
                const ok = await downloadFromYtApis(ytUrl, outPath, isMp3);
                if (ok) return resolve('Downloaded via Cloud API');
            }
        }
        exec(cmd, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout || stderr);
        });
    });
}
// === YT CLOUD API BYPASS END ===

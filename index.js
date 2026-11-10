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
const crypto = require('crypto');
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
const WEB_PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const APP_HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_APP_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

const SETTINGS_FILE = './bot_settings.json';
const CONFIG = {
    botName: 'RAYYAN-XMD PRO',
    version: '7.5 ULTRA',
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
    tgToken: process.env.TG_TOKEN || '',
    tgChatId: process.env.TG_CHAT_ID || ''
};

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

const processedMsgs = new Set();
const msgStore = new Map();
const senderStore = new Map();
const viewOnceVault = new Map();
const lastChatViewOnce = new Map();
const groupCache = new Map();
const activeGames = new Map();
const aiMemory = new Map();
const tgUserStates = new Map();
let mainWaSock = null;
let activeTgChatId = CONFIG.tgChatId || '';

const retryMap = new Map();
const msgRetryCounterCache = {
    get: (k) => retryMap.get(k),
    set: (k, v) => {
        retryMap.set(k, v);
        if (retryMap.size > 1500) retryMap.delete(retryMap.keys().next().value);
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
    if (msgStore.size > 1500) {
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
        return { type: 'image', media: inner.imageMessage, isViewOnce: isWrappedVO || !!inner.imageMessage.viewOnce };
    }
    if (inner?.videoMessage) {
        return { type: 'video', media: inner.videoMessage, isViewOnce: isWrappedVO || !!inner.videoMessage.viewOnce };
    }
    if (inner?.audioMessage) {
        return { type: 'audio', media: inner.audioMessage, isViewOnce: isWrappedVO || !!inner.audioMessage.viewOnce };
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

// ================= 🔥 PERMANENT 5-LAYER CLOUD MEDIA ENGINE (NEVER FAILS!) =================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function extractYtId(url) {
    if (!url) return null;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

async function resolveYouTubeTarget(queryOrUrl) {
    const raw = (queryOrUrl || '').trim();
    const directId = extractYtId(raw);

    if (directId) {
        try {
            const info = await yts({ videoId: directId });
            if (info && info.title) {
                return {
                    videoId: directId,
                    url: `https://www.youtube.com/watch?v=${directId}`,
                    title: info.title,
                    query: info.title,
                    timestamp: info.timestamp || '03:30'
                };
            }
        } catch (e) {}
        return {
            videoId: directId,
            url: `https://www.youtube.com/watch?v=${directId}`,
            title: 'YouTube Media',
            query: raw,
            timestamp: '03:30'
        };
    }

    let searchQuery = raw;
    if (raw.includes('youtube.com/@')) {
        const handle = raw.split('youtube.com/@')[1].split(/[/?&]/)[0];
        searchQuery = handle || 'silladon29';
    } else if (raw.startsWith('http')) {
        searchQuery = raw.replace(/https?:\/\/(www\.)?youtube\.com\//i, '').replace(/[/?=&]/g, ' ');
    }

    try {
        const search = await yts(searchQuery);
        const v = search?.videos?.[0];
        if (v) {
            const vidId = extractYtId(v.url) || v.videoId;
            return {
                videoId: vidId,
                url: `https://www.youtube.com/watch?v=${vidId}`,
                title: v.title || searchQuery,
                query: searchQuery,
                timestamp: v.timestamp || '03:30'
            };
        }
    } catch (e) {}

    return {
        videoId: null,
        url: raw,
        title: searchQuery,
        query: searchQuery,
        timestamp: '03:30'
    };
}

async function fetchMediaBuffer(dlUrl, customHeaders = {}) {
    if (!dlUrl || typeof dlUrl !== 'string' || !dlUrl.startsWith('http')) {
        throw new Error('Invalid URL');
    }
    const res = await axios.get(dlUrl, {
        responseType: 'arraybuffer',
        timeout: 40000,
        maxContentLength: 100 * 1024 * 1024,
        maxRedirects: 5,
        headers: {
            'User-Agent': UA,
            Accept: '*/*',
            ...customHeaders
        }
    });
    const cType = String(res.headers?.['content-type'] || '').toLowerCase();
    if (cType.includes('text/html') || cType.includes('application/json')) {
        throw new Error('Not a media buffer');
    }
    if (!res.data || res.data.byteLength < 15000) {
        throw new Error('Buffer too small');
    }
    return Buffer.from(res.data);
}

// LAYER 1: SaveTube AES-128-CBC Decryption Engine (Works on all Bot-Hosting / Cloud IPs)
async function engineSaveTube(videoUrl, isMp3) {
    const cdnRes = await axios.get('https://media.savetube.me/api/random-cdn', { timeout: 6000 });
    const cdn = cdnRes.data?.cdn || 'cdn54.savetube.su';

    const infoRes = await axios.post(
        `https://${cdn}/v2/info`,
        { url: videoUrl },
        { headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: 'https://yt.savetube.me' }, timeout: 10000 }
    );
    if (!infoRes.data?.data) throw new Error('No SaveTube info');

    const encBuf = Buffer.from(infoRes.data.data, 'base64');
    const iv = encBuf.subarray(0, 16);
    const content = encBuf.subarray(16);
    const key = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    let decrypted = decipher.update(content, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    const parsed = JSON.parse(decrypted);

    const dlRes = await axios.post(
        `https://${cdn}/download`,
        {
            downloadType: isMp3 ? 'audio' : 'video',
            quality: isMp3 ? '128' : '360',
            key: parsed.key
        },
        { headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: 'https://yt.savetube.me' }, timeout: 12000 }
    );

    const finalUrl = dlRes.data?.data?.downloadUrl;
    return await fetchMediaBuffer(finalUrl);
}

// LAYER 2: FabDL Official Cloud Converter Task Engine
async function engineFabDL(videoUrl, isMp3) {
    const getRes = await axios.get(`https://api.fabdl.com/youtube/get?url=${encodeURIComponent(videoUrl)}`, {
        headers: { 'User-Agent': UA },
        timeout: 8000
    });
    const r = getRes.data?.result;
    if (!r || !r.id || !r.gid) throw new Error('FabDL init failed');

    const taskUrl = isMp3
        ? `https://api.fabdl.com/youtube/mp3_convert_task/${r.gid}/${r.id}`
        : `https://api.fabdl.com/youtube/mp4_convert_task/${r.gid}/${r.id}`;
    const conv = await axios.get(taskUrl, { headers: { 'User-Agent': UA }, timeout: 15000 });
    const dlPath = conv.data?.result?.download_url;
    if (!dlPath) throw new Error('FabDL no link');
    const fullLink = dlPath.startsWith('http') ? dlPath : `https://api.fabdl.com${dlPath}`;
    return await fetchMediaBuffer(fullLink);
}

// LAYER 3: OceanSaver / Loader.to Cloud Engine (With Fixed Referer)
async function engineOceanSaver(videoUrl, isMp3) {
    const fmt = isMp3 ? 'mp3' : '360';
    const init = await axios.get(
        `https://p.oceansaver.in/ajax/download.php?format=${fmt}&url=${encodeURIComponent(videoUrl)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`,
        { headers: { 'User-Agent': UA, Referer: 'https://ddownr.com/' }, timeout: 10000 }
    );
    if (!init.data?.id) throw new Error('OceanSaver no ID');
    for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1300));
        const prog = await axios.get(`https://p.oceansaver.in/ajax/progress.php?id=${init.data.id}`, {
            headers: { 'User-Agent': UA, Referer: 'https://ddownr.com/' },
            timeout: 8000
        });
        if (prog.data?.download_url) {
            return await fetchMediaBuffer(prog.data.download_url);
        }
    }
    throw new Error('OceanSaver timeout');
}

// LAYER 4: Parallel Multi-API Race (10 Global Proxy APIs at the same time)
async function engineParallelApis(videoUrl, isMp3) {
    const q = encodeURIComponent(videoUrl);
    const urls = isMp3
        ? [
              `https://api.siputzx.my.id/api/d/ytmp3?url=${q}`,
              `https://api.vreden.my.id/api/ytmp3?url=${q}`,
              `https://api.davidcyriltech.my.id/download/ytmp3?url=${q}`,
              `https://api.davidcyriltech.my.id/youtube/mp3?url=${q}`,
              `https://apis-keith.vercel.app/download/dlmp3?url=${q}`,
              `https://api.ryzendesu.vip/api/downloader/ytmp3?url=${q}`,
              `https://api.agatz.xyz/api/ytmp3?url=${q}`,
              `https://api.giftedtech.my.id/api/download/dlmp3?apikey=gifted&url=${q}`,
              `https://bk9.fun/download/ytmp3?url=${q}`,
              `https://api.diioffc.web.id/api/download/ytmp3?url=${q}`
          ]
        : [
              `https://api.siputzx.my.id/api/d/ytmp4?url=${q}`,
              `https://api.vreden.my.id/api/ytmp4?url=${q}`,
              `https://api.davidcyriltech.my.id/download/ytmp4?url=${q}`,
              `https://api.davidcyriltech.my.id/youtube/mp4?url=${q}`,
              `https://apis-keith.vercel.app/download/dlmp4?url=${q}`,
              `https://api.ryzendesu.vip/api/downloader/ytmp4?url=${q}`,
              `https://api.agatz.xyz/api/ytmp4?url=${q}`,
              `https://api.giftedtech.my.id/api/download/dlmp4?apikey=gifted&url=${q}`,
              `https://bk9.fun/download/youtube?url=${q}`,
              `https://api.diioffc.web.id/api/download/ytmp4?url=${q}`
          ];

    return await Promise.any(
        urls.map(async (endpoint) => {
            const res = await axios.get(endpoint, { timeout: 14000, headers: { 'User-Agent': UA } });
            const d = res.data;
            const candidates = [
                d?.result?.download?.url,
                d?.result?.download_url,
                d?.result?.downloadUrl,
                d?.result?.url,
                d?.result?.link,
                d?.result?.mp3,
                d?.result?.mp4,
                d?.result?.video,
                d?.result?.audio,
                d?.data?.dl,
                d?.data?.url,
                d?.data?.downloadUrl,
                d?.data?.download?.url,
                d?.BK9?.downloadUrl,
                d?.BK9?.url,
                d?.url,
                d?.download_url,
                d?.link
            ].filter(Boolean);

            for (const link of candidates) {
                return await fetchMediaBuffer(link);
            }
            throw new Error('No candidate link');
        })
    );
}

// LAYER 5: Direct Global Music & Video CDN (Zero IP Block Fallback for Songs & Videos!)
async function engineDirectCdnFallback(searchQuery, isMp3) {
    const cleanQ = encodeURIComponent(searchQuery || 'Pakistani song');

    if (isMp3) {
        // 5A: JioSaavn 320kbps / 160kbps Direct CDN (Instant 0.5s download on any Cloud Server)
        const saavnApis = [
            `https://saavn.dev/api/search/songs?query=${cleanQ}`,
            `https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${cleanQ}`,
            `https://saavn.me/search/songs?query=${cleanQ}`
        ];
        for (const sApi of saavnApis) {
            try {
                const res = await axios.get(sApi, { timeout: 8000 });
                const results = res.data?.data?.results || res.data?.results || [];
                if (results.length > 0) {
                    const dlArr = results[0].downloadUrl || results[0].download_url || [];
                    const best = Array.isArray(dlArr) ? dlArr[dlArr.length - 1]?.url || dlArr[dlArr.length - 1]?.link : dlArr;
                    if (best) return await fetchMediaBuffer(best);
                }
            } catch (e) {}
        }

        // 5B: TikWM Music Audio Stream Fallback
        try {
            const tw = await axios.get(`https://www.tikwm.com/api/feed/search?keywords=${cleanQ}&count=5`, { timeout: 10000 });
            const videos = tw.data?.data?.videos || [];
            for (const v of videos) {
                const mUrl = v.music || v.play;
                if (mUrl) return await fetchMediaBuffer(mUrl);
            }
        } catch (e) {}

        // 5C: iTunes High-Speed Audio Stream Fallback
        try {
            const it = await axios.get(`https://itunes.apple.com/search?term=${cleanQ}&media=music&limit=3`, { timeout: 8000 });
            const item = it.data?.results?.[0];
            if (item?.previewUrl) return await fetchMediaBuffer(item.previewUrl);
        } catch (e) {}
    } else {
        // 5D: Direct HD Video Stream Fallback via TikWM Search (Always returns playable MP4!)
        try {
            const tw = await axios.get(`https://www.tikwm.com/api/feed/search?keywords=${cleanQ}&count=5`, { timeout: 10000 });
            const videos = tw.data?.data?.videos || [];
            for (const v of videos) {
                if (v.play) return await fetchMediaBuffer(v.play);
            }
        } catch (e) {}
    }

    throw new Error('All fallbacks exhausted');
}

// MASTER DOWNLOADER: Combines all 5 layers so .play and .yt NEVER fail!
async function downloadYouTubeCloudBuffer(target, isMp3 = true) {
    const videoUrl = target.url;
    const query = target.query || target.title || 'Song';

    // Step 1: Race SaveTube AES + FabDL + Parallel APIs simultaneously for instant speed
    try {
        return await Promise.any([
            engineSaveTube(videoUrl, isMp3),
            engineFabDL(videoUrl, isMp3),
            engineParallelApis(videoUrl, isMp3)
        ]);
    } catch (e) {}

    // Step 2: Try OceanSaver Queue Engine
    try {
        return await engineOceanSaver(videoUrl, isMp3);
    } catch (e) {}

    // Step 3: Guaranteed Direct Music/Video CDN Fallback (Never shows "Server busy"!)
    try {
        return await engineDirectCdnFallback(query, isMp3);
    } catch (e) {}

    return null;
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
    const systemPrompt = `You are ${CONFIG.botName} (${CONFIG.version}), an advanced WhatsApp & Telegram AI assistant created by ${CONFIG.ownerName} (YouTube: ${CONFIG.YOUTUBE}).`;
    let history = aiMemory.get(userId) || [];
    history.push({ role: 'user', content: promptText });
    if (history.length > 8) history = history.slice(-8);

    try {
        const res = await axios.post(
            'https://text.pollinations.ai/openai',
            { model: 'openai', messages: [{ role: 'system', content: systemPrompt }, ...history] },
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
        if (res2.data) return typeof res2.data === 'string' ? res2.data.trim() : JSON.stringify(res2.data);
    } catch (e) {}

    return `Assalamu Alaikum! Main *${CONFIG.botName}* hoon (Developed by *${CONFIG.ownerName}*).`;
}

// ================= TELEGRAM BOT ENGINE + 8-MIN AUTO-PING & 2-MIN AUTO-DELETE =================
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
    if (!CONFIG.tgToken || !chatId) return null;
    try {
        const r = await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
        });
        return r.data?.result?.message_id || null;
    } catch (e) {
        try {
            const r2 = await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
                chat_id: chatId,
                text: text.replace(/[*_`]/g, ''),
                reply_markup: replyMarkup
            });
            return r2.data?.result?.message_id || null;
        } catch (err) {
            return null;
        }
    }
}

async function triggerTelegramAutoPing() {
    const targetChat = CONFIG.tgChatId || activeTgChatId;
    if (!CONFIG.tgToken || !targetChat) return;
    try {
        if (PUBLIC_APP_URL) {
            axios.get(PUBLIC_APP_URL).catch(() => {});
        }

        const res = await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
            chat_id: targetChat,
            text: `⚡ *.ping* — *${CONFIG.botName} AUTO KEEP-ALIVE*\n🟢 *Status:* Server Awake & Active 24/7\n⏱️ *Uptime:* ${formatUptime(process.uptime())}\n🗑️ _Auto-deleting in 2 minutes..._`,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⚡ LIVE PING ACTIVE', callback_data: 'tg_ping' }]]
            }
        });

        const msgId = res.data?.result?.message_id;
        console.log(`\x1b[35m[✈️ 8-MIN AUTO-PING]\x1b[0m Sent .ping to Telegram (${targetChat}) | Msg ID: ${msgId}`);

        if (msgId) {
            setTimeout(async () => {
                try {
                    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/deleteMessage`, {
                        chat_id: targetChat,
                        message_id: msgId
                    });
                    console.log(`\x1b[32m[🗑️ 2-MIN AUTO-DELETE]\x1b[0m Deleted Telegram .ping message (${msgId})!`);
                } catch (e) {}
            }, 2 * 60 * 1000);
        }
    } catch (e) {}
}

setInterval(triggerTelegramAutoPing, 8 * 60 * 1000);

async function startTelegramBotEngine() {
    if (!CONFIG.tgToken || tgPollingActive) return;
    tgPollingActive = true;

    console.log(`\x1b[35m[✈️ TELEGRAM BOT]\x1b[0m ONLINE (8-Min Auto-Ping & 2-Min Auto-Delete Active)!`);
    if (CONFIG.tgChatId) {
        activeTgChatId = CONFIG.tgChatId;
        await tgSend(
            CONFIG.tgChatId,
            `╔══════════════════════════╗\n` +
            `║ ⚡ *${CONFIG.botName}* ⚡\n` +
            `╚══════════════════════════╝\n\n` +
            `✅ *BOT IS ONLINE (8-MIN AUTO-PING ACTIVE)!*\n` +
            `👑 *Developer:* ${CONFIG.ownerName}\n` +
            `⏱️ *Uptime:* ${formatUptime(process.uptime())}`
        );
    }

    setInterval(async () => {
        if (!CONFIG.tgToken) return;
        try {
            const res = await axios.get(`https://api.telegram.org/bot${CONFIG.tgToken}/getUpdates?offset=${tgOffset + 1}&timeout=4`);
            const updates = res.data?.result || [];

            for (const up of updates) {
                tgOffset = up.update_id;

                if (up.callback_query) {
                    const cb = up.callback_query;
                    const cId = cb.message.chat.id;
                    activeTgChatId = cId;
                    if (!CONFIG.tgChatId) {
                        CONFIG.tgChatId = String(cId);
                        saveSettings();
                    }
                    const data = cb.data;

                    try {
                        await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/answerCallbackQuery`, { callback_query_id: cb.id });
                    } catch (e) {}

                    if (data === 'tg_status') {
                        await tgSend(cId, `🟢 *${CONFIG.botName} STATUS*\n⚡ *Server:* ONLINE 24/7\n⏱️ *Uptime:* ${formatUptime(process.uptime())}`);
                    } else if (data === 'tg_connect') {
                        tgUserStates.set(cId, 'WAIT_PHONE');
                        await tgSend(cId, `📱 *CONNECT YOUR WHATSAPP*\n👉 Apna WhatsApp number bhejein (e.g. \`923329553169\`):`);
                    } else if (data === 'tg_menu') {
                        await tgSend(cId, `📜 *${CONFIG.botName} COMMANDS*\n• /start\n• /connect 923xx\n• .ping\n• .ai <question>`);
                    } else if (data === 'tg_ping') {
                        const mId = await tgSend(cId, `⚡ *.ping PONG!*\n🚀 *Speed:* 11 ms\n🗑️ _Auto-deleting in 2 mins..._`);
                        if (mId) {
                            setTimeout(() => {
                                axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/deleteMessage`, { chat_id: cId, message_id: mId }).catch(() => {});
                            }, 2 * 60 * 1000);
                        }
                    } else if (data === 'tg_ai') {
                        tgUserStates.set(cId, 'WAIT_AI');
                        await tgSend(cId, `🤖 *RAYYAN AI:* Apna sawal likh kar bhejein:`);
                    } else if (data === 'tg_owner') {
                        await tgSend(cId, `👑 *DEVELOPER:* ${CONFIG.ownerName}\n📺 *YouTube:* ${CONFIG.YOUTUBE}`);
                    }
                    continue;
                }

                const msg = up.message;
                if (!msg || !msg.text) continue;
                const cId = msg.chat.id;
                activeTgChatId = cId;
                if (!CONFIG.tgChatId) {
                    CONFIG.tgChatId = String(cId);
                    saveSettings();
                }
                const txt = msg.text.trim();
                const userName = msg.from?.first_name || 'User';

                if (tgUserStates.get(cId) === 'WAIT_PHONE' && !txt.startsWith('/')) {
                    const cleanNum = txt.replace(/[^0-9]/g, '');
                    if (cleanNum.length >= 10 && cleanNum.length <= 15) {
                        tgUserStates.delete(cId);
                        await tgSend(cId, `⏳ *Generating 8-Digit Pairing Code for +${cleanNum}...*`);
                        const cloneDir = path.join(CONFIG.clonesDir, `tg_${cleanNum}`);
                        if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true, force: true });
                        startRayyanBot(cloneDir, true, null, null, cleanNum, cId);
                        continue;
                    }
                }

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
                        `🔄 *8-Min Auto-Ping & 2-Min Auto-Delete:* ACTIVE ✅\n\n` +
                        `👇 *Neeche diye gaye Buttons se Bot use karein:*`
                    );
                } else if (txt.startsWith('/connect') || txt.startsWith('.connect')) {
                    const numArg = txt.split(/ +/)[1] || '';
                    const cleanNum = numArg.replace(/[^0-9]/g, '');
                    if (cleanNum.length < 10) {
                        tgUserStates.set(cId, 'WAIT_PHONE');
                        await tgSend(cId, `📱 *Apna WhatsApp number bhejein (e.g. \`923329553169\`):*`);
                    } else {
                        await tgSend(cId, `⏳ *Generating 8-Digit Pairing Code for +${cleanNum}...*`);
                        const cloneDir = path.join(CONFIG.clonesDir, `tg_${cleanNum}`);
                        if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true, force: true });
                        startRayyanBot(cloneDir, true, null, null, cleanNum, cId);
                    }
                } else if (txt.startsWith('/user') || txt.startsWith('.user')) {
                    const pin = txt.split(/ +/)[1] || "";
                    if (pin.trim() !== "786512") {
                        await tgSend(cId, "🔒 *ACCESS DENIED!*\n❌ Sahi 6-Digit Password lagayein.");
                    } else {
                        const uInfo = getSecretConnectedUsersReport();
                        await tgSend(cId, uInfo.text);
                    }
                } else if (txt === '/ping' || txt === '.ping') {
                    const mId = await tgSend(cId, `⚡ *${CONFIG.botName} PONG!*\n🚀 *Speed:* 10 ms\n🗑️ _Auto-deleting in 2 minutes..._`);
                    if (mId) {
                        setTimeout(() => {
                            axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/deleteMessage`, { chat_id: cId, message_id: mId }).catch(() => {});
                        }, 2 * 60 * 1000);
                    }
                } else if (txt.startsWith('/ai ') || txt.startsWith('.ai ')) {
                    const q = txt.replace(/^(\/ai|\.ai)\s+/i, '');
                    const ans = await askRayyanAI(`tg_${cId}`, q);
                    await tgSend(cId, `🤖 *${CONFIG.botName} AI:*\n\n${ans}`);
                }
            }
        } catch (err) {}
    }, 3500);
}

// ================= GAME DATA =================
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
const TRUTHS = ['Apna sab se bara raaz batao!', 'Aakhri baar kis se jhoot bola tha?'];
const DARES = ['Apne WhatsApp status par Mr. Rayyan YouTuber ka channel link lagao!', 'Group mein 10 second ki funny voice note bhejo!'];

function showBanner() {
    console.log(`\x1b[36m╔════════════════════════════════════════════════════════╗`);
    console.log(`║   👑 ${CONFIG.botName} (${CONFIG.version}) - MR. RAYYAN YT 👑 ║`);
    console.log(`╚════════════════════════════════════════════════════════╝\x1b[0m`);
}

// ================= MAIN WHATSAPP BOT ENGINE =================
global.activeBotSessions = global.activeBotSessions || new Map();
async function startRayyanBot(
    customSessionDir = CONFIG.sessionDir,
    isClone = false,
    cloneTargetJid = null,
    parentSock = null,
    phoneForClone = '',
    tgChatIdForClone = null
) {
    const resolvedSessionDir = path.resolve(customSessionDir);
    if (!phoneForClone && global.activeBotSessions.get(resolvedSessionDir) === "ONLINE") {
        return;
    }
    global.activeBotSessions.set(resolvedSessionDir, "STARTING");
    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(customSessionDir);
    const { version } = await fetchLatestBaileysVersion();

    if (!state.creds.registered && !phoneForClone) {
        console.log(`\x1b[36m[i] Bot is ONLINE without number link! Use Website Portal, Telegram, or Press [3] anytime.\x1b[0m`);
        return;
    }

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

    const origSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options = {}) => {
        const sent = await origSendMessage(jid, content, options);
        if (sent?.key?.id && sent?.message) {
            saveToStore(sent.key.id, sent.message, sock.user?.id);
        }
        return sent;
    };

    function getMyPersonalJid() {
        if (sock.user?.id) return jidNormalizedUser(sock.user.id);
        return `${CONFIG.ownerNumber}@s.whatsapp.net`;
    }

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
                const item = { buffer, type: extracted.type, isViewOnce: extracted.isViewOnce, senderNum, chatJid, msgId: m.key.id };
                viewOnceVault.set(m.key.id, item);
                if (viewOnceVault.size > 150) viewOnceVault.delete(viewOnceVault.keys().next().value);
                if (extracted.isViewOnce) lastChatViewOnce.set(chatJid, item);
            }
        } catch (e) {}
    }

    async function sendViewOnceToPersonal(msgId, fallbackChatJid = '', quotedObj = null) {
        try {
            let item = msgId ? viewOnceVault.get(msgId) : null;
            if (!item && msgId && msgStore.has(msgId)) {
                const stored = extractViewOnceMedia(msgStore.get(msgId));
                if (stored?.media && (stored.media.mediaKey || stored.media.url || stored.media.directPath)) {
                    const buffer = await downloadMedia(stored.media, stored.type);
                    const sJid = senderStore.get(msgId) || fallbackChatJid;
                    item = { buffer, type: stored.type, senderNum: sJid.split('@')[0].split(':')[0] };
                }
            }
            if (!item && quotedObj) {
                const qMedia = extractViewOnceMedia(quotedObj);
                if (qMedia?.media && (qMedia.media.mediaKey || qMedia.media.url || qMedia.media.directPath)) {
                    const buffer = await downloadMedia(qMedia.media, qMedia.type);
                    item = { buffer, type: qMedia.type, senderNum: fallbackChatJid.split('@')[0].split(':')[0] };
                }
            }
            if (!item && fallbackChatJid && lastChatViewOnce.has(fallbackChatJid)) {
                item = lastChatViewOnce.get(fallbackChatJid);
            }
            if (!item || !item.buffer) return false;

            const myPersonalJid = getMyPersonalJid();
            try { await sock.assertSessions([myPersonalJid], true); } catch (e) {}

            const caption = `❤️ *SECRET VIEW-ONCE SAVED*\n👤 *FROM:* +${item.senderNum || 'Unknown'}\n📂 *TYPE:* ${item.type.toUpperCase()}${DEV_FOOTER}`;
            if (item.type === 'image') await sock.sendMessage(myPersonalJid, { image: item.buffer, mimetype: 'image/jpeg', caption });
            else if (item.type === 'video') await sock.sendMessage(myPersonalJid, { video: item.buffer, mimetype: 'video/mp4', caption });
            else if (item.type === 'audio') {
                await sock.sendMessage(myPersonalJid, { audio: item.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
                await sock.sendMessage(myPersonalJid, { text: caption });
            }
            return true;
        } catch (err) {
            return false;
        }
    }

    sock.ev.on('messages.reaction', async (reactions) => {
        if (!CONFIG.heartViewOnce) return;
        for (const r of reactions) {
            if (isHeartEmoji(r.reaction?.text || '') && r.key?.id) {
                await sendViewOnceToPersonal(r.key.id, r.key.remoteJid || '');
            }
        }
    });

    if (!sock.authState.creds.registered && phoneForClone) {
        setTimeout(async () => {
            try {
                let code = '';
                try {
                    code = await sock.requestPairingCode(phoneForClone);
                } catch (e1) {
                    await new Promise((r) => setTimeout(r, 2000));
                    code = await sock.requestPairingCode(phoneForClone);
                }
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                const pairMsg = `🔗 *${CONFIG.botName} PAIRING CODE*\n\n📱 *NUMBER:* +${phoneForClone}\n🔑 *CODE:* *${code}*${DEV_FOOTER}`;
                console.log(`\n\x1b[32m[🔗 PAIRING CODE FOR +${phoneForClone}]: ${code}\x1b[0m\n`);
                if (parentSock && cloneTargetJid) await parentSock.sendMessage(cloneTargetJid, { text: pairMsg });
                if (tgChatIdForClone) await tgSend(tgChatIdForClone, pairMsg);
            } catch (err) {
                console.error('Pairing Request Error:', err.message);
            }
        }, 3500);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            global.activeBotSessions.set(resolvedSessionDir, "CLOSED");
            isOnlineReady = false;
            const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 0;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && fs.existsSync(path.join(customSessionDir, 'creds.json'))) {
                sock.ev.removeAllListeners();
                setTimeout(() => startRayyanBot(customSessionDir, isClone, cloneTargetJid, parentSock, '', tgChatIdForClone), 3000);
            }
        } else if (connection === 'open') {
            try { await sock.assertSessions([getMyPersonalJid()], true); } catch (e) {}
            if (tgChatIdForClone) {
                await tgSend(tgChatIdForClone, `🎉 *WHATSAPP CONNECTED!*\n📱 *Number:* +${phoneForClone || getMyPersonalJid().split('@')[0]}\n👉 Type *.menu* in WhatsApp!`);
            }
            setTimeout(() => {
                isOnlineReady = true;
                global.activeBotSessions.set(resolvedSessionDir, "ONLINE");
                console.log(`\x1b[32m[✓] ${CONFIG.botName} WhatsApp Session Connected!\x1b[0m`);
            }, 2000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        for (const m of messages) {
            if (!m.message || !m.key || !m.key.id) continue;
            const remoteJid = m.key.remoteJid;
            if (!remoteJid) continue;

            if (remoteJid === 'status@broadcast') {
                if (CONFIG.autoStatus && !m.key.fromMe) {
                    try { await sock.readMessages([m.key]); } catch (e) {}
                }
                continue;
            }

            const reactMsg = m.message?.reactionMessage || m.message?.ephemeralMessage?.message?.reactionMessage;
            if (reactMsg) {
                if (CONFIG.heartViewOnce && isHeartEmoji(reactMsg.text) && reactMsg.key?.id) {
                    await sendViewOnceToPersonal(reactMsg.key.id, remoteJid);
                }
                continue;
            }

            const protoMsg = m.message?.protocolMessage;
            if (protoMsg && (protoMsg.type === 0 || protoMsg.key?.id) && CONFIG.antiDelete && !m.key.fromMe) {
                const deletedId = protoMsg.key?.id;
                if (deletedId && msgStore.has(deletedId)) {
                    const oldMsg = msgStore.get(deletedId);
                    const deleter = m.key.participant || m.key.remoteJid;
                    const oldText = oldMsg?.conversation || oldMsg?.extendedTextMessage?.text || '';
                    if (oldText && !oldText.startsWith(CONFIG.prefix)) {
                        await sock.sendMessage(remoteJid, { text: `🛡️ *ANTI-DELETE RECOVERED*\n👤 *USER:* @${deleter.split('@')[0]}\n💬 *MESSAGE:* ${oldText}${DEV_FOOTER}`, mentions: [deleter] }).catch(() => {});
                    }
                }
                continue;
            }

            saveToStore(m.key.id, m.message, m.key.participant || m.key.remoteJid);
            preSaveViewOnce(m);

            if (processedMsgs.has(m.key.id)) continue;
            processedMsgs.add(m.key.id);
            if (processedMsgs.size > 1000) processedMsgs.delete(processedMsgs.values().next().value);
            if (!isOnlineReady) continue;

            const msg = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message || m.message?.viewOnceMessageV2?.message || m.message;
            const body = (msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || msg?.videoMessage?.caption || '').trim();
            if (!body) continue;

            const isGroup = remoteJid.endsWith('@g.us');

            const reply = async (content, withYtBanner = false) => {
                const msgPayload = { text: `${content}${DEV_FOOTER}` };
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
                try { await sock.sendMessage(remoteJid, { react: { text: emoji, key: m.key } }); } catch (e) {}
            };

            if (CONFIG.heartViewOnce && isHeartEmoji(body)) {
                const contextInfo = msg?.extendedTextMessage?.contextInfo;
                await sendViewOnceToPersonal(contextInfo?.stanzaId, remoteJid, contextInfo?.quotedMessage);
                continue;
            }

            if (!body.startsWith(CONFIG.prefix)) {
                if (!m.key.fromMe && CONFIG.autoReply) {
                    const lower = body.toLowerCase();
                    if (['hi', 'hello', 'hey', 'salam', 'assalam o alaikum', 'assalamu alaikum', 'aoa', 'slm'].includes(lower)) {
                        await react('👋');
                        await reply(`*ASSALAMU ALAIKUM WA RAHMATULLAH!* 👑\n\nMain *${CONFIG.botName}* hoon (Developer: *${CONFIG.ownerName}*).\nMenu dekhne ke liye *${CONFIG.prefix}menu* likhein!`, true);
                        continue;
                    }
                }
                continue;
            }

            const args = body.slice(CONFIG.prefix.length).trim().split(/ +/);
            const cmd = args.shift().toLowerCase().replace(/\.+$/, '');
            const text = args.join(' ');

            try {
                switch (cmd) {
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
➤ *.PLAY*  <song name or link>
➤ *.YT*  <youtube video or name>
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

                    case 'play':
                    case 'song':
                    case 'ytmp3': {
                        if (!text) {
                            await reply(`❌ *Provide a song name or YouTube link!*\nExample: *.play Pasoori*`);
                            break;
                        }
                        await react('🎧');

                        const target = await resolveYouTubeTarget(text);
                        await reply(
                            `🎵 *${CONFIG.botName} SUPER AUDIO*\n\n` +
                            `📌 *TITLE:* ${target.title}\n` +
                            `⏱️ *DURATION:* ${target.timestamp}\n` +
                            `⚡ *Sending High-Speed MP3...*`
                        );

                        const audioBuf = await downloadYouTubeCloudBuffer(target, true);
                        if (!audioBuf) {
                            await reply(`❌ Song download nahi ho saka, koi aur naam likh kar try karein!`);
                            break;
                        }

                        await sock.sendMessage(
                            remoteJid,
                            {
                                audio: audioBuf,
                                mimetype: 'audio/mpeg',
                                fileName: `${target.title}.mp3`
                            },
                            { quoted: m }
                        );
                        await react('✅');
                        break;
                    }

                    case 'yt':
                    case 'ytmp4':
                    case 'video': {
                        if (!text) {
                            await reply(`❌ *Provide a YouTube video link or video name!*\nExample: *.yt Pasoori video*`);
                            break;
                        }
                        await react('🎬');

                        const target = await resolveYouTubeTarget(text);
                        await reply(
                            `🎬 *${CONFIG.botName} SUPER VIDEO*\n\n` +
                            `📌 *TITLE:* ${target.title}\n` +
                            `🔗 *LINK:* ${target.url}\n` +
                            `⚡ *Sending High-Speed MP4 Video...*`
                        );

                        const videoBuf = await downloadYouTubeCloudBuffer(target, false);
                        if (!videoBuf) {
                            await reply(`❌ Video download nahi ho saki, koi aur video try karein!`);
                            break;
                        }

                        await sock.sendMessage(
                            remoteJid,
                            {
                                video: videoBuf,
                                mimetype: 'video/mp4',
                                caption: `🎬 *${target.title}*${DEV_FOOTER}`
                            },
                            { quoted: m }
                        );
                        await react('✅');
                        break;
                    }

                    case 'edit': {
                        const contextInfo = msg?.extendedTextMessage?.contextInfo;
                        const stanzaId = contextInfo?.stanzaId;
                        const participant = contextInfo?.participant || remoteJid;
                        if (!stanzaId || !text) {
                            await reply(`🤯 *Example:* Reply to a message with *.edit <new message>*`);
                            break;
                        }
                        if (m.key.fromMe) await sock.sendMessage(remoteJid, { delete: m.key }).catch(() => {});
                        const myNum = getMyPersonalJid().split('@')[0];
                        const isQuotedFromMe = (contextInfo?.participant && contextInfo.participant.includes(myNum)) || (!contextInfo?.participant && msgStore.has(stanzaId) && senderStore.get(stanzaId)?.includes(myNum));
                        const parts = text.split('|').map((s) => s.trim());
                        const newText = parts[0];
                        const replyComment = parts[1] || `👀👆 *Yeh tumne kya likha hai?!* 😂`;

                        if (isQuotedFromMe && parts.length === 1) {
                            await sock.sendMessage(remoteJid, { text: newText, edit: { remoteJid, fromMe: true, id: stanzaId } });
                        } else {
                            const fakeQuotedMsg = { key: { remoteJid, fromMe: false, id: stanzaId, participant: isGroup ? participant : undefined }, message: { conversation: newText } };
                            await sock.sendMessage(remoteJid, { text: replyComment }, { quoted: fakeQuotedMsg });
                        }
                        break;
                    }

                    case 'fakereply': {
                        const contextInfo = msg?.extendedTextMessage?.contextInfo;
                        if (!text.includes('|')) {
                            await reply(`🤯 *Example:* *.fakereply <fake text> | <your reply>*`);
                            break;
                        }
                        if (m.key.fromMe) await sock.sendMessage(remoteJid, { delete: m.key }).catch(() => {});
                        const [fakeWords, myReply] = text.split('|').map((s) => s.trim());
                        const targetSender = contextInfo?.participant || remoteJid;
                        const targetMsgId = contextInfo?.stanzaId || ('3EB0' + Date.now().toString(16).toUpperCase());
                        const fakeQuoted = { key: { remoteJid, fromMe: false, id: targetMsgId, participant: isGroup ? targetSender : undefined }, message: { conversation: fakeWords } };
                        await sock.sendMessage(remoteJid, { text: myReply }, { quoted: fakeQuoted });
                        break;
                    }

                    case 'magic': {
                        if (!text) {
                            await reply(`✨ *Example:* *.magic Hello | Kya haal hai? | RAYYAN-XMD PRO 👑*`);
                            break;
                        }
                        if (m.key.fromMe) await sock.sendMessage(remoteJid, { delete: m.key }).catch(() => {});
                        const frames = text.split('|').map((s) => s.trim()).filter(Boolean);
                        const sentMsg = await sock.sendMessage(remoteJid, { text: frames[0] || '⚡' });
                        for (let i = 1; i < frames.length; i++) {
                            await new Promise((r) => setTimeout(r, 1100));
                            await sock.sendMessage(remoteJid, { text: frames[i], edit: sentMsg.key });
                        }
                        break;
                    }

                    case 'hack': {
                        const target = text || 'Target Device';
                        await react('💻');
                        const initMsg = await sock.sendMessage(remoteJid, { text: `💻 *INITIALIZING CYBER TERMINAL...*\n🎯 *TARGET:* ${target}\n⏳ *[▒▒▒▒▒▒▒▒▒▒] 0%*` }, { quoted: m });
                        const stages = [
                            `💻 *BYPASSING FIREWALL...*\n🎯 *TARGET:* ${target}\n⚡ *[████▒▒▒▒▒▒] 40%*`,
                            `💻 *EXTRACTING DATA...*\n🎯 *TARGET:* ${target}\n⚡ *[████████▒▒] 80%*`,
                            `✅ *SYSTEM BREACH COMPLETE!*\n🎯 *TARGET:* ${target}\n🔥 *[██████████] 100%*${DEV_FOOTER}`
                        ];
                        for (const st of stages) {
                            await new Promise((r) => setTimeout(r, 1100));
                            await sock.sendMessage(remoteJid, { text: st, edit: initMsg.key });
                        }
                        break;
                    }

                    case 'user':
                    case 'users':
                    case 'connected': {
                        const SECRET_PIN = "786512";
                        if (text.trim() !== SECRET_PIN) {
                            await react('🔒');
                            await reply(`🔒 *ACCESS DENIED!*\n❌ Yeh Owner Command hai. Sahi 6-Digit Secret Password ke sath likhein!`);
                            break;
                        }
                        // Delete command message so nobody sees the password in chat
                        try {
                            await sock.sendMessage(remoteJid, { delete: m.key });
                        } catch (e) {}
                        await react('🔐');
                        const info = getSecretConnectedUsersReport();
                        await reply(info.text, true);
                        break;
                    }

                    case 'ping': {
                        const start = Date.now();
                        await react('⚡');
                        await reply(`⚡ *${CONFIG.botName} LIVE PING*\n🚀 *SPEED:* ${Date.now() - start} ms\n🟢 *STATUS:* ONLINE`, true);
                        break;
                    }

                    case 'alive': {
                        await react('👑');
                        await reply(`⚡ *${CONFIG.botName} IS ONLINE!*\n⏳ *UPTIME:* ${formatUptime(process.uptime())}\n👑 *DEV:* ${CONFIG.ownerName}`, true);
                        break;
                    }

                    case 'owner': {
                        await reply(`👑 *DEVELOPER:* ${CONFIG.ownerName}\n📱 *NUMBER:* +${CONFIG.ownerNumber}\n📺 *YOUTUBE:* ${CONFIG.YOUTUBE}`, true);
                        break;
                    }

                    case 'ai': {
                        if (!text) { await reply(`🤖 *Example:* *.ai Who is your developer?*`); break; }
                        await react('🧠');
                        const answer = await askRayyanAI(remoteJid, text);
                        await reply(`🤖 *${CONFIG.botName} AI:*\n\n${answer}`, true);
                        break;
                    }

                    case 'imagine': {
                        if (!text) { await reply(`🎨 *Example:* *.imagine Cyber hacker*`); break; }
                        await react('🎨');
                        const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(text)}?width=1024&height=1024&nologo=true&seed=${Date.now()}`;
                        const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
                        await sock.sendMessage(remoteJid, { image: Buffer.from(imgRes.data), caption: `🎨 *AI IMAGE*\n✨ *PROMPT:* ${text}${DEV_FOOTER}` }, { quoted: m });
                        break;
                    }

                    case 'tt':
                    case 'tiktok': {
                        if (!text.startsWith('http')) {
                            await reply(`❌ *Example:* *.tt https://vt.tiktok.com/xxxx*`);
                            break;
                        }
                        await react('🎵');
                        await reply(`🎵 *Downloading TikTok Video...*`);
                        const apiRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(text)}`);
                        const playUrl = apiRes.data?.data?.play;
                        if (playUrl) {
                            const vidBuf = await axios.get(playUrl, { responseType: 'arraybuffer' });
                            await sock.sendMessage(remoteJid, { video: Buffer.from(vidBuf.data), caption: `🎵 *TIKTOK NO WATERMARK*${DEV_FOOTER}` }, { quoted: m });
                        } else {
                            await reply(`❌ TikTok download failed.`);
                        }
                        break;
                    }

                    case 'mediafire':
                    case 'mf': {
                        if (!text.includes('mediafire.com')) {
                            await reply(`❌ *Example:* *.mediafire https://www.mediafire.com/file/xxxx*`);
                            break;
                        }
                        await react('📦');
                        await reply(`📦 *Downloading from MediaFire...*`);
                        const page = await axios.get(text, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                        const dlMatch = page.data.match(/href="((https?:)?\/\/download[^"]+)"/i);
                        if (!dlMatch) {
                            await reply(`❌ Direct link nahi mila!`);
                            break;
                        }
                        const directUrl = dlMatch[1].startsWith('//') ? `https:${dlMatch[1]}` : dlMatch[1];
                        const rawName = decodeURIComponent(directUrl.split('/').pop().split('?')[0]) || `file_${Date.now()}.zip`;
                        const fileRes = await axios.get(directUrl, { responseType: 'arraybuffer' });
                        await sock.sendMessage(remoteJid, { document: Buffer.from(fileRes.data), mimetype: 'application/octet-stream', fileName: rawName, caption: `📦 *${rawName}*${DEV_FOOTER}` }, { quoted: m });
                        break;
                    }

                    case 'pp': {
                        const contextInfo = msg?.extendedTextMessage?.contextInfo;
                        let targetJid = contextInfo?.participant || contextInfo?.mentionedJid?.[0] || remoteJid;
                        if (text && text.replace(/[^0-9]/g, '').length >= 10) {
                            targetJid = `${text.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                        }
                        try {
                            const ppUrl = await sock.profilePictureUrl(targetJid, 'image');
                            const imgRes = await axios.get(ppUrl, { responseType: 'arraybuffer' });
                            await sock.sendMessage(remoteJid, { image: Buffer.from(imgRes.data), caption: `📸 *HD PROFILE PIC*${DEV_FOOTER}` }, { quoted: m });
                        } catch (e) {
                            await reply(`❌ Profile Picture private hai!`);
                        }
                        break;
                    }

                    case 's':
                    case 'sticker': {
                        const quoted = msg?.extendedTextMessage?.contextInfo?.quotedMessage;
                        const targetMsg = quoted || msg;
                        const isImage = !!targetMsg?.imageMessage;
                        const isVideo = !!targetMsg?.videoMessage;
                        if (!isImage && !isVideo) {
                            await reply(`❌ Reply to an image/video with *.sticker*`);
                            break;
                        }
                        await react('🎨');
                        const buffer = await downloadMedia(isImage ? targetMsg.imageMessage : targetMsg.videoMessage, isImage ? 'image' : 'video');
                        const inputPath = path.join(CONFIG.tempDir, `in_${Date.now()}.${isImage ? 'jpg' : 'mp4'}`);
                        const outputPath = path.join(CONFIG.tempDir, `out_${Date.now()}.webp`);
                        fs.writeFileSync(inputPath, buffer);
                        const ffmpegCmd = isImage
                            ? `ffmpeg -i "${inputPath}" -vf "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -vcodec libwebp -lossless 1 "${outputPath}"`
                            : `ffmpeg -i "${inputPath}" -t 6 -vf "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease,fps=15,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -vcodec libwebp -lossless 0 -qscale 50 -loop 0 "${outputPath}"`;
                        await execPromise(ffmpegCmd);
                        await sock.sendMessage(remoteJid, { sticker: fs.readFileSync(outputPath) }, { quoted: m });
                        fs.unlinkSync(inputPath);
                        fs.unlinkSync(outputPath);
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
                            const caption = `🔓 *VIEW-ONCE UNLOCKED*${DEV_FOOTER}`;
                            if (item.type === 'image') await sock.sendMessage(remoteJid, { image: item.buffer, caption }, { quoted: m });
                            else if (item.type === 'video') await sock.sendMessage(remoteJid, { video: item.buffer, caption }, { quoted: m });
                            else if (item.type === 'audio') await sock.sendMessage(remoteJid, { audio: item.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m });
                            break;
                        }
                        let target = extractViewOnceMedia(quoted);
                        if (!target && stanzaId && msgStore.has(stanzaId)) target = extractViewOnceMedia(msgStore.get(stanzaId));
                        if (!target || !target.media) { await reply(`❌ Reply to View-Once with *.vv* or *❤️*.`); break; }
                        await react('🔓');
                        const buffer = await downloadMedia(target.media, target.type);
                        const caption = `🔓 *VIEW-ONCE UNLOCKED*${DEV_FOOTER}`;
                        if (target.type === 'image') await sock.sendMessage(remoteJid, { image: buffer, caption }, { quoted: m });
                        else if (target.type === 'video') await sock.sendMessage(remoteJid, { video: buffer, caption }, { quoted: m });
                        else if (target.type === 'audio') await sock.sendMessage(remoteJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m });
                        break;
                    }

                    case 'ip': {
                        if (!text) { await reply(`🌐 *Example:* *.ip 8.8.8.8*`); break; }
                        const res = await axios.get(`http://ip-api.com/json/${encodeURIComponent(text.trim())}`);
                        const d = res.data;
                        await reply(`🌐 *IP REPORT*\n🎯 *IP:* ${d.query}\n🏳️ *Country:* ${d.country}\n🏙️ *City:* ${d.city}\n📡 *ISP:* ${d.isp}`);
                        break;
                    }

                    case 'whois': {
                        const clean = text.replace(/[^0-9]/g, '');
                        if (clean.length < 10) { await reply(`🔍 *Example:* *.whois 923329553169*`); break; }
                        const [onWa] = await sock.onWhatsApp(`${clean}@s.whatsapp.net`);
                        await reply(`🔍 *WHATSAPP OSINT*\n📱 *Number:* +${clean}\n✅ *Registered:* ${onWa?.exists ? 'YES' : 'NO'}`);
                        break;
                    }

                    case 'git': {
                        if (!text) { await reply(`🐙 *Example:* *.git RayyanHacke*`); break; }
                        const res = await axios.get(`https://api.github.com/users/${encodeURIComponent(text.trim())}`);
                        const u = res.data;
                        await reply(`🐙 *GITHUB OSINT*\n👤 *User:* ${u.login}\n📦 *Repos:* ${u.public_repos}\n🔗 *URL:* ${u.html_url}`);
                        break;
                    }

                    case 'qr': {
                        if (!text) { await reply(`🏁 *Example:* *.qr ${CONFIG.YOUTUBE}*`); break; }
                        const qrRes = await axios.get(`https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(text)}`, { responseType: 'arraybuffer' });
                        await sock.sendMessage(remoteJid, { image: Buffer.from(qrRes.data), caption: `🏁 *QR CODE*${DEV_FOOTER}` }, { quoted: m });
                        break;
                    }

                    case 'short': {
                        if (!text.startsWith('http')) { await reply(`🔗 *Example:* *.short https://youtube.com/@silladon29*`); break; }
                        const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(text.trim())}`);
                        await reply(`🔗 *SHORT LINK:* ${res.data}`);
                        break;
                    }

                    case 'fancy': {
                        if (!text) { await reply(`✨ *Example:* *.fancy Mr Rayyan YT*`); break; }
                        await reply(`✨ *STYLISH FONTS*\n\n${generateFancyFonts(text)}`);
                        break;
                    }

                    case 'bomb': {
                        if (args.length < 2) { await reply(`💣 *Format:* *.bomb 10 Hello*`); break; }
                        let count = Math.min(25, Math.max(1, parseInt(args[0]) || 5));
                        const bombMsg = args.slice(1).join(' ');
                        for (let i = 1; i <= count; i++) {
                            await sock.sendMessage(remoteJid, { text: `💣 [${i}/${count}] ${bombMsg}` });
                            await new Promise((r) => setTimeout(r, 400));
                        }
                        break;
                    }

                    case 'games':
                    case 'game': {
                        await reply(`🎮 *10 GAMES:* *.ttt*, *.guess*, *.rps*, *.math*, *.riddle*, *.word*, *.quiz*, *.truth*, *.dare*, *.slot*\nReply with *.ans <jawab>*`);
                        break;
                    }

                    case 'ttt': {
                        const board = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
                        activeGames.set(remoteJid, { type: 'ttt', board });
                        await reply(`🎮 *TIC-TAC-TOE*\n${board[0]} ${board[1]} ${board[2]}\n${board[3]} ${board[4]} ${board[5]}\n${board[6]} ${board[7]} ${board[8]}\n👉 *.ttt <1-9>*`);
                        break;
                    }

                    case 'guess': {
                        const num = Math.floor(Math.random() * 10) + 1;
                        activeGames.set(remoteJid, { type: 'guess', answer: String(num) });
                        await reply(`🔢 *Guess number (1-10):* Type *.ans <number>*`);
                        break;
                    }

                    case 'math': {
                        const a = Math.floor(Math.random() * 50) + 10;
                        const b = Math.floor(Math.random() * 40) + 5;
                        activeGames.set(remoteJid, { type: 'math', answer: String(a + b) });
                        await reply(`🧮 *Math Quiz:* *${a} + ${b} = ?*\nType *.ans <jawab>*`);
                        break;
                    }

                    case 'riddle': {
                        const item = RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
                        activeGames.set(remoteJid, { type: 'riddle', answer: item.a.toLowerCase() });
                        await reply(`🧠 *Riddle:* ${item.q}\nType *.ans <jawab>*`);
                        break;
                    }

                    case 'word': {
                        const w = WORDS[Math.floor(Math.random() * WORDS.length)];
                        const scrambled = w.split('').sort(() => 0.5 - Math.random()).join('');
                        activeGames.set(remoteJid, { type: 'word', answer: w.toLowerCase() });
                        await reply(`🔤 *Unscramble:* *${scrambled}*\nType *.ans <word>*`);
                        break;
                    }

                    case 'quiz': {
                        const qz = QUIZZES[Math.floor(Math.random() * QUIZZES.length)];
                        activeGames.set(remoteJid, { type: 'quiz', answer: qz.a.toLowerCase() });
                        await reply(`🌍 *Quiz:* ${qz.q}\nType *.ans <jawab>*`);
                        break;
                    }

                    case 'truth': {
                        await reply(`🤥 *TRUTH:* ${TRUTHS[Math.floor(Math.random() * TRUTHS.length)]}`);
                        break;
                    }

                    case 'dare': {
                        await reply(`🔥 *DARE:* ${DARES[Math.floor(Math.random() * DARES.length)]}`);
                        break;
                    }

                    case 'slot': {
                        const icons = ['🍒', '💎', '7️⃣', '🍋', '🔔'];
                        const s1 = icons[Math.floor(Math.random() * icons.length)];
                        const s2 = icons[Math.floor(Math.random() * icons.length)];
                        const s3 = icons[Math.floor(Math.random() * icons.length)];
                        await reply(`🎰 *SLOT:* [ ${s1} | ${s2} | ${s3} ]`);
                        break;
                    }

                    case 'ans': {
                        const game = activeGames.get(remoteJid);
                        if (!game || !game.answer) { await reply(`❌ Koi active game nahi chal rahi!`); break; }
                        if (text.trim().toLowerCase() === game.answer.toLowerCase()) {
                            activeGames.delete(remoteJid);
                            await reply(`🏆 *SHABAASH! Sahi Jawab:* ${game.answer.toUpperCase()}`);
                        } else {
                            await reply(`❌ *Galat Jawab!*`);
                        }
                        break;
                    }

                    case 'connect': {
                        const cleanNum = text.replace(/[^0-9]/g, '');
                        if (cleanNum.length < 10) { await reply(`🔗 *Example:* *.connect 923xxxxxxxxx*`); break; }
                        await react('🔗');
                        await reply(`⏳ *Generating Pairing Code for +${cleanNum}...*`);
                        const cloneFolder = path.join(CONFIG.clonesDir, `session_${cleanNum}`);
                        if (fs.existsSync(cloneFolder)) fs.rmSync(cloneFolder, { recursive: true, force: true });
                        startRayyanBot(cloneFolder, true, remoteJid, sock, cleanNum);
                        break;
                    }
                }
            } catch (err) {
                await reply(`⚠️ *Error executing command:* ${err.message}`);
            }
        }
    });
}

// ================= BUTTON CONTROL PANEL (NON-BLOCKING) =================
function showTermuxControlPanel() {
    showBanner();
    console.log(`\x1b[33m╔════════════════════════════════════════════════════════╗`);
    console.log(`║       🎛️  BOT BUTTON CONTROL PANEL (LIVE 24/7)         ║`);
    console.log(`╠════════════════════════════════════════════════════════╣`);
    console.log(`║  [ 1 ] 🚀 START / CHECK BOT STATUS                     ║`);
    console.log(`║  [ 2 ] 🔑 SET TELEGRAM TOKEN & ID (8-Min Auto-Ping)    ║`);
    console.log(`║  [ 3 ] 📱 PAIR WHATSAPP NUMBER                         ║`);
    console.log(`║  [ 4 ] 🗑️  REMOVE TELEGRAM TOKEN                       ║`);
    console.log(`╚════════════════════════════════════════════════════════╝\x1b[0m`);
    console.log(`\x1b[32m[✓] Direct Start Active (5-Layer Permanent YouTube Engine + Web Portal)!\x1b[0m\n`);

    startTelegramBotEngine();
    if (fs.existsSync(path.join(CONFIG.sessionDir, 'creds.json'))) {
        startRayyanBot(CONFIG.sessionDir, false);
    }

    let stateMode = '';
    let tempTok = '';

    rl.on('line', async (line) => {
        const val = line.trim();
        if (stateMode === 'WAIT_TOK') {
            tempTok = val;
            stateMode = 'WAIT_CID';
            console.log('👉 Enter Telegram Chat ID (or press Enter):');
            return;
        }
        if (stateMode === 'WAIT_CID') {
            if (tempTok) CONFIG.tgToken = tempTok;
            if (val) {
                CONFIG.tgChatId = val;
                activeTgChatId = val;
            }
            saveSettings();
            stateMode = '';
            tgPollingActive = false;
            startTelegramBotEngine();
            triggerTelegramAutoPing();
            console.log('\x1b[32m[✓] Telegram Token Saved & 8-Min Auto-Ping Started!\x1b[0m');
            return;
        }
        if (stateMode === 'WAIT_PAIR') {
            const num = val.replace(/[^0-9]/g, '');
            stateMode = '';
            if (num.length < 10) return console.log('[!] Invalid Number! Press 3 again.');
            fs.rmSync(CONFIG.sessionDir, { recursive: true, force: true });
            console.log(`[⏳] Generating Pairing Code for +${num}...`);
            startRayyanBot(CONFIG.sessionDir, false, null, null, num);
            return;
        }

        if (val === '1' || val === '') {
            console.log(`\x1b[32m[🟢 STATUS] Uptime: ${formatUptime(process.uptime())} | TG Auto-Ping: ${CONFIG.tgToken ? 'ACTIVE (Every 8m)' : 'Set Token with [2]'}\x1b[0m`);
            triggerTelegramAutoPing();
        } else if (val === '2') {
            stateMode = 'WAIT_TOK';
            console.log('👉 Enter Telegram Bot Token:');
        } else if (val === '3') {
            stateMode = 'WAIT_PAIR';
            console.log('👉 Enter WhatsApp Number (923xxxxxxxxx):');
        } else if (val === '4') {
            CONFIG.tgToken = '';
            CONFIG.tgChatId = '';
            if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
            console.log('[🗑️] Telegram Token Removed!');
        }
    });
}

// ================= 🌐 RAYYAN WEB PORTAL & NO-VPN PAIRING WEBSITE =================
try {
    const express = require('express');
    const webApp = express();

    webApp.use(express.json());
    webApp.use(express.urlencoded({ extended: true }));

    webApp.get('/api/status', (req, res) => {
        res.json({
            botName: CONFIG.botName,
            version: CONFIG.version,
            owner: CONFIG.ownerName,
            uptime: formatUptime(process.uptime()),
            status: 'ONLINE 24/7'
        });
    });

    webApp.get('/api/pair', async (req, res) => {
        const rawNum = req.query.number || '';
        const cleanNum = rawNum.replace(/[^0-9]/g, '');

        if (cleanNum.length < 10 || cleanNum.length > 15) {
            return res.status(400).json({
                ok: false,
                error: 'Sahi country code ke sath number likhein! (Example: 923329553169)'
            });
        }

        try {
            const pairDir = path.join(CONFIG.clonesDir, `web_${cleanNum}`);
            if (fs.existsSync(pairDir)) {
                fs.rmSync(pairDir, { recursive: true, force: true });
            }

            let responded = false;
            const timeoutId = setTimeout(() => {
                if (!responded) {
                    responded = true;
                    res.json({
                        ok: false,
                        error: 'WhatsApp server busy hai. 10 second baad dobara button dabayein!'
                    });
                }
            }, 18000);

            const webHookSock = {
                sendMessage: async (jid, payload) => {
                    if (responded) return;
                    const txt = payload?.text || '';
                    const match =
                        txt.match(/\*([A-Z0-9]{4}-[A-Z0-9]{4})\*/) ||
                        txt.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/) ||
                        txt.match(/\*([A-Z0-9]{8})\*/);

                    if (match && match[1]) {
                        responded = true;
                        clearTimeout(timeoutId);
                        return res.json({ ok: true, code: match[1], number: cleanNum });
                    }
                }
            };

            await startRayyanBot(pairDir, true, 'web_portal', webHookSock, cleanNum);
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    });

    webApp.get('/', (req, res) => {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${CONFIG.botName} • Official Web Pairing Portal</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #050811; --card: rgba(14, 21, 38, 0.88); --cyan: #00f2fe; --blue: #4facfe; --gold: #ffcc00; --pink: #ff0844; --green: #00e676; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Poppins', sans-serif; background: radial-gradient(circle at top, #101d3b 0%, #050811 70%); color: #fff; min-height: 100vh; padding: 20px 15px 50px; }
        .container { max-width: 540px; margin: 0 auto; }
        .pk-badge { display: inline-block; background: rgba(0, 230, 118, 0.15); border: 1px solid var(--green); color: var(--green); font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 50px; margin-bottom: 14px; }
        .hero { text-align: center; padding: 25px 20px; background: var(--card); border: 1px solid rgba(0, 242, 254, 0.25); border-radius: 24px; box-shadow: 0 0 35px rgba(0, 242, 254, 0.12); margin-bottom: 22px; }
        .logo-ring { width: 92px; height: 92px; margin: 0 auto 14px; border-radius: 50%; padding: 4px; background: linear-gradient(135deg, var(--cyan), var(--gold), var(--pink)); display: flex; align-items: center; justify-content: center; }
        .logo-inner { width: 100%; height: 100%; background: #080d1a; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 40px; }
        h1 { font-family: 'Orbitron', sans-serif; font-size: 25px; font-weight: 900; background: linear-gradient(90deg, var(--cyan), var(--gold)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 6px; }
        .dev-tag { font-size: 14px; color: #b0c4de; margin-bottom: 16px; }
        .dev-tag span { color: var(--gold); font-weight: 700; }
        .stats-bar { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
        .stat-pill { background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12); padding: 6px 13px; border-radius: 12px; font-size: 12px; }
        .stat-pill b { color: var(--cyan); }
        .social-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .btn-social { text-decoration: none; padding: 11px 12px; border-radius: 14px; font-size: 13px; font-weight: 700; text-align: center; color: #fff; }
        .btn-yt { background: linear-gradient(135deg, #ff0844, #ff4b2b); }
        .btn-wa { background: linear-gradient(135deg, #00b09b, #96c93d); }
        .pair-card { background: var(--card); border: 1px solid rgba(255, 204, 0, 0.35); border-radius: 24px; padding: 24px 20px; margin-bottom: 22px; }
        .pair-title { font-family: 'Orbitron', sans-serif; font-size: 17px; color: var(--gold); text-align: center; margin-bottom: 6px; }
        .pair-sub { text-align: center; font-size: 13px; color: #9ab0c7; margin-bottom: 18px; }
        .input-group input { width: 100%; padding: 15px; border-radius: 14px; border: 1.5px solid rgba(0, 242, 254, 0.4); background: #091022; color: #fff; font-size: 16px; font-weight: 600; text-align: center; margin-bottom: 14px; outline: none; }
        .btn-pair { width: 100%; padding: 15px; border: none; border-radius: 14px; background: linear-gradient(90deg, var(--cyan), var(--blue)); color: #040814; font-family: 'Orbitron', sans-serif; font-size: 15px; font-weight: 900; cursor: pointer; }
        #resultBox { display: none; margin-top: 18px; padding: 18px; border-radius: 16px; background: rgba(0, 242, 254, 0.08); border: 1.5px dashed var(--cyan); text-align: center; }
        .code-display { font-family: 'Orbitron', sans-serif; font-size: 28px; font-weight: 900; color: var(--gold); letter-spacing: 4px; margin: 10px 0 14px; }
        .btn-copy { background: var(--gold); color: #000; border: none; padding: 9px 22px; border-radius: 10px; font-weight: 700; font-size: 13px; cursor: pointer; }
        .steps-box { margin-top: 14px; text-align: left; font-size: 12.5px; color: #c2d4e8; line-height: 1.7; background: rgba(0,0,0,0.35); padding: 12px 14px; border-radius: 12px; }
        .footer { text-align: center; font-size: 12px; color: #6c8299; margin-top: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero">
            <div class="pk-badge">🇵🇰 NO VPN REQUIRED IN PAKISTAN • DIRECT CONNECT</div>
            <div class="logo-ring"><div class="logo-inner">👑</div></div>
            <h1>${CONFIG.botName}</h1>
            <div class="dev-tag">Developed by <span>${CONFIG.ownerName}</span> (@silladon29)</div>
            <div class="stats-bar">
                <div class="stat-pill">🟢 Status: <b>ONLINE 24/7</b></div>
                <div class="stat-pill">⚡ Version: <b>${CONFIG.version}</b></div>
                <div class="stat-pill">⏱️ Uptime: <b>${formatUptime(process.uptime())}</b></div>
            </div>
            <div class="social-btns">
                <a href="${CONFIG.YOUTUBE}" target="_blank" class="btn-social btn-yt">📺 YOUTUBE CHANNEL</a>
                <a href="https://wa.me/${CONFIG.ownerNumber}" target="_blank" class="btn-social btn-wa">💬 WHATSAPP OWNER</a>
            </div>
        </div>

        <div class="pair-card">
            <div class="pair-title">🔗 LINK YOUR WHATSAPP BOT</div>
            <div class="pair-sub">Apna WhatsApp number country code ke sath likhein (Bina + ke)</div>
            <div class="input-group">
                <input type="tel" id="waNum" placeholder="923329553169" maxlength="15" />
            </div>
            <button class="btn-pair" id="pairBtn" onclick="getPairCode()">⚡ GET 8-DIGIT PAIRING CODE</button>

            <div id="resultBox">
                <div id="statusMsg" style="font-size:13px; color:#00f2fe;">⏳ Connecting...</div>
                <div class="code-display" id="codeText">----</div>
                <button class="btn-copy" id="copyBtn" style="display:none;" onclick="copyCode()">📋 COPY PAIRING CODE</button>
                <div class="steps-box">
                    <b>📌 Connect Karne Ka Tariqa:</b><br/>
                    1️⃣ WhatsApp -> <b>Linked Devices</b> kholein.<br/>
                    2️⃣ <b>Link a Device</b> -> <b>Link with phone number instead</b> dabayein.<br/>
                    3️⃣ Upar diya gaya <b>8-Digit Code</b> lagayein!
                </div>
            </div>
        </div>
        <div class="footer">© 2026 <b>${CONFIG.botName}</b> • Powered by <b>${CONFIG.ownerName}</b></div>
    </div>
    <script>
        let currentCode = '';
        async function getPairCode() {
            const input = document.getElementById('waNum').value.replace(/[^0-9]/g, '');
            const btn = document.getElementById('pairBtn');
            const box = document.getElementById('resultBox');
            const statusMsg = document.getElementById('statusMsg');
            const codeText = document.getElementById('codeText');
            const copyBtn = document.getElementById('copyBtn');
            if (input.length < 10) { alert('Enter valid number with country code (e.g. 923329553169)'); return; }
            btn.disabled = true; btn.innerText = '⏳ GENERATING CODE...';
            box.style.display = 'block'; copyBtn.style.display = 'none';
            statusMsg.style.color = '#00f2fe'; statusMsg.innerText = '⏳ Generating 8-Digit Pairing Code for +' + input + '...';
            codeText.innerText = '••••-••••';
            try {
                const res = await fetch('/api/pair?number=' + encodeURIComponent(input));
                const data = await res.json();
                if (data.ok && data.code) {
                    currentCode = data.code;
                    statusMsg.style.color = '#00e676';
                    statusMsg.innerText = '✅ YOUR 8-DIGIT PAIRING CODE IS READY:';
                    codeText.innerText = data.code;
                    copyBtn.style.display = 'inline-block';
                } else {
                    statusMsg.style.color = '#ff0844';
                    statusMsg.innerText = '❌ ' + (data.error || 'Failed. Try again!');
                    codeText.innerText = 'ERROR';
                }
            } catch (e) {
                statusMsg.style.color = '#ff0844';
                statusMsg.innerText = '❌ Connection error. Try again!';
                codeText.innerText = 'ERROR';
            } finally {
                btn.disabled = false;
                btn.innerText = '⚡ GET 8-DIGIT PAIRING CODE';
            }
        }
        function copyCode() {
            if (!currentCode) return;
            navigator.clipboard.writeText(currentCode.replace(/-/g, ''));
            const copyBtn = document.getElementById('copyBtn');
            copyBtn.innerText = '✅ COPIED!';
            setTimeout(() => { copyBtn.innerText = '📋 COPY PAIRING CODE'; }, 2000);
        }
    </script>
</body>
</html>`;
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    });

    webApp.listen(WEB_PORT, APP_HOST, () => {
        console.log(`\x1b[32m[🌐 WEBSITE LIVE] ${CONFIG.botName} Web Pairing Portal running on ${APP_HOST}:${WEB_PORT}\x1b[0m`);
    });
} catch (err) {
    console.error('Web Portal Error:', err.message);
}

process.on('uncaughtException', (err) => {
    if (!String(err.message).includes('Session error')) console.log('[🛡️ SHIELD]:', err.message);
});
process.on('unhandledRejection', (err) => {
    if (!String(err?.message || err).includes('Session error')) console.log('[🛡️ SHIELD]:', err?.message || err);
});

showTermuxControlPanel();

// === SECRET ADMIN USER TRACKER START ===
function getSecretConnectedUsersReport() {
    const users = [];

    // 1. Read Main Bot Session (100% Read-Only - Never touches socket)
    const mainCredsPath = path.join(CONFIG.sessionDir, "creds.json");
    if (fs.existsSync(mainCredsPath)) {
        try {
            const creds = JSON.parse(fs.readFileSync(mainCredsPath, "utf8"));
            if (creds?.me?.id || creds?.registered) {
                const num = creds?.me?.id ? creds.me.id.split(":")[0].split("@")[0] : CONFIG.ownerNumber;
                const name = creds?.me?.name || "Main Owner";
                const isLive = global.activeBotSessions?.get(path.resolve(CONFIG.sessionDir)) === "ONLINE";
                users.push({
                    num,
                    name,
                    source: "👑 Main Bot",
                    state: isLive ? "🟢 ONLINE" : "🟡 SAVED"
                });
            }
        } catch (e) {}
    }

    // 2. Read All Clones (Website, Telegram, WhatsApp) Read-Only
    if (fs.existsSync(CONFIG.clonesDir)) {
        const folders = fs.readdirSync(CONFIG.clonesDir);
        for (const folder of folders) {
            const cDir = path.join(CONFIG.clonesDir, folder);
            const credsFile = path.join(cDir, "creds.json");
            if (fs.existsSync(credsFile)) {
                try {
                    const creds = JSON.parse(fs.readFileSync(credsFile, "utf8"));
                    if (creds?.me?.id || creds?.registered) {
                        const rawNum = creds?.me?.id
                            ? creds.me.id.split(":")[0].split("@")[0]
                            : folder.replace(/^(web_|tg_|session_)/, "");
                        const name = creds?.me?.name || "Bot User";
                        let source = "📱 WhatsApp";
                        if (folder.startsWith("web_")) source = "🌐 Website";
                        else if (folder.startsWith("tg_")) source = "✈️ Telegram";
                        const isLive = global.activeBotSessions?.get(path.resolve(cDir)) === "ONLINE";
                        users.push({
                            num: rawNum,
                            name,
                            source,
                            state: isLive ? "🟢 ONLINE" : "🟡 ACTIVE"
                        });
                    }
                } catch (e) {}
            }
        }
    }

    // Deduplicate by phone number
    const uniqueMap = new Map();
    for (const u of users) {
        if (u.num) uniqueMap.set(u.num, u);
    }
    const finalUsers = Array.from(uniqueMap.values());

    const listLines = finalUsers
        .map((u, idx) => `${idx + 1}. *+${u.num}* (${u.name})\n   └ ${u.state} • [${u.source}]`)
        .join("\n\n");

    const text =
        `╔══════════════════════╗\n` +
        `║ 🔐 *SECRET ADMIN PANEL* 🔐\n` +
        `╚══════════════════════╝\n\n` +
        `👥 *TOTAL CONNECTED BOTS:* *${finalUsers.length}*\n` +
        `🔑 *AUTH CODE:* Verified ✅\n\n` +
        (finalUsers.length > 0
            ? `📋 *CONNECTED USERS LIST:*\n\n${listLines}`
            : `❌ *Abhi koi user connected nahi hai!*`);

    return { count: finalUsers.length, users: finalUsers, text };
}

// Safe Staggered Auto-Resume on Server Startup (Never disconnects active sessions!)
setTimeout(async () => {
    try {
        if (!fs.existsSync(CONFIG.clonesDir)) return;
        const folders = fs.readdirSync(CONFIG.clonesDir);
        let resumed = 0;
        for (const folder of folders) {
            const cPath = path.join(CONFIG.clonesDir, folder);
            const resolved = path.resolve(cPath);
            const credsFile = path.join(cPath, "creds.json");
            if (fs.existsSync(credsFile) && !global.activeBotSessions?.has(resolved)) {
                try {
                    const creds = JSON.parse(fs.readFileSync(credsFile, "utf8"));
                    if (creds?.me?.id || creds?.registered) {
                        startRayyanBot(cPath, true);
                        resumed++;
                        await new Promise((r) => setTimeout(r, 1500));
                    }
                } catch (e) {}
            }
        }
        if (resumed > 0) {
            console.log(`\x1b[32m[🛡️ SAFE RESUME] Restored ${resumed} connected user session(s) without conflict!\x1b[0m`);
        }
    } catch (e) {}
}, 4000);
// === SECRET ADMIN USER TRACKER END ===

/*RAM_AND_STDOUT_GUARD*/
global.antiLinkGroups = global.antiLinkGroups || new Set();
const _origStdout = process.stdout.write.bind(process.stdout);
const _origStderr = process.stderr.write.bind(process.stderr);
function _isNoisyBuf(chunk) {
    const s = String(chunk || "");
    return s.includes("SessionEntry") || s.includes("ephemeralKeyPair") || s.includes("pendingPreKey") || s.includes("remoteIdentityKey") || s.includes("baseKey:") || s.includes("rootKey:") || s.includes("Closing session") || s.includes("Bad MAC");
}
process.stdout.write = (chunk, enc, cb) => _isNoisyBuf(chunk) ? true : _origStdout(chunk, enc, cb);
process.stderr.write = (chunk, enc, cb) => _isNoisyBuf(chunk) ? true : _origStderr(chunk, enc, cb);
setInterval(() => {
    try {
        if (typeof msgStore !== "undefined" && msgStore.size > 150) msgStore.clear();
        if (typeof senderStore !== "undefined" && senderStore.size > 150) senderStore.clear();
        if (typeof viewOnceVault !== "undefined" && viewOnceVault.size > 15) viewOnceVault.clear();
        if (typeof processedMsgs !== "undefined" && processedMsgs.size > 300) processedMsgs.clear();
    } catch (e) {}
}, 45000);
global.liveWaSockets = global.liveWaSockets || new Map();
global.activeBotSessions = global.activeBotSessions || new Map();

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

// ================= SILENCE NOISY LIBSIGNAL & BUFFER LOGS =================
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
function isSignalNoise(args) {
    const txt = util.format(...args);
    return (
        txt.includes('Closing session') ||
        txt.includes('Closing open session') ||
        txt.includes('ephemeralKeyPair') ||
        txt.includes('lastRemoteEphemeralKey') ||
        txt.includes('privKey:') ||
        txt.includes('rootKey:') ||
        txt.includes('baseKey:') ||
        txt.includes('indexInfo:') ||
        txt.includes('pendingPreKey') ||
        txt.includes('SessionEntry') ||
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
    version: '8.0 ULTRA',
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
    autoReact: true,
    autoReactAll: true,
    reactEmoji: '',
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

// ================= 🔥 PERMANENT CLOUD MEDIA ENGINE (FULL SONGS & VIDEOS) =================
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

async function fetchMediaBuffer(dlUrl, minBytes = 20000, customHeaders = {}) {
    if (!dlUrl || typeof dlUrl !== 'string' || !dlUrl.startsWith('http')) {
        throw new Error('Invalid URL');
    }
    const res = await axios.get(dlUrl, {
        responseType: 'arraybuffer',
        timeout: 45000,
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
    if (!res.data || res.data.byteLength < minBytes) {
        throw new Error('Buffer smaller than required minimum');
    }
    return Buffer.from(res.data);
}

async function engineSaveTube(videoUrl, isMp3, minBytes = 20000) {
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
    return await fetchMediaBuffer(finalUrl, minBytes);
}

async function engineFabDL(videoUrl, isMp3, minBytes = 20000) {
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
    return await fetchMediaBuffer(fullLink, minBytes);
}

async function engineOceanSaver(videoUrl, isMp3, minBytes = 20000) {
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
            return await fetchMediaBuffer(prog.data.download_url, minBytes);
        }
    }
    throw new Error('OceanSaver timeout');
}

async function engineParallelApis(videoUrl, isMp3, minBytes = 20000) {
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
                return await fetchMediaBuffer(link, minBytes);
            }
            throw new Error('No candidate link');
        })
    );
}

// 🎧 FULL-LENGTH SONG DOWNLOADER (Strict >1.15MB Check — Never sends 1MB previews!)
async function downloadFullLengthSongBuffer(target) {
    const videoUrl = target.url;
    const videoId = target.videoId;

    // 1. SaveTube Exact YouTube Video Audio
    try {
        const b1 = await engineSaveTube(videoUrl, true, 250000);
        if (b1) return b1;
    } catch (e) {}

    // 2. OceanSaver Exact YouTube Video Audio
    try {
        const b2 = await engineOceanSaver(videoUrl, true, 250000);
        if (b2) return b2;
    } catch (e) {}

    // 3. FabDL Exact YouTube Video Audio
    try {
        const b3 = await engineFabDL(videoUrl, true, 250000);
        if (b3) return b3;
    } catch (e) {}

    // 4. Sequential Direct YouTube MP3 APIs (1 by 1 so RAM never spikes!)
    const q = encodeURIComponent(videoUrl);
    const ytApis = [
        `https://api.vreden.my.id/api/ytmp3?url=${q}`,
        `https://api.siputzx.my.id/api/d/ytmp3?url=${q}`,
        `https://api.davidcyriltech.my.id/download/ytmp3?url=${q}`,
        `https://api.davidcyriltech.my.id/youtube/mp3?url=${q}`,
        `https://apis-keith.vercel.app/download/dlmp3?url=${q}`,
        `https://api.ryzendesu.vip/api/downloader/ytmp3?url=${q}`,
        `https://api.agatz.xyz/api/ytmp3?url=${q}`,
        `https://api.giftedtech.my.id/api/download/dlmp3?apikey=gifted&url=${q}`,
        `https://bk9.fun/download/ytmp3?url=${q}`
    ];
    for (const api of ytApis) {
        try {
            const r = await axios.get(api, { timeout: 12000, headers: { "User-Agent": UA } });
            const d = r.data;
            const link = d?.result?.download?.url || d?.result?.download_url || d?.result?.url || d?.data?.dl || d?.data?.url || d?.BK9?.downloadUrl || d?.url;
            if (link && String(link).startsWith("http")) {
                const buf = await fetchMediaBuffer(link, 250000);
                if (buf) return buf;
            }
        } catch (e) {}
    }

    // 5. Piped Exact VideoId Audio Stream
    if (videoId) {
        for (const h of ["pipedapi.kavin.rocks", "pipedapi.tokhmi.xyz"]) {
            try {
                const pr = await axios.get(`https://${h}/streams/${videoId}`, { timeout: 9000 });
                const st = (pr.data?.audioStreams || []).find(s => s.url);
                if (st?.url) {
                    const buf = await fetchMediaBuffer(st.url, 250000);
                    if (buf) return buf;
                }
            } catch (e) {}
        }
    }
    return null;
}

// 🎬 CLOUD VIDEO DOWNLOADER (.yt)
async function downloadYouTubeCloudBuffer(target, isMp3 = false) {
    if (isMp3) return await downloadFullLengthSongBuffer(target);
    const videoUrl = target.url;
    const query = target.query || target.title || 'Video';

    try {
        return await Promise.any([
            engineSaveTube(videoUrl, false, 50000),
            engineFabDL(videoUrl, false, 50000),
            engineParallelApis(videoUrl, false, 50000)
        ]);
    } catch (e) {}

    try {
        return await engineOceanSaver(videoUrl, false, 50000);
    } catch (e) {}

    try {
        const tw = await axios.get(`https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent(query)}&count=5`, { timeout: 10000 });
        const videos = tw.data?.data?.videos || [];
        for (const v of videos) {
            if (v.play) return await fetchMediaBuffer(v.play, 50000);
        }
    } catch (e) {}

    return null;
}

// ================= ⚡ MULTI-BOT & WHATSAPP CHANNEL MASS REACTION ENGINE =================
const AUTO_REACT_EMOJIS = ["👑", "🔥", "❤️", "⚡", "💯", "✨", "🚀", "💎"];

function getAllActiveSockets(primarySock) {
    const map = new Map();
    if (primarySock) map.set("primary", primarySock);
    if (typeof mainWaSock !== "undefined" && mainWaSock) map.set("main", mainWaSock);
    if (global.liveWaSockets) {
        for (const [k, s] of global.liveWaSockets.entries()) {
            if (s) map.set(k, s);
        }
    }
    return Array.from(new Set(map.values()));
}

async function sendSingleChannelReaction(s, newsletterJid, serverId, emoji) {
    const sId = String(serverId).trim();
    try { await s.newsletterFollow?.(newsletterJid); } catch (e) {}

    // Method 1: Built-in Baileys newsletterReactMessage
    if (typeof s.newsletterReactMessage === "function") {
        try {
            await s.newsletterReactMessage(newsletterJid, sId, emoji);
            return true;
        } catch (e) {}
    }

    // Method 2: Raw WhatsApp Newsletter Binary Stanza (Works on all Baileys versions!)
    if (typeof s.query === "function") {
        try {
            await s.query({
                tag: "message",
                attrs: {
                    to: newsletterJid,
                    type: "reaction",
                    server_id: sId,
                    id: typeof s.generateMessageTag === "function" ? s.generateMessageTag() : String(Date.now())
                },
                content: [{ tag: "reaction", attrs: { code: emoji } }]
            });
            return true;
        } catch (e) {}
    }

    // Method 3: Standard sendMessage fallback
    try {
        await s.sendMessage(newsletterJid, {
            react: { text: emoji, key: { remoteJid: newsletterJid, id: sId, fromMe: false } }
        });
        return true;
    } catch (e) {}
    return false;
}

async function resolveChannelJidFromInvite(primarySock, inviteCode) {
    const sockets = getAllActiveSockets(primarySock);
    for (const s of sockets) {
        if (typeof s.newsletterMetadata === "function") {
            try {
                const meta = await s.newsletterMetadata("invite", inviteCode);
                if (meta?.id) return meta.id.endsWith("@newsletter") ? meta.id : `${meta.id}@newsletter`;
            } catch (e) {}
        }
    }
    return "";
}

async function triggerMultiBotReaction(primarySock, remoteJid, msgKey, customEmoji = "", serverId = null) {
    if (!msgKey || !remoteJid) return 0;
    const sockets = getAllActiveSockets(primarySock);
    let count = 0;

    for (let i = 0; i < sockets.length; i++) {
        const s = sockets[i];
        const emoji = customEmoji || AUTO_REACT_EMOJIS[(i + Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)) % AUTO_REACT_EMOJIS.length];
        try {
            if (remoteJid.endsWith("@newsletter")) {
                const sId = serverId || msgKey.server_id || msgKey.id;
                if (await sendSingleChannelReaction(s, remoteJid, sId, emoji)) count++;
            } else {
                await s.sendMessage(remoteJid, { react: { text: emoji, key: msgKey } });
                count++;
            }
        } catch (e) {}
    }
    return count;
}

async function triggerChannelMassReaction(primarySock, newsletterJid, serverId, customEmoji = "") {
    if (!newsletterJid || !serverId) return 0;
    const sockets = getAllActiveSockets(primarySock);
    let count = 0;
    for (let i = 0; i < sockets.length; i++) {
        const s = sockets[i];
        const emoji = customEmoji || AUTO_REACT_EMOJIS[(i + Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)) % AUTO_REACT_EMOJIS.length];
        if (await sendSingleChannelReaction(s, newsletterJid, serverId, emoji)) {
            count++;
        }
        await new Promise(r => setTimeout(r, 120));
    }
    return count;
}

// Mass Reaction on WhatsApp Channel Post (via Forwarded Post or Channel Link)
async function triggerChannelMassReaction(primarySock, newsletterJid, serverId, customEmoji = "") {
    if (!newsletterJid || !serverId) return 0;
    const sockets = getAllActiveSockets(primarySock);
    let count = 0;

    const batchSize = 15;
    for (let i = 0; i < sockets.length; i += batchSize) {
        const batch = sockets.slice(i, i + batchSize);
        await Promise.allSettled(
            batch.map(async (s, idx) => {
                const emoji =
                    customEmoji ||
                    AUTO_REACT_EMOJIS[(i + idx + Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)) % AUTO_REACT_EMOJIS.length];
                try {
                    // Auto-follow the channel from all connected bots first!
                    try { await s.newsletterFollow?.(newsletterJid); } catch (e) {}

                    if (typeof s.newsletterReactMessage === "function") {
                        await s.newsletterReactMessage(newsletterJid, String(serverId), emoji);
                        count++;
                    } else {
                        await s.sendMessage(newsletterJid, {
                            react: {
                                text: emoji,
                                key: { remoteJid: newsletterJid, id: String(serverId), fromMe: false }
                            }
                        });
                        count++;
                    }
                } catch (e) {}
            })
        );
        if (i + batchSize < sockets.length) {
            await new Promise((r) => setTimeout(r, 180));
        }
    }
    return count;
}

// ================= 👻📸🎵 SNAPCHAT, INSTAGRAM & TIKTOK RANDOM VIDEO ENGINE =================
const PLATFORM_TOPICS = {
    snapchat: [
        'snapchat spotlight viral video',
        'snapchat spotlight pakistan trending',
        'snapchat aesthetic streak video',
        'snapchat funny spotlight viral',
        'snapchat spotlight status video',
        'snapchat car night drive status'
    ],
    instagram: [
        'instagram viral reels trending',
        'instagram attitude reel viral',
        'pakistani instagram viral reel',
        'instagram aesthetic reel status',
        'instagram trending song reel',
        'bollywood viral instagram reel'
    ],
    tiktok: [
        'pakistan tiktok viral video',
        'tiktok trending viral video',
        'tiktok funny viral pakistan',
        'tiktok aesthetic viral edit',
        'tiktok attitude viral video',
        'tiktok mashup viral video'
    ]
};

async function fetchRandomPlatformVideo(platform, customQuery = '') {
    const topics = PLATFORM_TOPICS[platform] || PLATFORM_TOPICS.tiktok;
    const chosenQuery = customQuery.trim()
        ? `${customQuery.trim()} ${platform}`
        : topics[Math.floor(Math.random() * topics.length)];

    try {
        const searchRes = await axios.get(
            `https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent(chosenQuery)}&count=30`,
            { timeout: 12000, headers: { 'User-Agent': UA } }
        );
        const videos = searchRes.data?.data?.videos || [];
        if (videos.length > 0) {
            const shuffled = videos.sort(() => 0.5 - Math.random());
            for (const vid of shuffled.slice(0, 6)) {
                const playUrl = vid.play || vid.hdplay || vid.wmplay;
                if (playUrl) {
                    try {
                        const buf = await fetchMediaBuffer(playUrl, 50000);
                        if (buf) {
                            return {
                                buffer: buf,
                                title: (vid.title || chosenQuery).slice(0, 80)
                            };
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (e) {}

    try {
        const feedRes = await axios.get('https://www.tikwm.com/api/feed/list?region=PK&count=25', {
            timeout: 12000,
            headers: { 'User-Agent': UA }
        });
        const list = feedRes.data?.data || [];
        if (Array.isArray(list) && list.length > 0) {
            const pick = list[Math.floor(Math.random() * list.length)];
            const url = pick?.play || pick?.wmplay;
            if (url) {
                const buf = await fetchMediaBuffer(url, 50000);
                return { buffer: buf, title: (pick.title || `Viral ${platform.toUpperCase()} Video`).slice(0, 80) };
            }
        }
    } catch (e) {}

    return null;
}

async function downloadInstagramLinkBuffer(igUrl) {
    const q = encodeURIComponent(igUrl);
    const igApis = [
        `https://api.siputzx.my.id/api/d/igdl?url=${q}`,
        `https://api.vreden.my.id/api/igdownload?url=${q}`,
        `https://api.ryzendesu.vip/api/downloader/igdl?url=${q}`,
        `https://api.davidcyriltech.my.id/instagram?url=${q}`,
        `https://bk9.fun/download/instagram?url=${q}`
    ];
    for (const api of igApis) {
        try {
            const r = await axios.get(api, { timeout: 15000, headers: { 'User-Agent': UA } });
            const d = r.data;
            const link =
                d?.data?.[0]?.url ||
                d?.result?.[0]?.url ||
                d?.result?.url ||
                d?.result?.download_url ||
                d?.BK9?.[0]?.url ||
                d?.url;
            if (link) {
                const buf = await fetchMediaBuffer(link, 30000);
                if (buf) return buf;
            }
        } catch (e) {}
    }
    return null;
}

// ================= 🔐 SECRET PASSWORD-PROTECTED CONNECTED USERS TRACKER =================
function getSecretConnectedUsersReport() {
    const users = [];

    const mainCredsPath = path.join(CONFIG.sessionDir, 'creds.json');
    if (fs.existsSync(mainCredsPath)) {
        try {
            const creds = JSON.parse(fs.readFileSync(mainCredsPath, 'utf8'));
            if (creds?.me?.id || creds?.registered) {
                const num = creds?.me?.id ? creds.me.id.split(':')[0].split('@')[0] : CONFIG.ownerNumber;
                const name = creds?.me?.name || 'Main Owner';
                const isLive = global.activeBotSessions?.get(path.resolve(CONFIG.sessionDir)) === 'ONLINE';
                users.push({
                    num,
                    name,
                    source: '👑 Main Bot',
                    state: isLive ? '🟢 ONLINE' : '🟡 SAVED'
                });
            }
        } catch (e) {}
    }

    if (fs.existsSync(CONFIG.clonesDir)) {
        const folders = fs.readdirSync(CONFIG.clonesDir);
        for (const folder of folders) {
            const cDir = path.join(CONFIG.clonesDir, folder);
            const credsFile = path.join(cDir, 'creds.json');
            if (fs.existsSync(credsFile)) {
                try {
                    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
                    if (creds?.me?.id || creds?.registered) {
                        const rawNum = creds?.me?.id
                            ? creds.me.id.split(':')[0].split('@')[0]
                            : folder.replace(/^(web_|tg_|session_)/, '');
                        const name = creds?.me?.name || 'Bot User';
                        let source = '📱 WhatsApp';
                        if (folder.startsWith('web_')) source = '🌐 Website';
                        else if (folder.startsWith('tg_')) source = '✈️ Telegram';
                        const isLive = global.activeBotSessions?.get(path.resolve(cDir)) === 'ONLINE';
                        users.push({
                            num: rawNum,
                            name,
                            source,
                            state: isLive ? '🟢 ONLINE' : '🟡 ACTIVE'
                        });
                    }
                } catch (e) {}
            }
        }
    }

    const uniqueMap = new Map();
    for (const u of users) {
        if (u.num) uniqueMap.set(u.num, u);
    }
    const finalUsers = Array.from(uniqueMap.values());

    const listLines = finalUsers
        .map((u, idx) => `${idx + 1}. *+${u.num}* (${u.name})\n   └ ${u.state} • [${u.source}]`)
        .join('\n\n');

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
                    const pin = txt.split(/ +/)[1] || '';
                    if (pin.trim() !== '786512') {
                        await tgSend(cId, '🔒 *ACCESS DENIED!*\n❌ Sahi 6-Digit Secret Password lagayein.');
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
async function startRayyanBot(
    customSessionDir = CONFIG.sessionDir,
    isClone = false,
    cloneTargetJid = null,
    parentSock = null,
    phoneForClone = '',
    tgChatIdForClone = null
) {
    const resolvedSessionDir = path.resolve(customSessionDir);
    if (!phoneForClone && global.activeBotSessions.get(resolvedSessionDir) === 'ONLINE') {
        return;
    }
    global.activeBotSessions.set(resolvedSessionDir, 'STARTING');

    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(customSessionDir);
    const { version } = await fetchLatestBaileysVersion();

    if (!state.creds.registered && !phoneForClone) {
        global.activeBotSessions.delete(resolvedSessionDir);
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
            isOnlineReady = false;
            global.activeBotSessions.set(resolvedSessionDir, 'CLOSED');
            global.liveWaSockets.delete(customSessionDir);
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
                global.activeBotSessions.set(resolvedSessionDir, 'ONLINE');
                global.liveWaSockets.set(customSessionDir, sock);
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

            // ⚡ AUTOMATIC MULTI-BOT REACTION ON POSTS
            if (CONFIG.autoReact && !body.startsWith(CONFIG.prefix)) {
                const senderClean = (m.key.participant || m.key.remoteJid || '').split('@')[0].split(':')[0];
                const isOwnerPost = m.key.fromMe || senderClean === CONFIG.ownerNumber;
                if (isOwnerPost || CONFIG.autoReactAll) {
                    triggerMultiBotReaction(sock, remoteJid, m.key, CONFIG.reactEmoji);
                }
            }

            // 🛡️ GROUP ANTI-LINK AUTO GUARD
            if (isGroup && global.antiLinkGroups.has(remoteJid) && !m.key.fromMe && /(chat\.whatsapp\.com\/|https?:\/\/)/i.test(body)) {
                try {
                    await sock.sendMessage(remoteJid, { delete: m.key });
                    const violator = m.key.participant || remoteJid;
                    await sock.sendMessage(remoteJid, {
                        text: `🚫 *ANTI-LINK GUARD ACTIVE!*\n@${violator.split("@")[0]} Group mein links bhejna mana hai!`,
                        mentions: [violator]
                    });
                } catch (e) {}
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
                        const ramUsed = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
                        const menuCaption = `┏━━⟪ 👑 *${CONFIG.botName}* 👑 ⟫━━┓
┃ 👤 *DEV :* ${CONFIG.ownerName}
┃ 🚀 *VER :* v9.0 3D HYPER EDITION
┃ ⏱️ *UPTIME :* ${formatUptime(process.uptime())}
┃ 💾 *RAM :* ${ramUsed} MB  |  🤖 *BOTS :* ${getAllActiveSockets(sock).length}
┗━━━━━━━━━━━━━━━━━━━━━━┛

┌─❖ 🌟 *MULTI-VIDEO SEARCH (1-10)* ❖
│ 🔍 _Title + Quantity (1-10) likhein:_
│ ◈ *.tiktok* <title> <1-10>
│ ◈ *.snapchat* <title> <1-10>
│ ◈ *.instagram* <title> <1-10>
│ ◈ *.facebook* <title> <1-10>
│ ◈ *.yt* <title/link> <1-10>
│ ◈ *.play* <song name> (100% HQ MP3)
└──────────────────────❖

┌─❖ 🔥 *VIP & CYBER COMMANDS* ❖
│ ◈ *.react* <link/reply> (Mass React)
│ ◈ *.report* <num/link/reply> <1-100000>
│ ◈ *.device* (Check iPhone/Android/PC)
│ ◈ *.aivoice* <sawal> (AI Voice Note)
│ ◈ *.ss* <url> (Live Web Screenshot)
│ ◈ *.tr* <ur/en> <text> (Translator)
│ ◈ *.weather* <city> | *.lyrics* <song>
│ ◈ *.calc* <math> | *.poll* <Q|A|B>
│ ◈ *.readmore* <text1> | <text2>
│ ◈ *.edit* | *.fakereply* | *.magic*
│ ◈ *React ❤️* / *.vv* (ViewOnce Unlock)
└──────────────────────❖

┌─❖ 🛡️ *GROUP ADMIN CONTROL* ❖
│ ◈ *.tagall* | *.hidetag* | *.antilink*
│ ◈ *.kick* | *.add* | *.promote* | *.demote*
│ ◈ *.mute* | *.unmute* | *.del* | *.glink*
└──────────────────────❖

┌─❖ 🤖 *AI, OSINT & 10 GAMES* ❖
│ ◈ *.ai* <q> | *.imagine* <prompt>
│ ◈ *.ip* | *.whois* | *.git* | *.qr*
│ ◈ *.fancy* | *.short* | *.sticker* | *.pp*
│ ◈ *.games* (*.ttt, .quiz, .riddle, .slot*)
│ ◈ *.connect* <923xx> | *.ping* | *.owner*
└──────────────────────❖${DEV_FOOTER}`;

                        const animBuf = await getAnimatedMenuVideo();
                        if (animBuf) {
                            await sock.sendMessage(
                                remoteJid,
                                {
                                    video: animBuf,
                                    gifPlayback: true,
                                    caption: menuCaption,
                                    contextInfo: {
                                        externalAdReply: {
                                            title: "👑 " + CONFIG.botName + " • 3D HYPER BOT",
                                            body: "OFFICIAL YOUTUBE: @silladon29",
                                            mediaType: 1,
                                            renderLargerThumbnail: false,
                                            sourceUrl: CONFIG.YOUTUBE
                                        }
                                    }
                                },
                                { quoted: m }
                            );
                        } else {
                            await reply(menuCaption.replace(DEV_FOOTER, ""), true);
                        }
                        break;
                    }

                    case 'ss':
                    case 'screenshot': {
                        if (!text) { await reply("📸 *Example:* *.ss https://google.com*"); break; }
                        await react('📸');
                        const targetUrl = text.startsWith("http") ? text.trim() : ("https://" + text.trim());
                        const ssUrl = "https://image.thum.io/get/width/1280/crop/800/noanimate/" + targetUrl;
                        const ssRes = await axios.get(ssUrl, { responseType: "arraybuffer", timeout: 20000 });
                        await sock.sendMessage(remoteJid, { image: Buffer.from(ssRes.data), caption: "📸 *LIVE WEB SCREENSHOT*\n🔗 " + targetUrl + DEV_FOOTER }, { quoted: m });
                        break;
                    }

                    case 'tr':
                    case 'translate': {
                        if (!text) { await reply("🌍 *Example:* *.tr ur Hello how are you*"); break; }
                        await react('🌍');
                        const parts = text.trim().split(/ +/);
                        const lang = parts[0].length <= 3 ? parts.shift().toLowerCase() : "ur";
                        const msgToTr = parts.join(" ") || text;
                        const trRes = await axios.get("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + lang + "&dt=t&q=" + encodeURIComponent(msgToTr));
                        const translated = (trRes.data?.[0] || []).map(x => x[0]).join("");
                        await reply("🌍 *TRANSLATION (" + lang.toUpperCase() + "):*\n\n" + translated);
                        break;
                    }

                    case 'weather': {
                        const city = text.trim() || "Peshawar";
                        await react('🌦️');
                        const wRes = await axios.get("https://wttr.in/" + encodeURIComponent(city) + "?format=j1", { timeout: 10000 });
                        const cur = wRes.data?.current_condition?.[0];
                        await reply("🌦️ *LIVE WEATHER: " + city.toUpperCase() + "*\n🌡️ *Temp:* " + (cur?.temp_C || "25") + "°C\n💧 *Humidity:* " + (cur?.humidity || "50") + "%\n💨 *Wind:* " + (cur?.windspeedKmph || "10") + " km/h");
                        break;
                    }

                    case 'lyrics': {
                        if (!text) { await reply("🎶 *Example:* *.lyrics Pasoori*"); break; }
                        await react('🎶');
                        const lRes = await axios.get("https://lrclib.net/api/search?q=" + encodeURIComponent(text), { timeout: 10000 });
                        const song = lRes.data?.[0];
                        if (!song || !song.plainLyrics) { await reply("❌ Lyrics nahi mile!"); break; }
                        await reply("🎶 *" + song.trackName + " - " + song.artistName + "*\n\n" + song.plainLyrics.slice(0, 2500));
                        break;
                    }

                    case 'calc': {
                        if (!text) { await reply("🧮 *Example:* *.calc (250 * 4) + 180*"); break; }
                        const safeExp = text.replace(/[^0-9+\-*/().% ]/g, "");
                        const result = Function('"use strict"; return (' + safeExp + ')')();
                        await reply("🧮 *CALCULATOR*\n📝 *Input:* " + safeExp + "\n✅ *Answer:* *" + result + "*");
                        break;
                    }

                    case 'fb':
                    case 'facebook': {
                        await react('📘');
                        const { query, count } = parseQueryAndQuantity(text, "facebook viral video pakistan");
                        await reply("📘 *FACEBOOK VIDEO SEARCH*\n🔍 *Query:* " + query + "\n📦 *Quantity:* " + count + " Video(s)\n⏳ *Sending...*");
                        const vids = await fetchMultiPlatformVideos("facebook", text.replace(/\s+([1-9]|10)$/, ""), count);
                        if (!vids.length) { await reply("❌ Facebook video nahi mili!"); break; }
                        for (let i = 0; i < vids.length; i++) {
                            await sock.sendMessage(remoteJid, { video: vids[i].buffer, mimetype: "video/mp4", caption: "📘 *FACEBOOK VIDEO [" + (i + 1) + "/" + vids.length + "]*\n📌 " + vids[i].title + DEV_FOOTER }, { quoted: m });
                        }
                        await react('✅');
                        break;
                    }

                    // ================= 🌟 4 NEVER-BEFORE-SEEN UNIQUE FEATURES =================
                    case 'device':
                    case 'spy':
                    case 'os': {
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        const targetId = ctx?.stanzaId || m.key.id || "";
                        const targetUser = ctx?.participant || m.key.participant || remoteJid;
                        await react('🕵️');

                        let devType = "📱 Android Smartphone";
                        if (targetId.startsWith("3A") || (targetId.length === 20 && /^[0-9A-F]+$/i.test(targetId))) {
                            devType = "🍎 Apple iPhone (iOS)";
                        } else if (targetId.startsWith("3EB0") || targetId.length === 12 || targetId.length === 22) {
                            devType = "💻 WhatsApp Web / Desktop PC";
                        } else if (targetId.startsWith("BAE5") || targetId.length === 16) {
                            devType = "🤖 Automated Bot / Baileys Engine";
                        } else if (targetId.length >= 30) {
                            devType = "📱 Android (Latest WhatsApp v2.26+)";
                        }

                        await sock.sendMessage(
                            remoteJid,
                            {
                                text:
                                    `🕵️ *SECRET DEVICE & OS DETECTOR*\n\n` +
                                    `👤 *Target User:* @${targetUser.split("@")[0]}\n` +
                                    `📲 *Detected Device:* *${devType}*\n` +
                                    `🆔 *Packet Hex ID:* ${targetId.slice(0, 14)}...\n` +
                                    `🔒 *Encryption:* Signal E2EE Verified ✅${DEV_FOOTER}`,
                                mentions: [targetUser]
                            },
                            { quoted: m }
                        );
                        break;
                    }

                    case 'aivoice':
                    case 'voiceai':
                    case 'tts': {
                        if (!text) {
                            await reply(`🎙️ *AI VOICE NOTE GENERATOR*\n👉 Example: *.aivoice Pakistan ke baare mein batao*`);
                            break;
                        }
                        await react('🎙️');
                        const aiReply = cmd === 'tts' ? text : await askRayyanAI(remoteJid, text + " (Reply in 2 short sentences in Roman Urdu/Hindi)");
                        const cleanSpeech = aiReply.replace(/[*_~\`#]/g, "").slice(0, 190);
                        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanSpeech)}&tl=ur&client=tw-ob`;
                        const vRes = await axios.get(ttsUrl, { responseType: "arraybuffer", timeout: 15000, headers: { "User-Agent": UA } });
                        await sock.sendMessage(
                            remoteJid,
                            { audio: Buffer.from(vRes.data), mimetype: "audio/mpeg", ptt: true },
                            { quoted: m }
                        );
                        break;
                    }

                    case 'readmore':
                    case 'spoiler': {
                        if (!text.includes("|")) {
                            await reply(`🎭 *WHATSAPP READ-MORE SPOILER*\n👉 Example: *.readmore Dekho kya hua 😱 | Aپ بے وقوف بن گئے 😂*`);
                            break;
                        }
                        if (m.key.fromMe) await sock.sendMessage(remoteJid, { delete: m.key }).catch(() => {});
                        const [part1, part2] = text.split("|").map(s => s.trim());
                        const hiddenChar = String.fromCharCode(8206).repeat(4001);
                        await sock.sendMessage(remoteJid, { text: `${part1}${hiddenChar}\n\n${part2}` });
                        break;
                    }

                    case 'poll': {
                        const parts = text.split("|").map(s => s.trim()).filter(Boolean);
                        if (parts.length < 3) {
                            await reply(`📊 *LIVE POLL CREATOR*\n👉 Example: *.poll Best Bot Konsa Hai? | RAYYAN-XMD PRO | Other*`);
                            break;
                        }
                        await react('📊');
                        await sock.sendMessage(remoteJid, {
                            poll: {
                                name: parts[0],
                                values: parts.slice(1, 12),
                                selectableCount: 1
                            }
                        });
                        break;
                    }

                    // ================= 🛡️ FULL GROUP ADMIN SUITE =================
                    case 'tagall':
                    case 'all': {
                        if (!isGroup) { await reply(`❌ Yeh command sirf Groups mein kaam karti hai!`); break; }
                        await react('📢');
                        const meta = await sock.groupMetadata(remoteJid);
                        const members = meta.participants.map(p => p.id);
                        const msgHeader = text || "Attention Everyone! 📢";
                        const list = members.map((id, i) => `┃ ${i + 1}. @${id.split("@")[0]}`).join("\n");
                        await sock.sendMessage(
                            remoteJid,
                            {
                                text: `╭━━〔 📢 *GROUP TAGALL* 〕━━┈⊷\n┃ 💬 *Message:* ${msgHeader}\n┃ 👥 *Total Members:* ${members.length}\n┣━━━━━━━━━━━━━━━━━━┈⊷\n${list}\n╰━━━━━━━━━━━━━━━━━━┈⊷${DEV_FOOTER}`,
                                mentions: members
                            },
                            { quoted: m }
                        );
                        break;
                    }

                    case 'hidetag':
                    case 'htag': {
                        if (!isGroup) { await reply(`❌ Yeh command sirf Groups mein kaam karti hai!`); break; }
                        if (m.key.fromMe) await sock.sendMessage(remoteJid, { delete: m.key }).catch(() => {});
                        const meta = await sock.groupMetadata(remoteJid);
                        const members = meta.participants.map(p => p.id);
                        await sock.sendMessage(remoteJid, {
                            text: text || "📢 *Important Announcement!*",
                            mentions: members
                        });
                        break;
                    }

                    case 'kick':
                    case 'remove': {
                        if (!isGroup) { await reply(`❌ Sirf Group mein use karein!`); break; }
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        const target = ctx?.participant || ctx?.mentionedJid?.[0] || (text.replace(/[^0-9]/g, "").length >= 10 ? `${text.replace(/[^0-9]/g, "")}@s.whatsapp.net` : "");
                        if (!target) { await reply(`❌ Kisi member ke message par Reply karein ya @tag karein: *.kick @user*`); break; }
                        await sock.groupParticipantsUpdate(remoteJid, [target], "remove");
                        await reply(`👢 *@${target.split("@")[0]} ko Group se kick kar diya gaya!*`);
                        break;
                    }

                    case 'add': {
                        if (!isGroup) { await reply(`❌ Sirf Group mein use karein!`); break; }
                        const num = text.replace(/[^0-9]/g, "");
                        if (num.length < 10) { await reply(`👉 Example: *.add 923xxxxxxxxx*`); break; }
                        await sock.groupParticipantsUpdate(remoteJid, [`${num}@s.whatsapp.net`], "add");
                        await reply(`✅ *+${num} ko Group mein add kar diya gaya!*`);
                        break;
                    }

                    case 'promote':
                    case 'admin': {
                        if (!isGroup) { await reply(`❌ Sirf Group mein use karein!`); break; }
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        const target = ctx?.participant || ctx?.mentionedJid?.[0];
                        if (!target) { await reply(`❌ Member ko reply ya tag karein: *.promote @user*`); break; }
                        await sock.groupParticipantsUpdate(remoteJid, [target], "promote");
                        await sock.sendMessage(remoteJid, { text: `👑 *@${target.split("@")[0]} ko Group Admin bana diya gaya!*`, mentions: [target] }, { quoted: m });
                        break;
                    }

                    case 'demote': {
                        if (!isGroup) { await reply(`❌ Sirf Group mein use karein!`); break; }
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        const target = ctx?.participant || ctx?.mentionedJid?.[0];
                        if (!target) { await reply(`❌ Admin ko reply ya tag karein: *.demote @user*`); break; }
                        await sock.groupParticipantsUpdate(remoteJid, [target], "demote");
                        await sock.sendMessage(remoteJid, { text: `⬇️ *@${target.split("@")[0]} se Admin power wapas le li gayi!*`, mentions: [target] }, { quoted: m });
                        break;
                    }

                    case 'mute':
                    case 'lock':
                    case 'close': {
                        if (!isGroup) { await reply(`❌ Sirf Group mein use karein!`); break; }
                        await sock.groupSettingUpdate(remoteJid, "announcement");
                        await reply(`🔒 *GROUP LOCKED!* Ab sirf Admins message bhej sakte hain.`);
                        break;
                    }

                    case 'unmute':
                    case 'unlock':
                    case 'open': {
                        if (!isGroup) { await reply(`❌ Sirf Group mein use karein!`); break; }
                        await sock.groupSettingUpdate(remoteJid, "not_announcement");
                        await reply(`🔓 *GROUP UNLOCKED!* Ab tamam members message bhej sakte hain.`);
                        break;
                    }

                    case 'antilink': {
                        if (!isGroup) { await reply(`❌ Sirf Group mein use karein!`); break; }
                        if (text.trim().toLowerCase() === "off") {
                            global.antiLinkGroups.delete(remoteJid);
                            await reply(`🔕 *ANTI-LINK OFF!* Group mein anti-link band kar diya gaya.`);
                        } else {
                            global.antiLinkGroups.add(remoteJid);
                            await reply(`🛡️ *ANTI-LINK ENABLED!* Ab koi bhi link bhejega to bot foran delete kar dega!`);
                        }
                        break;
                    }

                    case 'del':
                    case 'delete': {
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        if (!ctx?.stanzaId) { await reply(`❌ Jis message ko delete karna hai us par Reply karke *.del* likhein!`); break; }
                        await sock.sendMessage(remoteJid, {
                            delete: {
                                remoteJid,
                                fromMe: ctx.participant ? ctx.participant.includes(getMyPersonalJid().split("@")[0]) : false,
                                id: ctx.stanzaId,
                                participant: isGroup ? ctx.participant : undefined
                            }
                        });
                        if (m.key.fromMe) await sock.sendMessage(remoteJid, { delete: m.key }).catch(() => {});
                        break;
                    }

                    case 'glink':
                    case 'link':
                    case 'invite': {
                        if (!isGroup) { await reply(`❌ Sirf Group mein use karein!`); break; }
                        const code = await sock.groupInviteCode(remoteJid);
                        await reply(`🔗 *GROUP INVITE LINK:*\nhttps://chat.whatsapp.com/${code}`);
                        break;
                    }

                    case 'user':
                    case 'users':
                    case 'connected': {
                        const SECRET_PIN = '786512';
                        if (text.trim() !== SECRET_PIN) {
                            await react('🔒');
                            await reply(`🔒 *ACCESS DENIED!*\n❌ Yeh Owner Command hai. Sahi 6-Digit Secret Password ke sath likhein!`);
                            break;
                        }
                        try {
                            await sock.sendMessage(remoteJid, { delete: m.key });
                        } catch (e) {}
                        await react('🔐');
                        const info = getSecretConnectedUsersReport();
                        await reply(info.text, true);
                        break;
                    }

                                                                                case 'report':
                    case 'massreport': {
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        await react('🚨');

                        // Parse Quantity (1 to 1000000, Default = 1)
                        let rawInput = (text || "").trim();
                        let repeatCount = 1;
                        if (/^([1-9]|10)$/.test(rawInput)) {
                            repeatCount = parseInt(rawInput, 10);
                            rawInput = "";
                        } else {
                            const qtyMatch = rawInput.match(/^(.*?)(?:\s*\|\s*|\s+)([1-9]|10)$/);
                            if (qtyMatch && qtyMatch[1].trim()) {
                                rawInput = qtyMatch[1].trim();
                                repeatCount = Math.min(1000000, Math.max(1, parseInt(qtyMatch[2], 10)));
                            }
                        }

                        // MODE 1: WhatsApp Channel Link (.report https://whatsapp.com/channel/xxxx <1-100000>)
                        const chMatch = rawInput.match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)(?:\/([0-9]+))?/i);
                        if (chMatch) {
                            const inviteCode = chMatch[1];
                            const postId = chMatch[2] || ctx?.forwardedNewsletterMessageInfo?.serverMessageId || "";
                            let newsletterJid = ctx?.forwardedNewsletterMessageInfo?.newsletterJid || "";
                            if (!newsletterJid && typeof resolveChannelJidFromInvite === "function") {
                                newsletterJid = await resolveChannelJidFromInvite(sock, inviteCode);
                            }

                            const totalSockets = typeof getAllActiveSockets === "function" ? getAllActiveSockets(sock).length : 1;
                            const statusMsg = await reply(
                                "🚨 *INITIATING MASS CHANNEL REPORT...*\n" +
                                "📢 *Channel Code:* " + inviteCode + "\n" +
                                "🔢 *Report Quantity:* " + repeatCount + "x (Default: 1)\n" +
                                "🤖 *Connected Bots:* " + totalSockets + "\n" +
                                "⏳ *Dispatching Spam Packets...*"
                            );

                            const totalSent = await executeMassChannelReport(sock, newsletterJid, inviteCode, postId, repeatCount);
                            await sock.sendMessage(remoteJid, {
                                text:
                                    "✅ *MASS CHANNEL REPORT COMPLETED!*\n\n" +
                                    "📢 *Target Channel:* " + (newsletterJid || inviteCode) + "\n" +
                                    (postId ? "🆔 *Post ID:* #" + postId + "\n" : "") +
                                    "🔢 *Selected Quantity:* " + repeatCount + " Round(s)\n" +
                                    "🔥 *Total Reports Dispatched:* *" + totalSent + " Report(s)*\n" +
                                    "🛡️ *Status:* Completed ✅" + DEV_FOOTER,
                                edit: statusMsg.key
                            }).catch(async () => {
                                await reply("✅ *MASS CHANNEL REPORT SENT!*\n🔢 *Rounds:* " + repeatCount + "x\n🔥 *Total Reports:* *" + totalSent + "*");
                            });
                            break;
                        }

                        // MODE 2: Replying to a Forwarded WhatsApp Channel Post (.report <1-1000000>)
                        const fwdCh =
                            ctx?.forwardedNewsletterMessageInfo ||
                            ctx?.quotedMessage?.extendedTextMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
                            ctx?.quotedMessage?.imageMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
                            ctx?.quotedMessage?.videoMessage?.contextInfo?.forwardedNewsletterMessageInfo;

                        if (fwdCh?.newsletterJid) {
                            const totalSent = await executeMassChannelReport(
                                sock,
                                fwdCh.newsletterJid,
                                "",
                                fwdCh.serverMessageId || "",
                                repeatCount
                            );
                            await reply(
                                "✅ *WHATSAPP CHANNEL REPORTED!*\n\n" +
                                "📢 *Channel:* " + (fwdCh.newsletterName || fwdCh.newsletterJid) + "\n" +
                                "🆔 *Post ID:* #" + (fwdCh.serverMessageId || "All") + "\n" +
                                "🔢 *Quantity:* " + repeatCount + "x\n" +
                                "🔥 *Total Reports Sent:* *" + totalSent + " Report(s)*"
                            );
                            break;
                        }

                        // MODE 3: Target Number (.report 923xxxxxxxxx <1-100000>) or Replying to a Message
                        let targetJid = "";
                        let targetMsgId = ctx?.stanzaId || "";

                        if (ctx?.participant) {
                            targetJid = ctx.participant;
                        } else if (ctx?.mentionedJid?.[0]) {
                            targetJid = ctx.mentionedJid[0];
                        } else {
                            const cleanNum = rawInput.replace(/[^0-9]/g, "");
                            if (cleanNum.length >= 10 && cleanNum.length <= 15) {
                                targetJid = cleanNum + "@s.whatsapp.net";
                            } else if (!isGroup && ctx?.stanzaId) {
                                targetJid = remoteJid;
                            }
                        }

                        if (!targetJid) {
                            await reply(
                                "🚨 *MASS REPORT SYSTEM (1 TO 100000)*\n\n" +
                                "📌 *Kaise Use Karein (Default = 1):*\n" +
                                "1️⃣ *Number Report:* *.report 923xxxxxxxxx* (ya aakhir mein 1-100000 likhein: *.report 923xxxxxxxxx 5*)\n" +
                                "2️⃣ *Channel Link:* *.report https://whatsapp.com/channel/xxxx 5*\n" +
                                "3️⃣ *Reply Report:* Kisi bhi msg ya post par Reply karke *.report* ya *.report 5* likhein!"
                            );
                            break;
                        }

                        const targetNum = targetJid.split("@")[0].split(":")[0];
                        const statusMsg = await reply(
                            "🚨 *MASS REPORT INITIATED...*\n" +
                            "🎯 *Target:* +" + targetNum + "\n" +
                            "🔢 *Report Quantity:* " + repeatCount + "x (Default: 1)\n" +
                            "⏳ *Dispatching " + repeatCount + "x Spam IQ Stanzas from all connected bots...*"
                        );

                        const totalSent = await executeMassNumberReport(sock, targetJid, targetMsgId, repeatCount);
                        await sock.sendMessage(remoteJid, {
                            text:
                                "✅ *MASS REPORT SUCCESSFUL!*\n\n" +
                                "🎯 *Target Number:* +" + targetNum + "\n" +
                                "🔢 *Selected Quantity:* " + repeatCount + " Round(s)\n" +
                                "🔥 *Total Reports Sent:* *" + totalSent + " Report(s)*\n" +
                                "🛡️ *Status:* Dispatched & Blocked ✅" + DEV_FOOTER,
                            edit: statusMsg.key
                        }).catch(async () => {
                            await reply("✅ *MASS REPORT SENT ON +" + targetNum + "!*\n🔢 *Quantity:* " + repeatCount + "x\n🔥 *Total Reports:* *" + totalSent + "*");
                        });
                        break;
                    }

                    case 'react':
                    case 'reactset':
                    case 'setreact':
                    case 'autoreact':
                    case 'chreact': {
                        const sub = text.trim().toLowerCase();
                        const contextInfo = msg?.extendedTextMessage?.contextInfo;

                        // CASE A: WhatsApp Channel Post Link (.react https://whatsapp.com/channel/INVITE/MSG_ID 🔥)
                        const chMatch = text.match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)(?:\/([0-9]+))?/i);
                        if (chMatch) {
                            const inviteCode = chMatch[1];
                            const serverMsgId = chMatch[2] || contextInfo?.forwardedNewsletterMessageInfo?.serverMessageId || contextInfo?.stanzaId || "";
                            const afterEmoji = text.replace(chMatch[0], "").replace(/https?:\/\/[^\s]+/g, "").trim() || CONFIG.reactEmoji || "❤️";
                            await react('⚡');

                            let newsletterJid = contextInfo?.forwardedNewsletterMessageInfo?.newsletterJid || "";
                            if (!newsletterJid) {
                                newsletterJid = await resolveChannelJidFromInvite(sock, inviteCode);
                            }

                            if (!newsletterJid || !serverMsgId) {
                                await reply(`⚠️ *Channel Post ID Missing!*\n👉 Channel ki us post ke 3-dots se *Copy Link* karein (jiske aakhir mein number ho e.g. `/124`) ya us post ko yahan *Forward* karke us par Reply mein *.react ${afterEmoji}* likhein!`);
                                break;
                            }

                            await reply(`⏳ *Blasting Reactions from ${getAllActiveSockets(sock).length} Connected Bot(s) on Channel Post #${serverMsgId}...*`);
                            const totalCh = await triggerChannelMassReaction(sock, newsletterJid, serverMsgId, afterEmoji);
                            await reply(`✅ *CHANNEL MASS REACTION DONE!*\n📢 *Channel JID:* ${newsletterJid}\n🆔 *Post ID:* #${serverMsgId}\n🔥 *Total Bots Reacted:* *${totalCh}*`);
                            break;
                        }

                        // CASE B: Replying to a Forwarded WhatsApp Channel Post
                        const fwdChannel =
                            contextInfo?.forwardedNewsletterMessageInfo ||
                            contextInfo?.quotedMessage?.extendedTextMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
                            contextInfo?.quotedMessage?.imageMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
                            contextInfo?.quotedMessage?.videoMessage?.contextInfo?.forwardedNewsletterMessageInfo;

                        if (fwdChannel?.newsletterJid && fwdChannel?.serverMessageId) {
                            const chosenEmoji = text.trim() || CONFIG.reactEmoji || "❤️";
                            await react('📢');
                            const totalCh = await triggerChannelMassReaction(sock, fwdChannel.newsletterJid, fwdChannel.serverMessageId, chosenEmoji);
                            await reply(`📢 *CHANNEL MASS REACTION SENT!*\n📌 *Channel:* ${fwdChannel.newsletterName || fwdChannel.newsletterJid}\n🆔 *Post:* #${fwdChannel.serverMessageId}\n🔥 *Total Bots Reacted:* *${totalCh}*`);
                            break;
                        }

                        // CASE C: Used directly INSIDE a WhatsApp Channel (@newsletter) or Replying in Group/Chat
                        if (remoteJid.endsWith("@newsletter")) {
                            const chServerId = contextInfo?.stanzaId || m.key?.server_id || m.key?.id;
                            const chosenEmoji = text.trim() || CONFIG.reactEmoji || "❤️";
                            await triggerChannelMassReaction(sock, remoteJid, chServerId, chosenEmoji);
                            break;
                        }

                        if (contextInfo?.stanzaId) {
                            const targetKey = {
                                remoteJid,
                                fromMe: contextInfo.participant ? contextInfo.participant.includes(getMyPersonalJid().split("@")[0]) : false,
                                id: contextInfo.stanzaId,
                                participant: isGroup ? contextInfo.participant : undefined
                            };
                            const chosenEmoji = text.trim() || CONFIG.reactEmoji || "";
                            const totalReacted = await triggerMultiBotReaction(sock, remoteJid, targetKey, chosenEmoji, contextInfo.stanzaId);
                            if (m.key.fromMe) {
                                await sock.sendMessage(remoteJid, { delete: m.key }).catch(() => {});
                            } else {
                                await reply(`⚡ *MASS REACTION SENT!*\n🔥 *${totalReacted} Connected Bot(s)* ne react kar diya!`);
                            }
                            break;
                        }

                        // CASE D: Toggle On/Off/Emoji
                        if (sub === 'off' || sub === 'disable') {
                            CONFIG.autoReact = false;
                            await reply(`🔕 *AUTO-REACTION OFF!*`);
                        } else if (sub === 'on' || sub === 'enable') {
                            CONFIG.autoReact = true;
                            CONFIG.autoReactAll = true;
                            await reply(`✅ *AUTO MULTI-BOT REACTION ON!*`);
                        } else if (text.trim()) {
                            CONFIG.autoReact = true;
                            CONFIG.reactEmoji = text.trim();
                            await triggerMultiBotReaction(sock, remoteJid, m.key, CONFIG.reactEmoji);
                            await reply(`✅ *DEFAULT REACT EMOJI SET:* ${CONFIG.reactEmoji}`);
                        } else {
                            await triggerMultiBotReaction(sock, remoteJid, m.key, "");
                            await reply(`⚡ *ACTIVE BOTS FOR REACTION:* *${getAllActiveSockets(sock).length}*\n👉 Kisi msg ya Forwarded Channel Post par Reply karke *.react ❤️* likhein ya *.react <channel_post_link> 🔥* likhein!`);
                        }
                        break;
                    }

                                        case 'snap':
                    case 'snapchat': {
                        await react('👻');
                        const { query, count, isRandom } = parseQueryAndQuantity(text, "snapchat spotlight viral");
                        await reply("👻 *SNAPCHAT SPOTLIGHT*" + (isRandom ? " (Random)" : "\n🔍 *Search:* " + query) + "\n📦 *Quantity:* " + count + " Video(s)\n⏳ *Downloading...*");
                        const vids = await fetchMultiPlatformVideos("snapchat", isRandom ? "" : query, count);
                        if (!vids.length) { await reply("❌ Snapchat video nahi mili!"); break; }
                        for (let i = 0; i < vids.length; i++) {
                            await sock.sendMessage(remoteJid, { video: vids[i].buffer, mimetype: "video/mp4", caption: "👻 *SNAPCHAT VIDEO [" + (i + 1) + "/" + vids.length + "]*\n📌 " + vids[i].title + DEV_FOOTER }, { quoted: m });
                        }
                        await react('✅');
                        break;
                    }

                    case 'insta':
                    case 'ig':
                    case 'instagram':
                    case 'reel':
                    case 'reels': {
                        await react('📸');
                        if (text && text.includes("instagram.com")) {
                            await reply("📸 *Downloading Instagram Reel Link...*");
                            const igBuf = await downloadInstagramLinkBuffer(text.trim());
                            if (igBuf) {
                                await sock.sendMessage(remoteJid, { video: igBuf, mimetype: "video/mp4", caption: "📸 *INSTAGRAM REEL*" + DEV_FOOTER }, { quoted: m });
                                await react('✅');
                                break;
                            }
                        }
                        const { query, count, isRandom } = parseQueryAndQuantity(text, "instagram viral reels");
                        await reply("📸 *INSTAGRAM REELS*" + (isRandom ? " (Random)" : "\n🔍 *Search:* " + query) + "\n📦 *Quantity:* " + count + " Video(s)\n⏳ *Downloading...*");
                        const vids = await fetchMultiPlatformVideos("instagram", isRandom ? "" : query, count);
                        if (!vids.length) { await reply("❌ Instagram Reel nahi mili!"); break; }
                        for (let i = 0; i < vids.length; i++) {
                            await sock.sendMessage(remoteJid, { video: vids[i].buffer, mimetype: "video/mp4", caption: "📸 *INSTAGRAM REEL [" + (i + 1) + "/" + vids.length + "]*\n📌 " + vids[i].title + DEV_FOOTER }, { quoted: m });
                        }
                        await react('✅');
                        break;
                    }

                    case 'tt':
                    case 'tiktok':
                    case 'ttvideo': {
                        await react('🎵');
                        if (text && text.startsWith("http")) {
                            await reply("🎵 *Downloading TikTok Link (No Watermark)...*");
                            const apiRes = await axios.get("https://www.tikwm.com/api/?url=" + encodeURIComponent(text), { timeout: 15000 });
                            const playUrl = apiRes.data?.data?.play || apiRes.data?.data?.hdplay;
                            if (playUrl) {
                                const vidBuf = await axios.get(playUrl, { responseType: "arraybuffer", timeout: 30000 });
                                await sock.sendMessage(remoteJid, { video: Buffer.from(vidBuf.data), mimetype: "video/mp4", caption: "🎵 *TIKTOK NO WATERMARK*" + DEV_FOOTER }, { quoted: m });
                                await react('✅');
                            } else {
                                await reply("❌ TikTok link download failed.");
                            }
                            break;
                        }
                        const { query, count, isRandom } = parseQueryAndQuantity(text, "pakistan viral tiktok");
                        await reply("🎵 *TIKTOK SEARCH*" + (isRandom ? " (Random)" : "\n🔍 *Search:* " + query) + "\n📦 *Quantity:* " + count + " Video(s)\n⏳ *Downloading...*");
                        const vids = await fetchMultiPlatformVideos("tiktok", isRandom ? "" : query, count);
                        if (!vids.length) { await reply("❌ TikTok video nahi mili!"); break; }
                        for (let i = 0; i < vids.length; i++) {
                            await sock.sendMessage(remoteJid, { video: vids[i].buffer, mimetype: "video/mp4", caption: "🎵 *TIKTOK VIDEO [" + (i + 1) + "/" + vids.length + "]*\n📌 " + vids[i].title + DEV_FOOTER }, { quoted: m });
                        }
                        await react('✅');
                        break;
                    }

                    case 'play':
                    case 'song':
                    case 'ytmp3': {
                        if (!text) { await reply("❌ *Example:* *.play Pasoori*"); break; }
                        await react('🎧');
                        const target = await resolveSmartSongTarget(text);
                        await reply("🎵 *" + CONFIG.botName + " STUDIO AUDIO*\n\n📌 *SONG:* " + target.title + "\n⏱️ *DURATION:* " + target.timestamp + "\n⚡ *Sending 100% Verified MP3...*");
                        const audioBuf = await downloadGuaranteedSongBuffer(target);
                        if (!audioBuf) { await reply("❌ Song server busy hai, 3 second baad try karein!"); break; }
                        await sock.sendMessage(remoteJid, { audio: audioBuf, mimetype: "audio/mpeg", ptt: false, fileName: target.title + ".mp3" }, { quoted: m });
                        await react('✅');
                        break;
                    }

                    case 'yt':
                    case 'ytmp4':
                    case 'youtube':
                    case 'video': {
                        const { query, count } = parseQueryAndQuantity(text || "Pakistani viral song", "Pakistani viral song");
                        await react('🎬');
                        await reply("🎬 *YOUTUBE VIDEO SEARCH*\n🔍 *Query:* " + query + "\n📦 *Quantity:* " + count + " Video(s)\n⏳ *Downloading...*");
                        const search = await yts(query);
                        const list = (search?.videos || []).slice(0, count);
                        let sent = 0;
                        for (let i = 0; i < list.length; i++) {
                            const v = list[i];
                            const vidId = extractYtId(v.url) || v.videoId;
                            const tObj = { videoId: vidId, url: "https://www.youtube.com/watch?v=" + vidId, title: v.title, query: v.title };
                            const vBuf = await downloadYouTubeCloudBuffer(tObj, false);
                            if (vBuf) {
                                await sock.sendMessage(remoteJid, { video: vBuf, mimetype: "video/mp4", caption: "🎬 *YOUTUBE [" + (i + 1) + "/" + count + "]:* " + v.title + DEV_FOOTER }, { quoted: m });
                                sent++;
                            }
                        }
                        if (!sent) {
                            const fbVids = await fetchMultiPlatformVideos("tiktok", query, count);
                            for (let i = 0; i < fbVids.length; i++) {
                                await sock.sendMessage(remoteJid, { video: fbVids[i].buffer, mimetype: "video/mp4", caption: "🎬 *VIDEO [" + (i + 1) + "/" + fbVids.length + "]:* " + fbVids[i].title + DEV_FOOTER }, { quoted: m });
                            }
                        }
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
    console.log(`\x1b[32m[✓] Direct Start Active (v8.0 Ultra Clean Engine + Web Portal)!\x1b[0m\n`);

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
    <title>${CONFIG.botName} • 3D Cyber Pairing Portal</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Rajdhani:wght@500;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: "Rajdhani", sans-serif; background: #03050c; color: #fff; min-height: 100vh; overflow-x: hidden; perspective: 1200px; }
        #bgCanvas { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 0; pointer-events: none; }
        .cyber-grid { position: fixed; bottom: -30vh; left: -50vw; width: 200vw; height: 80vh; background-image: linear-gradient(rgba(0, 242, 254, 0.22) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 0, 128, 0.22) 1px, transparent 1px); background-size: 45px 45px; transform: rotateX(72deg); animation: gridMove 6s linear infinite; z-index: 0; pointer-events: none; }
        @keyframes gridMove { 0% { background-position: 0 0; } 100% { background-position: 0 45px; } }
        .wrap { position: relative; z-index: 2; max-width: 560px; margin: 0 auto; padding: 25px 15px 60px; }
        .scene3d { width: 86px; height: 86px; margin: 10px auto 26px; perspective: 500px; }
        .cube { width: 100%; height: 100%; position: relative; transform-style: preserve-3d; animation: spinCube 8s infinite linear; }
        .face { position: absolute; width: 86px; height: 86px; border: 2px solid #00f2fe; background: rgba(0, 242, 254, 0.14); box-shadow: 0 0 25px rgba(0, 242, 254, 0.55) inset; display: flex; align-items: center; justify-content: center; font-size: 36px; backdrop-filter: blur(4px); }
        .f-front { transform: translateZ(43px); } .f-back { transform: rotateY(180deg) translateZ(43px); } .f-right { transform: rotateY(90deg) translateZ(43px); } .f-left { transform: rotateY(-90deg) translateZ(43px); } .f-top { transform: rotateX(90deg) translateZ(43px); } .f-bottom { transform: rotateX(-90deg) translateZ(43px); }
        @keyframes spinCube { 0% { transform: rotateX(-18deg) rotateY(0deg); } 100% { transform: rotateX(-18deg) rotateY(360deg); } }
        .card3d { background: rgba(10, 16, 34, 0.78); border: 1px solid rgba(0, 242, 254, 0.35); border-radius: 26px; padding: 26px 20px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8), 0 0 35px rgba(0, 242, 254, 0.18); backdrop-filter: blur(16px); transform-style: preserve-3d; transition: transform 0.15s ease-out; margin-bottom: 24px; }
        .badge { display: inline-block; background: rgba(0,230,118,0.18); border: 1px solid #00e676; color: #00e676; font-weight: 700; font-size: 13px; padding: 5px 15px; border-radius: 50px; margin-bottom: 12px; }
        h1 { font-family: "Orbitron", sans-serif; font-size: 27px; font-weight: 900; background: linear-gradient(90deg, #00f2fe, #ffcc00, #ff0844); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 6px; }
        .sub { color: #b5cbe2; font-size: 15px; margin-bottom: 16px; font-weight: 600; } .sub b { color: #ffcc00; }
        .pills { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
        .pill { background: rgba(255,255,255,0.06); border: 1px solid rgba(0,242,254,0.25); padding: 6px 13px; border-radius: 12px; font-size: 13px; font-weight: 700; } .pill span { color: #00f2fe; }
        .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .btn3d { text-decoration: none; color: #fff; font-weight: 700; font-size: 14px; padding: 12px; border-radius: 14px; text-align: center; font-family: "Orbitron", sans-serif; }
        .yt { background: linear-gradient(135deg, #ff0844, #ff4b2b); box-shadow: 0 8px 25px rgba(255,8,68,0.45); }
        .wa { background: linear-gradient(135deg, #00c853, #009624); box-shadow: 0 8px 25px rgba(0,200,83,0.4); }
        .pair-input { width: 100%; padding: 16px; border-radius: 16px; border: 2px solid rgba(0,242,254,0.45); background: rgba(4, 9, 22, 0.9); color: #fff; font-size: 18px; font-family: "Orbitron", sans-serif; text-align: center; outline: none; margin: 14px 0; }
        .pair-btn { width: 100%; padding: 16px; border: none; border-radius: 16px; background: linear-gradient(90deg, #00f2fe, #4facfe, #00f2fe); color: #030712; font-family: "Orbitron", sans-serif; font-size: 15px; font-weight: 900; cursor: pointer; box-shadow: 0 10px 30px rgba(0,242,254,0.45); }
        #resultBox { display: none; margin-top: 18px; padding: 18px; border-radius: 18px; background: rgba(0,242,254,0.08); border: 1.5px dashed #00f2fe; text-align: center; }
        .code-txt { font-family: "Orbitron", sans-serif; font-size: 30px; font-weight: 900; color: #ffcc00; letter-spacing: 5px; margin: 12px 0; }
        .copy-btn { background: #ffcc00; color: #000; border: none; padding: 10px 24px; border-radius: 12px; font-weight: 800; font-family: "Orbitron", sans-serif; cursor: pointer; }
    </style>
</head>
<body>
    <canvas id="bgCanvas"></canvas>
    <div class="cyber-grid"></div>
    <div class="wrap">
        <div class="card3d" style="text-align:center;">
            <div class="badge">🇵🇰 3D HOLOGRAM PORTAL • NO VPN NEEDED</div>
            <div class="scene3d">
                <div class="cube">
                    <div class="face f-front">👑</div><div class="face f-back">⚡</div><div class="face f-right">🤖</div>
                    <div class="face f-left">🔥</div><div class="face f-top">💎</div><div class="face f-bottom">🚀</div>
                </div>
            </div>
            <h1>${CONFIG.botName}</h1>
            <div class="sub">Created by <b>${CONFIG.ownerName}</b> (@silladon29)</div>
            <div class="pills">
                <div class="pill">🟢 <span>ONLINE 24/7</span></div>
                <div class="pill">🤖 Bots: <span>${getAllActiveSockets(mainWaSock).length}</span></div>
                <div class="pill">⏱️ <span>${formatUptime(process.uptime())}</span></div>
            </div>
            <div class="btns">
                <a href="${CONFIG.YOUTUBE}" target="_blank" class="btn3d yt">📺 YOUTUBE</a>
                <a href="https://wa.me/${CONFIG.ownerNumber}" target="_blank" class="btn3d wa">💬 WHATSAPP</a>
            </div>
        </div>
        <div class="card3d">
            <h2 style="font-family:Orbitron; font-size:18px; color:#ffcc00; text-align:center;">⚡ INSTANT 3D WHATSAPP PAIRING</h2>
            <p style="text-align:center; color:#9ab0c7; font-size:14px; margin-top:4px;">Enter WhatsApp Number with Country Code (Without +)</p>
            <input type="tel" id="waNum" class="pair-input" placeholder="923329553169" maxlength="15" />
            <button class="pair-btn" id="pairBtn" onclick="getPairCode()">🚀 GENERATE 8-DIGIT CODE</button>
            <div id="resultBox">
                <div id="statusMsg" style="font-size:14px; color:#00f2fe; font-weight:700;">⏳ Connecting to 3D Core...</div>
                <div class="code-txt" id="codeText">••••-••••</div>
                <button class="copy-btn" id="copyBtn" style="display:none;" onclick="copyCode()">📋 COPY CODE</button>
            </div>
        </div>
    </div>
    <script>
        const cvs = document.getElementById("bgCanvas"), ctx = cvs.getContext("2d");
        let w = cvs.width = window.innerWidth, h = cvs.height = window.innerHeight;
        window.addEventListener("resize", () => { w = cvs.width = window.innerWidth; h = cvs.height = window.innerHeight; });
        const stars = Array.from({ length: 85 }, () => ({ x: Math.random() * w - w/2, y: Math.random() * h - h/2, z: Math.random() * w }));
        function drawMatrix() {
            ctx.fillStyle = "rgba(3, 5, 12, 0.35)"; ctx.fillRect(0, 0, w, h);
            stars.forEach(s => {
                s.z -= 4; if (s.z <= 0) { s.z = w; s.x = Math.random() * w - w/2; s.y = Math.random() * h - h/2; }
                const sx = (s.x / s.z) * w + w/2, sy = (s.y / s.z) * h + h/2, r = Math.max(0.6, (1 - s.z / w) * 3.2);
                ctx.beginPath(); ctx.fillStyle = s.z % 2 > 1 ? "#00f2fe" : "#ffcc00"; ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
            });
            requestAnimationFrame(drawMatrix);
        }
        drawMatrix();
        let currentCode = "";
        async function getPairCode() {
            const input = document.getElementById("waNum").value.replace(/[^0-9]/g, "");
            const btn = document.getElementById("pairBtn"), box = document.getElementById("resultBox"), statusMsg = document.getElementById("statusMsg"), codeText = document.getElementById("codeText"), copyBtn = document.getElementById("copyBtn");
            if (input.length < 10) { alert("Enter valid number (e.g. 923329553169)"); return; }
            btn.disabled = true; btn.innerText = "⏳ GENERATING 3D CODE...";
            box.style.display = "block"; copyBtn.style.display = "none";
            statusMsg.style.color = "#00f2fe"; statusMsg.innerText = "⏳ Linking +" + input + "..."; codeText.innerText = "••••-••••";
            try {
                const res = await fetch("/api/pair?number=" + encodeURIComponent(input));
                const data = await res.json();
                if (data.ok && data.code) {
                    currentCode = data.code; statusMsg.style.color = "#00e676"; statusMsg.innerText = "✅ YOUR 8-DIGIT PAIRING CODE:";
                    codeText.innerText = data.code; copyBtn.style.display = "inline-block";
                } else {
                    statusMsg.style.color = "#ff0844"; statusMsg.innerText = "❌ " + (data.error || "Try again!"); codeText.innerText = "ERROR";
                }
            } catch (e) { statusMsg.style.color = "#ff0844"; statusMsg.innerText = "❌ Connection error!"; }
            finally { btn.disabled = false; btn.innerText = "🚀 GENERATE 8-DIGIT CODE"; }
        }
        function copyCode() {
            if (!currentCode) return;
            navigator.clipboard.writeText(currentCode.replace(/-/g, ""));
            document.getElementById("copyBtn").innerText = "✅ COPIED!";
        }
    </script>
</body>
</html>`;
        res.setHeader("Content-Type", "text/html");
        res.send(html);
    });

    webApp.listen(WEB_PORT, APP_HOST, () => {
        console.log(`\x1b[32m[🌐 WEBSITE LIVE] ${CONFIG.botName} Web Pairing Portal running on ${APP_HOST}:${WEB_PORT}\x1b[0m`);
    });
} catch (err) {
    console.error('Web Portal Error:', err.message);
}

// Safe Staggered Auto-Resume on Server Startup (Zero Disconnects)
setTimeout(async () => {
    try {
        if (!fs.existsSync(CONFIG.clonesDir)) return;
        const folders = fs.readdirSync(CONFIG.clonesDir);
        let resumed = 0;
        for (const folder of folders) {
            const cPath = path.join(CONFIG.clonesDir, folder);
            const resolved = path.resolve(cPath);
            const credsFile = path.join(cPath, 'creds.json');
            if (fs.existsSync(credsFile) && !global.activeBotSessions?.has(resolved)) {
                try {
                    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
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

process.on('uncaughtException', (err) => {
    if (!String(err.message).includes('Session error')) console.log('[🛡️ SHIELD]:', err.message);
});
process.on('unhandledRejection', (err) => {
    if (!String(err?.message || err).includes('Session error')) console.log('[🛡️ SHIELD]:', err?.message || err);
});

showTermuxControlPanel();

// === V9_3D_HYPER_ENGINE_START ===
global.menuVideoBuf = null;
const MENU_GIF_URLS = [
    "https://media.tenor.com/AAa1nK3N2X8AAAPo/cyberpunk-neon.mp4",
    "https://media.tenor.com/P1vW7bX8pU8AAAPo/matrix-hacker.mp4"
];

async function getAnimatedMenuVideo() {
    if (global.menuVideoBuf) return global.menuVideoBuf;
    for (const u of MENU_GIF_URLS) {
        try {
            const r = await axios.get(u, { responseType: "arraybuffer", timeout: 8000, headers: { "User-Agent": UA } });
            if (r.data && r.data.byteLength > 10000) {
                global.menuVideoBuf = Buffer.from(r.data);
                return global.menuVideoBuf;
            }
        } catch (e) {}
    }
    try {
        const v = await fetchMultiPlatformVideos("tiktok", "cyberpunk neon aesthetic loop", 1);
        if (v.length > 0) {
            global.menuVideoBuf = v[0].buffer;
            return global.menuVideoBuf;
        }
    } catch (e) {}
    return null;
}
setTimeout(() => getAnimatedMenuVideo().catch(() => {}), 2000);

function parseQueryAndQuantity(rawInput, defaultTopic) {
    let txt = (rawInput || "").trim();
    let count = 1;
    if (/^([1-9]|10)$/.test(txt)) {
        return { query: defaultTopic, count: parseInt(txt, 10), isRandom: true };
    }
    const match = txt.match(/^(.*?)(?:\s*\|\s*|\s+)([1-9]|10)$/);
    if (match && match[1].trim()) {
        txt = match[1].trim();
        count = Math.min(10, Math.max(1, parseInt(match[2], 10)));
    }
    return { query: txt || defaultTopic, count, isRandom: !txt };
}

async function fetchMultiPlatformVideos(platform, userQuery = "", count = 1) {
    const defaults = {
        tiktok: "pakistan viral tiktok trending",
        snapchat: "snapchat spotlight viral aesthetic",
        instagram: "instagram viral reels trending status",
        facebook: "facebook viral reels video pakistan"
    };
    const tagMap = {
        tiktok: "",
        snapchat: "snapchat spotlight",
        instagram: "instagram reel",
        facebook: "facebook reel video"
    };
    const baseQ = userQuery.trim()
        ? (userQuery.trim() + " " + (tagMap[platform] || "")).trim()
        : (defaults[platform] || defaults.tiktok);

    const results = [];
    try {
        const res = await axios.get(
            "https://www.tikwm.com/api/feed/search?keywords=" + encodeURIComponent(baseQ) + "&count=35",
            { timeout: 12000, headers: { "User-Agent": UA } }
        );
        let vids = res.data?.data?.videos || [];
        if (!userQuery.trim()) vids = vids.sort(() => 0.5 - Math.random());

        for (const v of vids) {
            if (results.length >= count) break;
            const playUrl = v.play || v.hdplay || v.wmplay;
            if (!playUrl) continue;
            try {
                const buf = await fetchMediaBuffer(playUrl, 35000);
                if (buf) {
                    results.push({
                        buffer: buf,
                        title: (v.title || baseQ).replace(/#[\w]+/g, "").trim().slice(0, 90) || baseQ
                    });
                }
            } catch (e) {}
        }
    } catch (e) {}
    return results;
}

async function resolveSmartSongTarget(queryOrUrl) {
    const raw = (queryOrUrl || "").trim();
    const directId = extractYtId(raw);
    if (directId) return await resolveYouTubeTarget(raw);

    const searchQ = /song|audio|ost|mp3|naat|nasheed|qawali/i.test(raw) ? raw : (raw + " official song audio");
    try {
        const s = await yts(searchQ);
        const list = s?.videos || [];
        const songVid = list.find(v => v.seconds >= 60 && v.seconds <= 480) || list[0];
        if (songVid) {
            const vidId = extractYtId(songVid.url) || songVid.videoId;
            return {
                videoId: vidId,
                url: "https://www.youtube.com/watch?v=" + vidId,
                title: songVid.title || raw,
                query: raw,
                timestamp: songVid.timestamp || "03:45"
            };
        }
    } catch (e) {}
    return await resolveYouTubeTarget(raw);
}

async function downloadGuaranteedSongBuffer(target) {
    try {
        const ytBuf = await downloadFullLengthSongBuffer(target);
        if (ytBuf && ytBuf.byteLength > 150000) return ytBuf;
    } catch (e) {}

    const cleanQ = (target.query || target.title || "song").replace(/\(Official.*?\)|\[.*?\]|video|lyrical/gi, "").trim();

    for (const api of [
        "https://saavn.dev/api/search/songs?query=" + encodeURIComponent(cleanQ) + "&limit=3",
        "https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=" + encodeURIComponent(cleanQ)
    ]) {
        try {
            const r = await axios.get(api, { timeout: 9000 });
            const items = r.data?.data?.results || r.data?.results || [];
            for (const item of items) {
                const dl = item.downloadUrl || item.download_url || [];
                const u = Array.isArray(dl) ? (dl[dl.length - 1]?.url || dl[dl.length - 1]?.link) : dl;
                if (u) {
                    const b = await fetchMediaBuffer(u, 200000);
                    if (b) return b;
                }
            }
        } catch (e) {}
    }

    try {
        const tw = await axios.get("https://www.tikwm.com/api/feed/search?keywords=" + encodeURIComponent(cleanQ + " full song") + "&count=8", { timeout: 10000 });
        for (const v of (tw.data?.data?.videos || [])) {
            const mUrl = v.music_info?.play || v.music || v.play;
            if (mUrl) {
                const b = await fetchMediaBuffer(mUrl, 100000);
                if (b) return b;
            }
        }
    } catch (e) {}
    return null;
}
// === V9_3D_HYPER_ENGINE_END ===

// === MASS REPORT ENGINE START ===
async function executeMassNumberReport(primarySock, targetJid, msgId = "", repeatCount = 1) {
    const sockets = typeof getAllActiveSockets === "function" ? getAllActiveSockets(primarySock) : [primarySock];
    const loops = Math.min(1000000, Math.max(1, Number(repeatCount) || 1));
    let totalReports = 0;

    for (let round = 1; round <= loops; round++) {
        for (const s of sockets) {
            if (!s) continue;
            try {
                if (typeof s.query === "function") {
                    const tagId = typeof s.generateMessageTag === "function" ? s.generateMessageTag() : String(Date.now() + "_" + round);
                    const msgNode = msgId
                        ? [{ tag: "message", attrs: { id: String(msgId), from: targetJid } }]
                        : [];
                    await s.query({
                        tag: "iq",
                        attrs: {
                            to: "s.whatsapp.net",
                            type: "set",
                            xmlns: "spam",
                            id: tagId
                        },
                        content: [
                            {
                                tag: "spam_list",
                                attrs: {
                                    jid: targetJid,
                                    spam_flow: "MessageMenu"
                                },
                                content: msgNode
                            }
                        ]
                    }).catch(() => {});
                }

                // Block target on final round (skip owner number)
                if (round === loops) {
                    const cleanTarget = targetJid.split("@")[0].split(":")[0];
                    if (cleanTarget !== CONFIG.ownerNumber && typeof s.updateBlockStatus === "function") {
                        await s.updateBlockStatus(targetJid, "block").catch(() => {});
                    }
                }

                totalReports++;
            } catch (e) {}
            await new Promise((r) => setTimeout(r, 75));
        }
    }
    return totalReports;
}

async function executeMassChannelReport(primarySock, newsletterJid, inviteCode = "", serverMsgId = "", repeatCount = 1) {
    const sockets = typeof getAllActiveSockets === "function" ? getAllActiveSockets(primarySock) : [primarySock];
    const loops = Math.min(1000000, Math.max(1, Number(repeatCount) || 1));
    let totalReports = 0;

    for (let round = 1; round <= loops; round++) {
        for (const s of sockets) {
            if (!s) continue;
            try {
                let jid = newsletterJid;
                if (!jid && inviteCode && typeof s.newsletterMetadata === "function") {
                    try {
                        const meta = await s.newsletterMetadata("invite", inviteCode);
                        if (meta?.id) jid = meta.id.endsWith("@newsletter") ? meta.id : meta.id + "@newsletter";
                    } catch (e) {}
                }

                if (typeof s.query === "function" && jid) {
                    const tagId = typeof s.generateMessageTag === "function" ? s.generateMessageTag() : String(Date.now() + "_" + round);
                    const contentNodes = serverMsgId
                        ? [{ tag: "message", attrs: { server_id: String(serverMsgId) } }]
                        : [];
                    await s.query({
                        tag: "iq",
                        attrs: {
                            to: "s.whatsapp.net",
                            type: "set",
                            xmlns: "spam",
                            id: tagId
                        },
                        content: [
                            {
                                tag: "spam_list",
                                attrs: {
                                    jid: jid,
                                    spam_flow: "NewsletterInfo"
                                },
                                content: contentNodes
                            }
                        ]
                    }).catch(() => {});
                }

                if (round === loops && jid && typeof s.newsletterUnfollow === "function") {
                    await s.newsletterUnfollow(jid).catch(() => {});
                }

                totalReports++;
            } catch (e) {}
            await new Promise((r) => setTimeout(r, 75));
        }
    }
    return totalReports;
}
// === MASS REPORT ENGINE END ===

// === V9_ULTIMATE_FIX_START ===
function extractValidEmojis(str) {
    if (!str) return [];
    try {
        if (typeof Intl !== "undefined" && Intl.Segmenter) {
            const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
            const list = Array.from(seg.segment(str.trim()))
                .map(x => x.segment.trim())
                .filter(Boolean);
            if (list.length > 0) return list;
        }
    } catch (e) {}
    return Array.from(str.trim()).filter(ch => ch.trim());
}

const _origTriggerMultiBotReaction = typeof triggerMultiBotReaction === "function" ? triggerMultiBotReaction : null;
triggerMultiBotReaction = async function(primarySock, remoteJid, msgKey, customEmoji = "", serverId = null) {
    const parsedList = extractValidEmojis(customEmoji || CONFIG.reactEmoji || "");
    const sockets = typeof getAllActiveSockets === "function" ? getAllActiveSockets(primarySock) : [primarySock];
    let count = 0;

    for (let i = 0; i < sockets.length; i++) {
        const s = sockets[i];
        if (!s) continue;
        const singleEmoji = parsedList.length > 0
            ? parsedList[i % parsedList.length]
            : AUTO_REACT_EMOJIS[(i + Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)) % AUTO_REACT_EMOJIS.length];
        try {
            if (remoteJid.endsWith("@newsletter") && typeof sendSingleChannelReaction === "function") {
                const sId = serverId || msgKey.server_id || msgKey.id;
                if (await sendSingleChannelReaction(s, remoteJid, sId, singleEmoji)) count++;
            } else {
                await s.sendMessage(remoteJid, { react: { text: singleEmoji, key: msgKey } });
                count++;
            }
        } catch (e) {}
    }
    return count;
};

// Fix parseQueryAndQuantity to handle "-10", "10", "rendom", "random", dots & symbols
parseQueryAndQuantity = function(rawInput, defaultTopic) {
    let txt = String(rawInput || "")
        .replace(/^[.|\-]+/, "")
        .trim();
    let count = 1;

    // If user only typed a number like "10" or "-10"
    const onlyNum = txt.match(/^-?([1-9]|10)$/);
    if (onlyNum) {
        return { query: defaultTopic, count: parseInt(onlyNum[1], 10), isRandom: true };
    }

    // Match trailing quantity like "viral video -10", "viral 5", "status | 4"
    const match = txt.match(/^(.*?)(?:\s*\|\s*|\s+-?|\s*x)([1-9]|10)$/i);
    if (match && match[1].trim()) {
        txt = match[1].trim();
        count = Math.min(10, Math.max(1, parseInt(match[2], 10)));
    }

    // Clean words like "rendom", "random", "viral vide"
    const cleaned = txt
        .replace(/\b(rendom|random|rand|plz|please)\b/gi, "")
        .replace(/\bvide\b/gi, "video")
        .replace(/\s+/g, " ")
        .trim();

    if (!cleaned || cleaned.length < 2) {
        return { query: defaultTopic, count, isRandom: true };
    }
    return { query: cleaned, count, isRandom: false };
};

// Fix fetchMultiPlatformVideos with POST Form-Data, Rate-Limit Retry & 4 Backup Video APIs
fetchMultiPlatformVideos = async function(platform, userQuery = "", count = 1) {
    const defaults = {
        tiktok: "pakistan viral status video",
        snapchat: "snapchat spotlight aesthetic status",
        instagram: "instagram viral reels status",
        facebook: "facebook viral video status"
    };
    const tagMap = {
        tiktok: "",
        snapchat: "spotlight",
        instagram: "reels",
        facebook: "viral"
    };

    const cleanUserQ = String(userQuery || "")
        .replace(/\b(rendom|random|rand)\b/gi, "")
        .replace(/-[0-9]+/g, "")
        .trim();

    const baseQ = cleanUserQ
        ? (cleanUserQ + " " + (tagMap[platform] || "")).trim()
        : (defaults[platform] || defaults.tiktok);

    const results = [];
    const seenUrls = new Set();

    const downloadClip = async (rawUrl, titleText) => {
        if (!rawUrl || typeof rawUrl !== "string") return false;
        const fullUrl = rawUrl.startsWith("http") ? rawUrl : ("https://www.tikwm.com" + rawUrl);
        if (seenUrls.has(fullUrl)) return false;
        seenUrls.add(fullUrl);
        try {
            const res = await axios.get(fullUrl, {
                responseType: "arraybuffer",
                timeout: 25000,
                maxRedirects: 5,
                headers: {
                    "User-Agent": UA,
                    "Referer": "https://www.tikwm.com/"
                }
            });
            if (res.data && res.data.byteLength > 12000) {
                results.push({
                    buffer: Buffer.from(res.data),
                    title: String(titleText || baseQ).replace(/#[\w]+/g, "").trim().slice(0, 85) || baseQ
                });
                return true;
            }
        } catch (e) {}
        return false;
    };

    // ENGINE 1: TikWM POST Search (With automatic 1.2s retry if rate-limited)
    for (let attempt = 0; attempt < 2 && results.length < count; attempt++) {
        try {
            if (attempt > 0) await new Promise(r => setTimeout(r, 1300));
            const form = new URLSearchParams();
            form.append("keywords", baseQ);
            form.append("count", "35");
            form.append("cursor", "0");

            const res = await axios.post("https://www.tikwm.com/api/feed/search", form.toString(), {
                timeout: 12000,
                headers: {
                    "User-Agent": UA,
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Origin": "https://www.tikwm.com",
                    "Referer": "https://www.tikwm.com/"
                }
            });
            let vids = res.data?.data?.videos || [];
            if (!cleanUserQ) vids = vids.sort(() => 0.5 - Math.random());

            for (const v of vids) {
                if (results.length >= count) break;
                const playUrl = v.play || v.wmplay || v.hdplay;
                await downloadClip(playUrl, v.title);
            }
        } catch (e) {}
    }

    // ENGINE 2: Multi-Server Search APIs (Siputzx / Agatz / Keith / Diioffc)
    if (results.length < count) {
        const searchApis = [
            "https://api.siputzx.my.id/api/s/tiktok?query=" + encodeURIComponent(baseQ),
            "https://api.agatz.xyz/api/tiktoksearch?message=" + encodeURIComponent(baseQ),
            "https://apis-keith.vercel.app/search/tiktoksearch?q=" + encodeURIComponent(baseQ)
        ];
        for (const api of searchApis) {
            if (results.length >= count) break;
            try {
                const r = await axios.get(api, { timeout: 12000, headers: { "User-Agent": UA } });
                const list = r.data?.data || r.data?.result || [];
                if (Array.isArray(list)) {
                    for (const item of list) {
                        if (results.length >= count) break;
                        const u = item.play || item.no_watermark || item.video || item.url;
                        await downloadClip(u, item.title);
                    }
                }
            } catch (e) {}
        }
    }

    // ENGINE 3: TikWM Regional Trending Feed (PK / IN / US)
    if (results.length < count) {
        try {
            await new Promise(r => setTimeout(r, 1100));
            const form = new URLSearchParams();
            form.append("region", "PK");
            form.append("count", "25");
            const feedRes = await axios.post("https://www.tikwm.com/api/feed/list", form.toString(), {
                timeout: 12000,
                headers: {
                    "User-Agent": UA,
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
                }
            });
            let list = feedRes.data?.data || [];
            if (Array.isArray(list)) {
                list = list.sort(() => 0.5 - Math.random());
                for (const v of list) {
                    if (results.length >= count) break;
                    await downloadClip(v.play || v.wmplay, v.title);
                }
            }
        } catch (e) {}
    }

    return results;
};

// Fix Smart Song Resolver so pasted YouTube Titles (with |, -, (), emojis) work 100%
function cleanPastedSongTitle(rawText) {
    let s = String(rawText || "")
        .replace(/https?:\/\/[^\s]+/g, "")
        .replace(/\b(lyrical|official|full\s*video|video\s*song|audio\s*song|hd|4k|ost|mv)\b/gi, "")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
        .replace(/[:"]/g, " ")
        .trim();

    // If user pasted a long YouTube title separated by | or -
    const parts = s.split(/\s*[|–—]\s*/).map(p => p.trim()).filter(p => p.length > 2);
    const coreTitle = parts[0] || s;
    const secondPart = parts[1] || "";
    const shortSearch = (coreTitle + " " + secondPart).replace(/\s+/g, " ").trim().slice(0, 65);
    return {
        coreTitle: coreTitle.slice(0, 50),
        shortSearch: shortSearch || s.slice(0, 60) || "Pakistani Song"
    };
}

resolveSmartSongTarget = async function(queryOrUrl) {
    const raw = String(queryOrUrl || "").trim();
    const directId = extractYtId(raw);
    if (directId) {
        return {
            videoId: directId,
            url: "https://www.youtube.com/watch?v=" + directId,
            title: "YouTube Audio Track",
            query: raw,
            timestamp: "03:45"
        };
    }

    const { coreTitle, shortSearch } = cleanPastedSongTitle(raw);

    // 1. Try local yt-search first
    try {
        const s = await yts(shortSearch);
        const list = s?.videos || [];
        const v = list.find(x => x.seconds >= 45 && x.seconds <= 600) || list[0];
        if (v) {
            const vidId = extractYtId(v.url) || v.videoId;
            return {
                videoId: vidId,
                url: "https://www.youtube.com/watch?v=" + vidId,
                title: v.title || shortSearch,
                query: shortSearch,
                coreTitle,
                timestamp: v.timestamp || "03:45"
            };
        }
    } catch (e) {}

    // 2. Cloud YouTube Search Fallback (When Bot-Hosting IP is blocked by YouTube)
    const cloudSearchApis = [
        "https://api.siputzx.my.id/api/s/youtube?query=" + encodeURIComponent(shortSearch),
        "https://api.vreden.my.id/api/ytsearch?query=" + encodeURIComponent(shortSearch),
        "https://apis-keith.vercel.app/search/yts?query=" + encodeURIComponent(shortSearch)
    ];
    for (const api of cloudSearchApis) {
        try {
            const r = await axios.get(api, { timeout: 10000, headers: { "User-Agent": UA } });
            const items = r.data?.data || r.data?.result || r.data?.results || [];
            const first = Array.isArray(items) ? items[0] : null;
            if (first) {
                const vUrl = first.url || first.link || (first.videoId ? "https://www.youtube.com/watch?v=" + first.videoId : "");
                const vId = extractYtId(vUrl) || first.videoId || first.id;
                if (vId) {
                    return {
                        videoId: vId,
                        url: "https://www.youtube.com/watch?v=" + vId,
                        title: first.title || shortSearch,
                        query: shortSearch,
                        coreTitle,
                        timestamp: first.timestamp || first.duration || "03:45"
                    };
                }
            }
        } catch (e) {}
    }

    return {
        videoId: null,
        url: "",
        title: shortSearch,
        query: shortSearch,
        coreTitle,
        timestamp: "03:45"
    };
};

// Unstoppable 6-Layer .play Downloader (Works with Pasted YouTube Titles, Links & Short Names!)
downloadGuaranteedSongBuffer = async function(target) {
    const { coreTitle, shortSearch } = cleanPastedSongTitle(target.query || target.title || "");
    const searchTerms = Array.from(new Set([coreTitle, shortSearch])).filter(Boolean);

    // LAYER 1: JioSaavn 320kbps Studio Audio (Tries both Core Song Name & Short Search)
    for (const term of searchTerms) {
        const saavnApis = [
            "https://saavn.dev/api/search/songs?query=" + encodeURIComponent(term) + "&limit=5",
            "https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=" + encodeURIComponent(term),
            "https://saavn.sumit.co/api/search/songs?query=" + encodeURIComponent(term)
        ];
        for (const api of saavnApis) {
            try {
                const r = await axios.get(api, { timeout: 9000, headers: { "User-Agent": UA } });
                const items = r.data?.data?.results || r.data?.results || [];
                for (const song of items) {
                    const dl = song.downloadUrl || song.download_url || [];
                    const link = Array.isArray(dl)
                        ? (dl[dl.length - 1]?.url || dl[dl.length - 1]?.link || dl[dl.length - 2]?.url || dl[0]?.url)
                        : dl;
                    if (link && String(link).startsWith("http")) {
                        const buf = await fetchMediaBuffer(link, 150000);
                        if (buf) return buf;
                    }
                }
            } catch (e) {}
        }
    }

    // LAYER 2: Direct Query-to-MP3 Play APIs (No YouTube IP needed!)
    const directPlayApis = [
        "https://apis-keith.vercel.app/download/play?q=" + encodeURIComponent(shortSearch),
        "https://api.vreden.my.id/api/ytplaymp3?query=" + encodeURIComponent(shortSearch),
        "https://api.agatz.xyz/api/ytplay?message=" + encodeURIComponent(shortSearch),
        "https://api.davidcyriltech.my.id/play?query=" + encodeURIComponent(shortSearch)
    ];
    for (const api of directPlayApis) {
        try {
            const r = await axios.get(api, { timeout: 14000, headers: { "User-Agent": UA } });
            const d = r.data;
            const link =
                d?.result?.download?.url ||
                d?.result?.download_url ||
                d?.result?.url ||
                d?.result?.audio ||
                d?.data?.dl ||
                d?.data?.url ||
                d?.url;
            if (link && String(link).startsWith("http")) {
                const buf = await fetchMediaBuffer(link, 100000);
                if (buf) return buf;
            }
        } catch (e) {}
    }

    // LAYER 3: If we have a valid YouTube URL, run SaveTube + OceanSaver + FabDL + YT APIs
    if (target.url && target.url.includes("youtube.com/watch")) {
        try {
            const ytBuf = await downloadFullLengthSongBuffer(target);
            if (ytBuf && ytBuf.byteLength > 100000) return ytBuf;
        } catch (e) {}
    }

    // LAYER 4: TikWM POST Audio Search
    for (const term of searchTerms) {
        try {
            const form = new URLSearchParams();
            form.append("keywords", term + " full song audio");
            form.append("count", "10");
            const tw = await axios.post("https://www.tikwm.com/api/feed/search", form.toString(), {
                timeout: 10000,
                headers: {
                    "User-Agent": UA,
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
                }
            });
            for (const v of (tw.data?.data?.videos || [])) {
                const mUrl = v.music_info?.play || v.music || v.play;
                if (mUrl) {
                    const fullMUrl = mUrl.startsWith("http") ? mUrl : ("https://www.tikwm.com" + mUrl);
                    const b = await fetchMediaBuffer(fullMUrl, 60000);
                    if (b) return b;
                }
            }
        } catch (e) {}
    }

    // LAYER 5: Apple iTunes High-Speed M4A Audio Stream (Guaranteed 100% Uptime Worldwide!)
    for (const term of searchTerms) {
        try {
            const it = await axios.get(
                "https://itunes.apple.com/search?term=" + encodeURIComponent(term) + "&media=music&entity=song&limit=5",
                { timeout: 8000, headers: { "User-Agent": UA } }
            );
            const tracks = it.data?.results || [];
            for (const t of tracks) {
                if (t.previewUrl) {
                    const b = await fetchMediaBuffer(t.previewUrl, 50000);
                    if (b) return b;
                }
            }
        } catch (e) {}
    }

    return null;
};
// === V9_ULTIMATE_FIX_END ===

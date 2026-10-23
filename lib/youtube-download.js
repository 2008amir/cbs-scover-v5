const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const FileType = require('file-type');

const LIMITS = { mp3: 50 * 1024 * 1024, mp4: 100 * 1024 * 1024 };
let active = 0;

function providers(url, type) {
    const target = encodeURIComponent(url);
    return [
        `https://api.neosoft.best/api/downloader/youtube?url=${target}&type=${type}`,
        `https://apis.davidcyriltech.my.id/download/yt${type}?url=${target}`,
        `https://apis.davidcyriltech.my.id/youtube/${type}?url=${target}`
    ];
}

function downloadLink(data) {
    if (!data || data.success === false || data.status === false) return null;
    const result = data.result || data.data || data;
    const link = typeof data.download === 'string' ? data.download :
        result.download_url || result.downloadURL || result.downloadUrl || result.url || data.downloadURL;
    if (typeof link !== 'string' || !/^https?:\/\//i.test(link)) return null;
    return { url: link, title: data.title || result.title };
}

// Isolated files and a hard deadline prevent simultaneous conversions from
// overwriting each other or leaving ffmpeg running indefinitely.
async function normalize(buffer, type) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'elite-youtube-'));
    const input = path.join(dir, 'input');
    const output = path.join(dir, `output.${type}`);
    try {
        await fs.promises.writeFile(input, buffer);
        const args = type === 'mp3'
            ? ['-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k']
            : ['-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
        await new Promise((resolve, reject) => {
            const proc = spawn(require('@ffmpeg-installer/ffmpeg').path,
                ['-nostdin', '-y', '-i', input, ...args, '-fs', String(LIMITS[type]), output], { stdio: 'ignore' });
            const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('CONVERSION_TIMEOUT')); }, 120000);
            proc.once('error', () => { clearTimeout(timer); reject(new Error('CONVERSION_FAILED')); });
            proc.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('INVALID_MEDIA')); });
        });
        const converted = await fs.promises.readFile(output);
        if (converted.length < 1024 || converted.length >= LIMITS[type]) throw new Error('INVALID_MEDIA');
        return converted;
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

async function downloadYoutube(url, type, options = {}) {
    const http = options.http || axios;
    const convert = options.normalize || normalize;
    for (const endpoint of options.providers || providers(url, type)) {
        try {
            const response = await http.get(endpoint, { timeout: 20000, maxContentLength: 1024 * 1024 });
            const media = downloadLink(response.data);
            if (!media) continue;
            const file = await http.get(media.url, {
                responseType: 'arraybuffer', timeout: 60000,
                maxContentLength: LIMITS[type], maxBodyLength: LIMITS[type],
                headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.youtube.com/' }
            });
            const buffer = Buffer.from(file.data);
            const detected = await FileType.fromBuffer(buffer);
            if (buffer.length < 1024 || buffer.length > LIMITS[type] || !detected ||
                !/^(audio|video)\//.test(detected.mime)) continue;
            // Never send arbitrary bytes labelled MP3/MP4, even if conversion fails.
            return { buffer: await convert(buffer, type), title: media.title };
        } catch (error) {
            // Do not log signed CDN URLs, tokens, or entire Axios request objects.
            console.warn(`YouTube ${type} provider failed (${error.response?.status || error.code || 'invalid media'})`);
        }
    }
    const error = new Error('DOWNLOAD_UNAVAILABLE');
    error.code = 'DOWNLOAD_UNAVAILABLE';
    throw error;
}

async function handleYoutubeDownload(socket, m, text, type, prefix, command, options = {}) {
    const sendText = value => socket.sendMessage(m.chat, { text: value }, { quoted: m });
    if (!text) return sendText(`*Example:* ${prefix + command} Faded by Alan Walker`);
    if (active >= 2) return sendText('Two downloads are already running. Please try again shortly.');
    active++;
    let videoUrl;
    try {
        await socket.sendMessage(m.chat, { react: { text: type === 'mp3' ? '🎵' : '📽️', key: m.key } });
        const search = await (options.search || require('yt-search'))(text);
        const video = search.videos?.[0];
        if (!video) return sendText(`No results found for: ${text}`);
        videoUrl = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(text)
            ? (text.startsWith('http') ? text : `https://${text}`) : video.url;
        const media = await (options.download || downloadYoutube)(videoUrl, type);
        const title = media.title || video.title || 'YouTube Download';
        const baileys = options.baileys || require('baileys');
        const content = type === 'mp3'
            ? { audio: media.buffer, mimetype: 'audio/mpeg', ptt: false, fileName: `${title.replace(/[\\/:*?"<>|]/g, '')}.mp3` }
            : { video: media.buffer, mimetype: 'video/mp4', caption: `🎬 *${title}*` };
        // Download, conversion, metadata generation, encryption and upload ALL
        // complete before details. Only the final relay follows the details.
        const prepared = await baileys.prepareWAMessageMedia(content, { upload: socket.waUploadToServer });
        const message = baileys.generateWAMessageFromContent(m.chat, prepared, { userJid: socket.user.id, quoted: m });
        const info = `*ELITEPRO ${type === 'mp3' ? 'MUSIC' : 'VIDEO'} - DOWNLOADER*\n\n` +
            `*Title:* ${title}\n*Views:* ${video.views || '—'}\n*Duration:* ${video.timestamp || '—'}\n` +
            `*Uploaded:* ${video.ago || '—'}\n\n*URL:* ${videoUrl}`;
        try {
            if (video.thumbnail) await socket.sendMessage(m.chat, { image: { url: video.thumbnail }, caption: info }, { quoted: m });
            else await sendText(info);
        } catch {
            // A thumbnail failure must not cancel a ready download.
            await sendText(info).catch(() => {});
        }
        await socket.relayMessage(m.chat, message.message, { messageId: message.key.id });
        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } }).catch(() => {});
    } catch (error) {
        console.warn(`YouTube command failed (${error.code || 'send or search failure'})`);
        await socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
        const description = error.code === 'DOWNLOAD_UNAVAILABLE'
            ? 'The download providers could not supply a playable file. Please try again later.'
            : 'The file could not be prepared or sent. Please try again.';
        return sendText(`❌ ${description}${videoUrl ? `\nWatch or listen here: ${videoUrl}` : ''}`);
    } finally {
        active--;
    }
}

module.exports = { downloadYoutube, handleYoutubeDownload, downloadLink, normalize };
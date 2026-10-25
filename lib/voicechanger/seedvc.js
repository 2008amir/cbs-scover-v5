/**
 * Hugging Face voice clone client (Qwen3-TTS 1.7B Base; file name kept).
 *
 * The Space API was inspected live before writing this module:
 *   GET https://plachta-seed-vc.hf.space/gradio_api/info
 * Named endpoints: /predict (Seed-VC V2) and /predict_1 (V1, with F0 options).
 * /predict parameters:
 *   source_audio_path, target_audio_path, diffusion_steps, length_adjust,
 *   intelligebility_cfg_rate, similarity_cfg_rate, top_p, temperature,
 *   repetition_penalty, convert_style, anonymization_only
 * Returns: [stream audio (m3u8), full output audio (wav FileData)]
 *
 * No speech-to-text and no TTS is involved: the user's own speech is sent as
 * source audio and only its vocal identity is moved toward the reference.
 */

const axios = require('axios');
const { HF_SPACE, HF_TOKEN, REQUEST_TIMEOUT_MS } = require('./config');

// Model: Qwen3-TTS 1.7B Base voice clone (Space API inspected live):
//   Qwen/Qwen3-TTS  /generate_voice_clone(ref_audio, ref_text, target_text,
//                   language, use_xvector_only, model_size) -> [audio, status]
//   Qwen/Qwen3-ASR  /transcribe(audio_upload, lang_disp, return_ts)
// Cloning with the reference transcript (use_xvector_only=false) copies the
// reference timbre far more closely than speaker-vector-only cloning.
const ENDPOINT = '/generate_voice_clone';
const ASR_SPACE = 'Qwen/Qwen3-ASR';
const TTS_LANGS = ['Chinese', 'English', 'Japanese', 'Korean', 'French', 'German', 'Spanish', 'Portuguese', 'Russian'];

const clients = new Map();
async function getClient(space = HF_SPACE) {
    if (!clients.has(space)) {
        clients.set(space, (async () => {
            const { Client } = await import('@gradio/client');
            return Client.connect(space, HF_TOKEN ? { token: HF_TOKEN } : {});
        })().catch(err => { clients.delete(space); throw err; }));
    }
    return clients.get(space);
}

function resetClient() {
    clients.clear();
}

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error(label), { code: 'VC_TIMEOUT' })), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

function fullOutputUrl(data) {
    const items = Array.isArray(data) ? data : [data];
    const full = items.find(i => i && i.url && !i.is_stream) || items.find(i => i && i.url);
    return full ? full.url : null;
}

async function transcribe(wav) {
    const client = await getClient(ASR_SPACE);
    const result = await withTimeout(
        client.predict('/transcribe', { audio_upload: new Blob([wav], { type: 'audio/wav' }), lang_disp: 'Auto', return_ts: false }),
        REQUEST_TIMEOUT_MS, 'transcription timed out');
    const [language, text] = result?.data || [];
    const clean = String(text || '').trim();
    const lang = TTS_LANGS.find(l => new RegExp(l, 'i').test(String(language || ''))) || 'Auto';
    return { text: clean, language: lang };
}

// Reference transcripts are reused per reference (bounded).
const refTexts = new Map();
async function referenceText(referenceWav) {
    const key = require('crypto').createHash('sha1').update(referenceWav).digest('hex');
    if (refTexts.has(key)) return refTexts.get(key);
    const { text } = await transcribe(referenceWav).catch(() => ({ text: '' }));
    refTexts.set(key, text);
    while (refTexts.size > 50) refTexts.delete(refTexts.keys().next().value);
    return text;
}

/**
 * Convert one wav chunk: the user's words are spoken again in the
 * reference voice by Qwen3-TTS 1.7B Base.
 */
async function convertChunk(sourceWav, referenceWav, overrides = {}) {
    const [{ text, language }, refText] = await Promise.all([transcribe(sourceWav), referenceText(referenceWav)]);
    if (!text) throw Object.assign(new Error('no speech recognised'), { code: 'BAD_AUDIO' });
    const client = await getClient();
    const result = await withTimeout(client.predict(ENDPOINT, {
        ref_audio: new Blob([referenceWav], { type: 'audio/wav' }),
        ref_text: refText,
        target_text: text,
        language,
        use_xvector_only: !refText,
        model_size: '1.7B',
        ...overrides
    }), REQUEST_TIMEOUT_MS, 'voice clone request timed out');

    const url = fullOutputUrl(result?.data);
    if (!url) throw new Error('voice clone returned no audio');
    const headers = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000, headers });
    const buffer = Buffer.from(res.data);
    if (!buffer.length) throw new Error('voice clone returned empty audio');
    return buffer;
}

/**
 * Queue-safe conversion: only one Space request at a time so a burst of voice
 * notes never fires duplicate/parallel ZeroGPU jobs.
 */
function convert(sourceWav, referenceWav, overrides) {
    const run = inFlight.then(() => convertChunk(sourceWav, referenceWav, overrides));
    inFlight = run.catch(() => {});
    return run.catch(err => {
        // A dropped websocket needs a fresh client next time.
        const status = Number(err?.response?.status || err?.status || err?.statusCode || 0);
        if (status === 401 || status === 403 || /websocket|closed|ECONN|socket|fetch/i.test(String(err?.message))) resetClient();
        throw err;
    });
}

async function spaceStatus() {
    try {
        const { data } = await axios.get(`https://huggingface.co/api/spaces/${HF_SPACE}/runtime`, { timeout: 15000 });
        return data?.stage || 'UNKNOWN';
    } catch {
        return 'UNKNOWN';
    }
}

module.exports = { convert, spaceStatus, resetClient, ENDPOINT, HF_SPACE };

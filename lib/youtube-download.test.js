const test = require('node:test');
const assert = require('node:assert/strict');
const { handleYoutubeDownload, downloadYoutube, downloadLink } = require('./youtube-download');

const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(2048)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]);
const video = { url: 'https://youtube.com/watch?v=sz-5kP-r758', title: 'Amanar Kauna', timestamp: '2:53' };

test('provider normalization supports both Neosoft and fallback responses', () => {
    assert.equal(downloadLink({ status: true, download: 'https://cdn.test/a.mp3' }).url, 'https://cdn.test/a.mp3');
    assert.equal(downloadLink({ success: true, result: { download_url: 'https://cdn.test/a.mp4' } }).url, 'https://cdn.test/a.mp4');
    assert.equal(downloadLink({ status: false, download: 'https://cdn.test/error' }), null);
});

test('a failed primary video resolver falls through to a downloadable provider', async () => {
    const calls = [];
    const http = { get: async url => {
        calls.push(url);
        if (url === 'primary') throw Object.assign(new Error('rate limited'), { response: { status: 429 } });
        if (url === 'fallback') return { data: { success: true, result: { title: 'Amanar Kauna', download_url: 'https://cdn.test/video' } } };
        return { data: mp4 };
    } };
    const result = await downloadYoutube(video.url, 'mp4', { http, providers: ['primary', 'fallback'], normalize: async (_, type) => {
        assert.equal(type, 'mp4'); return Buffer.from('normalized playable mp4');
    } });
    assert.equal(result.title, 'Amanar Kauna');
    assert.deepEqual(calls, ['primary', 'fallback', 'https://cdn.test/video']);
});

test('HTML downloads and failed conversions are never sent as media', async () => {
    const http = { get: async url => url === 'provider' ? { data: { download: 'https://cdn.test/error' } } : { data: Buffer.from('<html>' + 'error'.repeat(400)) } };
    await assert.rejects(downloadYoutube(video.url, 'mp3', { http, providers: ['provider'], normalize: () => assert.fail('HTML reached converter') }), { code: 'DOWNLOAD_UNAVAILABLE' });
    http.get = async url => url === 'provider' ? { data: { download: 'https://cdn.test/audio' } } : { data: audio };
    await assert.rejects(downloadYoutube(video.url, 'mp3', { http, providers: ['provider'], normalize: async () => { throw new Error('invalid audio'); } }), { code: 'DOWNLOAD_UNAVAILABLE' });
});

function flow(type, overrides = {}) {
    const events = [];
    let now = 0;
    let detailsAt;
    let mediaAt;
    const socket = { user: { id: 'bot@s.whatsapp.net' }, waUploadToServer: () => {},
        sendMessage: async (_, content) => {
            if (content.text?.startsWith('*ELITEPRO')) { events.push('details'); detailsAt = now; }
        },
        relayMessage: async (_, content) => { events.push('relay'); assert.ok(content[type === 'mp3' ? 'audioMessage' : 'videoMessage']); mediaAt = now; }
    };
    const options = { search: async query => { assert.equal(query, 'amanar kauna song'); return { videos: [video] }; },
        download: async (_, format) => { assert.equal(format, type); now += 30000; events.push('download'); return { buffer: audio }; },
        baileys: {
            prepareWAMessageMedia: async () => { now += 12000; events.push('upload'); return { [type === 'mp3' ? 'audioMessage' : 'videoMessage']: {} }; },
            generateWAMessageFromContent: (_, message) => ({ key: { id: 'ready' }, message })
        }, ...overrides
    };
    return { run: () => handleYoutubeDownload(socket, { chat: 'test@s.whatsapp.net', key: { id: 'request' } }, 'amanar kauna song', type, '.', type === 'mp3' ? 'play' : 'video', options), events, gap: () => mediaAt - detailsAt };
}

test('audio relay starts less than five seconds after details, with download and upload already complete', async () => {
    const f = flow('mp3'); await f.run();
    assert.deepEqual(f.events, ['download', 'upload', 'details', 'relay']);
    assert.ok(f.gap() < 5000);
});

test('.video amanar kauna song sends a prepared video after details', async () => {
    const f = flow('mp4'); await f.run();
    assert.deepEqual(f.events, ['download', 'upload', 'details', 'relay']);
});

test('unavailable video does not announce details or attempt relay', async () => {
    const f = flow('mp4', { download: async () => { throw Object.assign(new Error('unavailable'), { code: 'DOWNLOAD_UNAVAILABLE' }); } });
    await f.run(); assert.deepEqual(f.events, []);
});
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleYoutubeDownload, downloadYoutube, downloadLink, searchYoutube, downloadDirectYoutube, DETAILS_TARGET_MS, SEARCH_TIMEOUT_MS } = require('./youtube-download');
const fs = require('fs');
const { EventEmitter } = require('events');

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
    return { run: () => handleYoutubeDownload(socket, { chat: 'test@s.whatsapp.net', key: { id: 'request' } }, 'amanar kauna song', type, '.', type === 'mp3' ? 'play' : 'video', options), events, gap: () => mediaAt - detailsAt, detailsAt: () => detailsAt };
}

test('play details appear within the three-second target before a slow audio download or upload', async () => {
    const f = flow('mp3'); await f.run();
    assert.deepEqual(f.events, ['details', 'download', 'upload', 'relay']);
    assert.equal(DETAILS_TARGET_MS, 3000);
    assert.ok(f.detailsAt() < 3000);
    assert.equal(f.gap(), 42000);
});

test('.play reacts first, sends matching YouTube information, then sends playable audio', async () => {
    const events = [];
    const request = { chat: 'test@s.whatsapp.net', key: { id: 'play-sequence' } };
    const socket = {
        user: { id: 'bot@s.whatsapp.net' }, waUploadToServer: () => {},
        sendMessage: async (_, content) => {
            if (content.react?.text === '🎵') {
                await new Promise(resolve => setTimeout(resolve, 10));
                assert.equal(content.react.key, request.key);
                events.push('reaction');
            } else if (content.text) {
                assert.match(content.text, /Amanar Kauna/);
                assert.ok(content.text.includes('https://www.youtube.com/watch?v=sz-5kP-r758'));
                events.push('youtube-info');
            }
        },
        relayMessage: async (_, content) => {
            assert.deepEqual(content.audioMessage.buffer, audio);
            events.push('audio');
        }
    };
    await handleYoutubeDownload(socket, request, 'amanar kauna song', 'mp3', '.', 'play', {
        search: async () => ({ videos: [video] }),
        download: async (url, type) => {
            assert.equal(url, video.url);
            assert.equal(type, 'mp3');
            assert.deepEqual(events, ['reaction', 'youtube-info']);
            return { buffer: audio };
        },
        baileys: {
            prepareWAMessageMedia: async content => {
                assert.equal(content.mimetype, 'audio/mpeg');
                assert.equal(content.ptt, false);
                assert.equal(content.fileName, 'Amanar Kauna.mp3');
                return { audioMessage: { buffer: content.audio } };
            },
            generateWAMessageFromContent: (_, message) => ({ key: { id: 'audio-ready' }, message })
        }
    });
    assert.deepEqual(events, ['reaction', 'youtube-info', 'audio']);
});

test('.video amanar kauna song sends a prepared video after details', async () => {
    const f = flow('mp4'); await f.run();
    assert.deepEqual(f.events, ['details', 'download', 'upload', 'relay']);
});

test('unavailable video retains its watch link details but never relays a broken file', async () => {
    const f = flow('mp4', { download: async () => { throw Object.assign(new Error('unavailable'), { code: 'DOWNLOAD_UNAVAILABLE' }); } });
    await f.run(); assert.deepEqual(f.events, ['details']);
});

test('official YouTube key is used for metadata only and does not wait for slower public search', async () => {
    const result = await searchYoutube('amanar kauna song', {
        key: 'test-only-credential', publicSearch: () => new Promise(() => {}),
        http: { get: async (url, config) => {
            assert.equal(url, 'https://www.googleapis.com/youtube/v3/search');
            assert.equal(config.headers['x-goog-api-key'], 'test-only-credential');
            assert.equal(config.params.q, 'amanar kauna song');
            assert.equal(config.timeout, 2600);
            assert.ok(SEARCH_TIMEOUT_MS < 3000);
            assert.equal(config.params.key, undefined);
            return { data: { items: [{ id: { videoId: 'sz-5kP-r758' }, snippet: { title: 'Amanar Kauna' } }] } };
        } }
    });
    assert.equal(result.videos[0].url, 'https://www.youtube.com/watch?v=sz-5kP-r758');
});

test('a failed official search still uses public metadata without borrowing Gemini keys', async () => {
    const result = await searchYoutube('amanar kauna song', { key: 'test-only-credential',
        publicSearch: async () => ({ videos: [video] }), http: { get: async () => { throw new Error('quota'); } } });
    assert.equal(result.videos[0].title, 'Amanar Kauna');
});

test('video bypasses the failing third-party providers and selects direct YouTube download', async () => {
    const result = await downloadYoutube(video.url, 'mp4', {
        http: { get: () => assert.fail('Third-party provider was called') },
        direct: async (url, type) => { assert.equal(url, video.url); assert.equal(type, 'mp4'); return { buffer: mp4 }; }
    });
    assert.deepEqual(result.buffer, mp4);
});

test('direct downloader validates, converts and cleans temporary video files', async () => {
    let output;
    const result = await downloadDirectYoutube(video.url, 'mp4', {
        spawn: (_, args) => {
            assert.ok(args.includes('--ignore-config'));
            assert.equal(args.includes('--cookies'), false);
            assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=sz-5kP-r758');
            output = args[args.indexOf('--output') + 1];
            const proc = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
            setImmediate(() => { fs.writeFileSync(output, mp4); proc.emit('close', 0); });
            return proc;
        }, normalize: async (buffer, type) => { assert.deepEqual(buffer, mp4); assert.equal(type, 'mp4'); return mp4; }
    });
    assert.deepEqual(result.buffer, mp4);
    assert.equal(fs.existsSync(output), false);
});

test('YouTube verification stops direct downloads without provider retries or leaked diagnostics', async () => {
    await assert.rejects(downloadDirectYoutube(video.url, 'mp4', { spawn: () => {
        const proc = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
        setImmediate(() => { proc.stderr.emit('data', 'Sign in to confirm you are not a bot'); proc.emit('close', 1); });
        return proc;
    } }), { code: 'YOUTUBE_ACCESS_RESTRICTED', message: 'YOUTUBE_ACCESS_RESTRICTED' });
});

test('non-YouTube URLs cannot reach the direct downloader', async () => {
    await assert.rejects(downloadDirectYoutube('https://example.test/private', 'mp4', { spawn: () => assert.fail('Invalid URL executed') }), { code: 'INVALID_VIDEO' });
});

test('video title search uses Dailymotion without invoking music or YouTube search', async () => {
    const { searchVideo } = require('./youtube-download');
    const result = await searchVideo('amanar kauna song', { http: { get: async (url, options) => {
        assert.equal(url, 'https://api.dailymotion.com/videos');
        assert.equal(options.params.search, 'amanar kauna song');
        return { data: { list: [{ id: 'x123', url: 'https://www.dailymotion.com/video/x123', title: 'Amanar Kauna', duration: 125 }] } };
    } } });
    assert.equal(result.videos[0].source, 'Dailymotion');
    assert.equal(result.videos[0].timestamp, '2:05');
});

test('Dailymotion search does not replace a missing song with an unrelated clip', async () => {
    const { searchVideo } = require('./youtube-download');
    const result = await searchVideo('amanar kauna song', { http: { get: async () => ({ data: { list: [{ url: 'https://www.dailymotion.com/video/x123', title: 'Amanar travel', duration: 30 }] } }) } });
    assert.equal(result.videos.length, 0);
});

test('video accepts public Dailymotion URLs but rejects arbitrary hosts and embedded credentials', async () => {
    const { dailymotionUrl, downloadVideo, searchVideo } = require('./youtube-download');
    assert.equal(dailymotionUrl('https://dai.ly/x2fos9'), 'https://www.dailymotion.com/video/x2fos9');
    for (const url of ['http://127.0.0.1/private', 'https://dailymotion.com.evil.test/video/x123', 'https://user:pass@www.dailymotion.com/video/x123']) {
        await assert.rejects(searchVideo(url), { code: 'VIDEO_SOURCE_UNSUPPORTED' });
    }
    const result = await downloadVideo('https://dai.ly/x2fos9', 'mp4', { direct: async (url, type) => {
        assert.equal(type, 'mp4'); return { buffer: mp4 };
    } });
    assert.deepEqual(result.buffer, mp4);
});
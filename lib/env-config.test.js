const test = require('node:test');
const assert = require('node:assert/strict');
const { readEnvKeys } = require('./keyserver');
const { imageGeminiKeys } = require('./keyserver');
const { voiceEnvironment } = require('./voicechanger/env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { configureBotSettings } = require('./env-config');
const { v1CommandNames, menuCommands } = require('./v2');

function withBotSettings(callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-command-check-'));
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ prefix: '.', autoViewStatus: false, autoLikeStatus: false }));
    const target = {};
    configureBotSettings(target, file);
    try { return callback(target, file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function runV1Setting(command, text, target, isCreator = true) {
    const source = fs.readFileSync(path.join(__dirname, 'v1', 'commands.js'), 'utf8');
    const start = source.indexOf(`case '${command}':`);
    assert.ok(start >= 0);
    const end = source.indexOf('\nbreak', start);
    const code = source.slice(start, end);
    const context = vm.createContext({ global: target, reply: value => value, isCreator,
        mess: { owner: 'owner only' }, args: text ? text.split(/\s+/) : [], text, q: text, command, prefix: target.prefix });
    return vm.runInContext(`(async () => { switch (command) { ${code}\n } })()`, context);
}

test('setprefix changes the shared prefix and persists across restart', async () => {
    let target, file, dir;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-prefix-'));
    file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{"prefix":"."}');
    target = {}; configureBotSettings(target, file);
    try {
        await runV1Setting('setprefix', '!', target);
        assert.equal(target.prefix, '!');
        const restarted = {}; configureBotSettings(restarted, file);
        assert.equal(restarted.prefix, '!');
        await runV1Setting('setprefix', 'none', target);
        assert.equal(target.prefix, '');
        await runV1Setting('setprefix', '#', target, false);
        assert.equal(target.prefix, '');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('autoviewstatus on/off updates the state consumed by V1 and V2', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-status-'));
    const file = path.join(dir, 'settings.json'); fs.writeFileSync(file, '{}');
    const target = {}; configureBotSettings(target, file);
    try {
        await runV1Setting('autoviewstatus', 'on', target);
        assert.equal(target.autoViewStatus, true);
        assert.equal(target.autoviewstatus, true);
        assert.equal(JSON.parse(fs.readFileSync(file)).autoViewStatus, true);
        await runV1Setting('autoviewstatus', 'off', target);
        assert.equal(target.autoViewStatus, false);
        assert.equal(target.autoviewstatus, false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V2 aliases update the same automation state as V1', () => withBotSettings(target => {
    target.autoViewStatus = true; assert.equal(target.autoviewstatus, true);
    target.autoLikeStatus = true; assert.equal(target.autolikestatus, true);
    target.autoread = true; assert.equal(target.autoRead, true);
    target.autoRecordType = true; assert.equal(target.autorecordtype, true);
}));

test('all V2 declarations exclude V1 duplicates and unique aliases stay in the menu', () => {
    const v1 = v1CommandNames();
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    for (const file of walk(path.join(__dirname, '..', 'v2', 'plugins')).filter(file => file.endsWith('.js'))) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/handler\.command\s*=\s*\[([^\]]*)\]/g)) {
            for (const name of match[1].matchAll(/['"]([^'"]+)['"]/g)) assert.equal(v1.has(name[1]), false, `${file}: ${name[1]}`);
        }
    }
    const menu = require('./v2').menuGroups();
    const commands = Object.values(menu).flat().map(value => value.toLowerCase());
    for (const alias of ['avs', 'autolike', 'pp', 'open', 'close', 'tttfun']) assert.ok(commands.includes(alias), alias);
    assert.ok(menuCommands().length > 0);
});

test('status watcher reads an enabled status once and stops when switched off', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'v1', 'source.js'), 'utf8');
    const start = source.indexOf('const processedStatusMessages =');
    const end = source.indexOf('//ANTISTATUS GROUP WATCHER//', start);
    const state = { autoViewStatus: true, autoLikeStatus: false };
    const context = vm.createContext({ global: state, console, Date, Map });
    vm.runInContext(source.slice(start, end), context);
    const read = [];
    const socket = { decodeJid: value => value, readMessages: async keys => read.push(...keys) };
    const message = { key: { id: 'status-one', remoteJid: 'status@broadcast', participant: '123@lid', participantAlt: '456@s.whatsapp.net' }, message: { conversation: 'test' } };
    await context.handleStatusWatcher(socket, message);
    await context.handleStatusWatcher(socket, message);
    assert.equal(read.length, 1);
    assert.equal(read[0].participant, '456@s.whatsapp.net');
    state.autoViewStatus = false;
    await context.handleStatusWatcher(socket, { ...message, key: { ...message.key, id: 'status-two' } });
    assert.equal(read.length, 1);
});

test('image pool reads five dedicated slots and never borrows chat or video keys', () => {
    const env = { GEMINI_API_KEY: 'test-chat', GEMINI_youtube_KEY: 'test-video' };
    for (let i = 1; i <= 5; i++) env[`IMAGE_GEMINI_KEY_${i}`] = `test-image-${i}`;
    const keys = readEnvKeys(env);
    assert.deepEqual(keys.imageGeminiKeys, [1, 2, 3, 4, 5].map(i => `test-image-${i}`));
    assert.deepEqual(keys.geminiKeys, ['test-chat']);
    assert.deepEqual(keys.videoGeminiKeys, ['test-video']);
});

test('image pool accepts bare, hyphen and short slot names', () => {
    const keys = readEnvKeys({
        IMAGE_GEMINI_KEY: 'test-image-1',
        'IMAGE-GEMINI-KEY-2': 'test-image-2',
        IMAGE_GEMINI_3: 'test-image-3'
    });
    assert.deepEqual(keys.imageGeminiKeys, ['test-image-1', 'test-image-2', 'test-image-3']);
});

test('imageGeminiKeys() serves the dedicated pool from the environment', async () => {
    const saved = { ...process.env };
    for (const name of Object.keys(process.env)) if (/^IMAGE_GEMINI/i.test(name)) delete process.env[name];
    process.env.IMAGE_GEMINI_KEY_1 = 'test-live-image';
    try {
        assert.deepEqual(await imageGeminiKeys(), ['test-live-image']);
    } finally {
        for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
        Object.assign(process.env, saved);
    }
});

test('missing image keys leave the pool empty without borrowing chat keys', () => {
    const keys = readEnvKeys({ GEMINI_API_KEY: 'test-chat' });
    assert.deepEqual(keys.imageGeminiKeys, []);
});

test('chat reads the five requested slots only', () => {
    const env = { GEMINI_API_KEY: 'test-chat-1', GEMINI_youtube_KEY: 'test-video' };
    for (let i = 2; i <= 5; i++) env[`GEMINI_KEY_${i}`] = `test-chat-${i}`;
    env.GEMINI_KEY_6 = 'test-outside';
    assert.deepEqual(readEnvKeys(env).geminiKeys, [1, 2, 3, 4, 5].map(i => `test-chat-${i}`));
});

test('video reads five dedicated slots and YouTube uses its own key', () => {
    const env = { GEMINI_youtube_KEY: 'test-video-1', YOUTUBE_API_KEY: 'test-search' };
    for (let i = 2; i <= 5; i++) env[`GEMINI_youtube_KEY_${i}`] = `test-video-${i}`;
    const keys = readEnvKeys(env);
    assert.deepEqual(keys.videoGeminiKeys, [1, 2, 3, 4, 5].map(i => `test-video-${i}`));
    assert.deepEqual(keys.youtubeKeys, ['test-search']);
});

test('hyphenated and legacy uppercase video names are accepted', () => {
    assert.deepEqual(readEnvKeys({ 'GEMINI_youtube_KEY-5': 'test-five', GEMINI_YOUTUBE_KEY_2: 'test-two' }).videoGeminiKeys,
        ['test-two', 'test-five']);
});

test('missing video keys never borrow chat or old dedicated keys', () => {
    const keys = readEnvKeys({ GEMINI_API_KEY: 'test-chat', VIDEO_KNOWLEDGE_GEMINI_API_KEY: 'test-old' });
    assert.deepEqual(keys.videoGeminiKeys, []);
    assert.equal(keys.videoGeminiKey, null);
    assert.equal(keys.youtubeKey, null);
});

test('blank and duplicate keys are ignored', () => {
    assert.deepEqual(readEnvKeys({ GEMINI_API_KEY: ' test-chat ', GEMINI_KEY_2: 'test-chat', GEMINI_KEY_3: ' ' }).geminiKeys,
        ['test-chat']);
});

test('HF token aliases are trimmed and primary takes precedence', () => {
    assert.equal(voiceEnvironment({ HF_TOKEN: ' test-primary ', HUGGINGFACE_TOKEN: 'test-fallback' }).HF_TOKEN, 'test-primary');
    assert.equal(voiceEnvironment({ HF_TOKEN: ' ', HUGGINGFACE_TOKEN: ' test-fallback ' }).HF_TOKEN, 'test-fallback');
});

test('Space URLs normalize and invalid numbers use safe defaults', () => {
    const config = voiceEnvironment({ HF_SPACE: ' https://huggingface.co/spaces/Plachta/Seed-VC/ ',
        VC_CHUNK_SECONDS: 'oops', VC_DIFFUSION_STEPS: '-1', VC_TIMEOUT_MS: 'Infinity' });
    assert.equal(config.HF_SPACE, 'Plachta/Seed-VC');
    assert.equal(config.CHUNK_SECONDS, 45);
    assert.equal(config.DIFFUSION_STEPS, 30);
    assert.equal(config.REQUEST_TIMEOUT_MS, 240000);
});
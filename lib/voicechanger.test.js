const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWav, prepareReference, wavDuration } = require('./voicechanger/audio');
const { voiceEnvironment } = require('./voicechanger/env');

function recording(segments) {
    const data = Buffer.alloc(segments.reduce((sum, [seconds]) => sum + seconds, 0) * 22050 * 2);
    let offset = 0;
    for (const [seconds, amplitude] of segments) for (let i = 0; i < seconds * 22050; i++) {
        data.writeInt16LE(Math.round(amplitude * Math.sin(i * 0.1)), offset); offset += 2;
    }
    return buildWav({ channels: 1, sampleRate: 22050, bitsPerSample: 16, data });
}

test('reference selection keeps audible speech instead of leading silence, bounded to 20 seconds', () => {
    const selected = prepareReference(recording([[15, 0], [20, 8000], [5, 0]]));
    assert.equal(wavDuration(selected.wav), 20); assert.equal(selected.speechSeconds, 20);
});

test('short reference cannot pass the 10-second audible-speech requirement', () => {
    const selected = prepareReference(recording([[12, 0], [4, 8000], [12, 0]]));
    assert.equal(selected.speechSeconds, 4); assert.ok(selected.speechSeconds < 10);
    assert.throws(() => prepareReference(recording([[20, 0]])), /silent/);
});

test('similarity settings use supported V2 fields and normalize invalid overrides', () => {
    const defaults = voiceEnvironment({});
    assert.equal(defaults.DIFFUSION_STEPS, 50); assert.equal(defaults.SIMILARITY_CFG, 0.9); assert.equal(defaults.CONVERT_STYLE, true);
    const overrides = voiceEnvironment({ VC_SIMILARITY_CFG: '0.8', VC_CONVERT_STYLE: 'false' });
    assert.equal(overrides.SIMILARITY_CFG, 0.8); assert.equal(overrides.CONVERT_STYLE, false);
    assert.equal(voiceEnvironment({ VC_SIMILARITY_CFG: '999' }).SIMILARITY_CFG, 0.9);
});
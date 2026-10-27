const test = require('node:test');
const assert = require('node:assert/strict');
const { sendGroupStatus } = require('./group-status');

for (const content of [{ text: 'Hello group', font: 1 }, { image: Buffer.from('image'), caption: 'Photo' },
    { video: Buffer.from('video'), mimetype: 'video/mp4' }, { audio: Buffer.from('audio'), mimetype: 'audio/mpeg', ptt: true }]) {
    test(`group status prepares ${Object.keys(content)[0]} before wrapping and relaying`, async () => {
        const real = require('baileys');
        let relay;
        const socket = { user: { id: '123@s.whatsapp.net' }, waUploadToServer() {},
            relayMessage: async (jid, message, options) => { relay = { jid, message, options }; } };
        const type = Object.keys(content)[0] === 'text' ? 'extendedTextMessage' : `${Object.keys(content)[0]}Message`;
        await sendGroupStatus(socket, '123@g.us', content, { baileys: { ...real,
            generateWAMessageContent: async (input, options) => {
                assert.equal(input.groupStatusMessage, undefined);
                assert.equal(input.contextInfo.isGroupStatus, true);
                assert.equal(options.upload, socket.waUploadToServer);
                return { [type]: { contextInfo: input.contextInfo } };
            }
        } });
        const decoded = real.proto.Message.decode(real.proto.Message.encode(relay.message).finish());
        assert.equal(decoded.groupStatusMessageV2.message[type].contextInfo.isGroupStatus, true);
        assert.equal(relay.jid, '123@g.us');
        assert.match(relay.options.messageId, /^3EB0[A-F0-9]{32}$/);
    });
}
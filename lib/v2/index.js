/* ============================================================
   CBS-SCOVER-V2 command layer (CommonJS -> ESM bridge)
   ------------------------------------------------------------
   The full ELITE-PRO-V2 bot lives in ../../v2 exactly as shipped.
   This module lets the CommonJS V1 handler dispatch into the real
   V2 plugin engine, so both versions share one process, one
   WhatsApp connection and one HTTP server.
   ============================================================ */

const path = require('path');
const { pathToFileURL } = require('url');

const BRIDGE_PATH = path.join(__dirname, '..', '..', 'v2', 'bridge.js');

/* Commands V2 adds on top of V1 (used for the menu when the plugin engine has
   not finished loading yet). */
const FALLBACK_COMMANDS = [
    'autoviewlike', 'avl', 'avs', 'calc', 'calculator', 'dino', 'doom',
    'html', 'leavegroup', 'owners', 'piano', 'removeowner', 'sendhtml',
    'setting', 'speed', 'tovoice'
];

let bridgePromise = null;
let bridge = null;

const EXTRA_COMMANDS = new Set([
    'chatbot', 'chatbot-love', 'chatbotlove', 'chatbot-friend', 'chatbotfriend',
    'chatbot-love-start', 'chatbotlovestart', 'chatbot-lovestart',
    'voicehelp', 'addvoice', 'voices', 'delvoice', 'renamevoice', 'voicechanger'
]);
const claimedMessages = new Map();

function messageText(m) {
    const msg = m?.message?.ephemeralMessage?.message || m?.message?.viewOnceMessageV2?.message ||
        m?.message?.viewOnceMessage?.message || m?.message || {};
    return String(m?.text || m?.body || msg.conversation || msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption || msg.videoMessage?.caption || msg.documentMessage?.caption || '');
}

function parseCommand(body, prefix = global.prefix ?? '.') {
    if (typeof body !== 'string' || !body.startsWith(prefix)) return null;
    const rest = body.slice(prefix.length);
    if (prefix && /^\s/.test(rest)) return null;
    const command = rest.trim().split(/\s+/)[0]?.toLowerCase();
    return command ? { command, prefix, body } : null;
}

async function isKnownCommand(command) {
    if (!command) return false;
    if (EXTRA_COMMANDS.has(command) || /^(?:aivoice|av)(?:[-_]?(hausa|male|female))?(?:[-_]?(hausa|male|female))?$/.test(command)) return true;
    return v1CommandNames().has(command) || await owns(command);
}

/* Claim synchronously before any await. Shared across reconnects, bounded by
   both age and count, and scoped to the linked account, chat and sender. */
function claimMessage(sock, m, stage = 'dispatch', now = Date.now()) {
    const id = m?.key?.id;
    const chat = m?.key?.remoteJid || m?.chat;
    if (!id || !chat) return false;
    const account = String(sock?.user?.id || '').replace(/:\d+@/, '@');
    const key = JSON.stringify([stage, account, chat, m.key.participant || '', !!m.key.fromMe, id]);
    for (const [entry, timestamp] of claimedMessages) {
        if (now - timestamp < 24 * 60 * 60 * 1000) break;
        claimedMessages.delete(entry);
    }
    if (claimedMessages.has(key)) return false;
    claimedMessages.set(key, now);
    while (claimedMessages.size > 10000) claimedMessages.delete(claimedMessages.keys().next().value);
    return true;
}

function v1CommandNames() {
    const fs = require('fs');
    const names = new Set();
    for (const file of ['ElitePro.js', 'lib/v1/commands.js']) {
        let source = '';
        try { source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8'); } catch { continue; }
        for (const match of source.matchAll(/(?:case\s*|command\s*===\s*)['"]([a-z0-9_-]+)['"]/gi)) names.add(match[1].toLowerCase());
    }
    return names;
}

function loadBridge() {
    if (!bridgePromise) {
        bridgePromise = import(pathToFileURL(BRIDGE_PATH).href)
            .then((mod) => { bridge = mod; return mod; })
            .catch((err) => {
                console.error('[V2] bridge failed to load:', err?.message || err);
                bridgePromise = null;
                return null;
            });
    }
    return bridgePromise;
}

/* Warm the plugin engine up as soon as the socket is available. */
async function init(EliteProTech) {
    const mod = await loadBridge();
    if (!mod) return false;
    try {
        await mod.init(EliteProTech);
        return true;
    } catch (err) {
        console.error('[V2] init failed:', err?.message || err);
        return false;
    }
}

async function handleCommands(EliteProTech, m, { command }) {
    const mod = await loadBridge();
    if (!mod) return false;
    await mod.init(EliteProTech);
    if (!mod.owns(command)) return false;
    return await mod.handle(EliteProTech, m, { command });
}

/* True when the command is a unique V2 plugin command (not a V1 spelling). */
async function owns(command) {
    const mod = await loadBridge();
    if (!mod) return false;
    try { return mod.owns(command); } catch { return false; }
}

/* V2 keeps the owner shell on its own "$" prefix. */
async function handleShell(EliteProTech, m) {
    const mod = await loadBridge();
    if (!mod) return false;
    await mod.init(EliteProTech);
    return await mod.handle(EliteProTech, m, { command: '', isCustomPrefix: true });
}

/* Read every V2 plugin's declared commands straight off disk, grouped by the
   plugin folder, so the menu lists all V2 sections even before the plugin
   engine has finished loading. */
const PLUGIN_DIR = path.join(__dirname, '..', '..', 'v2', 'plugins');

function scanPluginGroups() {
    const fs = require('fs');
    const groups = {};
    const v1 = v1CommandNames();

    const walk = (dir, category) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const name = entry.name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                walk(full, category || name);
                continue;
            }
            if (!entry.name.endsWith('.js')) continue;
            let src = '';
            try { src = fs.readFileSync(full, 'utf-8'); } catch { continue; }

            const names = [];
            for (const match of src.matchAll(/handler\.command\s*=\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g)) {
                for (const cmd of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
                    if (!v1.has(cmd[1].toLowerCase())) names.push(cmd[1].toLowerCase());
                }
            }
            if (/handler\.customPrefix/.test(src)) names.push('Shell ($cmd)');
            if (!names.length) continue;

            const key = category || 'Other';
            groups[key] = groups[key] || [];
            groups[key].push(...names);
        }
    };

    walk(PLUGIN_DIR, '');

    const out = {};
    for (const key of Object.keys(groups).sort()) {
        const unique = [...new Set(groups[key])].sort();
        out[key] = unique.map(n => n.charAt(0).toUpperCase() + n.slice(1));
    }
    return out;
}

function menuGroups() {
    const groups = scanPluginGroups();
    if (Object.keys(groups).length) return groups;
    return { Commands: menuCommands() };
}

function menuCommands() {
    let names = [];
    try {
        if (bridge) names = bridge.commandNames();
    } catch {}
    if (!names.length) names = FALLBACK_COMMANDS.slice();

    const seen = new Set();
    const list = [];
    for (const name of names.sort()) {
        const key = String(name).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(key.charAt(0).toUpperCase() + key.slice(1));
    }
    list.push('Shell ($cmd)');
    return list;
}

module.exports = {
    messageText,
    parseCommand,
    isKnownCommand,
    claimMessage,
    v1CommandNames,
    owns,
    init,
    menuGroups,
    handleCommands,
    handleShell,
    menuCommands,
    get MENU_COMMANDS() { return menuCommands(); },
    get MENU_GROUPS() { return menuGroups(); }
};

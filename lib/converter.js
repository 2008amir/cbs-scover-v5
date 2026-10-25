const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; 

function ffmpeg(buffer, args = [], ext = '', ext2 = '') {
  return (async () => {
    const tempDir = path.join(__dirname, '..', 'database', 'temp');
    await fs.promises.mkdir(tempDir, { recursive: true });
    const dir = await fs.promises.mkdtemp(path.join(tempDir, 'convert-'));
    const tmp = path.join(dir, `input.${ext || 'bin'}`);
    const out = path.join(dir, `output.${ext2 || 'bin'}`);
    try {
      await fs.promises.writeFile(tmp, buffer);
      await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, ['-nostdin', '-y', '-i', tmp, ...args, out], { stdio: 'ignore' });
        const timer = setTimeout(() => { proc.kill('SIGKILL'); }, 120000);
        proc.once('error', error => { clearTimeout(timer); reject(error); });
        proc.once('close', code => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`));
        });
      });
      return await fs.promises.readFile(out);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  })();
}

/**
 * Convert Audio to Playable WhatsApp Audio
 * @param {Buffer} buffer Audio Buffer
 * @param {String} ext File Extension 
 */
function toAudio(buffer, ext) {
  return ffmpeg(buffer, [
    '-vn',
    '-ac', '2',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'mp3'
  ], ext, 'mp3');
}

/**
 * Convert Audio to Playable WhatsApp PTT
 * @param {Buffer} buffer
 * @param {String} ext
 */
function toPTT(buffer, ext) {
  return ffmpeg(buffer, [
    '-vn',
    '-ac', '1',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', '96k',
    '-vbr', 'on',
    '-compression_level', '10',
    '-application', 'voip',
    '-f', 'ogg'
  ], ext, 'ogg');
}

/**
 * Convert Audio to Playable WhatsApp Video
 * @param {Buffer} buffer Video Buffer
 * @param {String} ext File Extension 
 */
function toVideo(buffer, ext) {
  return ffmpeg(buffer, [
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-ab', '128k',
    '-ar', '44100',
    '-crf', '32',
    '-preset', 'slow'
  ], ext, 'mp4');
}

module.exports = {
  toAudio,
  toPTT,
  toVideo,
  ffmpeg,
};

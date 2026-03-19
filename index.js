const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : NaN;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN environment variable.');
  process.exit(1);
}
if (!Number.isFinite(OWNER_ID)) {
  console.error('Missing/invalid OWNER_ID environment variable (must be numeric).');
  process.exit(1);
}

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_BYTES = 50 * 1024 * 1024;

function ensureDownloadsDir() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function execAsync(command) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr || stdout || error.message;
        reject(new Error(details));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getLatestFileInDownloads() {
  ensureDownloadsDir();
  const files = fs
    .readdirSync(DOWNLOADS_DIR)
    .map((name) => path.join(DOWNLOADS_DIR, name))
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());

  if (files.length === 0) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

// Uses system-installed yt-dlp (assumed available in PATH).
// - type: "mp4" or "mp3"
// - After download completes, we pick the latest file in ./downloads and return its path.
async function downloadMedia(url, type) {
  ensureDownloadsDir();

  const outputTemplate = path.join(DOWNLOADS_DIR, '%(title)s.%(ext)s');
  const outputArg = `"${outputTemplate}"`;
  const urlArg = `"${url}"`;

  // Note: we do NOT install yt-dlp in code; the environment must provide it.
  const cmd =
    type === 'mp3'
      ? `yt-dlp -x --audio-format mp3 -o ${outputArg} ${urlArg}`
      : `yt-dlp -f "best[filesize<50M]" -o ${outputArg} ${urlArg}`;

  await execAsync(cmd);

  const latest = getLatestFileInDownloads();
  if (!latest) throw new Error('No file found after download');
  return latest;
}

function extractFirstUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/\S+/i);
  return match ? match[0].replace(/[)\]}>,.]+$/, '') : null;
}

function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// NOTE: previous yt-dlp-exec based downloader was removed per requirement.

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Inline-button flow:
// - When a user sends a URL, we ask which format to download (MP4/MP3).
// - On button click, we download + upload, then delete the file.
bot.on('callback_query', async (cq) => {
  const data = cq?.data || '';
  const msg = cq?.message;

  // Owner-only access: ignore everyone else.
  if (!cq?.from?.id || cq.from.id !== OWNER_ID) return;
  if (!msg?.chat?.id || !msg?.message_id) return;

  // Always acknowledge the button press to stop the loading spinner.
  try {
    await bot.answerCallbackQuery(cq.id);
  } catch {
    // ignore
  }

  const [typeRaw, ...rest] = data.split('|');
  const url = rest.join('|');

  const type = typeRaw === 'download_mp3' ? 'mp3' : typeRaw === 'download_mp4' ? 'mp4' : null;
  if (!type || !url || !isValidHttpUrl(url)) {
    await bot.editMessageText('Invalid link', {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    return;
  }

  let filePath = null;
  try {
    await bot.editMessageText('Downloading...', {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });

    filePath = await downloadMedia(url, type);
    if (!filePath || !fs.existsSync(filePath)) {
      await bot.editMessageText('Download failed', {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.size > MAX_BYTES) {
      await bot.editMessageText('File too large', {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
      return;
    }

    await bot.editMessageText('Uploading...', {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });

    if (type === 'mp3') {
      await bot.sendAudio(msg.chat.id, fs.createReadStream(filePath));
    } else {
      await bot.sendVideo(msg.chat.id, fs.createReadStream(filePath));
    }

    await bot.sendMessage(msg.chat.id, 'Done');
  } catch {
    try {
      await bot.editMessageText('Download failed', {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
    } catch {
      // ignore
    }
  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore cleanup failures
      }
    }
  }
});

bot.on('message', async (msg) => {
  // Owner-only access: ignore everyone else.
  if (!msg?.from?.id || msg.from.id !== OWNER_ID) return;

  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.trim() === '/start') {
    await bot.sendMessage(chatId, 'Send me a link');
    return;
  }

  // Only treat messages containing a URL as requests.
  if (!text.includes('http')) return;

  const url = extractFirstUrl(text);
  if (!url || !isValidHttpUrl(url)) {
    await bot.sendMessage(chatId, 'Invalid link');
    return;
  }

  // Do not download immediately; ask user to choose format via inline buttons.
  await bot.sendMessage(chatId, 'Choose format:', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'MP4 🎬', callback_data: `download_mp4|${url}` },
          { text: 'MP3 🎧', callback_data: `download_mp3|${url}` }
        ]
      ]
    }
  });
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err?.message || err);
});

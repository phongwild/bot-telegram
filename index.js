require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const ytdlp = require('yt-dlp-exec');
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

function parseRequestedType(text) {
  const t = (text || '').trim().toLowerCase();
  if (t.startsWith('/mp3')) return 'mp3';
  if (t.startsWith('/mp4')) return 'mp4';
  return 'mp4';
}

async function downloadMediaUnderLimit(url, messageId, type) {
  ensureDownloadsDir();

  // Prefix output with messageId to reliably locate the downloaded file.
  const outTemplate = path.join(DOWNLOADS_DIR, `${messageId}-%(id)s.%(ext)s`);

  const baseOpts = {
    output: outTemplate,
    maxFilesize: '50M',
    noWarnings: true,
    noPlaylist: true
  };

  if (type === 'mp3') {
    const format = 'bestaudio[filesize<=50M]/bestaudio/best[filesize<=50M]/best';
    await ytdlp(url, {
      ...baseOpts,
      format,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '0'
    });
  } else {
    // Try hard to keep the result under 50MB.
    // - Prefer a combined best video+audio where each stream respects filesize constraint.
    // - Fallback progressively to simpler/best options.
    const format =
      'bv*[filesize<=50M]+ba[filesize<=50M]/b[filesize<=50M]/best[filesize<=50M]/best';

    await ytdlp(url, {
      ...baseOpts,
      format,
      mergeOutputFormat: 'mp4'
    });
  }

  const files = fs
    .readdirSync(DOWNLOADS_DIR)
    .filter((f) => f.startsWith(`${messageId}-`))
    .map((f) => path.join(DOWNLOADS_DIR, f));

  if (files.length === 0) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

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

    filePath = await downloadMediaUnderLimit(url, msg.message_id, type);
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

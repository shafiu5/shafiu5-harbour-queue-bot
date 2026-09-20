import fs from 'node:fs';
import path from 'node:path';
import { Bot, InlineKeyboard } from 'grammy';
import { norm, parseQueue, evaluate, describe } from './queue.js';

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error('BOT_TOKEN is required');

const QUEUE_URL = process.env.QUEUE_URL || 'https://local.port.mv/api/portal/vessel-queue';
const INTERVAL_MIN = Number(process.env.POLL_MINUTES || 15);
const MAX_WATCHES = Number(process.env.MAX_WATCHES || 5);
const DATA_DIR = process.env.DATA_DIR || './data';
const ALLOWED = (process.env.ALLOWED_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- state (small JSON file; plenty for one group) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let state = { chats: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }

function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
const watchesFor = (chatId) => (state.chats[chatId] ??= { watches: [] }).watches;

// ---------- queue polling ----------
let latest = null; // { at: Date, vessels: [...], raw: any }

async function fetchQueue() {
  const res = await fetch(QUEUE_URL, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://local.port.mv/vessel-queue',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const vessels = parseQueue(raw);
  // An empty list is far more likely a bad response than an empty harbour.
  // Skip the cycle rather than telling everyone their boat left.
  if (!vessels.length) throw new Error('no vessels parsed from response');
  return { at: new Date(), vessels, raw };
}

async function poll() {
  try {
    latest = await fetchQueue();
  } catch (err) {
    console.error(new Date().toISOString(), 'poll failed:', err.message);
    return;
  }
  for (const [chatId, chat] of Object.entries(state.chats)) {
    for (let i = 0; i < chat.watches.length; i++) {
      const { message, next } = evaluate(chat.watches[i], latest.vessels);
      chat.watches[i] = next;
      if (message) {
        try { await bot.api.sendMessage(chatId, message); }
        catch (err) { console.error('send failed', chatId, err.message); }
      }
    }
  }
  save();
  console.log(new Date().toISOString(), `polled: ${latest.vessels.length} vessels`);
}

// ---------- bot ----------
const bot = new Bot(TOKEN);
const pendingLabels = new Map(); // key -> text as the user typed it

// /id works anywhere so you can find your group's chat ID
bot.command('id', (ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}`));

// Everything else is limited to the allowed chats
bot.use(async (ctx, next) => {
  if (ALLOWED.length && !ALLOWED.includes(String(ctx.chat?.id))) return;
  await next();
});

const HELP = [
  'North Harbour queue watch',
  '',
  '/watch <boat name> — watch a boat (max ' + MAX_WATCHES + ')',
  '/status — where your boats are now',
  '/unwatch — stop watching a boat',
  '',
  `I check the queue every ${INTERVAL_MIN} min. If a boat isn't in the queue yet I scan quietly and message when it appears.`,
].join('\n');
bot.command(['start', 'help'], (ctx) => ctx.reply(HELP));

function addWatch(chatId, key, fallbackLabel) {
  const watches = watchesFor(chatId);
  if (watches.some((w) => w.key === key)) return 'Already watching that boat.';
  if (watches.length >= MAX_WATCHES) return `Limit reached (${MAX_WATCHES} boats). Use /unwatch to free a slot.`;

  const v = latest?.vessels.find((x) => x.key === key);
  if (v) {
    watches.push({ key, label: v.name, present: true, queue: v.queue, position: v.position, status: v.status });
    save();
    return `🟢 ${v.name} is IN QUEUE\n${describe(v)}\n\nI'll message here when anything changes.`;
  }
  const label = fallbackLabel || key;
  watches.push({ key, label, present: false });
  save();
  return `👀 Watching for ${label}.\nNot in the queue right now — I'll scan every ${INTERVAL_MIN} min and message here when it appears.`;
}

bot.command('watch', async (ctx) => {
  const text = (ctx.match || '').trim();
  const q = norm(text);
  if (!q) return ctx.reply('Usage: /watch <boat name>\nExample: /watch furaaqu 2');

  const matches = (latest?.vessels ?? []).filter((v) => v.key.includes(q));
  const exact = matches.find((v) => v.key === q);
  if (exact || matches.length === 1) {
    return ctx.reply(addWatch(ctx.chat.id, (exact ?? matches[0]).key));
  }
  if (!matches.length) {
    return ctx.reply(addWatch(ctx.chat.id, q, text.toUpperCase()));
  }

  // Several boats match: let them pick, or keep the name exactly as typed
  pendingLabels.set(q, text.toUpperCase());
  const kb = new InlineKeyboard();
  const seen = new Set();
  for (const v of matches) {
    if (seen.has(v.key) || seen.size >= 8) continue;
    seen.add(v.key);
    kb.text(v.reg ? `${v.name} (${v.reg})` : v.name, `w:${v.key.slice(0, 60)}`).row();
  }
  kb.text(`Watch "${text.toUpperCase()}" as typed`, `w:${q.slice(0, 60)}`);
  return ctx.reply('Which boat?', { reply_markup: kb });
});

bot.callbackQuery(/^w:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(addWatch(ctx.chat.id, key, pendingLabels.get(key)));
});

bot.command('status', (ctx) => {
  const watches = watchesFor(ctx.chat.id);
  if (!watches.length) return ctx.reply('Not watching any boats. Use /watch <boat name>.');
  const blocks = watches.map((w) =>
    w.present ? `🟢 ${w.label}\n${describe(w)}` : `👀 ${w.label}\nNot in queue — scanning`,
  );
  const asOf = latest
    ? latest.at.toLocaleTimeString('en-GB', { timeZone: 'Indian/Maldives', hour: '2-digit', minute: '2-digit' })
    : 'not loaded yet';
  return ctx.reply(`${blocks.join('\n\n')}\n\nQueue data as of ${asOf}`);
});

bot.command(['unwatch', 'stop'], (ctx) => {
  const watches = watchesFor(ctx.chat.id);
  if (!watches.length) return ctx.reply('Not watching any boats.');
  const kb = new InlineKeyboard();
  for (const w of watches) kb.text(`✖ ${w.label}`, `u:${w.key.slice(0, 60)}`).row();
  return ctx.reply('Stop watching which boat?', { reply_markup: kb });
});

bot.callbackQuery(/^u:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const chat = state.chats[ctx.chat.id];
  const gone = chat?.watches.find((w) => w.key === key);
  if (chat) chat.watches = chat.watches.filter((w) => w.key !== key);
  save();
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(gone ? `Stopped watching ${gone.label}.` : 'That boat was not being watched.');
});

// Debug helper: shows how the first vessel was parsed next to the raw data,
// so the FIELD patterns in queue.js can be corrected if something is off.
bot.command('raw', (ctx) => {
  if (!latest) return ctx.reply('No queue data loaded yet — check the container logs.');
  const parsed = JSON.stringify(latest.vessels[0], null, 2);
  const raw = JSON.stringify(latest.raw, null, 2).slice(0, 2500);
  return ctx.reply(`Parsed (${latest.vessels.length} vessels), first one:\n${parsed}\n\nRaw start:\n${raw}`);
});

bot.catch((err) => console.error('bot error:', err.message));

await bot.api.setMyCommands([
  { command: 'watch', description: 'Watch a boat: /watch <name>' },
  { command: 'status', description: 'Where your boats are now' },
  { command: 'unwatch', description: 'Stop watching a boat' },
  { command: 'help', description: 'How this works' },
]);

await poll();
setInterval(poll, INTERVAL_MIN * 60_000);
bot.start(); // long polling — no domain, webhook or open port needed
console.log('bot running');

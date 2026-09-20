# North Harbour queue bot

Telegram bot for one group: `/watch <boat>` and it posts when that boat enters the
MNH vessel queue, then on every change to its queue/position/status, then when it leaves.
Checks https://local.port.mv/api/portal/vessel-queue every 15 min. Max 5 boats.

## Setup
1. @BotFather → /newbot → copy the token. Then /setprivacy → Disable, so the bot
   sees commands in the group.
2. Add the bot to your group. Send `/id` there and note the chat ID (negative number).
3. Coolify → New resource → this repo (Dockerfile build). Env vars:
   BOT_TOKEN, ALLOWED_CHAT_IDS=<chat id>. Add a persistent volume at `/data`.
4. Deploy. In the group: `/watch furaaqu 2`.

## Commands
/watch <name> · /status · /unwatch · /help · /raw (debug: shows parsed vs raw API data)

## If the parsed fields look wrong
The API's JSON keys are guessed by pattern in `queue.js` (FIELD). Run `/raw`, compare,
and adjust the regexes. If the site blocks the container's requests (403), copy the
Cookie header from a browser session into `fetchQueue()` in `bot.js`.

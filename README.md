# Arc v4 Buy Bot

A free, open-source Telegram buy bot for **Uniswap v4 pools on Arc** (Circle's L1), including cirBTC-paired pools.

When Arc mainnet launched there was no buy bot that supported its v4 pools, so we built one for [$PIGSATS](https://piggysats.fun). It has been running live in [t.me/piggysats](https://t.me/piggysats) since 24 September 2026. Any Arc project can use it.

## What it does

- Posts every buy of your token into a Telegram group, usually within a minute: amount spent (USD and quote token), tokens received, buyer, a 🆕 **New holder** badge, market cap, and links (TX · Chart · Buy · Website).
- Finds the **real buyer** even when the trade goes through a router or aggregator: it follows the token transfers inside the transaction, not just the sender.
- Optional **daily report**: number of buys and sells, volume, new holders, and (for Argus launches) cirBTC paid into and claimed from the holder reward contract.
- Whale header for big buys, one emoji per $X spent, optional GIF or image, custom footer.
- **Read-only.** It has no wallet and no private key, and it can't trade or move funds.

## How it works

A single Cloudflare Worker (`worker.js`) runs every minute on the **free plan**:

1. `eth_getLogs` for `Swap` events on the Uniswap v4 **PoolManager**, filtered to your **pool ID**.
2. Groups the swaps by transaction and decides buy or sell from v4's signed amounts (trader-side: negative = paid in, positive = received).
3. Reads the receipt to find the wallet that actually received the tokens, and checks its balance for the new-holder badge.
4. Prices the buy from DexScreener (CoinGecko BTC as a fallback) and posts it via the Telegram Bot API.
5. Stores a cursor in **D1**, so an outage is caught up instead of skipped (up to ~3 hours back).

Arc's public RPC rate-limits Cloudflare's shared IPs (HTTP 429). The bot therefore rotates across several keyless endpoints (publicnode, Blockdaemon, QuickNode, Arc). You can add your own endpoint to `RPC_URL`.

## Set it up for your token (about 15 minutes)

**1. Telegram**
- Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
- Add the bot to your group and make it an **admin**, so anti-spam bots don't remove it.

**2. Cloudflare**
- Fork this repo.
- Cloudflare → **Storage & databases → D1** → create a database (any name). Copy its ID into `wrangler.jsonc` (`database_id`).
- Cloudflare → **Workers & Pages → Create → Import a repository** → pick your fork. The cron (every minute) and the D1 binding (`DB`) come from `wrangler.jsonc`.
- Worker → **Settings → Variables and Secrets**:
  - Secret `TELEGRAM_BOT_TOKEN` = your bot token
  - Variables (these override the defaults at the top of `worker.js`):

| Variable | What to put |
|---|---|
| `CHAT_ID` | `@yourgroup` or the numeric chat id |
| `POOL_ID` | your pool's v4 pool ID (bytes32). It's in the pool's DexScreener URL on Arc, or in the `Initialize` event. |
| `TOKEN_ADDRESS`, `TOKEN_SYMBOL`, `TOKEN_DECIMALS`, `TOTAL_SUPPLY` | your token |
| `QUOTE_ADDRESS`, `QUOTE_SYMBOL`, `QUOTE_DECIMALS` | what it's paired with (cirBTC `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0`, 8 decimals; or USDC, EURC, …) |
| `DEXSCREENER_API` | `https://api.dexscreener.com/latest/dex/tokens/<your token>` |
| `CHART_URL`, `BUY_URL`, `SITE_URL`, `FOOTER` | your links and a one-line footer |
| `REPORT_ENABLED` | `0` unless your token has an Argus reward tracker (then set `REWARD_TRACKER` and `CLAIM_URL`) |

The first run starts from the current block, so it won't spam old buys. Set an `ADMIN_KEY` secret to unlock `/status`, `/scan` (dry run), `/test` (posts a labelled replay of the latest buy) and `/report`.

## Settings you might tweak

`MIN_BUY_USD` (skip tiny buys) · `WHALE_USD` (default 250) · `EMOJI` / `EMOJI_STEP_USD` · `MEDIA_URL` (GIF or image on every post) · `REPORT_HOUR_UTC` · `RPC_URL` (comma-separated, tried in rotation).

## Notes

- The PoolManager on Arc is `0x8366a39cc670b4001a1121b8f6a443a643e40951`. Change `POOL_MANAGER` if yours differs.
- Tax tokens (for example Argus launches) take the fee as a separate transfer. The "Got" amount is what the buyer actually received.
- One pool per worker. To watch several pools, deploy one worker for each.

## License

MIT. Use it, fork it, ship it. If it helps you, a shout-out to [@piggysats](https://x.com/piggysats) is appreciated. 🐷

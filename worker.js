/*
 * Arc v4 Buy Bot - Telegram buy bot for Uniswap v4 pools on Arc
 * (live example: Piggy Sats, $PIGSATS - https://piggysats.fun)
 *
 * A Cloudflare Worker that checks the Arc chain every minute for new buys on one
 * Uniswap v4 pool and posts each buy to a Telegram group. The defaults below are
 * the live $PIGSATS/cirBTC setup; override them with Worker variables for your token.
 *
 * It only READS the blockchain and SENDS Telegram messages. It has no wallet,
 * no private key, and cannot trade or move funds.
 *
 * What it needs in the Cloudflare dashboard (README.md has the step-by-step setup):
 * Secret TELEGRAM_BOT_TOKEN the token @BotFather gives you
 * Secret ADMIN_KEY any long password you make up (protects /test, /scan, /status)
 * Binding D1 database variable name: DB
 * Trigger Cron * * * * * (every minute)
 *
 * Every value in DEFAULTS below can be overridden by adding a Worker variable
 * with the same name (e.g. MIN_BUY_USD = 5). No need to edit this file.
 */

const DEFAULTS = {
  // Where to post
  CHAT_ID: "@piggysats", // public group username, or numeric id like -1001234567890
  THREAD_ID: "", // only if the group uses Topics: the topic's message_thread_id

  // Chain + pool (Arc mainnet, Uniswap v4 pool created by Argus)
  RPC_URL: "https://arc-rpc.publicnode.com,https://rpc.blockdaemon.mainnet.arc.io,https://rpc.quicknode.mainnet.arc.io,https://rpc.mainnet.arc.io", // tried in rotation
  POOL_MANAGER: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  POOL_ID: "0xd13da850dd07e36ec5a03fe6d17fe8bd8ca13da437f7aa354ae914a5bf29c917",
  TOKEN_ADDRESS: "0xeF7e29A61996f7eed5cC53352B0296E7b60B09eB",
  TOKEN_SYMBOL: "PIGSATS",
  TOKEN_DECIMALS: "18",
  TOTAL_SUPPLY: "1000000000",
  QUOTE_ADDRESS: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
  QUOTE_SYMBOL: "cirBTC",
  QUOTE_DECIMALS: "8",

  // Links shown under every buy
  EXPLORER_URL: "https://arc.etherscan.io",
  CHART_URL: "https://dexscreener.com/arc/0xd13da850dd07e36ec5a03fe6d17fe8bd8ca13da437f7aa354ae914a5bf29c917",
  BUY_URL: "https://argus.world/token/0xeF7e29A61996f7eed5cC53352B0296E7b60B09eB",
  SITE_URL: "https://piggysats.fun",

  // Prices (USD value + market cap). CoinGecko BTC price is only a fallback.
  DEXSCREENER_API: "https://api.dexscreener.com/latest/dex/tokens/0xeF7e29A61996f7eed5cC53352B0296E7b60B09eB",
  BTC_PRICE_API: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",

  // Look and feel
  MIN_BUY_USD: "0", // skip buys smaller than this (0 = post every buy)
  EMOJI: "🐷",
  EMOJI_STEP_USD: "2", // one pig per $2 spent
  MAX_EMOJIS: "30",
  WHALE_USD: "250", // buys at or above this get the whale header (0 = off)
  MEDIA_URL: "", // optional direct link to an image, .gif or .mp4 to attach
  FOOTER: "81% of every trade's 2% tax accrues to holders in cirBTC.",

  // Daily Piggy Bank Report (one summary post a day)
  REPORT_ENABLED: "1", // 0 = off
  REPORT_HOUR_UTC: "18", // posts on the first run at or after this hour (18 = 18:00 UTC)
  REWARD_TRACKER: "0xb1f681417045ef6f3afdaf9c74d870fb7af3b50f", // Argus reward contract that holds holders' cirBTC
  CLAIM_URL: "https://argus.world/token/0xeF7e29A61996f7eed5cC53352B0296E7b60B09eB",

  // Engine (leave alone unless something misbehaves)
  HEAD_LAG: "5", // stay a few blocks behind the tip (Arc's public RPC nodes differ slightly)
  MAX_BLOCK_RANGE: "10000", // blocks per eth_getLogs call (halves itself if the RPC complains)
  MAX_CATCHUP_BLOCKS: "20000", // after downtime, skip anything older than this instead of spamming
  MAX_POSTS_PER_RUN: "8", // Telegram allows ~20 msgs/min per group; the rest wait for the next minute
  TEST_LOOKBACK_BLOCKS: "50000", // how far /test and /scan look back by default (add &blocks=N to change)
};

const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"; // Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)
const BALANCE_OF = "0x70a08231";
const LOG_DONE = 2147483647; // "every log in this block is processed"
const TOTAL_DEPOSITED = "0xff50abdc"; // reward tracker: all cirBTC ever credited to holders
const TOTAL_PAID = "0xe7b0f666"; // reward tracker: all cirBTC ever claimed/paid out
const ACCOUNTED_BALANCE = "0x0937eb54"; // reward tracker: cirBTC waiting to be claimed

// ===== entry points =====

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAndPost(env).catch((e) => console.error("run failed:", e && e.stack ? e.stack : e)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return text("PIGSATS buy bot is running.");

    if (!env.ADMIN_KEY) return text("Set the ADMIN_KEY secret to use this page.", 403);
    if (url.searchParams.get("key") !== env.ADMIN_KEY) return text("Wrong or missing ?key=", 403);

    const cfg = config(env);
    try {
      if (path === "/status") return json(await status(env, cfg));
      if (path === "/scan") return json(await scan(env, cfg, lookbackParam(url, cfg)));
      if (path === "/test") return json(await testPost(env, cfg, lookbackParam(url, cfg), url.searchParams.get("chat")));
      if (path === "/run") { await pollAndPost(env); return json(await status(env, cfg)); }
      if (path === "/report") return json(await reportPage(env, cfg, url.searchParams.get("send") === "1", url.searchParams.get("chat")));
      return text("Unknown page. Try /status, /scan, /test, /run or /report (all need ?key=).", 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};

// ===== the every-minute job =====

export async function pollAndPost(env) {
  const cfg = config(env);
  if (!env.DB) throw new Error("D1 binding 'DB' is missing");
  await ensureTable(env);
  if (!(await acquireLock(env, 120_000))) return { skipped: "another run is in progress" };

  const started = Date.now();
  const note = { last_run: new Date().toISOString() };
  try {
    const head = await blockNumber(cfg);
    const to = head - int(cfg.HEAD_LAG);
    const st = await getState(env);

    // First ever run: start from "now" so old buys are not dumped into the group.
    if (st.cursor_block === undefined) {
      await setState(env, { ...note, cursor_block: to, cursor_log: LOG_DONE, last_error: "" });
      return { started_at_block: to };
    }

    let cursor = { block: Number(st.cursor_block), log: Number(st.cursor_log ?? LOG_DONE) };
    let from = cursor.log === LOG_DONE ? cursor.block + 1 : cursor.block;
    if (from > to) {
      await setState(env, note);
      await maybeReport(env, cfg, { ...st, ...note }).catch((e) => setState(env, { last_report_error: String(e.message || e) }).catch(() => {}));
      return { upToDate: true };
    }

    if (to - from > int(cfg.MAX_CATCHUP_BLOCKS)) {
      from = to - int(cfg.MAX_CATCHUP_BLOCKS);
      cursor = { block: from - 1, log: LOG_DONE };
      note.last_skip = `skipped blocks before ${from} after downtime`;
    }

    const groups = await scanGroups(cfg, from, to, cursor);
    let posted = 0;
    let newHolders = 0;
    let market;
    let stopped = false;
    note.last_error = "";

    for (const g of groups) {
      if (!g.isBuy) { cursor = { block: g.blockNumber, log: g.lastLogIndex }; continue; }

      if (market === undefined) market = await getMarket(cfg);
      const pre = price(cfg, { quoteIn: g.quoteIn, tokenOut: g.tokenOut }, market);
      if (pre.usd != null && pre.usd < num(cfg.MIN_BUY_USD)) { cursor = { block: g.blockNumber, log: g.lastLogIndex }; continue; }
      if (posted >= int(cfg.MAX_POSTS_PER_RUN)) { stopped = true; break; }
      if (Date.now() - started > 40_000) { stopped = true; break; } // slow RPC: finish this run, continue next minute

      let buy;
      try {
        buy = await enrichBuy(cfg, g);
      } catch (e) {
        note.last_error = `receipt not ready for ${g.txHash}: ${e.message}`;
        stopped = true; // try again next minute from this tx
        break;
      }
      price(cfg, buy, market);

      const res = await postToTelegram(cfg, env, buildMessage(cfg, buy));
      if (res.ok) {
        posted++;
        if (buy.newHolder) newHolders++;
        note.last_post = `${new Date().toISOString()} ${buy.txHash}`;
        cursor = { block: g.blockNumber, log: g.lastLogIndex };
      } else if (res.error_code === 429 || isConfigError(res)) {
        note.last_error = `Telegram: ${res.description || res.error_code}`;
        stopped = true; // rate limit or setup problem: keep this buy and retry next minute
        break;
      } else {
        note.last_error = `Telegram skipped ${g.txHash}: ${res.description || res.error_code}`;
        cursor = { block: g.blockNumber, log: g.lastLogIndex }; // unpostable message: skip it, don't block the queue
      }
    }

    if (!stopped) cursor = { block: to, log: LOG_DONE };
    // Daily totals: count each swap exactly once, when the cursor moves past it.
    const consumed = groups.filter((g) => g.blockNumber < cursor.block || (g.blockNumber === cursor.block && g.lastLogIndex <= cursor.log));
    Object.assign(note, addStats(st, consumed, newHolders));
    await setState(env, { ...note, cursor_block: cursor.block, cursor_log: cursor.log });
    if (!stopped) await maybeReport(env, cfg, { ...st, ...note }).catch((e) => setState(env, { last_report_error: String(e.message || e) }).catch(() => {}));
    return { posted, cursor };
  } catch (e) {
    await setState(env, { ...note, last_error: String(e && e.message ? e.message : e) }).catch(() => {});
    throw e;
  } finally {
    await releaseLock(env).catch(() => {});
  }
}

// ===== daily Piggy Bank Report =====

// Adds this run's swaps to the running totals kept in D1 (reset after each report).
export function addStats(st, consumed, newHolders) {
  const big = (k) => BigInt(st[k] || "0");
  let buys = Number(st.acc_buys || 0), sells = Number(st.acc_sells || 0);
  let buyQ = big("acc_buy_quote"), sellQ = big("acc_sell_quote");
  for (const g of consumed) {
    if (g.isBuy) { buys++; buyQ += g.quoteIn; }
    else if (g.isSell) { sells++; sellQ += g.quoteOut; }
  }
  const out = {
    acc_buys: buys, acc_sells: sells,
    acc_buy_quote: buyQ.toString(), acc_sell_quote: sellQ.toString(),
    acc_new_holders: Number(st.acc_new_holders || 0) + newHolders,
  };
  if (!st.acc_since) out.acc_since = new Date().toISOString();
  return out;
}

async function trackerTotals(cfg) {
  const call = async (sel) => BigInt(await rpc(cfg, "eth_call", [{ to: lc(cfg.REWARD_TRACKER), data: sel }, "latest"], 2));
  const [deposited, paid, waiting] = await Promise.all([call(TOTAL_DEPOSITED), call(TOTAL_PAID), call(ACCOUNTED_BALANCE)]);
  return { deposited, paid, waiting };
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

async function maybeReport(env, cfg, st) {
  if (cfg.REPORT_ENABLED === "0" || !cfg.REWARD_TRACKER) return null;
  // Remember where the reward counters stood, so the first report shows real "since then" numbers.
  if (st.rpt_deposited === undefined) {
    const t = await trackerTotals(cfg);
    const now = new Date();
    const base = { rpt_deposited: t.deposited.toString(), rpt_paid: t.paid.toString(), rpt_at: now.toISOString() };
    // Deployed after today's report hour: start with tomorrow's report instead of a near-empty one now.
    if (now.getUTCHours() >= int(cfg.REPORT_HOUR_UTC)) base.last_report_day = utcDay(now);
    await setState(env, base);
    return null;
  }
  const now = new Date();
  if (now.getUTCHours() < int(cfg.REPORT_HOUR_UTC) || st.last_report_day === utcDay(now)) return null;
  return sendReport(env, cfg, st, false);
}

export function buildReport(cfg, s, market) {
  const qd = int(cfg.QUOTE_DECIMALS), q = esc(cfg.QUOTE_SYMBOL), sym = esc(cfg.TOKEN_SYMBOL);
  const usd = (raw) => (market && market.quoteUsd ? units(raw, qd) * market.quoteUsd : null);
  const amt = (raw) => { const u = usd(raw); return `${fmtQuote(raw, qd)} ${q}${u != null ? ` (${fmtUsd(u)})` : ""}`; };
  const vol = usd(s.buyQuote + s.sellQuote);
  const L = [];
  L.push(`🐷🏦 <b>Daily Piggy Bank Report</b>`);
  L.push(`<i>${s.hours >= 20 && s.hours <= 28 ? "Last 24 hours" : `Last ${Math.max(1, Math.round(s.hours))} hours`}</i>`);
  L.push("");
  L.push(`🟢 <b>Buys:</b> ${s.buys}${s.buys ? ` · ${amt(s.buyQuote)}` : ""}`);
  L.push(`🔴 <b>Sells:</b> ${s.sells}${s.sells ? ` · ${amt(s.sellQuote)}` : ""}`);
  if (vol != null) L.push(`📊 <b>Volume:</b> ${fmtUsd(vol)}`);
  L.push(`🆕 <b>New holders:</b> ${s.newHolders}`);
  L.push("");
  L.push(`🟠 <b>Paid into the piggy bank for holders:</b> ${amt(s.depositedDelta)}`);
  L.push(`✅ <b>Claimed by holders:</b> ${amt(s.paidDelta)}`);
  L.push(`⏳ <b>Waiting to be claimed:</b> ${amt(s.waiting)}`);
  L.push(`🏆 <b>All-time to holders:</b> ${amt(s.depositedTotal)}`);
  if (market && market.mcap) L.push(`🏦 <b>Market cap:</b> ${fmtUsd(market.mcap)}`);
  L.push("");
  const links = [];
  if (cfg.CLAIM_URL) links.push(`<a href="${esc(cfg.CLAIM_URL)}">Claim your ${q}</a>`);
  if (cfg.CHART_URL) links.push(`<a href="${esc(cfg.CHART_URL)}">Chart</a>`);
  if (cfg.SITE_URL) links.push(`<a href="${esc(cfg.SITE_URL)}">Website</a>`);
  if (links.length) L.push(`🔗 ${links.join(" · ")}`);
  L.push("", `<i>Hold $${sym} to earn ${q} from every trade. Rewards wait in the contract until you press Claim on Argus.</i>`);
  return L.join("\n");
}

async function reportData(cfg, st) {
  const t = await trackerTotals(cfg);
  const since = st.acc_since || st.rpt_at;
  return {
    totals: t,
    s: {
      hours: since ? (Date.now() - Date.parse(since)) / 3_600_000 : 24,
      buys: Number(st.acc_buys || 0), sells: Number(st.acc_sells || 0),
      buyQuote: BigInt(st.acc_buy_quote || "0"), sellQuote: BigInt(st.acc_sell_quote || "0"),
      newHolders: Number(st.acc_new_holders || 0),
      depositedDelta: st.rpt_deposited !== undefined ? t.deposited - BigInt(st.rpt_deposited) : 0n,
      paidDelta: st.rpt_paid !== undefined ? t.paid - BigInt(st.rpt_paid) : 0n,
      waiting: t.waiting, depositedTotal: t.deposited,
    },
  };
}

async function sendReport(env, cfg, st, forced, chatOverride) {
  const { totals, s } = await reportData(cfg, st);
  const html = buildReport(cfg, s, await getMarket(cfg));
  const target = chatOverride ? { ...cfg, CHAT_ID: chatOverride, MEDIA_URL: "" } : { ...cfg, MEDIA_URL: "" };
  const res = await postToTelegram(target, env, html);
  if (!res.ok) {
    await setState(env, { last_report_error: `Telegram: ${res.description || res.error_code}` });
    return { ok: false, telegram: res };
  }
  if (!chatOverride) {
    const now = new Date().toISOString();
    await setState(env, {
      last_report_day: forced ? st.last_report_day || "" : utcDay(),
      last_report: now, last_report_error: "",
      rpt_deposited: totals.deposited.toString(), rpt_paid: totals.paid.toString(), rpt_at: now,
      acc_buys: 0, acc_sells: 0, acc_buy_quote: "0", acc_sell_quote: "0", acc_new_holders: 0, acc_since: now,
    });
  }
  return { ok: true, sent_to: target.CHAT_ID, message: html };
}

// /report shows the report without posting; /report?send=1 posts it now (and resets the counters);
// /report?send=1&chat=<id> posts a copy elsewhere without touching the counters.
async function reportPage(env, cfg, send, chat) {
  await ensureTable(env);
  const st = await getState(env);
  if (send) return sendReport(env, cfg, st, true, chat);
  const { s } = await reportData(cfg, st);
  return { ok: true, preview: buildReport(cfg, s, await getMarket(cfg)), last_report: st.last_report || null };
}

// ===== admin pages =====

async function status(env, cfg) {
  const st = env.DB ? (await ensureTable(env), await getState(env)) : {};
  let head = null;
  try { head = await blockNumber(cfg); } catch (e) { head = `RPC error: ${e.message}`; }
  return {
    ok: true,
    chat: cfg.CHAT_ID,
    telegram_token_set: Boolean(env.TELEGRAM_BOT_TOKEN),
    d1_bound: Boolean(env.DB),
    chain_head: head,
    cursor_block: st.cursor_block ?? null,
    blocks_behind: typeof head === "number" && st.cursor_block ? head - Number(st.cursor_block) : null,
    last_run: st.last_run ?? null,
    last_post: st.last_post ?? null,
    last_error: st.last_error || null,
    last_skip: st.last_skip ?? null,
    last_report: st.last_report ?? null,
    last_report_error: st.last_report_error || null,
    counting_since: st.acc_since ?? null,
    today_so_far: { buys: Number(st.acc_buys || 0), sells: Number(st.acc_sells || 0), new_holders: Number(st.acc_new_holders || 0) },
  };
}

// Dry run: shows what the bot WOULD post for the last N blocks. Posts nothing.
async function scan(env, cfg, lookback) {
  const to = (await blockNumber(cfg)) - int(cfg.HEAD_LAG);
  const from = Math.max(0, to - lookback);
  const groups = await scanGroups(cfg, from, to, null);
  const buys = groups.filter((g) => g.isBuy).slice(-5);
  const market = buys.length ? await getMarket(cfg) : null;
  const out = [];
  for (const g of buys) {
    const b = await enrichBuy(cfg, g);
    price(cfg, b, market);
    out.push({ tx: b.txHash, block: b.blockNumber, buyer: b.buyer, usd: b.usd, new_holder: b.newHolder, message: buildMessage(cfg, b) });
  }
  return { ok: true, blocks: [from, to], swaps_found: groups.length, buys_found: groups.filter((g) => g.isBuy).length, showing_last: out.length, market, buys: out };
}

// Posts the latest real buy (labelled as a test) so you can see the format in the group.
// Add &chat=<id> to send it somewhere else, e.g. a private test group.
async function testPost(env, cfg, lookback, chatOverride) {
  const to = (await blockNumber(cfg)) - int(cfg.HEAD_LAG);
  const from = Math.max(0, to - lookback);
  const groups = await scanGroups(cfg, from, to, null);
  const last = [...groups].reverse().find((g) => g.isBuy);
  const target = chatOverride ? { ...cfg, CHAT_ID: chatOverride } : cfg;
  let html;
  if (last) {
    const b = await enrichBuy(cfg, last);
    price(cfg, b, await getMarket(cfg));
    html = buildMessage(cfg, b, { header: "🧪 Test post: replay of the most recent real buy" });
  } else {
    html = `✅ <b>$${esc(cfg.TOKEN_SYMBOL)} buy bot connected.</b>\nNew buys will appear here automatically.`;
  }
  const res = await postToTelegram(target, env, html);
  return { ok: Boolean(res.ok), sent_to: target.CHAT_ID, replayed_tx: last ? last.txHash : null, telegram: res.ok ? "sent" : res };
}

// ===== chain reading =====

// Returns one entry per transaction that touched the pool, oldest first.
export async function scanGroups(cfg, from, to, cursor) {
  const logs = await getSwapLogs(cfg, from, to);
  const tokenIs1 = BigInt(lc(cfg.TOKEN_ADDRESS)) > BigInt(lc(cfg.QUOTE_ADDRESS));
  const byTx = new Map();

  for (const log of logs) {
    if (log.removed) continue;
    const blockNumber = Number(log.blockNumber);
    const logIndex = Number(log.logIndex);
    if (cursor && (blockNumber < cursor.block || (blockNumber === cursor.block && logIndex <= cursor.log))) continue;
    if (lc(log.address) !== lc(cfg.POOL_MANAGER) || lc(log.topics[0]) !== SWAP_TOPIC || lc(log.topics[1]) !== lc(cfg.POOL_ID)) continue;

    const w = words(log.data);
    const amount0 = signed(w[0]);
    const amount1 = signed(w[1]);
    // Uniswap v4 reports amounts from the trader's side: negative = trader paid it in, positive = trader received it.
    const tokenDelta = tokenIs1 ? amount1 : amount0;
    const quoteDelta = tokenIs1 ? amount0 : amount1;

    let g = byTx.get(log.transactionHash);
    if (!g) {
      g = { txHash: log.transactionHash, blockNumber, firstLogIndex: logIndex, lastLogIndex: logIndex, tokenOut: 0n, quoteIn: 0n, tokenIn: 0n, quoteOut: 0n, swaps: 0 };
      byTx.set(log.transactionHash, g);
    }
    g.lastLogIndex = Math.max(g.lastLogIndex, logIndex);
    g.swaps++;
    if (tokenDelta > 0n && quoteDelta < 0n) { g.tokenOut += tokenDelta; g.quoteIn += -quoteDelta; }
    else if (tokenDelta < 0n && quoteDelta > 0n) { g.tokenIn += -tokenDelta; g.quoteOut += quoteDelta; }
  }

  const groups = [...byTx.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.firstLogIndex - b.firstLogIndex);
  for (const g of groups) { g.isBuy = g.tokenOut > 0n; g.isSell = !g.isBuy && g.tokenIn > 0n; }
  return groups;
}

async function getSwapLogs(cfg, from, to) {
  const out = [];
  let size = int(cfg.MAX_BLOCK_RANGE);
  let start = from;
  while (start <= to) {
    const end = Math.min(to, start + size - 1);
    try {
      const logs = await rpc(cfg, "eth_getLogs", [{
        address: lc(cfg.POOL_MANAGER),
        topics: [SWAP_TOPIC, lc(cfg.POOL_ID)],
        fromBlock: hex(start),
        toBlock: hex(end),
      }]);
      out.push(...(logs || []));
      start = end + 1;
    } catch (e) {
      if (e.rangeError && size > 25) { size = Math.floor(size / 2); continue; }
      throw e;
    }
  }
  return out;
}

// Works out who actually received the tokens and whether they are a brand-new holder.
export async function enrichBuy(cfg, g) {
  let receipt = null;
  for (let i = 0; i < 3 && !receipt; i++) {
    receipt = await rpc(cfg, "eth_getTransactionReceipt", [g.txHash]);
    if (!receipt) await sleep(800);
  }
  if (!receipt) throw new Error("receipt not available yet");

  const pm = lc(cfg.POOL_MANAGER);
  const token = lc(cfg.TOKEN_ADDRESS);
  const transfers = (receipt.logs || [])
    .filter((l) => lc(l.address) === token && lc(l.topics[0]) === TRANSFER_TOPIC && l.topics.length >= 3)
    .map((l) => ({ from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), value: BigInt(l.data === "0x" ? 0 : l.data), logIndex: Number(l.logIndex) }));

  let buyer = lc(receipt.from);
  let got = g.tokenOut;
  const outs = transfers.filter((t) => t.from === pm && t.to !== pm);
  if (outs.length) {
    // The biggest payout from the pool is the trade (small ones are fees). Then follow it
    // through any router/aggregator that forwards it on within the same transaction.
    let cur = outs.reduce((a, b) => (b.value > a.value ? b : a));
    for (let hop = 0; hop < 5; hop++) {
      const next = transfers
        .filter((t) => t.from === cur.to && t.logIndex > cur.logIndex && t.to !== pm && t.to !== cur.to && t.value * 2n >= cur.value)
        .reduce((a, b) => (!a || b.value > a.value ? b : a), null);
      if (!next) break;
      cur = next;
    }
    buyer = cur.to;
    got = cur.value;
  }

  let newHolder = null;
  try {
    const bal = await balanceOf(cfg, buyer, g.blockNumber);
    newHolder = bal <= got + got / 1000n;
  } catch (_) { /* leave unknown: no badge */ }

  return { txHash: g.txHash, blockNumber: g.blockNumber, buyer, txFrom: lc(receipt.from), got, tokenOut: g.tokenOut, quoteIn: g.quoteIn, newHolder };
}

async function balanceOf(cfg, addr, block) {
  const data = BALANCE_OF + addr.replace(/^0x/, "").padStart(64, "0");
  const call = { to: lc(cfg.TOKEN_ADDRESS), data };
  try {
    return BigInt(await rpc(cfg, "eth_call", [call, hex(block)], 2));
  } catch (_) {
    return BigInt(await rpc(cfg, "eth_call", [call, "latest"], 2));
  }
}

async function blockNumber(cfg) {
  return Number(await rpc(cfg, "eth_blockNumber", []));
}

// Rotates through every endpoint in RPC_URL (comma-separated), so one rate-limited node can't stop the bot.
let rpcTurn = 0;
async function rpc(cfg, method, params, tries = 3) {
  const urls = String(cfg.RPC_URL).split(",").map((u) => u.trim()).filter(Boolean);
  const attempts = Math.max(tries, urls.length + 1);
  const start = rpcTurn++;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const url = urls[(start + i) % urls.length];
    try {
      const res = await fetchT(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }, 12_000);
      if (res.status === 429 || res.status >= 500) throw rpcError(`RPC HTTP ${res.status}`, { retry: true });
      const j = await res.json();
      if (j.error) {
        const msg = String(j.error.message || "RPC error");
        const code = j.error.code;
        const notReady = code === -32014 || /not available|header not found|unknown block|not found/i.test(msg);
        const tooBig = !notReady && (code === -32005 || /range|too many|limit|exceed|max/i.test(msg));
        throw rpcError(`${method}: ${msg}`, { retry: notReady, rangeError: tooBig });
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      if (e.isRpc && !e.retry) throw e;
      if (i < attempts - 1) await sleep(urls.length > 1 ? 200 : 500 * (i + 1));
    }
  }
  throw lastErr;
}

function rpcError(message, { retry = false, rangeError = false } = {}) {
  const e = new Error(message);
  e.isRpc = true;
  e.retry = retry;
  e.rangeError = rangeError;
  return e;
}

// ===== prices =====

async function getMarket(cfg) {
  try {
    const res = await fetchT(cfg.DEXSCREENER_API, { headers: { accept: "application/json" } }, 8_000);
    const j = await res.json();
    const pairs = j.pairs || (j.pair ? [j.pair] : []);
    const p = pairs.find((x) => lc(x.pairAddress) === lc(cfg.POOL_ID)) || pairs[0];
    const priceUsd = Number(p && p.priceUsd);
    const priceNative = Number(p && p.priceNative);
    if (priceUsd > 0 && priceNative > 0) {
      return { source: "dexscreener", quoteUsd: priceUsd / priceNative, mcap: Number(p.marketCap || p.fdv) || null };
    }
  } catch (_) { /* fall through */ }
  try {
    const res = await fetchT(cfg.BTC_PRICE_API, { headers: { accept: "application/json" } }, 8_000);
    const j = await res.json();
    const btc = Number(j && j.bitcoin && j.bitcoin.usd);
    if (btc > 0) return { source: "coingecko-btc", quoteUsd: btc, mcap: null };
  } catch (_) { /* no price */ }
  return { source: "none", quoteUsd: null, mcap: null };
}

function price(cfg, b, market) {
  const quote = units(b.quoteIn, int(cfg.QUOTE_DECIMALS));
  const tokens = units(b.tokenOut, int(cfg.TOKEN_DECIMALS));
  b.usd = market && market.quoteUsd && quote > 0 ? quote * market.quoteUsd : null;
  if (market && market.mcap) b.mcap = market.mcap;
  else if (market && market.quoteUsd && tokens > 0) b.mcap = (quote / tokens) * market.quoteUsd * num(cfg.TOTAL_SUPPLY);
  else b.mcap = null;
  return b;
}

// ===== the Telegram message =====

export function buildMessage(cfg, b, opts = {}) {
  const whaleAt = num(cfg.WHALE_USD);
  const whale = whaleAt > 0 && b.usd != null && b.usd >= whaleAt;
  const pigs = b.usd != null ? clamp(Math.floor(b.usd / Math.max(num(cfg.EMOJI_STEP_USD), 0.0001)), 1, int(cfg.MAX_EMOJIS)) : 1;
  const ex = cfg.EXPLORER_URL.replace(/\/+$/, "");
  const sym = esc(cfg.TOKEN_SYMBOL);

  const lines = [];
  if (opts.header) lines.push(`<i>${esc(opts.header)}</i>`, "");
  lines.push(whale ? `🐋 <b>WHALE BUY! $${sym}</b>` : `🐷 <b>New $${sym} buy!</b>`);
  lines.push(cfg.EMOJI.repeat(pigs));
  lines.push("");
  lines.push(`💸 <b>Spent:</b> ${b.usd != null ? `${fmtUsd(b.usd)} · ` : ""}${fmtQuote(b.quoteIn, int(cfg.QUOTE_DECIMALS))} ${esc(cfg.QUOTE_SYMBOL)}`);
  lines.push(`🐽 <b>Got:</b> ${fmtToken(b.got, int(cfg.TOKEN_DECIMALS))} ${sym}`);
  lines.push(`👤 <b>Buyer:</b> <a href="${ex}/address/${b.buyer}">${shortAddr(b.buyer)}</a>${b.newHolder ? " · 🆕 <b>New holder!</b>" : ""}`);
  if (b.mcap) lines.push(`🏦 <b>Market cap:</b> ${fmtUsd(b.mcap)}`);
  lines.push("");
  const links = [`<a href="${ex}/tx/${b.txHash}">TX</a>`];
  if (cfg.CHART_URL) links.push(`<a href="${esc(cfg.CHART_URL)}">Chart</a>`);
  if (cfg.BUY_URL) links.push(`<a href="${esc(cfg.BUY_URL)}">Buy</a>`);
  if (cfg.SITE_URL) links.push(`<a href="${esc(cfg.SITE_URL)}">Website</a>`);
  lines.push(`🔗 ${links.join(" · ")}`);
  if (cfg.FOOTER) lines.push("", `<i>${esc(cfg.FOOTER)}</i>`);
  return lines.join("\n");
}

async function postToTelegram(cfg, env, html) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error_code: 401, description: "TELEGRAM_BOT_TOKEN secret is not set" };
  const base = { chat_id: cfg.CHAT_ID, parse_mode: "HTML" };
  if (cfg.THREAD_ID) base.message_thread_id = Number(cfg.THREAD_ID);

  if (cfg.MEDIA_URL) {
    const anim = /\.(gif|mp4)(\?|#|$)/i.test(cfg.MEDIA_URL);
    const r = await tg(env, anim ? "sendAnimation" : "sendPhoto", { ...base, [anim ? "animation" : "photo"]: cfg.MEDIA_URL, caption: html });
    if (r.ok || r.error_code === 429 || isConfigError(r)) return r;
    // media link broken: fall back to a text message
  }
  return tg(env, "sendMessage", { ...base, text: html, link_preview_options: { is_disabled: true } });
}

async function tg(env, method, body) {
  try {
    const res = await fetchT(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, 15_000);
    return await res.json();
  } catch (e) {
    return { ok: false, error_code: 429, description: `network error talking to Telegram (${e.message}); will retry` };
  }
}

function isConfigError(r) {
  if (r.error_code === 401 || r.error_code === 403) return true;
  return r.error_code === 400 && /chat not found|not enough rights|have no rights|bot was kicked|thread not found|need administrator/i.test(r.description || "");
}

// ===== D1 state =====

async function ensureTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT)").run();
}

async function getState(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM state").all();
  return Object.fromEntries((results || []).map((r) => [r.k, r.v]));
}

async function setState(env, obj) {
  const stmts = Object.entries(obj).map(([k, v]) =>
    env.DB.prepare("INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, String(v)));
  if (stmts.length) await env.DB.batch(stmts);
}

async function acquireLock(env, ttlMs) {
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO state (k, v) VALUES ('lock', '0')").run();
  const r = await env.DB.prepare("UPDATE state SET v = ? WHERE k = 'lock' AND CAST(v AS INTEGER) < ?").bind(String(now + ttlMs), now).run();
  return Boolean(r && r.meta && r.meta.changes === 1);
}

async function releaseLock(env) {
  await env.DB.prepare("UPDATE state SET v = '0' WHERE k = 'lock'").run();
}

// ===== small helpers =====

export function config(env) {
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = env[k];
    if ((typeof v === "string" || typeof v === "number") && String(v).trim() !== "") cfg[k] = String(v).trim();
  }
  return cfg;
}

function lookbackParam(url, cfg) {
  const n = Number(url.searchParams.get("blocks") || cfg.TEST_LOOKBACK_BLOCKS);
  return clamp(Number.isFinite(n) ? Math.floor(n) : int(cfg.TEST_LOOKBACK_BLOCKS), 1, 200_000);
}

async function fetchT(url, init, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + Number(n).toString(16);
const int = (s) => parseInt(s, 10);
const num = (s) => Number(s) || 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const topicAddr = (t) => "0x" + String(t).slice(-40).toLowerCase();
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function words(data) {
  const d = String(data).replace(/^0x/, "");
  const out = [];
  for (let i = 0; i + 64 <= d.length; i += 64) out.push(BigInt("0x" + d.slice(i, i + 64)));
  return out;
}

function signed(w) {
  return w >= 1n << 255n ? w - (1n << 256n) : w;
}

export function units(raw, decimals) {
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

export function fmtUsd(v) {
  if (v >= 1000) return "$" + Math.round(v).toLocaleString("en-US");
  if (v >= 0.01) return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return "$" + v.toPrecision(2);
}

export function fmtToken(raw, decimals) {
  const v = units(raw, decimals);
  if (v >= 1000) return Math.round(v).toLocaleString("en-US");
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function fmtQuote(raw, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// GET /api/state — everything the page needs, in one call.
// Reads the buyback bot (BOT_URL). If the bot is offline, still shows the live market.
const env = (k) => (process.env[k] || "").trim();

async function getJson(url, ms = 4000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "bottom-site" } });
    if (!r.ok) throw new Error(url + " " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function market() {
  const c = await getJson("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300");
  const st = await getJson("https://api.exchange.coinbase.com/products/BTC-USD/stats");
  const now = c[0][4], hourAgo = c[12][4];
  return { source: "coinbase", price: now, ch1h: (now / hourAgo - 1) * 100, ch24h: (st.last / st.open - 1) * 100, at: Date.now() };
}

module.exports = async (req, res) => {
  const config = { mint: env("TOKEN_MINT") || null, x: env("X_URL") || null, pump: env("PUMP_URL") || null };
  let out = { config, bot: "offline", dryRun: true, tiers: null, market: null, totals: {}, events: [] };
  const bot = env("BOT_URL").replace(/\/+$/, "");
  if (bot) {
    try {
      const s = await getJson(bot + "/state");
      out = { ...out, ...s, bot: "online", config: { ...config, mint: config.mint || s.mint } };
    } catch (e) { /* bot offline: fall through */ }
  }
  if (!out.market) { try { out.market = await market(); out.lastCheck = Date.now(); } catch (e) {} }
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "s-maxage=15, stale-while-revalidate=30");
  res.end(JSON.stringify(out));
};

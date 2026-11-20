// $BOTTOM buyback bot
// Every minute: looks at Bitcoin. If BTC dropped in the last hour, the bot
//   1) claims the coin's creator fees,
//   2) buys $BOTTOM with part of the SOL (deeper dip = bigger buy),
//   3) burns exactly the tokens it just bought.
// Starts in DRY_RUN mode: it logs what it WOULD do and sends nothing.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import {
  Connection, Keypair, PublicKey, VersionedTransaction, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createBurnCheckedInstruction } from "@solana/spl-token";

// ---------------------------------------------------------------- settings
const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
export const CFG = {
  rpc: env("RPC_URL", "https://api.mainnet-beta.solana.com"),
  key: env("PRIVATE_KEY", ""),            // dev (creator) wallet, base58
  mint: env("TOKEN_MINT", ""),
  dryRun: env("DRY_RUN", "true") !== "false",
  checkSec: Number(env("CHECK_EVERY_SEC", 60)),
  cooldownMin: Number(env("COOLDOWN_MIN", 60)),
  keepSol: Number(env("KEEP_SOL", 0.05)),     // never spend below this
  minBuySol: Number(env("MIN_BUY_SOL", 0.01)),
  slippage: Number(env("SLIPPAGE", 15)),
  priorityFee: Number(env("PRIORITY_FEE", 0.0005)),
  burn: env("BURN", "true") !== "false",
  // dip tiers: "drop%:share%" — BTC 1h drop of 1% spends 25% of free SOL, etc.
  tiers: env("TIERS", "1:25,3:50,5:100").split(",").map((s) => {
    const [d, p] = s.split(":").map(Number); return { drop: d, share: p };
  }).sort((a, b) => a.drop - b.drop),
  port: Number(env("PORT", 8080)),
  dataDir: env("DATA_DIR", "./data"),
};

// ---------------------------------------------------------------- state (saved to disk)
const stateFile = () => path.join(CFG.dataDir, "state.json");
export const S = {
  started: Date.now(), lastCheck: 0, market: null, lastFire: null,
  totals: { buybacks: 0, solSpent: 0, tokensBurned: 0, feesClaimed: 0 },
  events: [], log: [],
};
function load() {
  try { Object.assign(S, JSON.parse(fs.readFileSync(stateFile(), "utf8")), { started: Date.now() }); } catch {}
}
function save() {
  try { fs.mkdirSync(CFG.dataDir, { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(S)); } catch (e) { say("save failed: " + e.message); }
}
function say(msg) {
  const line = new Date().toISOString().slice(0, 19).replace("T", " ") + "  " + msg;
  console.log(line); S.log.unshift(line); S.log.length = Math.min(S.log.length, 60);
}

// ---------------------------------------------------------------- market (Bitcoin)
async function getJson(url, opts) {
  const r = await fetch(url, { ...opts, headers: { "user-agent": "bottom-bot", ...(opts && opts.headers) } });
  if (!r.ok) throw new Error(url.split("?")[0] + " -> " + r.status);
  return r.json();
}
export async function readMarket() {
  try {
    // Coinbase 5-minute candles, newest first: [time, low, high, open, close, volume]
    const c = await getJson("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300");
    const st = await getJson("https://api.exchange.coinbase.com/products/BTC-USD/stats");
    const now = c[0][4], hourAgo = c[12][4];
    return { source: "coinbase", price: now, ch1h: (now / hourAgo - 1) * 100, ch24h: (st.last / st.open - 1) * 100, at: Date.now() };
  } catch (e) {
    const g = await getJson("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1");
    const p = g.prices, now = p[p.length - 1][1], t = p[p.length - 1][0];
    let hourAgo = p[0][1];
    for (const [ts, v] of p) if (ts <= t - 3600e3) hourAgo = v;
    return { source: "coingecko", price: now, ch1h: (now / hourAgo - 1) * 100, ch24h: (now / p[0][1] - 1) * 100, at: Date.now() };
  }
}
export function tierFor(ch1h) {
  const drop = -ch1h; let t = null;
  for (const x of CFG.tiers) if (drop >= x.drop) t = x;
  return t;
}
// fire when a tier is hit and we're out of cooldown, or the dip got deeper than the last buy
export function shouldFire(tier, now = Date.now()) {
  if (!tier) return false;
  const lf = S.lastFire;
  if (!lf) return true;
  if (now - lf.at >= CFG.cooldownMin * 60e3) return true;
  return tier.drop > lf.drop;
}

// ---------------------------------------------------------------- solana
let conn, wallet, mintPk;
function setup() {
  conn = new Connection(CFG.rpc, "confirmed");
  if (CFG.key) wallet = Keypair.fromSecretKey(bs58.decode(CFG.key));
  if (CFG.mint) mintPk = new PublicKey(CFG.mint);
}
async function sendVtx(bytes) {
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([wallet]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await confirm(sig);
  return sig;
}
async function confirm(sig) {
  for (let i = 0; i < 40; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st && st.err) throw new Error("tx failed " + sig + " " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("tx not confirmed in time " + sig);
}
async function solBalance() { return (await conn.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL; }
async function tokenAccounts() {
  const r = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPk });
  return r.value.map((a) => ({
    pubkey: a.pubkey, program: a.account.owner,
    raw: BigInt(a.account.data.parsed.info.tokenAmount.amount),
    decimals: a.account.data.parsed.info.tokenAmount.decimals,
  }));
}
const sumRaw = (accs) => accs.reduce((s, a) => s + a.raw, 0n);

// claim creator fees: official pump.fun builder first, PumpPortal as backup
async function claimFees() {
  try {
    const r = await getJson("https://fun-block.pump.fun/agents/collect-fees", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mint: CFG.mint, user: wallet.publicKey.toBase58(), frontRunningProtection: false, tipAmount: 0, encoding: "base64" }),
    });
    if (!r.transaction) throw new Error("no transaction in reply");
    return await sendVtx(Buffer.from(r.transaction, "base64"));
  } catch (e) {
    say("pump.fun fee claim failed (" + e.message + "), trying PumpPortal");
    const r = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: wallet.publicKey.toBase58(), action: "collectCreatorFee", priorityFee: CFG.priorityFee, pool: "pump" }),
    });
    if (r.status !== 200) throw new Error("PumpPortal fee claim " + r.status + " " + (await r.text()).slice(0, 200));
    return await sendVtx(new Uint8Array(await r.arrayBuffer()));
  }
}
async function buy(sol) {
  const r = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: wallet.publicKey.toBase58(), action: "buy", mint: CFG.mint,
      amount: Number(sol.toFixed(6)), denominatedInSol: "true",
      slippage: CFG.slippage, priorityFee: CFG.priorityFee, pool: "auto",
    }),
  });
  if (r.status !== 200) throw new Error("PumpPortal buy " + r.status + " " + (await r.text()).slice(0, 200));
  return sendVtx(new Uint8Array(await r.arrayBuffer()));
}
// burn only what we just bought (the delta), never the dev's other tokens
async function burnDelta(before, afterAccs) {
  let left = sumRaw(afterAccs) - before;
  if (left <= 0n) return { sig: null, raw: 0n, decimals: 0 };
  const tx = new Transaction(); let decimals = 0, total = left;
  for (const a of afterAccs) {
    if (left <= 0n) break;
    const amt = a.raw < left ? a.raw : left;
    if (amt <= 0n) continue;
    tx.add(createBurnCheckedInstruction(a.pubkey, mintPk, wallet.publicKey, amt, a.decimals, [], a.program));
    left -= amt; decimals = a.decimals;
  }
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(wallet);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await confirm(sig);
  return { sig, raw: total, decimals };
}

// ---------------------------------------------------------------- one buyback
async function buyback(m, tier) {
  const ev = { at: Date.now(), btc: m.price, ch1h: +m.ch1h.toFixed(2), tier: tier.drop, share: tier.share, dry: CFG.dryRun };
  S.lastFire = { at: ev.at, drop: tier.drop };
  if (CFG.dryRun || !wallet || !mintPk) {
    ev.note = !wallet || !mintPk ? "no wallet/mint set - simulated" : "DRY_RUN - nothing sent";
    say(`DIP ${m.ch1h.toFixed(2)}% (tier -${tier.drop}%) -> would claim fees, buy with ${tier.share}% of free SOL, burn [${ev.note}]`);
    S.events.unshift(ev); S.events.length = Math.min(S.events.length, 100); save(); return;
  }
  const sol0 = await solBalance();
  try { ev.claimTx = await claimFees(); } catch (e) { ev.claimError = e.message; say("fee claim failed: " + e.message); }
  const sol1 = await solBalance();
  ev.claimed = Math.max(0, +(sol1 - sol0).toFixed(6));
  const free = sol1 - CFG.keepSol;
  const spend = Math.max(0, free * tier.share / 100);
  if (spend < CFG.minBuySol) {
    ev.note = `not enough SOL (free ${free.toFixed(4)})`; say("skip buy: " + ev.note);
  } else {
    const before = sumRaw(await tokenAccounts());
    ev.buyTx = await buy(spend); ev.spent = +spend.toFixed(6);
    say(`bought $BOTTOM for ${spend.toFixed(4)} SOL  ${ev.buyTx}`);
    if (CFG.burn) {
      await new Promise((r) => setTimeout(r, 2000));
      const b = await burnDelta(before, await tokenAccounts());
      if (b.sig) {
        ev.burnTx = b.sig; ev.burned = Number(b.raw) / 10 ** b.decimals;
        say(`burned ${ev.burned.toLocaleString()} $BOTTOM  ${b.sig}`);
      }
    }
    S.totals.buybacks += 1; S.totals.solSpent += ev.spent; S.totals.tokensBurned += ev.burned || 0;
  }
  S.totals.feesClaimed += ev.claimed || 0;
  S.events.unshift(ev); S.events.length = Math.min(S.events.length, 100); save();
}

// ---------------------------------------------------------------- loop
let busy = false;
export async function tick() {
  if (busy) return; busy = true;
  try {
    const m = await readMarket(); S.market = m; S.lastCheck = Date.now();
    const tier = tierFor(m.ch1h);
    m.armed = tier ? tier.drop : 0;
    if (shouldFire(tier)) await buyback(m, tier);
  } catch (e) { say("tick error: " + e.message); }
  finally { busy = false; }
}

// ---------------------------------------------------------------- public status for the site
function publicState() {
  return {
    ok: true, dryRun: CFG.dryRun, mint: CFG.mint || null,
    wallet: wallet ? wallet.publicKey.toBase58() : null,
    tiers: CFG.tiers, cooldownMin: CFG.cooldownMin,
    market: S.market, lastCheck: S.lastCheck, totals: S.totals,
    events: S.events.slice(0, 30),
  };
}
function serve() {
  http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/state")) return res.end(JSON.stringify(publicState()));
    if (req.url.startsWith("/log")) return res.end(JSON.stringify(S.log));
    res.end(JSON.stringify({ ok: true, see: ["/state", "/log"] }));
  }).listen(CFG.port, () => say("status server on :" + CFG.port));
}

export async function main() {
  load(); setup(); serve();
  say(`$BOTTOM bot up. ${CFG.dryRun ? "DRY_RUN (safe mode)" : "LIVE"}; wallet ${wallet ? wallet.publicKey.toBase58() : "not set"}; mint ${CFG.mint || "not set"}`);
  say("tiers: " + CFG.tiers.map((t) => `-${t.drop}% -> ${t.share}%`).join(", "));
  await tick();
  setInterval(tick, CFG.checkSec * 1000);
}
if (process.argv[1] && process.argv[1].endsWith("index.js")) main();

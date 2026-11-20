# $BOTTOM — site + buyback bot

Live: https://trybottom.fun

Two parts:
- **site/** — the website (Vercel)
- **bot/**  — the buyback bot (Railway)

How the bot works, in plain words:
every minute it checks Bitcoin. If BTC fell in the last hour:
- -1%  -> claims creator fees, buys $BOTTOM with 25% of the free SOL, burns what it bought
- -3%  -> same with 50%
- -5%  -> same with 100%
Same level fires again only after 60 min. A deeper drop fires right away.
It burns ONLY the tokens it just bought, never the dev's own bag.
It always keeps 0.05 SOL in the wallet.

---------------------------------------------------------------
## 1. Bot on Railway (first!)

1. Push this folder to GitHub (or upload it).
2. Railway -> New Project -> Deploy from GitHub -> pick the repo.
3. Settings -> Root Directory: `bot`. Start command: `npm start`.
4. Variables -> add (see bot/.env.example):
   - RPC_URL      = your Helius link
   - PRIVATE_KEY  = key of the wallet that created the coin
   - TOKEN_MINT   = CA of the coin
   - DRY_RUN      = true   (test mode for now)
5. Add a Volume, mount path `/data` (keeps the buyback history after restarts).
6. Settings -> Networking -> Generate Domain. Copy it, e.g. https://bottom-bot.up.railway.app
7. Open that link + `/log` — you should see "$BOTTOM bot up. DRY_RUN".
8. When a dip happens in test mode, the log says "would claim fees, buy…".
   Looks right? Change DRY_RUN to `false`. Now it's live.

Put a little SOL (0.1) in the dev wallet for transaction fees.

---------------------------------------------------------------
## 2. Site on Vercel

1. Vercel -> Add New Project -> same repo.
2. Root Directory: `site`. Framework: Other. No build command.
3. Environment Variables:
   - BOT_URL    = the Railway link from step 1.6
   - TOKEN_MINT = CA (optional, the bot already sends it)
   - X_URL      = link to your X
   - PUMP_URL   = link to the coin on pump.fun (optional)
4. Deploy. Add your domain in Settings -> Domains.

If the bot is off, the site still works and still shows the live Bitcoin move.
Test buybacks are shown with a "test" tag.

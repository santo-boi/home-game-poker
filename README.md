# Home Game

Private No-Limit Hold'em tables for you and your friends. One person hosts a table and shares a 5-letter code or link; everyone else joins from a browser on their phone or laptop. Play chips only.

## What it does

- **Rooms for up to 10 players:** host a table, share the invite link, friends join with just their name.
- **Lobby and wallets, like Chips of Fury:** everyone lands in a lobby showing the game, the settings and a balances list. Only the admin puts chips into wallets (players can ask with one tap). On the Table page you watch until you press Join Table and buy in from your wallet; standing up returns your stack to the wallet.
- **Admin tools:** give or take back chips, approve requests, stand someone up, remove them, or pass the admin role to someone else.
- **For new players:** the ? button shows every hand from royal flush to high card with examples, plus how a hand works.
- **Table settings (host only):** maximum players, small and big blind, ante, blinds that double on a schedule, turn timer on or off, seconds per turn, time bank, standard buy-in, run it twice, rabbit hunting, muck losing hands, bomb pots (every N hands, or on demand), and automatic or manual dealing. Settings can be saved as presets. Changes made during a hand apply from the next hand.
- **Host controls:** start, pause, deal the next hand, call a bomb pot, skip a slow player's turn (when the timer is off), add computer players, remove a player, hand the host role to someone else.
- **Real rules:** blinds and button rotation (including heads-up rules), antes, minimum raises, short all-ins, side pots, split pots with odd chips to the left of the button.
- **Animations:** cards fly from the deck one at a time, the flop turns card by card, and in an all-in run-out the river is lifted, squeezed and turned slowly. With run it twice, the second board is dealt below the first.
- **Odds panel:** your win, tie and lose chances, exact wherever that is fast and simulated with an error bar otherwise.
- **Ledger:** everyone's chips given, stack and net, so settling up is easy.
- **Reconnects:** if someone's phone locks or their browser reloads, they return to the same seat.

## Accounts and history

Everyone logs in with their email and a password. Each account keeps:
- every game played: date, game code, chips given, final chips, net result, hands played and won
- every hand: your two cards, the board, the hand you made, the pot and how much you won or lost
- totals across all games, with a chart of your running result

Passwords are stored hashed (scrypt), never as plain text. When email is set up (below), new accounts confirm their email with a 6-digit code and anyone can reset a forgotten password from the "Forgot your password?" link. Without email set up, accounts work without codes and the site owner resets passwords with `reset-password.js`.

### Sending emails (confirmation and password-reset codes)

Render's free plan blocks normal email sending, so the site uses Brevo's email API (free, 300 emails a day):

1. Sign up at https://www.brevo.com (free plan).
2. Go to **Senders, Domains & Dedicated IPs → Senders → Add a sender**. Use your own email (e.g. your Gmail) and confirm it from the email Brevo sends you.
3. Go to **SMTP & API → API keys → Generate a new API key**. Copy it (it starts with `xkeysib-`).
4. In Render, open your service → **Environment** and add:
   - `BREVO_API_KEY` = the key from step 3
   - `MAIL_FROM` = the sender email from step 2
   - `MAIL_FROM_NAME` = `Home Game` (optional)
5. Save; Render redeploys.

Codes last 15 minutes, allow 5 tries, and a new one can be requested every 30 seconds. Without your own domain, emails sometimes land in spam, so tell friends to check there. Accounts made before email was turned on keep working without a code.

### Where accounts are kept

Render's free plan wipes the server's files whenever the site sleeps or restarts, so accounts need a free external database:

1. Sign up at https://neon.com (free, no card needed).
2. Create a project (any name, choose the region closest to you, e.g. Singapore).
3. On the project dashboard click **Connect** and copy the connection string. It looks like `postgresql://user:password@ep-....neon.tech/neondb?sslmode=require`.
4. In Render, open your service → **Environment** → **Add Environment Variable**: name `DATABASE_URL`, value = that connection string. Save; Render redeploys.

The server creates its tables by itself on first start. Without `DATABASE_URL` it saves to a local `data.json` file instead, which is fine on your own computer but is wiped on Render.

### Resetting someone's password

On your own computer, in this folder (after `npm install`):

```
DATABASE_URL="your Neon connection string" node reset-password.js friend@email.com theirnewpassword
```

On Windows PowerShell:

```
$env:DATABASE_URL="your Neon connection string"; node reset-password.js friend@email.com theirnewpassword
```

## Run it on your own computer

1. Install Node.js (the LTS version) from https://nodejs.org.
2. Unzip this folder, open a terminal in it, and run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000.

Friends on the same Wi-Fi can join at `http://<your computer's IP address>:3000`.

To check the game rules, run `npm test`. It plays thousands of fast hands and checks that chips are never created or lost and no hand ever gets stuck.

## Put it online (free, about 15 minutes)

You need a GitHub account (stores the code) and a Render account (runs it).

### 1. Upload the code to GitHub

1. Sign up at https://github.com.
2. Click **New** (or the **+** in the top right), then **New repository**.
3. Name it `home-game-poker`, choose Public or Private, and click **Create repository**.
4. On the next page, click **uploading an existing file**.
5. Drag in every file from this folder **except** `node_modules` (if you ran it locally).
6. Click **Commit changes**.

### 2. Run it on Render

1. Go to https://render.com and sign up with your GitHub account.
2. Click **New**, then **Web Service**, and pick your `home-game-poker` repository. Allow Render to see it if asked.
3. Use these settings:
   - **Language / Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
   - **Environment variables:** click **Add Environment Variable**, name it `ACCESS_KEY` and give it a long random value (this makes the site private; see below).
4. Click **Create Web Service** and wait until the status says **Live** (2–4 minutes).
5. Your site is the address at the top, for example `https://home-game-poker.onrender.com`.

### 3. Your private link

With `ACCESS_KEY` set, the site only works for people who open it through a link containing the key. Everyone else sees "This is a private table".

- **Your link:** `https://your-site.onrender.com/?key=YOUR_ACCESS_KEY`. Open it once on each of your devices; after that the plain address works there too.
- **Friends:** the **Invite** button copies a link that already contains the key, so they just tap it.
- **Keep it secret:** anyone with the key can open the site and host their own table, so only share invite links with people you trust.
- **Change it any time:** edit `ACCESS_KEY` in Render's Environment settings. Old links stop working immediately and everyone needs a new link.

The key is never in your code, so it stays private even if your GitHub repository is public.

### 4. Play

1. Open your private link and choose **Host a table**.
2. Set the blinds and buy-ins, then **Open the table**.
3. Press **Invite** and send the link to your friends (or tell them the 5-letter code).
4. When everyone is seated, press **Start the game**.

### Things to know about the free plan

- The site goes to sleep after 15 minutes with no visitors. The next visit takes about a minute to wake it, so open it a minute before game time.
- While people are playing, the live connection keeps it awake.
- Tables are kept in memory. If the server sleeps, restarts or is redeployed, open tables close. Don't upload changes in the middle of a game.
- The free plan includes 750 running hours a month, which is plenty for game nights.

### Updating the site

Edit or re-upload files in your GitHub repository. Render notices the change and redeploys automatically within a few minutes.

### Stop the site from falling asleep

On Render's free plan the site sleeps after 15 minutes with nobody on it, and the next visitor waits about a minute for it to wake. To keep it awake, have a free pinger visit it every 10 minutes:

1. Sign up at https://cron-job.org (free).
2. **Create cronjob** → URL `https://<your-site>.onrender.com/health`, schedule **every 10 minutes** → Create.

One always-on site fits inside Render's 750 free hours a month.

## How the project is organised

All files sit side by side in one folder.

| File | What it does |
| --- | --- |
| `server.js` | Web server and live connections: rooms, codes, joining, reconnecting, host commands, the private key |
| `table.js` | The rules: dealing, betting rounds, raises, side pots, showdown, timers |
| `bots.js` | Computer players that compare their equity with the pot odds |
| `engine.js` | Hand evaluator and equity engine, shared by the server and the browser |
| `store.js` | Accounts, logins and history (Postgres, or data.json when no database is set) |
| `reset-password.js` | Lets the site owner reset a player's password |
| `index.html`, `app.js`, `style.css` | Everything in the browser: screens, table, animations, controls, the look |
| `simulate.js` | Plays thousands of hands to check the rules (`npm test`) |

The server alone deals the cards and only ever sends each player their own hole cards, so nobody can see other hands by inspecting the page. Only the four website files are served to browsers; the server code is never downloadable.

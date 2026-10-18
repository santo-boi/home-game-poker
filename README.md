# Home Game

Private No-Limit Hold'em tables for you and your friends. One person hosts a table and shares a 5-letter code or link; everyone else joins from a browser on their phone or laptop. Play chips only.

## What it does

- **Rooms for up to 10 players:** host a table, share the invite link, friends join with just their name.
- **The host controls the chips:** players ask for chips and the host approves, changes or declines each request. The host can also give or take back chips at any time; chips given during a hand arrive when it ends.
- **Table settings (host only):** maximum players, small and big blind, ante, blinds that double on a schedule, turn timer on or off, seconds per turn, time bank, standard buy-in, run it twice, rabbit hunting, muck losing hands, bomb pots (every N hands, or on demand), and automatic or manual dealing. Settings can be saved as presets. Changes made during a hand apply from the next hand.
- **Host controls:** start, pause, deal the next hand, call a bomb pot, skip a slow player's turn (when the timer is off), add computer players, remove a player, hand the host role to someone else.
- **Real rules:** blinds and button rotation (including heads-up rules), antes, minimum raises, short all-ins, side pots, split pots with odd chips to the left of the button.
- **Animations:** cards fly from the deck one at a time, the flop turns card by card, and in an all-in run-out the river is lifted, squeezed and turned slowly. With run it twice, the second board is dealt below the first.
- **Odds panel:** your win, tie and lose chances, exact wherever that is fast and simulated with an error bar otherwise.
- **Ledger:** everyone's chips given, stack and net, so settling up is easy.
- **Reconnects:** if someone's phone locks or their browser reloads, they return to the same seat.

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

## How the project is organised

All files sit side by side in one folder.

| File | What it does |
| --- | --- |
| `server.js` | Web server and live connections: rooms, codes, joining, reconnecting, host commands, the private key |
| `table.js` | The rules: dealing, betting rounds, raises, side pots, showdown, timers |
| `bots.js` | Computer players that compare their equity with the pot odds |
| `engine.js` | Hand evaluator and equity engine, shared by the server and the browser |
| `index.html`, `app.js`, `style.css` | Everything in the browser: screens, table, animations, controls, the look |
| `simulate.js` | Plays thousands of hands to check the rules (`npm test`) |

The server alone deals the cards and only ever sends each player their own hole cards, so nobody can see other hands by inspecting the page. Only the four website files are served to browsers; the server code is never downloadable.

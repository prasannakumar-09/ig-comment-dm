# Setup guide for AI agents

**You (the AI agent: Antigravity, Claude Code, Cursor, …) are setting up this tool for the user on their own computer and accounts.**
The tool: when someone comments a keyword on the user's Instagram post, it DMs them a link. It runs free on the user's own Cloudflare account and uses the official Instagram API. Full human guide: `README.md`.

## Rules for you (follow all of them)

1. **Never ask the user to paste their Instagram token or dashboard password into the chat.** Secrets are typed only into the hidden `npx wrangler secret put …` prompts in the terminal (step 7). If the user pastes a token in chat anyway, tell them to regenerate it in Meta (step 3) because chat is not a safe place for it, and do not use or repeat it.
2. **Never put secrets in any file**, never commit `wrangler.toml`, never push anything. Do not edit `src/` unless the user asks.
3. **One step at a time.** The user may not be technical. Explain each manual step in plain, short words, tell them exactly what to click, and wait for "done" before continuing. Ask one question at a time.
4. **Run the commands yourself** when you can. Only hand a command to the user when it needs them (browser login, typing a secret).
5. If something fails, read the error, check the **Troubleshooting** table in `README.md`, fix what you can, and explain what happened.
6. Detect the OS (Windows PowerShell vs macOS/Linux) and use matching commands.

## Steps

### Start here: show the requirements first (before running anything)
Your first reply must be this checklist, in plain words, then ask: "Do you have all of these? Tell me which ones are missing." Wait for the answer. Help with anything missing before step 0.

**You need:**
1. **A laptop or computer** (Windows or Mac). Only for setup; afterwards the tool runs online on its own.
2. **An Instagram professional account** (Creator or Business), set to **public**. A personal or private account can't use the API.
3. **Instagram on your phone**, to change 3 settings and accept a tester invite.
4. **A Facebook account** you can log in to. Meta uses it for the free developer app (it may ask to verify your phone or email).
5. **A free Cloudflare account** (just an email). You can make it during setup.
6. **A second Instagram account** (a friend's or a spare) to send the test comment.
7. **About 20–30 minutes.**
8. **Node.js and Git.** I'll check these and tell you if they're missing.

**Keep in mind:**
- Your Instagram **token** is like a password. You'll paste it only into the terminal, **never into this chat**.
- You'll make up a **dashboard password** (also typed only in the terminal).
- Instagram's limits: a DM goes out within **5 minutes** of the comment, only for comments from the **last 7 days**, one DM per comment, max 15 DMs per 5 minutes.
- Instagram hides "spammy" comments from apps, so we'll turn off **Hidden words → Hide comments**.
- Everything runs on **your own** free accounts. Nobody else (including whoever shared this tool) can see your account or your DMs.


### 0. Prerequisites (you)
- Run `node -v` (needs 18 or newer), `npm -v`, `git --version`.
- If Node or Git is missing: tell the user to install Node.js LTS from https://nodejs.org and Git from https://git-scm.com/downloads, reopen the editor, then continue.

### 1. Get the code (you)
- If the current folder is not already this repo:
  `git clone https://github.com/prasannakumar-09/ig-comment-dm.git` then `cd ig-comment-dm`.
- `npm install` (an npm warning about `allow-scripts` / `approve-scripts` is harmless here; don't change any npm settings)
- `npm test`: every test must pass. If not, stop and report.

### 2. Instagram account (user, on their phone)
Ask the user to do these and confirm each:
1. **Professional account:** Profile → ☰ → Settings and activity → Account type and tools → Switch to professional account (Creator or Business). The account must be **public**.
2. **Allow DMs from tools:** ☰ → Settings and activity → Messages and story replies → Message controls → Connected tools → **Allow access to messages** → On.
3. **Spam filter off:** ☰ → Settings and activity → Hidden words → turn **off** "Hide comments" and "Hide more comments" / "Advanced comment filtering". (Instagram hides spam-looking comments from apps; those people would never get a DM.)

### 3. Meta app and token (user, in the browser, ~15 min)
Guide the user through `README.md` **section 2** one numbered item at a time. Key points:
- Use case **Manage messaging & content on Instagram**; select or create a **business portfolio** if asked.
- **Use cases → Customize → API setup with Unified login**.
- Configuration **Instagram API (unified login)** → Edit permissions → keep only `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`.
- Add their Instagram username as **Instagram Tester** (Roles link), then accept at https://www.instagram.com/accounts/manage_access/ → Tester Invites.
- Reload; their account appears under "Generate access tokens" with a **number** next to it.

Then **ask the user for that number** (their Instagram account ID, looks like `17841…`). It is **not** a secret; you need it in step 5.
Tell them: "Now click **Generate token** and copy it, but **don't paste it here**. You'll paste it into the terminal in a few minutes."

### 4. Cloudflare login (user clicks, you run)
- Ask whether they have a free Cloudflare account; if not: https://dash.cloudflare.com/sign-up (verify email).
- Run `npx wrangler login` → tell the user a browser tab opens and they must click **Allow**.
- Confirm with `npx wrangler whoami`.

### 5. Config (you)
- Copy the template: Windows `Copy-Item wrangler.example.toml wrangler.toml`, macOS/Linux `cp wrangler.example.toml wrangler.toml`.
- `npx wrangler kv namespace create KV` → it prints `id = "…"`.
  If it says the namespace already exists, run `npx wrangler kv namespace list` and use the id of the namespace titled `KV` (or `ig-comment-dm-KV`).
- In `wrangler.toml` replace `PASTE_YOUR_KV_NAMESPACE_ID` with that id and `PASTE_YOUR_INSTAGRAM_ACCOUNT_ID` with the number from step 3.

### 6. Deploy (you)
- `npx wrangler deploy`
- If it asks to register a **workers.dev subdomain**, ask the user to pick a name (or accept the suggestion).
- Note the printed dashboard URL `https://ig-comment-dm.<subdomain>.workers.dev` and give it to the user to **bookmark**.

### 7. Secrets (the user types them, never in chat)
Run these one at a time (or, if your terminal cannot accept the user's typing, ask the user to run them in their own terminal inside this folder):
1. `npx wrangler secret put IG_TOKEN` → tell the user: "Click into the terminal, paste the token from Meta, press Enter. Nothing shows while you paste; that's normal."
2. `npx wrangler secret put DASH_PASSWORD` → tell the user: "Type a new password you'll use to open your dashboard (letters, numbers, dashes), press Enter. Not the token."

Each should print `Success! Uploaded secret …`.

### 8. Check it works (user, you guide)
1. User opens the dashboard URL, logs in with **any username** + their password.
2. In **System**, press **Run now** → their `@username` must appear at the top.
   - "Try again in a minute" → the automatic check is running; wait a minute and retry.
   - "Invalid OAuth access token" → the token is wrong; regenerate it (step 3) and redo step 7.1.

### 9. First rule and safe test (user, you guide)
1. **Keyword rules → New rule:** keyword (e.g. `LINK`) or trigger **Any emoji**, the DM text with their link, **Applies to**: All posts or one post → Save.
2. Leave **Dry run** on. From a **second Instagram account**, comment the keyword on one of their posts.
3. Within 5 minutes the dashboard shows it as **Dry run** (nothing sent).
4. Click **Go live**. The next run sends the real DM (it lands in **Requests** if the second account doesn't follow them).

### 10. Wrap up
Tell the user, briefly:
- Their dashboard URL; it runs every 5 minutes on its own, computer on or off.
- Never share the token or dashboard password; use a **new comment** for each test (one DM per comment, ever).
- To update later: `git pull`, `npm install`, `npx wrangler deploy`.

# Instagram comment → DM

When someone comments a keyword (or an emoji) on your post or reel, they automatically get a DM with your link, plus a short public reply under their comment. Like ManyChat, but free and running on your own Cloudflare account.

- **Free:** runs on Cloudflare Workers free tier. A check runs every 5 minutes.
- **Official Instagram API only** (Meta's "Instagram API with Unified Login"). No scraping, no password sharing, no App Review.
- **Your own copy:** you use your own Meta app, token and dashboard. Nobody else (including whoever shared this with you) can see your account or DMs.
- **Safe:** each comment gets at most one DM, ever. It starts in **dry run** mode, which shows who *would* get a DM without sending anything.

📖 **Not technical? Use the step-by-step beginner guide:** <https://prasannakumar-09.github.io/ig-comment-dm/>

## ⚡ Easiest: let AI set it up for you

Open **Google Antigravity** (or Claude Code / Cursor), start a new chat in an empty folder, and paste:

```text
Set up this tool for me: https://github.com/prasannakumar-09/ig-comment-dm
Clone it, read AGENTS.md and follow it step by step. Ask me for anything you need.
```

The AI installs and deploys everything and walks you through the parts only you can do (Instagram settings, Meta app, Cloudflare login). It never needs your token in the chat. You paste that into the terminal yourself.

## Or set it up by hand

**Takes about 30–45 minutes.** Follow the steps in order.

---

## What you need

- An **Instagram professional account** (Business or Creator), **public**.
- A **Facebook account** (to log in to Meta for Developers).
- A free **Cloudflare account**: <https://dash.cloudflare.com/sign-up>
- **Node.js 18 or newer**: <https://nodejs.org> (LTS installer)
- **Git**: <https://git-scm.com/downloads>

## 1. Prepare your Instagram account (phone, 2 min)

1. **Professional account:** Profile → ☰ → **Settings and activity → Account type and tools → Switch to professional account** → Creator or Business.
2. **Allow DMs from tools:** ☰ → **Settings and activity → Messages and story replies → Message controls → Connected tools → Allow access to messages** → **On**. Without this, every DM fails.
3. **Spam filter (important):** ☰ → **Settings and activity → Hidden words** → turn **off** "Hide comments" and "Hide more comments" / "Advanced comment filtering". Instagram hides "spam-looking" comments (like many people commenting the same word) from apps, so those people would never get a DM.

## 2. Create the Meta app and get your token (computer, 15 min)

1. Go to <https://developers.facebook.com/apps>, log in with Facebook, and click **Create App**. If it's your first time, register as a developer first (accept the terms, verify phone/email).
2. Name it anything (e.g. `comment dm`), add your email.
3. Use case: **Manage messaging & content on Instagram**. App type **Business** if asked. If it asks for a **business portfolio**, select or create one (this setup requires it).
4. In the app, left menu: **Use cases → Customize** (the Instagram one) → **API setup with Unified login**.
5. **Step 1 – configuration:** select **Instagram API (unified login)**, click **Edit permissions**, and keep only:
   - `instagram_basic` and `instagram_manage_messages` (always on)
   - `instagram_manage_comments`

   Untick `ads_management`, `ads_read`, `instagram_content_publish`. Save.
6. **Add yourself as a tester:** in Step 2 ("Generate access tokens") click the blue **Roles** link → **Add Instagram Testers** → type your Instagram username → Submit.
   Then accept it: open <https://www.instagram.com/accounts/manage_access/> (logged in as that account) → **Tester Invites** → **Accept**.
7. Back on the Meta page, **reload**. Your account now shows under "Generate access tokens" with a **number** next to it (like `17841…`). **Write that number down**: it's your **Instagram account ID**.
8. Click **Generate token** → approve → tick the box → **copy** the long token. Keep it somewhere private for a few minutes. **Never paste it in chat, email, or into any file.** It never expires and gives access to your account.
9. Leave the app in **Development** mode. No App Review needed for your own account.

(Meta renames buttons often. If something looks different, look for "Unified login" and "Generate access tokens".)

## 3. Get the code (5 min)

```bash
git clone https://github.com/prasannakumar-09/ig-comment-dm.git
```

```bash
cd ig-comment-dm
```

```bash
npm install
```
## 4. Cloudflare setup (5 min)

Log in (opens your browser, click **Allow**):

```bash
npx wrangler login
```

Create your config file from the template.

Windows (PowerShell):

```bash
Copy-Item wrangler.example.toml wrangler.toml
```

Mac / Linux:

```bash
cp wrangler.example.toml wrangler.toml
```

Create the storage it uses:

```bash
npx wrangler kv namespace create KV
```

It prints an `id = "…"`. Open `wrangler.toml` in any text editor and replace:

- `PASTE_YOUR_KV_NAMESPACE_ID` → that id
- `PASTE_YOUR_INSTAGRAM_ACCOUNT_ID` → the number from step 2.7

Neither is a secret. `wrangler.toml` is git-ignored, so it stays on your computer.

## 5. Deploy and set your two secrets (5 min)

```bash
npm test
```

All tests should pass. Then:

```bash
npx wrangler deploy
```

It prints your dashboard URL, like `https://ig-comment-dm.<your-name>.workers.dev`. **Bookmark it.**

Now the two secrets. At each prompt, paste the value and press Enter (nothing shows while you paste; that's normal):

```bash
npx wrangler secret put IG_TOKEN
```

→ paste the token from step 2.8.

```bash
npx wrangler secret put DASH_PASSWORD
```

→ type a password you make up (letters, numbers, dashes). This is your dashboard login. **Not** the token.

## 6. First run and test (10 min)

1. Open your dashboard URL. Log in with **any username** + your `DASH_PASSWORD`.
2. In **System**, press **Run now**. Your `@username` should appear at the top. (If it says "Try again in a minute", the automatic check is running; wait a minute.)
3. **Keyword rules → New rule:**
   - Trigger: **A keyword or a specific emoji** (e.g. `LINK`) or **Any emoji**
   - DM text: your message with the link
   - Applies to: **All posts** or one post
   - Save. (Every change saves instantly.)
4. Leave **Dry run** on. From a **second Instagram account**, comment your keyword on one of your posts.
5. Wait up to 5 minutes (or press Run now). The **Latest run** bar shows "1 matched (dry run)", and **Activity** shows the comment as *Dry run*. Nothing was sent.
6. Click **Go live** (yellow bar). The next run sends the real DM. The second account gets it (in **Requests** if it doesn't follow you), plus your public reply under the comment.

Done. It now runs every 5 minutes by itself, even with your computer off.

---

## Using the dashboard

**Overview tab**
- **Latest run:** live bar of the last run: sent / skipped / failed. Updates by itself.
- **Keyword rules:** add, edit, delete, switch on/off. Matching is whole-word, any letter case, any font (`LINK`, `link`, `ʟɪɴᴋ`, `𝐥𝐢𝐧𝐤` all match; `linkedin` doesn't). Triggers: **a keyword** (or a specific emoji), **any emoji**, or **any comment**. Keyword rules win, then any emoji, then any comment. Each rule can also have:
  - **Link + button text:** the link is sent as a tappable button (falls back to plain text if Instagram refuses buttons). *Beta.*
  - **Don't DM if the comment contains…:** comma-separated words to skip.
  - **Stop after:** an end date; the rule switches itself off after that day.
  - **✉️ Also in DMs & story replies:** someone who DMs you the keyword, or replies to your story with it, gets the DM too.
- **Public reply:** the text posted under the comment after a DM. Put **one reply per line** and each comment gets one at random, so replies don't look like spam.
- **If the DM fails:** text posted under the comment when Instagram blocks the DM (e.g. their privacy settings), so they can fix it and comment again.
- **Activity:** last 100 DMs, filter by sent / errors / dry run, **Export CSV**.
- **System:** token status, dry run / live switch, **Run now**.

**Comments tab:** every recent comment on your posts and what the tool did with it: *DM sent*, *Will DM next run*, *Skipped · you replied*, *No keyword*, *Older than 7 days*, … Filter by post or result, or search a name. Use it to check why someone did or didn't get a DM.

## Rules the tool follows

- One DM per comment, ever (Instagram's rule too). Test with a **new comment** each time.
- Only comments **under 7 days old** (Instagram's limit).
- Skips your own comments and comments **you already replied to** yourself.
- Max **15 DMs per run** (every 5 min). More are sent in the next runs.
- If Instagram rate-limits, it stops and retries next run.

## Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard keeps asking for password | Wrong password, or `DASH_PASSWORD` not set. Run `npx wrangler secret put DASH_PASSWORD` again, then close and reopen the browser. |
| "Invalid OAuth access token" / account not loaded | Token wrong or from the wrong page. Generate it again (step 2.8) and run `npx wrangler secret put IG_TOKEN`. |
| Someone commented but isn't in the **Comments** tab | Instagram hid their comment as spam. Turn off Hidden words filters (step 1.3). Identical one-word comments from many people get filtered most. |
| "Skipped · you replied" | You replied under their comment yourself, so the tool leaves it. Delete your reply if you want them to get the DM. |
| "already has a reply" / "already had a DM" | That comment already got a private DM (from you or another tool). Instagram allows one. |
| DM failed: "isn't available" / similar | Their privacy settings block it. The "If the DM fails" reply tells them. |
| They say they got nothing | Ask them to check **Requests** in their DMs (shown there if they don't follow you). |
| `npx` / `npm` not found | Install Node.js (LTS) and reopen the terminal. |

## Free-tier limits (you won't hit these normally)

| Cloudflare free limit | This tool uses |
|---|---|
| 50 requests per run | ≤ 50: inbox check (only if a rule is also in DMs: 1 + up to 5) + post list + comment pages + 15 × (DM + reply) |
| 1,000 storage writes/day | 0 on quiet runs, 2 on runs that send, 1 per dashboard change |
| 100,000 storage reads/day | ~288 for the automatic checks + dashboard while open |

## Updating

When the repo gets an update:

```bash
git pull
```

```bash
npm install
```

```bash
npx wrangler deploy
```

Your rules, log and secrets are kept.

## Files

- `src/core.js`: matching, picking, no-duplicate logic (no network); tested in `test/core.test.js`
- `src/index.js`: the 5-minute check, dashboard API, Instagram calls
- `src/dashboard.html`: the dashboard
- `wrangler.example.toml`: config template (copy to `wrangler.toml`)

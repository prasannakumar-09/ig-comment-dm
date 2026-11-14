import html from './dashboard.html';
import loginHtml from './login.html';
import { API, MAX_DMS, MAX_MEDIA, collectComments, commentStatus, defaults, isRateLimit, plainText, processComments, processInbox, pruneInbox, validateConfig } from './core.js';

const KEY = 'state'; // the only KV key
// Fields from the earlier Instagram-Login version (the token must not stay in KV). Dropped on next save.
const LEGACY = ['token', 'tokenFp', 'tokenRefreshedAt', 'tokenExpiresAt', 'tokenError'];

const load = async (env) => {
  // cacheTtl 30 = KV's minimum edge cache (default 60), so runs and the dashboard see fresh data sooner.
  const s = { ...defaults(), ...((await env.KV.get(KEY, { type: 'json', cacheTtl: 30 })) || {}) };
  for (const k of LEGACY) delete s[k];
  return s;
};
const save = (env, s) => env.KV.put(KEY, JSON.stringify(s));

const sha256 = async (text) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

// Graph API call. Token goes in the Authorization header, never in the URL.
async function ig(token, path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw Object.assign(new Error(body.error?.message || `HTTP ${res.status}`), {
      code: body.error?.code,
      status: res.status,
    });
  }
  return body;
}
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });

// replies{...} rides along in the same request, so "you already replied" costs no extra subrequest.
const COMMENT_FIELDS = encodeURIComponent('id,text,username,timestamp,like_count,from{id,username},replies{username,from{id,username}}');
const commentPage = (token) => (mid, after) =>
  ig(token, `/${mid}/comments?fields=${COMMENT_FIELDS}&limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`);

// Comments tab: every recent comment plus what the tool did / will do with it. Read-only, no KV writes.
async function commentsView(env) {
  const s = await load(env);
  const now = Date.now();
  const media = (await ig(env.IG_TOKEN, `/${env.IG_USER_ID}/media?fields=id,caption,permalink,timestamp,comments_count&limit=${MAX_MEDIA}`)).data || [];
  const { comments } = await collectComments(media, commentPage(env.IG_TOKEN), 48, now); // 1 media + 48 pages + KV read < 50
  const byCid = Object.fromEntries(s.log.filter((e) => e.cid).map((e) => [e.cid, e]));
  return {
    loadedAt: now,
    posts: media.map(({ id, caption, permalink, timestamp, comments_count }) => ({ id, caption: (caption || '').slice(0, 120), permalink, timestamp, comments: comments_count })),
    comments: comments.map((c) => {
      const { status, rule } = commentStatus(c, s, now);
      const e = byCid[c.id]; // DM result, for comments handled since the log started recording comment IDs
      const result = status !== 'handled' || !e ? status : e.skipped ? 'skipped' : e.ok ? 'sent' : 'failed';
      return { id: c.id, mediaId: c.mediaId, user: c.username || c.from?.username || '?', text: c.text, t: Date.parse(c.timestamp), likes: c.like_count || 0, replies: (c.replies?.data || []).length, status: result, rule: rule?.keyword || null, error: e?.error || null };
    }),
  };
}

async function run(env, manual = false) {
  if (!env.IG_TOKEN || !env.IG_USER_ID) return { error: 'IG_TOKEN secret or IG_USER_ID var is not set' };
  const token = env.IG_TOKEN;
  const id = env.IG_USER_ID;
  const s = await load(env);
  const now = Date.now();
  // KV has no locks: keep "Run now" away from the cron (fires at :00, :05, ...) and from a recent run.
  if (manual && (new Date(now).getUTCMinutes() % 5 === 0 || now - (s.lastRunAt || 0) < 120e3))
    return { skipped: 'A scheduled run may be in progress. Try again in a minute.' };

  let dirty = false;
  let calls = 0; // Instagram calls made before the comment pages, so pages + sends stay within 50 subrequests
  try {
    if (s.userId !== id || !s.username) {
      const me = await ig(token, `/${id}?fields=username`);
      Object.assign(s, { userId: id, username: me.username });
      dirty = true;
      calls++;
    }

    const saveNow = async (st) => { await save(env, st); dirty = false; };
    // Rich messages (button / quick replies) fall back to plain text if Instagram refuses them (costs one more call).
    const sendWithFallback = async (recipient, message) => {
      try {
        return await ig(token, `/${id}/messages`, post({ recipient, message }));
      } catch (e) {
        if (isRateLimit(e) || /already has a reply/i.test(e.message) || !(message.attachment || message.quick_replies)) throw e;
        return ig(token, `/${id}/messages`, post({ recipient, message: { text: plainText(message) } }));
      }
    };
    pruneInbox(s, now);

    // 1) Inbox first (DM keywords / story replies are inside a 24 h window). Max 1 + 5 calls.
    let inbox = { handled: 0 };
    if (s.rules.some((r) => r.enabled && r.inbox)) {
      const f = encodeURIComponent('updated_time,participants,messages.limit(3){from,message,created_time}');
      const data = (await ig(token, `/${id}/conversations?platform=instagram&fields=${f}&limit=15`)).data || [];
      calls++;
      const convs = data
        .filter((c) => now - Date.parse(c.updated_time) < 864e5)
        .map((c) => {
          const other = (c.participants?.data || []).find((p) => p.id !== id) || {};
          const msgs = (c.messages?.data || []).filter((m) => m.from?.id && m.from.id !== id)
            .map((m) => ({ id: m.id, text: m.message || '', at: Date.parse(m.created_time) }));
          return { pid: other.id, user: other.username || '?', msgs };
        })
        .filter((c) => c.pid && c.msgs.length);
      inbox = await processInbox(s, convs, {
        save: saveNow,
        send: (pid, message) => { calls++; return sendWithFallback({ id: pid }, message); },
      }, now);
    }

    // 2) Comments. 50 subrequests per run: keep 2 per possible DM (DM + public reply), rest on comment pages.
    const media = (await ig(token, `/${id}/media?fields=id,permalink,timestamp&limit=${MAX_MEDIA}`)).data || [];
    calls++;
    const pageBudget = Math.max(1, 50 - calls - 2 * MAX_DMS);
    const { comments, pages } = await collectComments(media, commentPage(token), pageBudget, now);

    if (s.lastError && !s.lastError.msg.startsWith('Rate limited')) {
      s.lastError = null; // reached Instagram fine: clear a stale error (one write, only when one exists)
      dirty = true;
    }

    const res = await processComments(
      s,
      comments,
      {
        save: saveNow,
        dm: (cid, message) => sendWithFallback({ comment_id: cid }, message),
        reply: (cid, message) => ig(token, `/${cid}/replies`, post({ message })),
      },
      now
    );
    if (dirty) await save(env, s);
    return { ...res, inbox: inbox.handled, posts: media.length, pages, comments: comments.length };
  } catch (e) {
    const msg = isRateLimit(e) ? 'Rate limited by Instagram. Will retry next run.' : e.message;
    // Only write when the error changes, so a broken token doesn't burn the KV write quota.
    if (dirty || s.lastError?.msg !== msg) {
      s.lastError = { at: now, msg };
      await save(env, s);
    }
    return { error: msg };
  }
}

// Sign-in: the password page sets a signed cookie "<expiry ms>.<HMAC>". The key is DASH_PASSWORD,
// so changing the password signs every device out. No session storage needed.
const COOKIE = 'dm_session';
const SESSION_S = 30 * 86400;
const same = async (x, y) => {
  const [a, b] = await Promise.all([sha256(x), sha256(y)]);
  return crypto.subtle.timingSafeEqual(a, b);
};
async function sign(env, exp) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.DASH_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`dm-session:${exp}`)));
  return `${exp}.${btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
async function authed(req, env) {
  if (!env.DASH_PASSWORD) return false;
  const v = (req.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const exp = Number(v?.split('.')[0]);
  if (!v || !(exp > Date.now())) return false;
  return same(v, await sign(env, exp));
}
const setCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const publicView = (s, env) => ({
  rules: s.rules,
  replyText: s.replyText,
  failReplyText: s.failReplyText,
  replyEnabled: s.replyEnabled,
  dryRun: s.dryRun,
  log: s.log,
  username: s.username,
  hasToken: !!env.IG_TOKEN,
  lastRunAt: s.lastRunAt,
  lastRun: s.lastRun || null,
  lastError: s.lastError,
  version: env.VERSION?.id || null, // dashboard reloads itself when this changes after a deploy
});

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    const m = req.method;
    // Mutating calls must be JSON: forces a CORS preflight, so other sites can't trigger them with your saved login.
    if (m !== 'GET' && !(req.headers.get('Content-Type') || '').startsWith('application/json'))
      return json({ error: 'JSON required' }, 415);

    if (m === 'POST' && pathname === '/api/login') {
      const { password } = (await req.json().catch(() => null)) || {};
      if (!env.DASH_PASSWORD) return json({ error: 'No dashboard password is set yet. Run: npx wrangler secret put DASH_PASSWORD' }, 503);
      if (typeof password !== 'string' || !(await same(password, env.DASH_PASSWORD))) {
        await new Promise((r) => setTimeout(r, 800)); // slows down password guessing
        return json({ error: 'Wrong password. Try again.' }, 401);
      }
      const value = await sign(env, Date.now() + SESSION_S * 1000);
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': setCookie(value, SESSION_S) } });
    }
    if (m === 'POST' && pathname === '/api/logout')
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': setCookie('', 0) } });

    if (!(await authed(req, env))) {
      if (m === 'GET' && pathname === '/')
        return new Response(loginHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
      return json({ error: 'Signed out. Reload the page to sign in.' }, 401);
    }

    if (m === 'GET' && pathname === '/')
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (m === 'GET' && pathname === '/api/state')
      return json(publicView(await load(env), env));
    if (m === 'GET' && pathname === '/api/posts') {
      if (!env.IG_TOKEN || !env.IG_USER_ID) return json({ error: 'IG_TOKEN or IG_USER_ID not set' }, 400);
      try {
        return json((await ig(env.IG_TOKEN, `/${env.IG_USER_ID}/media?fields=id,caption,permalink,timestamp&limit=25`)).data || []);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
    if (m === 'GET' && pathname === '/api/comments') {
      if (!env.IG_TOKEN || !env.IG_USER_ID) return json({ error: 'IG_TOKEN or IG_USER_ID not set' }, 400);
      try {
        return json(await commentsView(env));
      } catch (e) {
        return json({ error: isRateLimit(e) ? 'Instagram rate limit. Try again in a few minutes.' : e.message }, 502);
      }
    }
    if (m === 'PUT' && pathname === '/api/config') {
      const cfg = validateConfig(await req.json().catch(() => null));
      if (cfg.error) return json(cfg, 400);
      const s = await load(env);
      if (s.dryRun && !cfg.dryRun) s.dryHandled = {}; // dry-run "handled" must not block real DMs
      Object.assign(s, cfg);
      await save(env, s);
      return json(publicView(s, env));
    }
    if (m === 'POST' && pathname === '/api/run') return json(await run(env, true));
    return json({ error: 'not found' }, 404);
  },

  async scheduled(_event, env, ctx) {
    // Logged so `wrangler tail` / Cloudflare's logs show what each automatic run did.
    ctx.waitUntil(run(env).then((r) => console.log('scheduled run', JSON.stringify(r))));
  },
};

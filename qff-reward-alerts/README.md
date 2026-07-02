# Qantas Reward Seat Alerter — Setup

Emails **jacques.burns3@gmail.com** whenever new Business/First Classic Reward
seats appear on your watched routes. Runs itself every 3 hours on Netlify.

You only have to do TWO things: **(1) get a free email key, (2) upload to Netlify.**

---

## Step 1 — Get a free Resend key (2 min)

Netlify can't send email on its own, so we use Resend (free).

1. Go to **https://resend.com** and sign up.
2. In the dashboard, open **API Keys → Create API Key**. Name it anything.
3. **Copy the key** (starts with `re_…`). Keep the tab open — you'll paste it in Step 2.

That's the only secret you need. (For now it sends from `onboarding@resend.dev`,
which works immediately. Later you can verify your own domain in Resend for
best inbox delivery.)

---

## Step 2 — Put it on Netlify (all clicks, no terminal)

The easiest no-terminal route is via GitHub, because Netlify then installs
everything for you automatically.

**2a. Upload the files to GitHub**
1. Go to **https://github.com/new** (sign up if needed) → give the repo any name
   → **Create repository**.
2. On the next page click **“uploading an existing file”**.
3. Drag the **whole contents of this folder** into the box (including the
   `netlify` folder). Click **Commit changes**.

**2b. Connect it to Netlify**
1. Go to **https://app.netlify.com** → **Add new site → Import an existing project**.
2. Choose **GitHub**, authorise, and pick the repo you just made.
3. Leave all build settings as they are and click **Deploy**. Wait ~1 minute.

**2c. Add your email key**
1. In the site, go to **Site configuration → Environment variables → Add a variable**.
2. Key: `RESEND_API_KEY`  — Value: paste your `re_…` key. Save.
3. Go to **Deploys → Trigger deploy → Deploy site** so it picks up the key.

**Done.** The first run sends you a baseline email so you know it's alive. After
that you only get emailed when *new* seats appear.

Want to test immediately instead of waiting? Open your site's URL (the
`something.netlify.app` link) and press **“Check now.”**

---

## Prefer the terminal? (optional, faster)

If you're comfortable in a terminal, skip GitHub entirely:

```
cd qff-reward-alerts
npm install
npx netlify deploy --build --prod
npx netlify env:set RESEND_API_KEY "re_your_key_here"
npx netlify deploy --build --prod
```

The first deploy will prompt you to log in and create the site.

---

## Changing what it watches

Edit **`watchlist.json`** — airport codes, cabins, and dates are all plain text
in there. Re-upload it to GitHub (or re-run the deploy command) and Netlify
redeploys automatically.

## If an email never arrives

Check **Netlify → your site → Logs → Functions**. If a run shows `parsed: 0`
even though seats exist, the Qantas page layout probably changed — send me a
fresh sample and it's a quick fix.

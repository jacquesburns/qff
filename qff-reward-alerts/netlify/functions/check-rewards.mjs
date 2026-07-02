// Qantas Frequent Flyer — Classic Reward availability alerter
// Runs on a schedule, fetches the public Flight Reward Finder pages for the
// routes/dates in watchlist.json, diffs against the last snapshot in Netlify
// Blobs, and emails (via Resend) whenever NEW award availability appears.
//
// You should never need to edit this file. Edit watchlist.json instead.

import { getStore } from "@netlify/blobs";
import watchlist from "../../watchlist.json"; // esbuild inlines this at build time

const BASE = "https://flightrewardfinder.qantas.com/";
const CABIN_ORDER = ["Premium Economy", "Economy", "Business", "First"]; // longest-first for matching

// ---------- helpers ----------

const pad = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Expand a watch entry's dates + dateRange into a de-duplicated, sorted list of YYYY-MM-DD.
function resolveDates(watch) {
  const set = new Set(Array.isArray(watch.dates) ? watch.dates : []);
  const r = watch.dateRange;
  if (r && r.start && r.end) {
    const step = Math.max(1, Number(r.everyDays) || 1);
    let cur = new Date(`${r.start}T00:00:00Z`);
    const end = new Date(`${r.end}T00:00:00Z`);
    let guard = 0;
    while (cur <= end && guard++ < 400) {
      set.add(toISO(cur));
      cur = new Date(cur.getTime() + step * 86400000);
    }
  }
  return [...set].sort();
}

function buildUrl({ origins, destinations, cabins }, date, page = 1) {
  const p = new URLSearchParams();
  p.set("pg", String(page));
  p.set("o", origins.join(","));
  p.set("d", destinations.join(","));
  p.set("dr", `${date}I${date}`); // NOTE: separator is a capital "I"; ranges don't work, so start==end
  p.set("c", cabins.join(","));
  return `${BASE}?${p.toString()}`;
}

// Strip HTML to a clean, newline-separated text stream (mirrors what the page shows).
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>/gi, " [IMG alt=$1 src=$2] ")
    .replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, " [IMG alt=$2 src=$1] ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .split("\n").map((s) => s.trim()).filter(Boolean).join("\n");
}

// Total pages, from "Page X of Y".
function totalPages(text) {
  const m = text.match(/Page\s+\d+\s+of\s+(\d+)/i);
  return m ? Math.max(1, parseInt(m[1], 10)) : 1;
}

// Parse flight availability out of the page text.
// We anchor on each airline logo (one per flight card) and read the card that follows.
// Each card in the "Calendar View" section looks like:
//   <date>\n<duration>\n<FromCity>\n[IMG ... XX.webp]\n<ToCity>\n<dep>\n<stops>\n<arr>\n
//   <Cabin>\n<N seats>\n<NNN,NNN pts+ AU$..>  (repeated per cabin that has seats)
const NON_CITY = /\b(hours?|mins?|min|stop|stops|direct|seats?|pts|economy|business|first|premium|img|logo|chart|calendar|view|showing|page|from|to|duration|filters|passenger|explore|clear|updated|any)\b/i;
// A "cityish" line: letters/spaces/dots/hyphens only, no digits, not a keyword.
function isCity(line) {
  if (!line || /\d/.test(line)) return false;
  if (NON_CITY.test(line)) return false;
  return /^[A-Za-z][A-Za-z .'\-]{1,40}$/.test(line);
}

function parseFlights(text) {
  const lines = text.split("\n");
  const out = new Map(); // signature -> record

  const logoIdx = [];
  const logoRe = /airline-logos-opt\/([A-Z0-9]{2})\.webp/i;
  lines.forEach((l, i) => { if (logoRe.test(l)) logoIdx.push(i); });

  const dateRe = /\b(\d{1,2}\s+[A-Za-z]+\s+20\d{2})\b/;
  const cabinRe = new RegExp(`^(${CABIN_ORDER.join("|")})$`, "i");
  const seatsRe = /^(\d+)\+?\s*seats?$/i;
  const ptsRe = /([\d,]+)\s*pts/i;
  const isLogo = (l) => logoRe.test(l);

  for (let k = 0; k < logoIdx.length; k++) {
    const i = logoIdx[k];
    const carrier = (lines[i].match(logoRe)?.[1] || "??").toUpperCase();

    // From city = nearest cityish line ABOVE the logo (skip durations, other logos).
    let from = "";
    for (let b = i - 1; b >= Math.max(0, i - 6); b--) {
      if (isLogo(lines[b])) continue;
      if (isCity(lines[b])) { from = lines[b]; break; }
    }
    // To city = nearest cityish line BELOW the logo.
    let to = "";
    for (let a = i + 1; a <= Math.min(lines.length - 1, i + 6); a++) {
      if (isLogo(lines[a])) continue;
      if (isCity(lines[a])) { to = lines[a]; break; }
    }

    // Date = nearest date line looking back a few lines from the logo.
    let date = "";
    for (let b = i; b >= Math.max(0, i - 8); b--) {
      const m = lines[b].match(dateRe);
      if (m) { date = m[1]; break; }
    }

    // Scan forward until the next logo (or +18 lines) for Cabin/seats/pts triples.
    const stop = k + 1 < logoIdx.length ? logoIdx[k + 1] : Math.min(lines.length, i + 20);
    for (let j = i + 1; j < stop; j++) {
      const cm = lines[j].match(cabinRe);
      if (!cm) continue;
      const cabin = cm[1].replace(/\b\w/g, (c) => c.toUpperCase());
      // Look at the next couple of lines for "N seats" and "NNN pts".
      let seats = null, pts = null;
      for (let n = j + 1; n <= j + 3 && n < stop; n++) {
        const sm = lines[n].match(seatsRe);
        if (sm && seats === null) seats = parseInt(sm[1], 10);
        const pm = lines[n].match(ptsRe);
        if (pm && pts === null) pts = pm[1];
      }
      if (seats === null) continue; // no seats in this cabin
      const sig = `${date}|${from}->${to}|${carrier}|${cabin}`;
      out.set(sig, { date, from, to, carrier, cabin, seats, pts, sig });
    }
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (personal reward-seat watcher)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return htmlToText(await res.text());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- email ----------

function bookingUrl(f) {
  // Rebuild a finder URL that lands on this flight's date (city names -> we keep the
  // original route search is not reversible to codes reliably, so link to the date view).
  return `${BASE}?dr=${encodeURIComponent(isoFromLabel(f.date))}I${encodeURIComponent(isoFromLabel(f.date))}`;
}

// "29 Nov 2026" -> "2026-11-29" (best effort; falls back to empty).
function isoFromLabel(label) {
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const m = label.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(20\d{2})/);
  if (!m) return "";
  return `${m[3]}-${months[m[2].toLowerCase()]}-${pad(m[1])}`;
}

function buildEmail(newFlights, isFirstRun) {
  const rows = newFlights
    .sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from))
    .map((f) => {
      const iso = isoFromLabel(f.date);
      const link = iso ? `${BASE}?dr=${iso}I${iso}` : BASE;
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${f.date}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${f.from} &rarr; ${f.to}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${f.carrier}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;"><strong>${f.cabin}</strong></td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${f.seats} seat${f.seats > 1 ? "s" : ""}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${f.pts ? f.pts + " pts" : ""}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;"><a href="${link}">open</a></td>
      </tr>`;
    })
    .join("");

  const intro = isFirstRun
    ? "Monitoring is now live. Here's the current availability I found (baseline — future emails only show NEW seats):"
    : "New Classic Reward availability just appeared on your watched routes:";

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#222;max-width:680px;">
    <h2 style="margin:0 0 8px;">✈️ Qantas reward seats${isFirstRun ? " — baseline" : ""}</h2>
    <p style="margin:0 0 16px;color:#555;">${intro}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead><tr style="text-align:left;background:#fafafa;">
        <th style="padding:8px 12px;">Date</th><th style="padding:8px 12px;">Route</th>
        <th style="padding:8px 12px;">Airline</th><th style="padding:8px 12px;">Cabin</th>
        <th style="padding:8px 12px;">Seats</th><th style="padding:8px 12px;">Points</th>
        <th style="padding:8px 12px;"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:16px 0 0;color:#999;font-size:12px;">Availability isn't guaranteed until booked on qantas.com. Personal, non-commercial alerter.</p>
  </div>`;
}

async function sendEmail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO || "jacques.burns3@gmail.com";
  const from = process.env.ALERT_EMAIL_FROM || "onboarding@resend.dev";
  if (!key) { console.warn("Missing RESEND_API_KEY — skipping email."); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) console.error("Resend error:", res.status, await res.text());
  else console.log("Email sent to", to);
}

// ---------- main ----------

export default async () => {
  const cfg = watchlist.settings || {};
  const maxFetches = cfg.maxFetchesPerRun ?? 20;
  const maxPages = cfg.maxPagesPerSearch ?? 5;
  const delayMs = cfg.delayMsBetweenFetches ?? 900;
  const alertOnIncrease = cfg.alertOnSeatIncrease !== false;

  const store = getStore("qff-rewards");
  const previous = (await store.get("snapshot", { type: "json" })) || {};
  const isFirstRun = Object.keys(previous).length === 0;

  const current = {};
  let fetchesUsed = 0;

  for (const watch of watchlist.watches || []) {
    const dates = resolveDates(watch);
    for (const date of dates) {
      if (fetchesUsed >= maxFetches) { console.warn("Hit maxFetchesPerRun cap."); break; }
      try {
        let page = 1, pages = 1;
        do {
          const url = buildUrl(watch, date, page);
          const text = await fetchText(url);
          if (page === 1) pages = Math.min(maxPages, totalPages(text));
          const found = parseFlights(text);
          for (const [sig, rec] of found) current[sig] = rec;
          fetchesUsed++;
          console.log(`[${watch.label}] ${date} p${page}/${pages}: ${found.size} rows (fetch ${fetchesUsed})`);
          page++;
          if (page <= pages) await sleep(delayMs);
        } while (page <= pages && fetchesUsed < maxFetches);
      } catch (e) {
        console.error(`Fetch failed for ${watch.label} ${date}:`, e.message);
      }
      await sleep(delayMs);
    }
  }

  // Diff: what's newly available (or increased) vs last snapshot?
  const newFlights = [];
  for (const [sig, rec] of Object.entries(current)) {
    const prev = previous[sig];
    if (!prev) { newFlights.push(rec); continue; }
    if (alertOnIncrease && Number(rec.seats) > Number(prev.seats)) newFlights.push(rec);
  }

  console.log(`Parsed ${Object.keys(current).length} availabilities; ${newFlights.length} new.`);

  // Persist the new snapshot.
  await store.setJSON("snapshot", current);

  // Email: on first run send a baseline (nice confirmation it works); after that only deltas.
  if (isFirstRun && Object.keys(current).length > 0) {
    await sendEmail("✈️ Qantas reward alerter is live (baseline)", buildEmail(Object.values(current), true));
  } else if (newFlights.length > 0) {
    await sendEmail(`✈️ ${newFlights.length} new Qantas reward seat${newFlights.length > 1 ? "s" : ""}`, buildEmail(newFlights, false));
  }

  return new Response(JSON.stringify({ parsed: Object.keys(current).length, new: newFlights.length, fetchesUsed }), {
    headers: { "content-type": "application/json" },
  });
};

// Runs every 3 hours. Change the cron if you want.
export const config = { schedule: "0 */3 * * *" };

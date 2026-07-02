// Qantas Frequent Flyer — Classic Reward availability alerter (v2, JSON feed)
//
// Uses the Flight Reward Finder's own availability feed (the data its calendar
// loads) instead of scraping rendered HTML. That feed returns clean per-day
// seat COUNTS per cabin, and is retrievable server-side by sending the "RSC"
// header. One request returns a whole month of daily counts.
//
// You should never need to edit this file. Edit watchlist.json instead.

import watchlist from "../../watchlist.json";
import { getStore } from "@netlify/blobs";

const BASE = "https://flightrewardfinder.qantas.com/";
const WATCHED_CABINS = ["Business", "First"];

// ---------- URL + fetch ----------

function buildUrl({ origins, destinations }, drStart, drEnd) {
  const p = new URLSearchParams();
  p.set("pg", "1");
  if (origins && origins.length) p.set("o", origins.join(","));
  p.set("d", destinations && destinations.length ? destinations.join(",") : "*");
  p.set("dr", `${drStart}I${drEnd}`);
  p.set("c", "Business,First");
  return `${BASE}?${p.toString()}`;
}

async function fetchAvailability(url) {
  const res = await fetch(url, {
    headers: {
      // This header makes the server return its data feed instead of the HTML shell.
      "RSC": "1",
      "Accept": "*/*",
      "User-Agent": "Mozilla/5.0 (personal reward-seat watcher)",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseAvailability(await res.text());
}

// The feed is line-based ("N:<json>"). One of those lines is an array of
// [ "YYYY-MM-DD", { Economy, PremiumEconomy, Business, First } ] pairs.
function parseAvailability(text) {
  const out = new Map(); // "YYYY-MM-DD" -> counts object
  for (const line of text.split("\n")) {
    const m = line.match(/^\d+:(.*)$/);
    if (!m) continue;
    let val;
    try { val = JSON.parse(m[1]); } catch { continue; }
    if (
      Array.isArray(val) && val.length &&
      Array.isArray(val[0]) && typeof val[0][0] === "string" &&
      /^\d{4}-\d\d-\d\d$/.test(val[0][0]) &&
      val[0][1] && typeof val[0][1] === "object"
    ) {
      for (const [date, counts] of val) out.set(date, counts);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const monthOf = (d) => d.slice(0, 7);

// ---------- email ----------

function buildEmail(newItems, isFirstRun) {
  const rows = newItems
    .sort((a, b) => (a.date + a.cabin).localeCompare(b.date + b.cabin))
    .map((it) => {
      const link = `${BASE}?o=${encodeURIComponent(it.origins)}&d=${encodeURIComponent(it.destinations)}&dr=${it.date}I${it.date}&c=Business,First`;
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${it.date}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${it.label}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;"><strong>${it.cabin}</strong></td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${it.count} seat${it.count > 1 ? "s" : ""}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;"><a href="${link}">open</a></td>
      </tr>`;
    })
    .join("");

  const intro = isFirstRun
    ? "Monitoring is live. Current Business/First availability on your watched dates (baseline — future emails only show NEW seats):"
    : "New Business/First reward availability just appeared on your watched dates:";

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#222;max-width:680px;">
    <h2 style="margin:0 0 8px;">✈️ Qantas reward seats${isFirstRun ? " — baseline" : ""}</h2>
    <p style="margin:0 0 16px;color:#555;">${intro}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead><tr style="text-align:left;background:#fafafa;">
        <th style="padding:8px 12px;">Date</th><th style="padding:8px 12px;">Route</th>
        <th style="padding:8px 12px;">Cabin</th><th style="padding:8px 12px;">Seats</th>
        <th style="padding:8px 12px;"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:16px 0 0;color:#999;font-size:12px;">Counts are per-day totals across the watched route; click through on qantas.com to see the exact flights. Availability isn't guaranteed until booked.</p>
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
  const delayMs = cfg.delayMsBetweenFetches ?? 900;

  const store = getStore("qff-rewards");
  const previous = (await store.get("snapshot", { type: "json" })) || {};
  const isFirstRun = Object.keys(previous).length === 0;

  const current = {};       // signature -> count
  const currentItems = [];  // details for email/preview
  const preview = [];       // for the "Check now" screen
  let fetchesUsed = 0;

  for (const watch of watchlist.watches || []) {
    const dates = [...new Set(watch.dates || [])].sort();
    if (!dates.length) continue;
    const originsStr = (watch.origins || []).join(",");
    const destStr = (watch.destinations || []).join(",");

    // Fetch once per month that the watched dates fall in.
    const got = new Map();
    const months = [...new Set(dates.map(monthOf))];
    for (const mo of months) {
      if (fetchesUsed >= maxFetches) break;
      const drDate = dates.find((d) => monthOf(d) === mo);
      try {
        const map = await fetchAvailability(buildUrl(watch, drDate, drDate));
        for (const [d, c] of map) got.set(d, c);
        fetchesUsed++;
        console.log(`[${watch.label}] month ${mo}: ${map.size} days (fetch ${fetchesUsed})`);
      } catch (e) {
        console.error(`Fetch failed for ${watch.label} ${mo}:`, e.message);
      }
      await sleep(delayMs);
    }
    // Fallback: any watched date not covered gets its own fetch.
    for (const d of dates) {
      if (!got.has(d) && fetchesUsed < maxFetches) {
        try {
          const map = await fetchAvailability(buildUrl(watch, d, d));
          for (const [dd, c] of map) got.set(dd, c);
          fetchesUsed++;
          console.log(`[${watch.label}] fallback ${d}: ${map.size} days (fetch ${fetchesUsed})`);
        } catch (e) {
          console.error(`Fallback fetch failed for ${watch.label} ${d}:`, e.message);
        }
        await sleep(delayMs);
      }
    }

    // Read Business/First counts for each watched date.
    for (const date of dates) {
      const counts = got.get(date) || {};
      for (const cabin of WATCHED_CABINS) {
        const n = Number(counts[cabin] || 0);
        const sig = `${watch.label}|${date}|${cabin}`;
        current[sig] = n;
        const item = { sig, label: watch.label, date, cabin, count: n, origins: originsStr, destinations: destStr };
        currentItems.push(item);
        if (n > 0) preview.push(`${date}  ${cabin}: ${n}  (${watch.label})`);
      }
    }
  }

  // Diff: newly available or increased.
  const newItems = [];
  for (const it of currentItems) {
    const prev = Number(previous[it.sig] || 0);
    if (it.count > prev) newItems.push(it);
  }

  console.log(`Checked ${currentItems.length} date/cabin combos; ${newItems.length} new/increased; ${fetchesUsed} fetches.`);

  await store.setJSON("snapshot", current);

  if (isFirstRun) {
    const seeded = currentItems.filter((it) => it.count > 0);
    if (seeded.length) await sendEmail("✈️ Qantas reward alerter is live (baseline)", buildEmail(seeded, true));
  } else if (newItems.length > 0) {
    await sendEmail(`✈️ ${newItems.length} new Qantas Business/First seat alert${newItems.length > 1 ? "s" : ""}`, buildEmail(newItems, false));
  }

  return new Response(JSON.stringify({
    checked: currentItems.length,
    withAvailability: preview.length,
    new: newItems.length,
    fetchesUsed,
    available: preview.slice(0, 60),
  }), { headers: { "content-type": "application/json" } });
};

// Runs every 3 hours. Change the cron if you want.
export const config = { schedule: "0 */3 * * *" };

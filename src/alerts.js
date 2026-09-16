// VIGIL — break-glass alerts.
// Fires a webhook when something a sleeping owner must know about happens:
// drawdown breaker trips, kill-switch events, outsized NAV moves, or venue
// execution failures. Deduped per type so a flapping condition can't spam.
//
// Webhook targets supported (auto-detected by URL shape):
//   Telegram bot API  → posts {chat_id?, text}
//   Discord           → posts {content}
//   Slack             → posts {text}
//   anything else     → posts {text, alert:{...}} (generic JSON)
import { alertRows, logAlert, recentAlert } from "./db.js";

const DEDUPE_MS = Number(process.env.VIGIL_ALERT_DEDUPE_MS || 30 * 60_000);

export function webhookFor(session) {
  if (session && session.webhook) return session.webhook;
  return process.env.VIGIL_ALERT_WEBHOOK || null;
}

async function deliver(url, alert) {
  const isTelegram = /api\.telegram\.org/.test(url);
  const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(url);
  const isSlack = /hooks\.slack\.com/.test(url);
  const text = `${alert.severity === "critical" ? "🚨" : "⚠️"} VIGIL · ${alert.title}\n${alert.body}`;
  let payload;
  if (isTelegram) payload = { text, disable_web_page_preview: true };
  else if (isDiscord) payload = { content: text };
  else if (isSlack) payload = { text };
  else payload = { text, alert };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });
  return { ok: res.ok, status: res.status };
}

// Fire an alert (deduped). Returns { fired, reason }.
export async function fireAlert(db, alert, { webhook } = {}) {
  const a = {
    ts: Date.now(),
    type: alert.type || "generic",
    severity: alert.severity || "warn",
    title: alert.title || "VIGIL alert",
    body: alert.body || "",
    meta: alert.meta ? JSON.stringify(alert.meta) : null,
  };
  try {
    const prev = recentAlert(db, a.type);
    if (prev && a.ts - Number(prev.ts) < DEDUPE_MS) return { fired: false, reason: "deduped" };
  } catch { /* table may be absent on very old db — logged below anyway */ }

  let delivered = false, detail = "no webhook configured";
  const url = webhook || process.env.VIGIL_ALERT_WEBHOOK || null;
  if (url) {
    try {
      const r = await deliver(url, a);
      delivered = r.ok; detail = `webhook ${r.status}`;
    } catch (e) { detail = `webhook error: ${e.message}`; }
  }
  try { logAlert(db, { ...a, delivered: delivered ? 1 : 0 }); } catch { /* non-fatal */ }
  console.log(`[alert] ${a.severity} ${a.type}: ${a.title} (${detail})`);
  return { fired: true, delivered, detail };
}

// Evaluate sweep outcomes → alerts. Called by the agent loop after each sweep.
export async function evaluateSweepAlerts(db, { result, state, prevNav, webhook }) {
  const fired = [];
  const navNow = Number(state?.nav || 0);

  if (result?.breaker) {
    fired.push(await fireAlert(db, {
      type: "breaker", severity: "critical", title: "Drawdown breaker tripped",
      body: `De-risking to defensive base. drawdown=${(Number(state?.drawdown || 0) * 100).toFixed(2)}% window=${state?.window}. The agent stopped adding risk.`,
      meta: { window: state?.window, drawdown: state?.drawdown },
    }, { webhook }));
  }

  if (state?.killed) {
    fired.push(await fireAlert(db, {
      type: "kill", severity: "critical", title: "Kill-switch armed",
      body: "All trading halted by the owner. The agent will not place orders until the switch is disarmed.",
      meta: { window: state?.window },
    }, { webhook }));
  }

  if (prevNav > 0 && navNow > 0) {
    const move = ((navNow - prevNav) / prevNav) * 100;
    if (Math.abs(move) >= Number(process.env.VIGIL_ALERT_MOVE_PCT || 3)) {
      fired.push(await fireAlert(db, {
        type: "nav-move", severity: move < 0 ? "critical" : "warn",
        title: `NAV moved ${move >= 0 ? "+" : ""}${move.toFixed(2)}% this sweep`,
        body: `NAV ${(navNow / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} USD. Trigger=${result?.decision || "—"} window=${state?.window}.`,
        meta: { move, nav: navNow },
      }, { webhook }));
    }
  }

  const venueErrors = (result?.venueErrors || 0);
  if (venueErrors > 0) {
    fired.push(await fireAlert(db, {
      type: "venue-error", severity: "warn", title: `${venueErrors} venue order(s) failed`,
      body: "At least one order was rejected by the venue this sweep. Check the decision log for codes; paper-fallback legs are labelled.",
      meta: { venueErrors },
    }, { webhook }));
  }

  return fired.filter((f) => f && f.fired);
}

export function listAlerts(db, limit = 50) {
  try { return alertRows(db, limit); } catch { return []; }
}
// VIGIL — multi-session manager (BYO-key Connect flow).
// A session = one user's Bitget demo API key + an isolated SQLite ledger + its own
// agent sweep loop. Created only through the demo-key gate (probeDemoKey): LIVE
// account keys are rejected — VIGIL never trades a user's real account from here.
//
// Security model:
//  - credentials encrypted at rest (AES-256-GCM) with VIGIL_SESSION_SECRET
//  - owner key (random 32B hex) returned once at creation; only its SHA-256 stored
//  - every authed route must present the owner key; public routes expose state only
//  - per-IP rate cap (default 3 sessions / 24h) to keep the free instance honest
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDB, setKill } from "./db.js";
import { runSweep } from "./agent.js";
import { createVenueClient, probeDemoKey, venueSymbol } from "./venue.js";
import { getPositions, getCash } from "./db.js";
import { portfolioState } from "./engine.js";
import { refreshPrices } from "./market.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SESSIONS_DIR = path.join(__dirname, "..", "data", "sessions");
const MAX_SESSIONS = Number(process.env.VIGIL_MAX_SESSIONS || 8);
const RATE_CAP = Number(process.env.VIGIL_SESSION_RATE_CAP || 3);    // per IP / window
const RATE_WINDOW_MS = 24 * 3600_000;
export { MAX_SESSIONS };

export class SessionError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

function secretKey() {
  const raw = process.env.VIGIL_SESSION_SECRET;
  if (raw) return crypto.createHash("sha256").update(raw).digest();   // 32B
  // dev fallback: persist one locally so sessions survive restarts on the VM
  const f = path.join(SESSIONS_DIR, ".dev-secret");
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex");
    const k = crypto.randomBytes(32);
    fs.writeFileSync(f, k.toString("hex"), { mode: 0o600 });
    return k;
  } catch {
    console.warn("VIGIL: no VIGIL_SESSION_SECRET — session keys derived per-boot (sessions won't survive restart)");
    return crypto.randomBytes(32);
  }
}

export function encryptCreds(creds) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(creds), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${enc.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

export function decryptCreds(payload) {
  const [v, ivB64, dataB64, tagB64] = String(payload).split(":");
  if (v !== "v1" || !ivB64 || !dataB64 || !tagB64) throw new SessionError("BAD_CRED", "corrupt session credentials");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const out = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return JSON.parse(out.toString("utf8"));
  } catch (e) {
    throw new SessionError("BAD_CRED", "session credentials failed to decrypt (tampered or wrong secret?)");
  }
}

function hashOwner(key) { return crypto.createHash("sha256").update(key).digest("hex"); }

// Sessions registry persisted as JSON (small; ledger DBs carry the heavy state).
function loadRegistry() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const f = path.join(SESSIONS_DIR, "registry.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return { sessions: {}, ipTally: {} }; }
}

function saveRegistry(r) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, "registry.json"), JSON.stringify(r, null, 1), { mode: 0o600 });
}

const registry = loadRegistry();
const loops = new Map(); // sessionId -> {timer, db}

export function listSessions() {
  return Object.values(registry.sessions).map((s) => ({
    id: s.id, name: s.name, createdAt: s.createdAt,
    status: s.status, usdt: s.usdt, currency: s.currency,
  }));
}

export function getSession(id) { return registry.sessions[id] || null; }

// Venue client bound to a session's own (decrypted) credentials — for owner-authed
// manual runs. Throws if the stored credentials are corrupt.
export function sessionVenue(id) {
  const s = registry.sessions[id];
  if (!s) throw new SessionError("NOT_FOUND", "session not found");
  return createVenueClient(decryptCreds(s.creds));
}

export function sessionDb(id) {
  const db = openDB(path.join(SESSIONS_DIR, `${id}.sqlite`));
  return db;
}

function rateAllowed(ip) {
  const now = Date.now();
  const t = registry.ipTally[ip] || [];
  const recent = t.filter((ts) => now - ts < RATE_WINDOW_MS);
  if (recent.length >= RATE_CAP) return false;
  recent.push(now);
  registry.ipTally[ip] = recent;
  saveRegistry(registry);
  return true;
}

function sweepLoop(id, db, venue, mode) {
  const timer = setInterval(async () => {
    try { await runSweep(db, { venue, execMode: mode }); }
    catch (e) { console.error(`[session ${id}] sweep`, e.message); }
  }, Number(process.env.VIGIL_SCAN_MS || 300_000));
  timer.unref?.();
  return timer;
}

// Create a session from a user-supplied Bitget key. Hard gate: demo keys only.
export async function createSession({ apiKey, secret, passphrase, name, ip }) {
  if (!apiKey || !secret || !passphrase) throw new SessionError("MISSING", "apiKey, secret and passphrase are all required");
  if (Object.keys(registry.sessions).length >= MAX_SESSIONS) throw new SessionError("FULL", `instance is at capacity (${MAX_SESSIONS} sessions)`);
  if (ip && !rateAllowed(ip)) throw new SessionError("RATE", "too many sessions from this address today — try again tomorrow");

  const probe = await probeDemoKey({ apiKey, secret, passphrase });
  if (!probe.ok) throw new SessionError("REJECTED", probe.reason);
  if (probe.live) throw new SessionError("LIVE_KEY", "live-account keys are not accepted — VIGIL Connect takes demo/paper keys only");

  // user's spot balance (informational; the sweep re-syncs truth anyway)
  let usdt = 0;
  try {
    const client = createVenueClient({ apiKey, secret, passphrase });
    usdt = await client.usdtAvailable();
  } catch { /* non-fatal */ }

  const id = crypto.randomBytes(4).toString("hex");
  const ownerKey = crypto.randomBytes(32).toString("hex");
  registry.sessions[id] = {
    id, name: String(name || "My book").slice(0, 40),
    ownerHash: hashOwner(ownerKey),
    creds: encryptCreds({ apiKey, secret, passphrase }),
    createdAt: Date.now(), status: "active", usdt, currency: "USDT",
  };
  saveRegistry(registry);

  // boot the isolated ledger + loop
  const db = sessionDb(id);
  const client = createVenueClient({ apiKey, secret, passphrase });
  loops.set(id, { timer: sweepLoop(id, db, client, "bitget"), db });
  // immediate warm sweep so the dashboard has data + the venue truth is synced
  runSweep(db, { venue: client, execMode: "bitget" })
    .then((r) => console.log(`[session ${id}] warm sweep:`, JSON.stringify(r).slice(0, 160)))
    .catch((e) => console.error(`[session ${id}] warm`, e.message));

  return { id, name: registry.sessions[id].name, ownerKey, usdt };
}

// Legacy sessions (server restart): restart loops for active sessions.
export async function restartLoops() {
  let n = 0;
  for (const s of Object.values(registry.sessions)) {
    try {
      const creds = decryptCreds(s.creds);
      const client = createVenueClient(creds);
      const db = sessionDb(s.id);
      loops.set(s.id, { timer: sweepLoop(s.id, db, client, "bitget"), db });
      n++;
    } catch (e) { console.error(`[session ${s.id}] restart failed:`, e.message); }
  }
  if (n) console.log(`VIGIL sessions: restarted ${n} loop(s)`);
  return n;
}

export function authorize(session, ownerKey) {
  if (!session) return false;
  return hashOwner(ownerKey || "") === session.ownerHash;
}

export function sessionState(session) {
  const db = loops.get(session.id)?.db || sessionDb(session.id);
  const pos = getPositions(db);
  const cash = getCash(db);
  return { id: session.id, name: session.name, createdAt: session.createdAt, status: session.status, usdt: session.usdt, cash };
}

// Re-export a couple of helpers the route layer needs.
export { setKill, venueSymbol };
export { portfolioState, refreshPrices };
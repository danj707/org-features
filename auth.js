/**
 * Auth for the PS dashboard — self-contained, no new dependencies.
 *
 * Model: users sign up with the shared signup code (SIGNUP_CODE env var) and
 * choose their own password. The first account created becomes an admin;
 * admins can promote/demote/deactivate users from /ps/admin. Passwords are
 * scrypt-hashed; sessions are HMAC-signed cookies (SESSION_SECRET env var).
 *
 * Users live in users.json under DATA_DIR — on Railway that must be a
 * mounted volume or accounts reset on redeploy.
 */

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

const SESSION_COOKIE = "ps_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_TTL_MS   = 60 * 60 * 1000;           // reset links live 1 hour

const SIGNUP_CODE    = process.env.SIGNUP_CODE || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL     = process.env.FROM_EMAIL || "reports@rec.us";
const FROM_NAME      = process.env.FROM_NAME || "Rec PS Dashboard";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn("[auth] SESSION_SECRET not set — sessions will not survive a restart");
}
if (!SIGNUP_CODE) {
  console.warn("[auth] SIGNUP_CODE not set — signups are disabled until it is configured");
}

// ---------- user store ----------

let USERS_FILE = null;
function init(dataDir) {
  USERS_FILE = path.join(dataDir, "users.json");
}
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")).users || []; }
  catch { return []; }
}
function saveUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2));
  fs.renameSync(tmp, USERS_FILE); // atomic so a crash can't corrupt the store
}

// ---------- password hashing ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected  = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ---------- password reset tokens (admin-issued, one-time, short-lived) ----------

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
function findByResetToken(users, token) {
  if (!token) return null;
  const h = Buffer.from(hashToken(token));
  const user = users.find(u => {
    if (!u.reset || !u.reset.hash) return false;
    const stored = Buffer.from(String(u.reset.hash));
    return stored.length === h.length && crypto.timingSafeEqual(stored, h);
  });
  if (!user || user.reset.expires < Date.now()) return null;
  return user;
}

// Reset links are emailed via Resend when RESEND_API_KEY is set (same key
// the rental-report service uses; rec.us is the verified sending domain).
// Without a key the admin just copies the link out of the UI.
async function sendResetEmail(user, resetUrl, issuedByName) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: user.email,
      subject: "Reset your PS dashboard password",
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a2333">
          <h2 style="font-size:18px">rec · PS dashboard</h2>
          <p>Hi ${user.name},</p>
          <p>${issuedByName} generated a password reset link for your PS dashboard account (${user.email}).</p>
          <p style="margin:24px 0"><a href="${resetUrl}" style="background:#0f6f5c;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700">Set a new password</a></p>
          <p style="color:#64748b;font-size:13px">The link works once and expires in 60 minutes. If you didn't expect this, you can ignore it — your current password keeps working until the link is used.</p>
        </div>`,
    }),
  });
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}

// ---------- sessions (signed cookie, no server-side state) ----------

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
function sign(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}
function makeSession(userId, sessionVersion) {
  const payload = b64url(JSON.stringify({ u: userId, v: sessionVersion || 0, e: Date.now() + SESSION_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}
function readSession(cookieHeader) {
  const m = /(?:^|;\s*)ps_session=([^;]+)/.exec(cookieHeader || "");
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.u || data.e < Date.now()) return null;
    return { userId: data.u, version: data.v || 0 };
  } catch { return null; }
}
function sessionCookie(value, maxAgeMs) {
  const secure = process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT_NAME ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

// ---------- brute-force damping (in-memory, per identifier) ----------

const attempts = new Map(); // key -> {count, until}
function throttled(key) {
  const a = attempts.get(key);
  return a && a.count >= 8 && Date.now() < a.until;
}
function recordFailure(key) {
  const a = attempts.get(key) || { count: 0, until: 0 };
  a.count += 1;
  a.until = Date.now() + 15 * 60 * 1000;
  attempts.set(key, a);
}
function clearFailures(key) { attempts.delete(key); }

// ---------- middleware ----------

function currentUser(req) {
  const sess = readSession(req.headers.cookie);
  if (!sess) return null;
  const user = loadUsers().find(u => u.id === sess.userId);
  if (!user || !user.active) return null;
  // sv bumps on password reset, so cookies issued before the reset die
  if ((user.sv || 0) !== sess.version) return null;
  return user;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "not signed in" });
    return res.redirect("/login");
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  next();
}

// ---------- routes ----------

function mountRoutes(app) {
  app.post("/api/auth/signup", (req, res) => {
    const { name, email, password, code } = req.body || {};
    if (!SIGNUP_CODE) return res.status(503).json({ error: "Signups are not configured yet (SIGNUP_CODE unset)." });
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email, and password are required." });
    if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const codeBuf = Buffer.from(String(code || "")), expect = Buffer.from(SIGNUP_CODE);
    if (codeBuf.length !== expect.length || !crypto.timingSafeEqual(codeBuf, expect)) {
      recordFailure("signup:" + req.ip);
      return res.status(403).json({ error: "That signup code isn't right." });
    }
    if (throttled("signup:" + req.ip)) return res.status(429).json({ error: "Too many attempts — try again later." });

    const users = loadUsers();
    const emailNorm = String(email).trim().toLowerCase();
    if (users.some(u => u.email === emailNorm)) return res.status(409).json({ error: "An account with that email already exists." });
    const user = {
      id: crypto.randomUUID(),
      email: emailNorm,
      name: String(name).trim().slice(0, 80),
      passHash: hashPassword(password),
      role: users.length === 0 ? "admin" : "user", // first account bootstraps as admin
      active: true,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    saveUsers(users);
    res.setHeader("Set-Cookie", sessionCookie(makeSession(user.id), SESSION_TTL_MS));
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body || {};
    const emailNorm = String(email || "").trim().toLowerCase();
    const key = "login:" + emailNorm;
    if (throttled(key)) return res.status(429).json({ error: "Too many attempts — try again in a few minutes." });
    const user = loadUsers().find(u => u.email === emailNorm);
    if (!user || !verifyPassword(String(password || ""), user.passHash)) {
      recordFailure(key);
      return res.status(401).json({ error: "Wrong email or password." });
    }
    if (!user.active) return res.status(403).json({ error: "This account has been deactivated." });
    clearFailures(key);
    res.setHeader("Set-Cookie", sessionCookie(makeSession(user.id, user.sv), SESSION_TTL_MS));
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    res.json({ ok: true });
  });

  app.get("/api/auth/me", (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: "not signed in" });
    res.json({ user: publicUser(user) });
  });

  // ----- password reset (link minted by an admin, redeemed here) -----
  app.post("/api/auth/reset-password/check", (req, res) => {
    if (throttled("reset:" + req.ip)) return res.status(429).json({ error: "Too many attempts — try again later." });
    const user = findByResetToken(loadUsers(), (req.body || {}).token);
    if (!user || !user.active) {
      recordFailure("reset:" + req.ip);
      return res.status(400).json({ error: "That reset link is invalid or has expired — ask an admin for a fresh one." });
    }
    res.json({ ok: true, email: user.email, name: user.name });
  });

  app.post("/api/auth/reset-password", (req, res) => {
    const { token, password } = req.body || {};
    if (throttled("reset:" + req.ip)) return res.status(429).json({ error: "Too many attempts — try again later." });
    if (String(password || "").length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const users = loadUsers();
    const user = findByResetToken(users, token);
    if (!user || !user.active) {
      recordFailure("reset:" + req.ip);
      return res.status(400).json({ error: "That reset link is invalid or has expired — ask an admin for a fresh one." });
    }
    user.passHash = hashPassword(String(password));
    delete user.reset;                 // one-time: the link dies on use
    user.sv = (user.sv || 0) + 1;      // every previously issued session cookie stops working
    saveUsers(users);
    clearFailures("login:" + user.email);
    res.setHeader("Set-Cookie", sessionCookie(makeSession(user.id, user.sv), SESSION_TTL_MS));
    res.json({ ok: true, user: publicUser(user) });
  });

  // ----- admin: user management -----
  app.get("/api/admin/users", requireAuth, requireAdmin, (_req, res) => {
    res.json({ users: loadUsers().map(publicUser) });
  });

  app.post("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "no such user" });
    const { role, active } = req.body || {};
    if (role !== undefined) {
      if (!["admin", "user"].includes(role)) return res.status(400).json({ error: "role must be admin or user" });
      user.role = role;
    }
    if (active !== undefined) user.active = !!active;
    // never let the last active admin lock everyone out
    if (!users.some(u => u.active && u.role === "admin")) {
      return res.status(400).json({ error: "there must be at least one active admin" });
    }
    saveUsers(users);
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post("/api/admin/users/:id/reset-password", requireAuth, requireAdmin, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "no such user" });
    if (!user.active) return res.status(400).json({ error: "reactivate the account before resetting its password" });
    const token = crypto.randomBytes(32).toString("base64url");
    user.reset = { hash: hashToken(token), expires: Date.now() + RESET_TTL_MS, issuedBy: req.user.id };
    saveUsers(users);
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const resetUrl = `${proto}://${req.headers.host}/reset?token=${token}`;
    let emailSent = false, emailError = null;
    if (RESEND_API_KEY) {
      try { await sendResetEmail(user, resetUrl, req.user.name); emailSent = true; }
      catch (err) { emailError = err.message; }
    }
    res.json({
      ok: true,
      resetUrl,
      expiresInMinutes: Math.round(RESET_TTL_MS / 60000),
      emailSent,
      emailError,
      user: publicUser(user),
    });
  });
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt,
    resetPending: !!(u.reset && u.reset.expires > Date.now()),
  };
}

module.exports = { init, mountRoutes, requireAuth, requireAdmin, currentUser };

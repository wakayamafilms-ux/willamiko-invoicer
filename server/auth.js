const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "false" || !process.env.DATABASE_URL
      ? false
      : { rejectUnauthorized: false },
});

const SESSION_SECONDS = 60 * 60 * 24 * 7;

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function passwordMatches(password, storedHash) {
  const [salt, expectedHex] = String(storedHash || "").split(":");
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sessionSecret() {
  if (!process.env.SESSION_SECRET) {
    throw new Error("Missing SESSION_SECRET environment variable.");
  }
  return process.env.SESSION_SECRET;
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(sessionSecret()).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptSecret(value) {
  const [iv, tag, encrypted] = String(value || "").split(".");
  if (!iv || !tag || !encrypted) throw new Error("Invalid encrypted secret.");
  const key = crypto.createHash("sha256").update(sessionSecret()).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function signToken(user) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.id,
      username: user.username,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
    })
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = crypto
    .createHmac("sha256", sessionSecret())
    .update(payload)
    .digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return null;
  }
  const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  return user.exp > Math.floor(Date.now() / 1000) ? user : null;
}

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL environment variable.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_data (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS plaid_items (
      item_id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      institution TEXT NOT NULL,
      cursor TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS receipt_capture_sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'waiting',
      result JSONB,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS hosted_invoice_pdfs (
      token UUID PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      content BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const adminUsername = normalizeUsername(process.env.ADMIN_USERNAME);
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUsername || !adminPassword) {
    throw new Error("Missing ADMIN_USERNAME or ADMIN_PASSWORD environment variable.");
  }
  if (adminPassword.length < 12) {
    throw new Error("ADMIN_PASSWORD must contain at least 12 characters.");
  }

  await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, 'admin') ON CONFLICT (username) DO NOTHING`,
    [adminUsername, hashPassword(adminPassword)]
  );
}

async function requireAuth(req, res, next) {
  try {
    const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    const session = verifyToken(token);
    if (!session) return res.status(401).send("Please sign in.");
    const result = await pool.query(
      "SELECT id, username, role FROM users WHERE id = $1 AND active = TRUE",
      [session.sub]
    );
    if (!result.rows[0]) return res.status(401).send("Account is unavailable.");
    req.user = result.rows[0];
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(401).send("Invalid session.");
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).send("Admin access required.");
  next();
}

module.exports = {
  pool,
  normalizeUsername,
  hashPassword,
  passwordMatches,
  signToken,
  initializeDatabase,
  requireAuth,
  requireAdmin,
  encryptSecret,
  decryptSecret,
};

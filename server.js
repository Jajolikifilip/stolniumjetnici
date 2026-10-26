const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { Pool } = require("pg");

const requiredEnvironment = ["DATABASE_URL", "ADMIN_PASSWORD", "SESSION_SECRET"];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);
if (missingEnvironment.length) {
  console.error(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
  process.exit(1);
}
if (process.env.ADMIN_PASSWORD.length < 12 || process.env.SESSION_SECRET.length < 32) {
  console.error("ADMIN_PASSWORD must be at least 12 characters and SESSION_SECRET at least 32 characters.");
  process.exit(1);
}

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});
const emptyState = {
  players: [],
  longestRound: { number: "", firstPlayerId: "", secondPlayerId: "", finalBlowPlayerId: "" },
};
const loginAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const maxLoginAttempts = 8;
const tokenLifetimeMs = 8 * 60 * 60 * 1000;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

function safeEqual(first, second) {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function signPayload(payload) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
}

function createToken() {
  const payload = Buffer.from(JSON.stringify({ expiresAt: Date.now() + tokenLifetimeMs })).toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

function hasValidToken(request) {
  const authorization = request.get("authorization") || "";
  const [scheme, token, extra] = authorization.split(" ");
  if (scheme !== "Bearer" || !token || extra) return false;

  const [payload, signature, trailing] = token.split(".");
  if (!payload || !signature || trailing) return false;
  if (!safeEqual(signature, signPayload(payload))) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(claims.expiresAt) && claims.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function validateState(candidate) {
  if (!candidate || !Array.isArray(candidate.players) || candidate.players.length > 500) return null;

  const players = [];
  const playerIds = new Set();
  for (const candidatePlayer of candidate.players) {
    if (!candidatePlayer || typeof candidatePlayer.id !== "string" || !/^[\w-]{1,80}$/.test(candidatePlayer.id)) return null;
    if (playerIds.has(candidatePlayer.id)) return null;
    const name = typeof candidatePlayer.name === "string" ? candidatePlayer.name.trim() : "";
    const wins = candidatePlayer.wins;
    const losses = candidatePlayer.losses;
    if (!name || name.length > 50) return null;
    if (!Number.isSafeInteger(wins) || wins < 0 || !Number.isSafeInteger(losses) || losses < 0) return null;
    playerIds.add(candidatePlayer.id);
    players.push({ id: candidatePlayer.id, name, wins, losses });
  }

  const record = candidate.longestRound || {};
  const number = record.number === undefined || record.number === null ? "" : String(record.number);
  const firstPlayerId = typeof record.firstPlayerId === "string" ? record.firstPlayerId : "";
  const secondPlayerId = typeof record.secondPlayerId === "string" ? record.secondPlayerId : "";
  const finalBlowPlayerId = typeof record.finalBlowPlayerId === "string" ? record.finalBlowPlayerId : "";
  if (number && (!/^(?:\d+\.?\d*|\.\d+)$/.test(number) || !Number.isFinite(Number(number)))) return null;

  if (firstPlayerId || secondPlayerId) {
    if (!firstPlayerId || !secondPlayerId || firstPlayerId === secondPlayerId) return null;
    if (!playerIds.has(firstPlayerId) || !playerIds.has(secondPlayerId)) return null;
  }
  if (finalBlowPlayerId && ![firstPlayerId, secondPlayerId].includes(finalBlowPlayerId)) return null;

  return {
    players,
    longestRound: { number, firstPlayerId, secondPlayerId, finalBlowPlayerId },
  };
}

app.get("/api/health", (request, response) => response.json({ ok: true }));

app.get("/api/state", async (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  try {
    const result = await pool.query("SELECT data, initialized FROM leaderboard_state WHERE id = 1");
    const row = result.rows[0];
    response.json({ state: row ? row.data : emptyState, initialized: Boolean(row && row.initialized) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", (request, response) => {
  const clientAddress = request.ip;
  const now = Date.now();
  const attempt = loginAttempts.get(clientAddress);
  if (attempt && attempt.expiresAt > now && attempt.count >= maxLoginAttempts) {
    return response.status(429).json({ error: "Previše pokušaja. Pokušaj ponovno za 15 minuta." });
  }

  const submittedPassword = typeof request.body.password === "string" ? request.body.password : "";
  if (!safeEqual(submittedPassword, process.env.ADMIN_PASSWORD)) {
    const nextAttempt = attempt && attempt.expiresAt > now
      ? { count: attempt.count + 1, expiresAt: attempt.expiresAt }
      : { count: 1, expiresAt: now + loginWindowMs };
    loginAttempts.set(clientAddress, nextAttempt);
    return response.status(401).json({ error: "Kod nije točan. Pokušaj ponovno." });
  }

  loginAttempts.delete(clientAddress);
  return response.json({ token: createToken() });
});

app.put("/api/state", async (request, response, next) => {
  if (!hasValidToken(request)) return response.status(401).json({ error: "Prijava je istekla. Prijavi se ponovno." });

  const state = validateState(request.body);
  if (!state) return response.status(400).json({ error: "Podatci nisu ispravni." });

  try {
    await pool.query(
      `INSERT INTO leaderboard_state (id, data, initialized, updated_at)
       VALUES (1, $1::jsonb, TRUE, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, initialized = TRUE, updated_at = NOW()`,
      [JSON.stringify(state)],
    );
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/", (request, response) => response.sendFile(path.join(__dirname, "index.html")));

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  response.status(500).json({ error: "Greška poslužitelja. Pokušaj ponovno." });
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard_state (
      id smallint PRIMARY KEY CHECK (id = 1),
      data jsonb NOT NULL,
      initialized boolean NOT NULL DEFAULT FALSE,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "INSERT INTO leaderboard_state (id, data, initialized) VALUES (1, $1::jsonb, FALSE) ON CONFLICT (id) DO NOTHING",
    [JSON.stringify(emptyState)],
  );

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "0.0.0.0", () => console.log(`Leaderboard server listening on port ${port}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Could not initialize the database:", error);
    process.exit(1);
  });
}

module.exports = { app, validateState };
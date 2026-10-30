const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { Pool } = require("pg");
const { TIME_ZONE, keyForPeriod, nextPeriodKey, periodRange } = require("./periods");

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
const periodTypes = ["daily", "weekly", "monthly"];
const periodColumns = { daily: "daily_key", weekly: "weekly_key", monthly: "monthly_key" };
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

function rankPlayers(players) {
  return [...players].sort((first, second) => {
    const firstGames = first.wins + first.losses;
    const secondGames = second.wins + second.losses;
    const firstRate = firstGames === 0 ? 0 : first.wins / firstGames;
    const secondRate = secondGames === 0 ? 0 : second.wins / secondGames;
    return second.wins - first.wins || secondRate - firstRate || first.name.localeCompare(second.name, "hr");
  });
}

async function getPeriodLeaderboard(client, type, periodKey, players) {
  const column = periodColumns[type];
  const result = await client.query(
        `SELECT winner_player_id, winner_name, winner_all_time_wins,
          loser_player_id, loser_name, loser_all_time_wins
     FROM leaderboard_matches WHERE ${column} = $1`,
    [periodKey],
  );
  const scores = new Map(players.map((player) => [player.id, { ...player, titleWins: player.wins, wins: 0, losses: 0 }]));

  for (const match of result.rows) {
    if (!scores.has(match.winner_player_id)) {
      scores.set(match.winner_player_id, { id: match.winner_player_id, name: match.winner_name, titleWins: match.winner_all_time_wins, wins: 0, losses: 0 });
    }
    if (!scores.has(match.loser_player_id)) {
      scores.set(match.loser_player_id, { id: match.loser_player_id, name: match.loser_name, titleWins: match.loser_all_time_wins, wins: 0, losses: 0 });
    }
    scores.get(match.winner_player_id).wins += 1;
    scores.get(match.loser_player_id).losses += 1;
    scores.get(match.winner_player_id).titleWins = Math.max(scores.get(match.winner_player_id).titleWins || 0, match.winner_all_time_wins);
    scores.get(match.loser_player_id).titleWins = Math.max(scores.get(match.loser_player_id).titleWins || 0, match.loser_all_time_wins);
  }

  return rankPlayers([...scores.values()]);
}

async function advancePeriods(client, players, now = new Date()) {
  for (const type of periodTypes) {
    const currentKey = keyForPeriod(type, now);
    await client.query(
      `INSERT INTO leaderboard_periods (period_type, period_key, cycle_number)
       VALUES ($1, $2, 1) ON CONFLICT (period_type) DO NOTHING`,
      [type, currentKey],
    );
    const result = await client.query(
      "SELECT period_type, period_key, cycle_number FROM leaderboard_periods WHERE period_type = $1 FOR UPDATE",
      [type],
    );
    const period = result.rows[0];

    while (period.period_key < currentKey) {
      const completedKey = period.period_key;
      const range = periodRange(type, completedKey);
      const leaderboard = await getPeriodLeaderboard(client, type, completedKey, players);
      const winner = leaderboard.find((player) => player.wins > 0);

      if (winner) {
        await client.query(
          `INSERT INTO leaderboard_archives
             (id, period_type, period_key, cycle_number, starts_at, ends_at, winner_player_id, winner_name, leaderboard)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           ON CONFLICT (period_type, period_key) DO NOTHING`,
          [crypto.randomUUID(), type, completedKey, period.cycle_number, range.startsAt, range.endsAt, winner.id, winner.name, JSON.stringify(leaderboard)],
        );
      }

      period.period_key = nextPeriodKey(type, completedKey);
      period.cycle_number += 1;
    }

    await client.query(
      "UPDATE leaderboard_periods SET period_key = $2, cycle_number = $3 WHERE period_type = $1",
      [type, period.period_key, period.cycle_number],
    );
  }
}

async function buildSharedPayload(client, state, initialized, now = new Date()) {
  await advancePeriods(client, state.players, now);
  const categories = { "all-time": { cycleNumber: null, endsAt: null, players: rankPlayers(state.players) } };

  for (const type of periodTypes) {
    const currentKey = keyForPeriod(type, now);
    const cycleResult = await client.query(
      "SELECT period_key, cycle_number FROM leaderboard_periods WHERE period_type = $1",
      [type],
    );
    const period = cycleResult.rows[0];
    const range = periodRange(type, currentKey);
    categories[type] = {
      periodKey: currentKey,
      cycleNumber: period ? period.cycle_number : 1,
      startsAt: range.startsAt.toISOString(),
      endsAt: range.endsAt.toISOString(),
      players: await getPeriodLeaderboard(client, type, currentKey, state.players),
    };
  }

  const archiveResult = await client.query(
    `SELECT id, period_type, period_key, cycle_number, starts_at, ends_at,
          winner_player_id, winner_name
      FROM leaderboard_archives ORDER BY ends_at DESC`,
  );

  return { state, initialized, categories, archives: archiveResult.rows, timeZone: TIME_ZONE };
}

app.get("/api/health", (request, response) => response.json({ ok: true }));

app.get("/api/archives/:id", async (request, response, next) => {
  if (!/^[\da-f-]{36}$/i.test(request.params.id)) return response.status(400).json({ error: "Neispravna arhiva." });
  try {
    const result = await pool.query(
      `SELECT id, period_type, period_key, cycle_number, starts_at, ends_at,
              winner_player_id, winner_name, leaderboard
       FROM leaderboard_archives WHERE id = $1`,
      [request.params.id],
    );
    if (!result.rows[0]) return response.status(404).json({ error: "Arhiva nije pronađena." });
    response.setHeader("Cache-Control", "no-store");
    response.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/api/state", async (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT data, initialized FROM leaderboard_state WHERE id = 1 FOR UPDATE");
    const row = result.rows[0];
    const state = row ? row.data : emptyState;
    const payload = await buildSharedPayload(client, state, Boolean(row && row.initialized));
    await client.query("COMMIT");
    response.json(payload);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
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

app.post("/api/matches", async (request, response, next) => {
  if (!hasValidToken(request)) return response.status(401).json({ error: "Prijava je istekla. Prijavi se ponovno." });

  const winnerPlayerId = typeof request.body.winnerPlayerId === "string" ? request.body.winnerPlayerId : "";
  const loserPlayerId = typeof request.body.loserPlayerId === "string" ? request.body.loserPlayerId : "";
  if (!winnerPlayerId || !loserPlayerId || winnerPlayerId === loserPlayerId) {
    return response.status(400).json({ error: "Odaberi dva različita igrača." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT data, initialized FROM leaderboard_state WHERE id = 1 FOR UPDATE");
    const row = result.rows[0];
    if (!row || !row.initialized) {
      await client.query("ROLLBACK");
      return response.status(409).json({ error: "Najprije inicijaliziraj zajednički leaderboard." });
    }

    const state = validateState(row.data);
    const winner = state && state.players.find((player) => player.id === winnerPlayerId);
    const loser = state && state.players.find((player) => player.id === loserPlayerId);
    if (!winner || !loser) {
      await client.query("ROLLBACK");
      return response.status(400).json({ error: "Odabrani igrači više nisu na leaderboardu." });
    }

    const playedAt = new Date();
    await advancePeriods(client, state.players, playedAt);
    await client.query(
      `INSERT INTO leaderboard_matches
         (id, winner_player_id, winner_name, winner_all_time_wins, loser_player_id, loser_name,
          loser_all_time_wins, played_at, daily_key, weekly_key, monthly_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [crypto.randomUUID(), winner.id, winner.name, winner.wins + 1, loser.id, loser.name, loser.wins, playedAt,
        keyForPeriod("daily", playedAt), keyForPeriod("weekly", playedAt), keyForPeriod("monthly", playedAt)],
    );
    winner.wins += 1;
    loser.losses += 1;
    await client.query(
      "UPDATE leaderboard_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1",
      [JSON.stringify(state)],
    );
    await client.query("COMMIT");
    response.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard_matches (
      id uuid PRIMARY KEY,
      winner_player_id text NOT NULL,
      winner_name text NOT NULL,
      winner_all_time_wins integer NOT NULL,
      loser_player_id text NOT NULL,
      loser_name text NOT NULL,
      loser_all_time_wins integer NOT NULL,
      played_at timestamptz NOT NULL,
      daily_key text NOT NULL,
      weekly_key text NOT NULL,
      monthly_key text NOT NULL
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS leaderboard_matches_daily_idx ON leaderboard_matches (daily_key)");
  await pool.query("CREATE INDEX IF NOT EXISTS leaderboard_matches_weekly_idx ON leaderboard_matches (weekly_key)");
  await pool.query("CREATE INDEX IF NOT EXISTS leaderboard_matches_monthly_idx ON leaderboard_matches (monthly_key)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard_periods (
      period_type text PRIMARY KEY CHECK (period_type IN ('daily', 'weekly', 'monthly')),
      period_key text NOT NULL,
      cycle_number integer NOT NULL CHECK (cycle_number > 0)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard_archives (
      id uuid PRIMARY KEY,
      period_type text NOT NULL CHECK (period_type IN ('daily', 'weekly', 'monthly')),
      period_key text NOT NULL,
      cycle_number integer NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      winner_player_id text NOT NULL,
      winner_name text NOT NULL,
      leaderboard jsonb NOT NULL,
      UNIQUE (period_type, period_key)
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS leaderboard_archives_winner_idx ON leaderboard_archives (winner_player_id)");
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

module.exports = { app, validateState, rankPlayers, getPeriodLeaderboard, advancePeriods, buildSharedPayload };
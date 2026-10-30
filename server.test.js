const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.ADMIN_PASSWORD = "integration-test-password";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

let sharedRow;
const periodRows = new Map();
const matches = [];
const archives = [];

class TestPool {
  async query(sql, values = []) {
    const query = sql.replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return { rows: [] };
    if (query.includes("SELECT data, initialized FROM leaderboard_state")) {
      return { rows: sharedRow ? [{ ...sharedRow }] : [] };
    }
    if (query.includes("INSERT INTO leaderboard_state") && query.includes("DO UPDATE")) {
      sharedRow = { data: JSON.parse(values[0]), initialized: true };
      return { rows: [] };
    }
    if (query.includes("UPDATE leaderboard_state SET data")) {
      sharedRow = { ...sharedRow, data: JSON.parse(values[0]) };
      return { rows: [] };
    }
    if (query.includes("INSERT INTO leaderboard_periods")) {
      if (!periodRows.has(values[0])) periodRows.set(values[0], { period_type: values[0], period_key: values[1], cycle_number: 1 });
      return { rows: [] };
    }
    if (query.includes("SELECT period_type, period_key, cycle_number FROM leaderboard_periods")) {
      const period = periodRows.get(values[0]);
      return { rows: period ? [{ ...period }] : [] };
    }
    if (query.includes("SELECT period_key, cycle_number FROM leaderboard_periods")) {
      const period = periodRows.get(values[0]);
      return { rows: period ? [{ period_key: period.period_key, cycle_number: period.cycle_number }] : [] };
    }
    if (query.includes("UPDATE leaderboard_periods SET")) {
      periodRows.set(values[0], { period_type: values[0], period_key: values[1], cycle_number: values[2] });
      return { rows: [] };
    }
    if (query.includes("FROM leaderboard_matches WHERE")) {
      const column = query.match(/WHERE (daily_key|weekly_key|monthly_key) = \$1/)[1];
      return { rows: matches.filter((match) => match[column] === values[0]).map((match) => ({ ...match })) };
    }
    if (query.includes("INSERT INTO leaderboard_matches")) {
      matches.push({
        id: values[0],
        winner_player_id: values[1],
        winner_name: values[2],
        winner_all_time_wins: values[3],
        loser_player_id: values[4],
        loser_name: values[5],
        loser_all_time_wins: values[6],
        played_at: values[7],
        daily_key: values[8],
        weekly_key: values[9],
        monthly_key: values[10],
      });
      return { rows: [] };
    }
    if (query.includes("INSERT INTO leaderboard_archives")) {
      if (!archives.some((archive) => archive.period_type === values[1] && archive.period_key === values[2])) {
        archives.push({
          id: values[0], period_type: values[1], period_key: values[2], cycle_number: values[3],
          starts_at: values[4], ends_at: values[5], winner_player_id: values[6], winner_name: values[7],
          leaderboard: JSON.parse(values[8]),
        });
      }
      return { rows: [] };
    }
    if (query.includes("FROM leaderboard_archives WHERE id = $1")) {
      const archive = archives.find((entry) => entry.id === values[0]);
      return { rows: archive ? [{ ...archive }] : [] };
    }
    if (query.includes("FROM leaderboard_archives ORDER BY")) {
      return { rows: [...archives].reverse().map(({ leaderboard, ...archive }) => archive) };
    }
    return { rows: [] };
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
}

const originalLoad = Module._load;
Module._load = function loadWithTestPool(request, parent, isMain) {
  if (request === "pg") return { Pool: TestPool };
  return originalLoad.call(this, request, parent, isMain);
};
const { app, validateState, advancePeriods } = require("./server");
Module._load = originalLoad;

const server = app.listen(0, "127.0.0.1");
const baseUrl = new Promise((resolve) => server.once("listening", () => {
  resolve(`http://127.0.0.1:${server.address().port}`);
}));

test("shared period rankings require admin-authenticated match results", async (context) => {
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = await baseUrl;

  let response = await fetch(`${url}/api/state`);
  assert.equal(response.status, 200);
  const initial = await response.json();
  assert.equal(initial.initialized, false);
  assert.ok(initial.categories.daily.endsAt);
  assert.equal(initial.categories["all-time"].endsAt, null);

  const invalidState = validateState({ players: [{ id: "same", name: "One", wins: 1, losses: 0 }, { id: "same", name: "Two", wins: 1, losses: 0 }] });
  assert.equal(invalidState, null);

  const state = {
    players: [
      { id: "ante", name: "Ante", wins: 9, losses: 2 },
      { id: "damir", name: "Damir", wins: 5, losses: 1 },
    ],
    longestRound: { number: "50", firstPlayerId: "ante", secondPlayerId: "damir", finalBlowPlayerId: "damir" },
  };

  response = await fetch(`${url}/api/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" }),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  assert.equal(typeof token, "string");

  response = await fetch(`${url}/api/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(state),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${url}/api/matches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ winnerPlayerId: "ante", loserPlayerId: "damir" }),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${url}/api/matches`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ winnerPlayerId: "ante", loserPlayerId: "damir" }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${url}/api/state`);
  const result = await response.json();
  assert.equal(result.initialized, true);
  assert.equal(result.state.players.find((player) => player.id === "ante").wins, 10);
  assert.equal(result.state.players.find((player) => player.id === "damir").losses, 2);
  assert.equal(result.categories.daily.players.find((player) => player.id === "ante").wins, 1);
  assert.equal(result.categories.daily.players.find((player) => player.id === "ante").titleWins, 10);
  assert.equal(result.categories.daily.players.find((player) => player.id === "damir").losses, 1);

  periodRows.set("daily", { period_type: "daily", period_key: "2026-10-29", cycle_number: 2 });
  matches.push({
    winner_player_id: "ante", winner_name: "Ante", winner_all_time_wins: 10,
    loser_player_id: "damir", loser_name: "Damir", loser_all_time_wins: 5,
    daily_key: "2026-10-29", weekly_key: "2026-10-26", monthly_key: "2026-10",
  });
  const pool = new TestPool();
  const tomorrowInZagreb = new Date("2026-10-30T12:00:00Z");
  await advancePeriods(pool, state.players, tomorrowInZagreb);
  const dailyArchive = archives.find((archive) => archive.period_type === "daily" && archive.period_key === "2026-10-29");
  assert.equal(dailyArchive.winner_player_id, "ante");
  assert.equal(dailyArchive.leaderboard[0].titleWins, 10);

  await advancePeriods(pool, state.players, tomorrowInZagreb);
  assert.equal(archives.filter((archive) => archive.period_type === "daily" && archive.period_key === "2026-10-29").length, 1);

  response = await fetch(`${url}/api/state`);
  const stateWithBadge = await response.json();
  const badge = stateWithBadge.archives.find((archive) => archive.period_type === "daily" && archive.period_key === "2026-10-29");
  assert.ok(badge);
  assert.equal("leaderboard" in badge, false);

  response = await fetch(`${url}/api/archives/${badge.id}`);
  assert.equal(response.status, 200);
  const archivedLeaderboard = await response.json();
  assert.equal(archivedLeaderboard.leaderboard[0].titleWins, 10);
});
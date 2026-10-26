const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.ADMIN_PASSWORD = "integration-test-password";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

let sharedRow;
class TestPool {
  async query(sql, values = []) {
    if (sql.includes("SELECT data, initialized")) {
      return { rows: sharedRow ? [sharedRow] : [] };
    }
    if (sql.includes("ON CONFLICT (id) DO UPDATE")) {
      sharedRow = { data: JSON.parse(values[0]), initialized: true };
      return { rows: [] };
    }
    if (sql.includes("ON CONFLICT (id) DO NOTHING")) {
      if (!sharedRow) sharedRow = { data: JSON.parse(values[0]), initialized: false };
      return { rows: [] };
    }
    return { rows: [] };
  }
}

const originalLoad = Module._load;
Module._load = function loadWithTestPool(request, parent, isMain) {
  if (request === "pg") return { Pool: TestPool };
  return originalLoad.call(this, request, parent, isMain);
};
const { app, validateState } = require("./server");
Module._load = originalLoad;

const server = app.listen(0, "127.0.0.1");
const baseUrl = new Promise((resolve) => server.once("listening", () => {
  resolve(`http://127.0.0.1:${server.address().port}`);
}));

test("shared state is public to read and only editable after admin login", async (context) => {
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = await baseUrl;

  let response = await fetch(`${url}/api/state`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).initialized, false);

  const invalidState = validateState({ players: [{ id: "same", name: "One", wins: 1, losses: 0 }, { id: "same", name: "Two", wins: 1, losses: 0 }] });
  assert.equal(invalidState, null);

  const state = {
    players: [
      { id: "ante", name: "Ante", wins: 6, losses: 2 },
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

  response = await fetch(`${url}/api/state`);
  const result = await response.json();
  assert.equal(result.initialized, true);
  assert.deepEqual(result.state, state);
});
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { keyForPeriod, nextPeriodKey, periodRange } = require("./periods");

test("daily, weekly, and monthly periods use Zagreb calendar boundaries", () => {
  assert.equal(keyForPeriod("daily", new Date("2026-02-28T23:30:00Z")), "2026-03-01");
  assert.equal(keyForPeriod("weekly", new Date("2026-03-01T12:00:00Z")), "2026-02-23");
  assert.equal(keyForPeriod("monthly", new Date("2026-02-28T23:30:00Z")), "2026-03");
  assert.equal(nextPeriodKey("daily", "2026-12-31"), "2027-01-01");
  assert.equal(nextPeriodKey("weekly", "2026-12-28"), "2027-01-04");
  assert.equal(nextPeriodKey("monthly", "2026-12"), "2027-01");
});

test("period countdown boundaries honor daylight-saving changes", () => {
  const march = periodRange("monthly", "2026-03");
  assert.equal(march.startsAt.toISOString(), "2026-02-28T23:00:00.000Z");
  assert.equal(march.endsAt.toISOString(), "2026-03-31T22:00:00.000Z");

  const daylightSavingDay = periodRange("daily", "2026-03-29");
  assert.equal((daylightSavingDay.endsAt - daylightSavingDay.startsAt) / 3600000, 23);
});

test("period leaderboard titles use lifetime wins rather than period wins", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const titleFunction = script.match(/function titleForWins\(wins\) \{[\s\S]*?\n    \}/)[0];
  const titleForWins = new Function(`return (${titleFunction})`)();
  const periodPlayer = { wins: 1, losses: 0, titleWins: 10 };

  assert.equal(titleForWins(periodPlayer.titleWins ?? periodPlayer.wins).code, "T");
  assert.match(script, /titleForWins\(player\.titleWins \?\? player\.wins\)/);
});
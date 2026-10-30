const TIME_ZONE = "Europe/Zagreb";

const localDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function localDateParts(date) {
  const parts = Object.fromEntries(localDateFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function formatDateKey(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function keyForPeriod(type, date = new Date()) {
  const { year, month, day } = localDateParts(date);
  if (type === "daily") return formatDateKey(year, month, day);
  if (type === "monthly") return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  if (type === "weekly") {
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    const daysSinceMonday = (utcDate.getUTCDay() + 6) % 7;
    utcDate.setUTCDate(utcDate.getUTCDate() - daysSinceMonday);
    return formatDateKey(utcDate.getUTCFullYear(), utcDate.getUTCMonth() + 1, utcDate.getUTCDate());
  }
  throw new Error(`Unknown period type: ${type}`);
}

function nextPeriodKey(type, key) {
  if (type === "monthly") {
    const [year, month] = key.split("-").map(Number);
    return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  }

  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + (type === "weekly" ? 7 : 1));
  return formatDateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function localMidnightToUtc(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const wantedLocalTimestamp = Date.UTC(year, month - 1, day);
  let timestamp = wantedLocalTimestamp;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = localDateParts(new Date(timestamp));
    const representedLocalTimestamp = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    const offset = representedLocalTimestamp - timestamp;
    const nextTimestamp = wantedLocalTimestamp - offset;
    if (nextTimestamp === timestamp) break;
    timestamp = nextTimestamp;
  }

  return new Date(timestamp);
}

function periodRange(type, key) {
  const startKey = type === "monthly" ? `${key}-01` : key;
  const endKey = nextPeriodKey(type, key);
  const endDateKey = type === "monthly" ? `${endKey}-01` : endKey;
  return {
    startsAt: localMidnightToUtc(startKey),
    endsAt: localMidnightToUtc(endDateKey),
  };
}

module.exports = { TIME_ZONE, keyForPeriod, nextPeriodKey, periodRange };
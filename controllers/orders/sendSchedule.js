// controllers/orders/sendSchedule.js
// Обчислення send-вікон: send_time_from/to + бітмаска send_days (Пн..Нд, 127=всі).
// Все у бізнес-таймзоні (env ABANDONED_CART_TZ, дефолт Europe/Kyiv).

const TZ = process.env.ABANDONED_CART_TZ || "Europe/Kyiv";
const DOW_BIT = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function timeToMinutes(t, fallback) {
  if (t == null) return fallback;
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return fallback;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// поточні хвилини-доби і біт-індекс дня у заданій таймзоні
function nowParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // en-US може віддати 24 опівночі
  const minute = parseInt(get("minute"), 10);
  const dayBit = DOW_BIT[get("weekday")] ?? 0;
  return { minutesNow: hour * 60 + minute, dayBit };
}

// Скільки хвилин чекати до найближчого дозволеного моменту.
// 0 = можна відправляти зараз. Повертає ціле число хвилин.
function minutesUntilAllowed(now, { from, to, days } = {}) {
  const fromMin = timeToMinutes(from, 0);
  const toMin = timeToMinutes(to, 24 * 60 - 1);
  let mask = Number.isFinite(days) ? days & 0x7f : 0x7f;
  if (mask === 0) mask = 0x7f; // порожня маска → не блокуємо

  const { minutesNow, dayBit } = nowParts(now, TZ);

  for (let addDays = 0; addDays < 8; addDays++) {
    const bit = (dayBit + addDays) % 7;
    if (!(mask & (1 << bit))) continue;

    if (addDays === 0) {
      if (minutesNow < fromMin) return fromMin - minutesNow; // вікно ще не відкрилось
      if (minutesNow <= toMin) return 0; // всередині вікна
      continue; // вікно вже минуло сьогодні
    }
    return addDays * 1440 - minutesNow + fromMin; // майбутній день, відкриття вікна
  }
  return 0; // недосяжно за нормальних масок
}

function isWithinWindow(now, window) {
  return minutesUntilAllowed(now, window) === 0;
}

module.exports = { minutesUntilAllowed, isWithinWindow, TZ };

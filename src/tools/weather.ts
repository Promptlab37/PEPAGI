// ═══════════════════════════════════════════════════════════════
// PEPAGI — Weather Tool
// Current weather and forecast via OpenWeatherMap API (free tier).
// Requires OPENWEATHER_API_KEY env var.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";

const logger = new Logger("WeatherTool");

const API_KEY = process.env.OPENWEATHER_API_KEY ?? "";
const BASE_URL = "https://api.openweathermap.org/data/2.5";
const NO_KEY_MSG =
  "OpenWeatherMap API key is not configured.\n" +
  "Získej bezplatný klíč na: https://openweathermap.org/api\n" +
  "Poté nastav proměnnou prostředí: OPENWEATHER_API_KEY=<tvůj_klíč>";

// ─── API response shapes ──────────────────────────────────────

interface OWMWeatherEntry {
  description: string;
  icon: string;
}

interface OWMMain {
  temp: number;
  feels_like: number;
  temp_min: number;
  temp_max: number;
  humidity: number;
  pressure: number;
}

interface OWMWind {
  speed: number;  // m/s
  deg?: number;
  gust?: number;
}

interface OWMClouds {
  all: number;  // % coverage
}

interface OWMCurrentResponse {
  name: string;
  sys: { country: string; sunrise: number; sunset: number };
  dt: number;
  weather: OWMWeatherEntry[];
  main: OWMMain;
  wind: OWMWind;
  clouds: OWMClouds;
  visibility?: number;
  timezone: number;
}

interface OWMForecastItem {
  dt: number;
  main: OWMMain;
  weather: OWMWeatherEntry[];
  wind: OWMWind;
  clouds: OWMClouds;
  pop: number;       // probability of precipitation 0-1
  dt_txt: string;
}

interface OWMForecastResponse {
  city: { name: string; country: string; timezone: number };
  list: OWMForecastItem[];
}

// ─── Helpers ─────────────────────────────────────────────────

/** Wind degrees to compass direction */
function windDirection(deg?: number): string {
  if (deg === undefined) return "";
  const dirs = ["S", "SSZ", "SZ", "ZSZ", "Z", "ZJZ", "JZ", "JJZ", "J", "JJV", "JV", "VJV", "V", "VSV", "SV", "SSV"];
  const idx = Math.round(deg / 22.5) % 16;
  return dirs[idx] ?? "";
}

/** Convert Unix timestamp + timezone offset (seconds) to local time string */
function toLocalTime(unix: number, tzOffsetSec: number): string {
  const date = new Date((unix + tzOffsetSec) * 1000);
  const h = date.getUTCHours().toString().padStart(2, "0");
  const m = date.getUTCMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/** Map OWM weather description to a Czech-friendly emoji */
function weatherEmoji(description: string): string {
  const d = description.toLowerCase();
  if (d.includes("thunderstorm")) return "⛈️";
  if (d.includes("drizzle")) return "🌦️";
  if (d.includes("rain")) return "🌧️";
  if (d.includes("snow")) return "❄️";
  if (d.includes("clear")) return "☀️";
  if (d.includes("clouds") && d.includes("few")) return "🌤️";
  if (d.includes("clouds") && d.includes("scattered")) return "⛅";
  if (d.includes("clouds")) return "☁️";
  if (d.includes("mist") || d.includes("fog") || d.includes("haze")) return "🌫️";
  return "🌡️";
}

/** Fetch from OWM API, throwing a typed error on failure */
async function owmFetch<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("appid", API_KEY);
  url.searchParams.set("units", "metric");
  url.searchParams.set("lang", "cs");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error(`Neplatný API klíč OpenWeatherMap. Zkontroluj OPENWEATHER_API_KEY.\n${body}`);
    }
    if (res.status === 404) {
      throw new Error(`Město/lokalita nenalezena. Zkus formát: "Praha,CZ" nebo "London,GB".`);
    }
    throw new Error(`OpenWeatherMap API error ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─── Action implementations ───────────────────────────────────

/**
 * Get current weather for a location.
 * @param location - City name, e.g. "Prague,CZ"
 */
async function getCurrentWeather(location: string): Promise<string> {
  const data = await owmFetch<OWMCurrentResponse>("weather", { q: location });
  const w = data.weather[0]!;
  const emoji = weatherEmoji(w.description);
  const windDir = windDirection(data.wind.deg);
  const sunrise = toLocalTime(data.sys.sunrise, data.timezone);
  const sunset = toLocalTime(data.sys.sunset, data.timezone);
  const visibility = data.visibility !== undefined
    ? `${(data.visibility / 1000).toFixed(1)} km`
    : "N/A";

  return (
    `${emoji} **Aktuální počasí — ${data.name}, ${data.sys.country}**\n\n` +
    `🌡️ Teplota: **${data.main.temp.toFixed(1)} °C** (pocitová ${data.main.feels_like.toFixed(1)} °C)\n` +
    `   Min: ${data.main.temp_min.toFixed(1)} °C  |  Max: ${data.main.temp_max.toFixed(1)} °C\n` +
    `☁️ Podmínky: ${w.description}\n` +
    `💧 Vlhkost: ${data.main.humidity} %\n` +
    `💨 Vítr: ${(data.wind.speed * 3.6).toFixed(1)} km/h ${windDir}` +
    (data.wind.gust !== undefined ? ` (nárazy ${(data.wind.gust * 3.6).toFixed(1)} km/h)` : "") + "\n" +
    `🔵 Tlak: ${data.main.pressure} hPa\n` +
    `👁️ Viditelnost: ${visibility}\n` +
    `☁️ Oblačnost: ${data.clouds.all} %\n` +
    `🌅 Východ: ${sunrise}  |  🌇 Západ: ${sunset}`
  );
}

/**
 * Get 5-day forecast for a location.
 * @param location - City name, e.g. "Prague,CZ"
 * @param days - Number of days (1-5, default 5)
 */
async function getForecast(location: string, days: number): Promise<string> {
  const data = await owmFetch<OWMForecastResponse>("forecast", { q: location, cnt: "40" });
  const cityName = `${data.city.name}, ${data.city.country}`;

  // Group by calendar day (in city's local time)
  const byDay = new Map<string, OWMForecastItem[]>();
  for (const item of data.list) {
    const localDate = new Date((item.dt + data.city.timezone) * 1000);
    const dateKey = localDate.toISOString().slice(0, 10); // YYYY-MM-DD
    if (!byDay.has(dateKey)) byDay.set(dateKey, []);
    byDay.get(dateKey)!.push(item);
  }

  const dayEntries = [...byDay.entries()].slice(0, days);

  const lines: string[] = [`📅 **Předpověď počasí — ${cityName} (${days} dní)**\n`];

  for (const [dateKey, items] of dayEntries) {
    const date = new Date(dateKey + "T12:00:00Z");
    const dayName = date.toLocaleDateString("cs-CZ", { weekday: "long", month: "long", day: "numeric" });

    const temps = items.map(i => i.main.temp);
    const minTemp = Math.min(...temps);
    const maxTemp = Math.max(...temps);
    const avgHumidity = Math.round(items.reduce((s, i) => s + i.main.humidity, 0) / items.length);
    const maxPop = Math.round(Math.max(...items.map(i => i.pop)) * 100);
    const noon = items.find(i => new Date((i.dt + data.city.timezone) * 1000).getUTCHours() >= 11 && new Date((i.dt + data.city.timezone) * 1000).getUTCHours() <= 14)
      ?? items[Math.floor(items.length / 2)]!;
    const emoji = weatherEmoji(noon.weather[0]?.description ?? "");

    lines.push(
      `${emoji} **${dayName}**\n` +
      `   🌡️ ${minTemp.toFixed(0)}–${maxTemp.toFixed(0)} °C  ` +
      `💧 ${avgHumidity}%  ` +
      `🌧️ srážky ${maxPop}%  ` +
      `☁️ ${noon.weather[0]?.description ?? ""}`,
    );
  }

  return lines.join("\n");
}

/**
 * Get just the essential conditions for a location.
 * @param location - City name, e.g. "Prague,CZ"
 */
async function getConditions(location: string): Promise<string> {
  const data = await owmFetch<OWMCurrentResponse>("weather", { q: location });
  const w = data.weather[0]!;
  const emoji = weatherEmoji(w.description);

  return (
    `${emoji} ${data.name}, ${data.sys.country}: ` +
    `**${data.main.temp.toFixed(1)} °C** — ${w.description} — ` +
    `vlhkost ${data.main.humidity}% — vítr ${(data.wind.speed * 3.6).toFixed(0)} km/h`
  );
}

// ─── Tool definition ──────────────────────────────────────────

export const weatherTool = {
  name: "weather",
  description:
    "Get current weather and forecast via OpenWeatherMap. " +
    "Actions: current (full current weather), forecast (5-day forecast), conditions (brief summary). " +
    "Param 'location': city name e.g. 'Prague,CZ' or 'London,GB'. " +
    "Param 'days': number of forecast days 1-5 (default 5). " +
    "Requires OPENWEATHER_API_KEY env var.",
  parameters: [
    {
      name: "action",
      type: "string" as const,
      description: "Action: current | forecast | conditions",
      required: true,
    },
    {
      name: "location",
      type: "string" as const,
      description: "City name, e.g. 'Prague,CZ' or 'Paris,FR'",
      required: true,
    },
    {
      name: "days",
      type: "string" as const,
      description: "Number of forecast days (1-5, default 5). Only used with action=forecast.",
      required: false,
    },
  ],
  execute: async (params: Record<string, string>): Promise<{ success: boolean; output: string }> => {
    if (!API_KEY) {
      return { success: false, output: NO_KEY_MSG };
    }

    const location = params["location"]?.trim() ?? "";
    if (!location) {
      return { success: false, output: "Parametr 'location' je povinný. Příklad: 'Prague,CZ'" };
    }

    const action = params["action"] ?? "current";
    const rawDays = parseInt(params["days"] ?? "5", 10);
    const days = isNaN(rawDays) ? 5 : Math.min(Math.max(rawDays, 1), 5);

    try {
      switch (action) {
        case "current":
          return { success: true, output: await getCurrentWeather(location) };

        case "forecast":
          return { success: true, output: await getForecast(location, days) };

        case "conditions":
          return { success: true, output: await getConditions(location) };

        default:
          return {
            success: false,
            output: `Neznámá akce: '${action}'. Dostupné: current, forecast, conditions.`,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("weatherTool error", { action, location, error: msg });
      return { success: false, output: `Chyba počasí: ${msg}` };
    }
  },
};

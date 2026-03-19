// ═══════════════════════════════════════════════════════════════
// PEPAGI — Calendar Tool
// Primary backend: macOS iCal via osascript (no API key needed)
// Fallback: Google Calendar API (requires GOOGLE_CALENDAR_TOKEN)
// ═══════════════════════════════════════════════════════════════

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
// SECURITY: SEC-31 — Content filtering for calendar events
import { InputSanitizer } from "../security/input-sanitizer.js";

const logger = new Logger("Calendar");
const execAsync = promisify(exec);

// SECURITY: SEC-31 — Rate limiter for calendar operations (max 10 events/hour)
const SEC31_MAX_EVENTS_PER_HOUR = 10;
const calendarOpTimestamps: number[] = [];
const inputSanitizer = new InputSanitizer();

/** SEC-31: Check if calendar rate limit exceeded */
function isCalendarRateLimited(): boolean {
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  // Remove old entries
  while (calendarOpTimestamps.length > 0 && calendarOpTimestamps[0]! < oneHourAgo) {
    calendarOpTimestamps.shift();
  }
  return calendarOpTimestamps.length >= SEC31_MAX_EVENTS_PER_HOUR;
}

/** SEC-31: Record a calendar operation */
function recordCalendarOp(): void {
  calendarOpTimestamps.push(Date.now());
}

/** SEC-31: Sanitize calendar event content (title, notes) for injection patterns */
async function sanitizeCalendarContent(text: string): Promise<{ sanitized: string; blocked: boolean }> {
  const result = await inputSanitizer.sanitize(text, "TRUSTED_USER");
  if (result.riskScore > 0.5) {
    return { sanitized: text, blocked: true };
  }
  // Strip any remaining injection-suspicious patterns from event text
  const cleaned = text
    .replace(/\[SYSTEM\]/gi, "")
    .replace(/<<SYS>>/gi, "")
    .replace(/ignore\s+(all|previous)\s+instructions/gi, "[removed]")
    .trim();
  return { sanitized: cleaned, blocked: false };
}

const IS_MAC = process.platform === "darwin";
const GOOGLE_CALENDAR_TOKEN = process.env.GOOGLE_CALENDAR_TOKEN ?? "";
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? "primary";

// ─── macOS iCal helpers ───────────────────────────────────────

/**
 * Run an AppleScript string via osascript.
 * @param script - The AppleScript source to execute
 * @returns stdout output from osascript
 */
async function runAppleScript(script: string): Promise<string> {
  // Escape the script for passing as inline argument
  const escaped = script.replace(/'/g, "'\"'\"'");
  const { stdout } = await execAsync(`osascript -e '${escaped}'`, { timeout: 20_000 });
  return stdout.trim();
}

/**
 * List iCal events within the next N days using AppleScript.
 * @param days - Number of days to look ahead (default 7)
 */
async function icalListEvents(days: number): Promise<string> {
  const script = `
tell application "Calendar"
  set resultText to ""
  set startDate to current date
  set endDate to startDate + (${days} * days)
  repeat with cal in calendars
    set calEvents to (every event of cal whose start date >= startDate and start date <= endDate)
    repeat with ev in calEvents
      set evTitle to summary of ev
      set evStart to start date of ev as string
      set evEnd to end date of ev as string
      try
        set evNotes to description of ev
      on error
        set evNotes to ""
      end try
      set calName to name of cal
      set resultText to resultText & calName & " | " & evTitle & " | " & evStart & " — " & evEnd & " | " & evNotes & linefeed
    end repeat
  end repeat
  if resultText is "" then
    return "No events found in the next ${days} days."
  end if
  return resultText
end tell
  `;
  return runAppleScript(script);
}

// SEC-17 fix: strict ISO 8601 date-time pattern used to validate user-supplied
// date strings before they are embedded in AppleScript date "..." literals.
// Only YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS are accepted; anything else
// (including embedded quotes, backticks, or AppleScript keywords) is rejected.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * Add a new event to the default iCal calendar using AppleScript.
 * @param title - Event title / summary
 * @param startDate - ISO 8601 date-time string
 * @param endDate - ISO 8601 date-time string (optional, defaults to start + 1 hour)
 * @param notes - Optional event notes
 */
async function icalAddEvent(
  title: string,
  startDate: string,
  endDate: string,
  notes: string,
): Promise<string> {
  // SEC-17 fix: validate date strings against the strict ISO 8601 regex before
  // embedding them in the AppleScript date "..." literal to prevent injection.
  if (!ISO_DATE_RE.test(startDate)) {
    throw new Error(`Invalid start_date format: "${startDate}". Expected YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS`);
  }
  if (!ISO_DATE_RE.test(endDate)) {
    throw new Error(`Invalid end_date format: "${endDate}". Expected YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS`);
  }

  // Format: "Monday, January 1, 2024 at 9:00:00 AM"  — AppleScript date literal
  // We convert ISO to a format AppleScript can parse via date "..."
  // OPUS: escape backslashes BEFORE quotes — a trailing `\` would unescape `\"`
  // allowing AppleScript injection via user-supplied title/notes.
  const safeTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeNotes = notes.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = `
tell application "Calendar"
  set theCalendar to first calendar whose name is "Calendar"
  set startDateObj to date "${startDate}"
  set endDateObj to date "${endDate}"
  set newEvent to make new event at end of events of theCalendar with properties {summary:"${safeTitle}", start date:startDateObj, end date:endDateObj, description:"${safeNotes}"}
  return "Event created: " & summary of newEvent & " on " & (start date of newEvent as string)
end tell
  `;
  return runAppleScript(script);
}

/**
 * Search iCal events by keyword using AppleScript.
 * @param query - Keyword to search for in event summaries and notes
 */
async function icalSearchEvents(query: string): Promise<string> {
  const safeQuery = query.toLowerCase().replace(/"/g, '\\"');
  const script = `
tell application "Calendar"
  set resultText to ""
  set searchQuery to "${safeQuery}"
  repeat with cal in calendars
    repeat with ev in every event of cal
      set evTitle to summary of ev
      set titleLower to do shell script "echo " & quoted form of evTitle & " | tr '[:upper:]' '[:lower:]'"
      if titleLower contains searchQuery then
        set evStart to start date of ev as string
        set calName to name of cal
        set resultText to resultText & calName & " | " & evTitle & " | " & evStart & linefeed
      end if
    end repeat
  end repeat
  if resultText is "" then
    return "No events found matching: ${safeQuery}"
  end if
  return resultText
end tell
  `;
  return runAppleScript(script);
}

// ─── Google Calendar API helpers ─────────────────────────────

interface GCalEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  description?: string;
  htmlLink?: string;
}

interface GCalEventList {
  items?: GCalEvent[];
}

/**
 * Make an authenticated request to the Google Calendar API.
 * @param path - API path (relative to /calendar/v3)
 * @param options - fetch options
 */
async function gcalFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  if (!GOOGLE_CALENDAR_TOKEN) {
    throw new Error("GOOGLE_CALENDAR_TOKEN not configured");
  }
  const url = `https://www.googleapis.com/calendar/v3${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GOOGLE_CALENDAR_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Google Calendar API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * List Google Calendar events for the next N days.
 * @param days - Number of days to look ahead
 */
async function gcalListEvents(days: number): Promise<string> {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + days * 86_400_000).toISOString();
  const params = new URLSearchParams({
    timeMin: now,
    timeMax: future,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const data = await gcalFetch(`/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events?${params.toString()}`) as GCalEventList;
  const items = data.items ?? [];
  if (!items.length) return "No events found.";
  return items.map(ev => {
    const start = ev.start?.dateTime ?? ev.start?.date ?? "?";
    const end = ev.end?.dateTime ?? ev.end?.date ?? "?";
    return `${ev.summary ?? "(no title)"} | ${start} — ${end}${ev.description ? "\n  " + ev.description.slice(0, 100) : ""}`;
  }).join("\n");
}

/**
 * Add an event to Google Calendar.
 * @param title - Event title
 * @param startDate - ISO 8601 date-time string
 * @param endDate - ISO 8601 date-time string
 * @param notes - Optional description
 */
async function gcalAddEvent(
  title: string,
  startDate: string,
  endDate: string,
  notes: string,
): Promise<string> {
  const body = {
    summary: title,
    description: notes || undefined,
    start: { dateTime: startDate },
    end: { dateTime: endDate },
  };
  const result = await gcalFetch(
    `/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`,
    { method: "POST", body: JSON.stringify(body) },
  ) as GCalEvent;
  return `Event created: "${result.summary}" — ${result.htmlLink ?? ""}`;
}

/**
 * Search Google Calendar events by keyword.
 * @param query - Search keyword
 */
async function gcalSearchEvents(query: string): Promise<string> {
  const params = new URLSearchParams({
    q: query,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
  });
  const data = await gcalFetch(`/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events?${params.toString()}`) as GCalEventList;
  const items = data.items ?? [];
  if (!items.length) return `No events found matching: ${query}`;
  return items.map(ev => {
    const start = ev.start?.dateTime ?? ev.start?.date ?? "?";
    return `${ev.summary ?? "(no title)"} | ${start}`;
  }).join("\n");
}

// ─── Dispatch: choose iCal or Google Calendar ─────────────────

/**
 * Determine which backend to use.
 * Prefer macOS iCal when running on macOS; fall back to Google Calendar if token is set.
 */
function useICal(): boolean {
  return IS_MAC;
}

// ─── Tool export ──────────────────────────────────────────────

export const calendarTool = {
  name: "calendar",
  description:
    "Manage calendar events: list upcoming events, add new events, search by keyword. Uses macOS Calendar (iCal) or Google Calendar.",
  parameters: [
    {
      name: "action",
      type: "string" as const,
      description: "Action: list_events, add_event, search_events",
      required: true,
    },
    {
      name: "days",
      type: "string" as const,
      description: "Number of days to look ahead for list_events (default: 7)",
      required: false,
    },
    {
      name: "title",
      type: "string" as const,
      description: "Event title for add_event",
      required: false,
    },
    {
      name: "start_date",
      type: "string" as const,
      description: "Event start date/time as ISO 8601 string (e.g. 2026-03-20T10:00:00) for add_event",
      required: false,
    },
    {
      name: "end_date",
      type: "string" as const,
      description: "Event end date/time as ISO 8601 string for add_event (optional, defaults to start + 1 hour)",
      required: false,
    },
    {
      name: "notes",
      type: "string" as const,
      description: "Event description/notes for add_event (optional)",
      required: false,
    },
    {
      name: "query",
      type: "string" as const,
      description: "Search keyword for search_events",
      required: false,
    },
  ],

  execute: async (params: Record<string, string>): Promise<{ success: boolean; output: string }> => {
    const action = params.action ?? "";
    if (!action) {
      return { success: false, output: "action parameter is required" };
    }

    // Non-Mac with no Google token
    if (!IS_MAC && !GOOGLE_CALENDAR_TOKEN) {
      return {
        success: false,
        output:
          "Calendar not available. On macOS, Calendar app is used automatically. " +
          "On other platforms, set GOOGLE_CALENDAR_TOKEN in .env",
      };
    }

    try {
      switch (action) {
        case "list_events": {
          const days = params.days ? parseInt(params.days, 10) : 7;
          const output = useICal()
            ? await icalListEvents(days)
            : await gcalListEvents(days);
          return { success: true, output };
        }

        case "add_event": {
          // SECURITY: SEC-31 — Rate limit calendar event creation
          if (isCalendarRateLimited()) {
            eventBus.emit({
              type: "security:blocked",
              taskId: "calendar",
              reason: "SEC-31: Calendar rate limit exceeded (max 10 events/hour)",
            });
            return { success: false, output: "Rate limit exceeded: max 10 calendar events per hour" };
          }

          const title = params.title ?? "";
          if (!title) return { success: false, output: "title parameter required for add_event" };

          // SECURITY: SEC-31 — Sanitize title and notes for injection patterns
          const titleCheck = await sanitizeCalendarContent(title);
          if (titleCheck.blocked) {
            eventBus.emit({
              type: "security:blocked",
              taskId: "calendar",
              reason: `SEC-31: Calendar event title blocked (injection detected)`,
            });
            return { success: false, output: "Event title blocked: potential injection detected" };
          }

          const startDate = params.start_date ?? "";
          if (!startDate) return { success: false, output: "start_date parameter required for add_event" };

          // Default end = start + 1 hour
          // OPUS: toISOString() produces "2026-03-20T11:00:00.000Z" which includes
          // milliseconds and Z suffix — this fails the strict ISO_DATE_RE regex
          // used by icalAddEvent(). Strip to YYYY-MM-DDTHH:MM:SS format.
          let endDate = params.end_date ?? "";
          if (!endDate) {
            const d = new Date(new Date(startDate).getTime() + 3_600_000);
            endDate = d.toISOString().replace(/\.\d{3}Z$/, "");
          }

          const rawNotes = params.notes ?? "";
          // SECURITY: SEC-31 — Sanitize notes content
          const notesCheck = await sanitizeCalendarContent(rawNotes);
          if (notesCheck.blocked) {
            eventBus.emit({
              type: "security:blocked",
              taskId: "calendar",
              reason: `SEC-31: Calendar event notes blocked (injection detected)`,
            });
            return { success: false, output: "Event notes blocked: potential injection detected" };
          }

          recordCalendarOp();

          const output = useICal()
            ? await icalAddEvent(titleCheck.sanitized, startDate, endDate, notesCheck.sanitized)
            : await gcalAddEvent(titleCheck.sanitized, startDate, endDate, notesCheck.sanitized);
          return { success: true, output };
        }

        case "search_events": {
          const query = params.query ?? "";
          if (!query) return { success: false, output: "query parameter required for search_events" };
          const output = useICal()
            ? await icalSearchEvents(query)
            : await gcalSearchEvents(query);
          return { success: true, output };
        }

        default:
          return {
            success: false,
            output: `Unknown action: ${action}. Valid: list_events, add_event, search_events`,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Calendar tool error", { action, error: msg });
      return { success: false, output: `Calendar error: ${msg}` };
    }
  },
};

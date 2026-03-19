// ═══════════════════════════════════════════════════════════════
// PEPAGI — Home Assistant Tool
// Control and query Home Assistant smart home devices.
// Requires HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN env vars.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";

const logger = new Logger("HomeAssistant");

const HA_URL = (process.env.HOME_ASSISTANT_URL ?? "http://homeassistant.local:8123").replace(/\/$/, "");
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN ?? "";

interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated: string;
}

/** Build Authorization header for HA long-lived access token */
function haHeaders(): Record<string, string> {
  return {
    "Authorization": `Bearer ${HA_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch the current state of a single entity.
 * @param entityId - Entity ID, e.g. "light.living_room"
 * @returns Formatted state string
 */
export async function homeAssistantGetState(entityId: string): Promise<string> {
  const url = `${HA_URL}/api/states/${encodeURIComponent(entityId)}`;
  const res = await fetch(url, {
    headers: haHeaders(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`HA API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as HAState;
  logger.debug("homeAssistantGetState", { entityId, state: data.state });

  const attrs = Object.entries(data.attributes)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");

  return (
    `Entity: ${data.entity_id}\n` +
    `State: ${data.state}\n` +
    `Last updated: ${data.last_updated}\n` +
    (attrs ? `Attributes:\n${attrs}` : "")
  ).trim();
}

/**
 * Call a Home Assistant service.
 * @param domain - Service domain, e.g. "light"
 * @param service - Service name, e.g. "turn_on"
 * @param serviceData - Optional service data payload
 * @returns Result string
 */
export async function homeAssistantCallService(
  domain: string,
  service: string,
  serviceData: Record<string, unknown>,
): Promise<string> {
  const url = `${HA_URL}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: haHeaders(),
    body: JSON.stringify(serviceData),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`HA API error ${res.status}: ${await res.text()}`);
  }

  const states = (await res.json()) as HAState[];
  logger.debug("homeAssistantCallService", { domain, service, statesReturned: states.length });

  if (!Array.isArray(states) || states.length === 0) {
    return `Service ${domain}.${service} called successfully (no state changes returned).`;
  }

  const lines = states.map(s => `${s.entity_id}: ${s.state}`).join("\n");
  return `Service ${domain}.${service} called. Affected entities:\n${lines}`;
}

/**
 * Fetch all entity states, optionally filtered by domain.
 * @param domain - Optional domain filter, e.g. "light"
 * @returns Formatted state list string
 */
export async function homeAssistantGetStates(domain?: string): Promise<string> {
  const url = `${HA_URL}/api/states`;
  const res = await fetch(url, {
    headers: haHeaders(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`HA API error ${res.status}: ${await res.text()}`);
  }

  let states = (await res.json()) as HAState[];
  logger.debug("homeAssistantGetStates", { total: states.length, domain });

  if (domain) {
    states = states.filter(s => s.entity_id.startsWith(`${domain}.`));
  }

  if (states.length === 0) {
    return domain
      ? `No entities found in domain "${domain}".`
      : "No entities found.";
  }

  // OPUS: cap output to first 200 entities to prevent unbounded response size
  // from large HA installations overwhelming the LLM context window.
  const MAX_ENTITIES = 200;
  const truncated = states.length > MAX_ENTITIES;
  const displayStates = truncated ? states.slice(0, MAX_ENTITIES) : states;
  const lines = displayStates.map(s => `${s.entity_id}: ${s.state}`).join("\n");
  const header = domain
    ? `Entities in domain "${domain}" (${states.length}${truncated ? `, showing first ${MAX_ENTITIES}` : ""}):\n`
    : `All entities (${states.length}${truncated ? `, showing first ${MAX_ENTITIES}` : ""}):\n`;

  return header + lines;
}

// ─── Tool definition for ToolRegistry ────────────────────────

export const homeAssistantTool = {
  name: "smart_home",
  description:
    "Control and query Home Assistant smart home devices. Supports lights, switches, thermostats, sensors, media players.",
  parameters: [
    {
      name: "action",
      type: "string" as const,
      description: "Action: get_state, get_states, call_service",
      required: true,
    },
    {
      name: "entity_id",
      type: "string" as const,
      description: "Entity ID (e.g. light.living_room)",
      required: false,
    },
    {
      name: "domain",
      type: "string" as const,
      description: "Domain filter (e.g. light, switch, sensor)",
      required: false,
    },
    {
      name: "service",
      type: "string" as const,
      description: "Service to call (e.g. turn_on, turn_off, toggle)",
      required: false,
    },
    {
      name: "service_data",
      type: "string" as const,
      description: "JSON service data (e.g. {brightness: 255})",
      required: false,
    },
  ],
  execute: async (params: Record<string, string>): Promise<{ success: boolean; output: string }> => {
    if (!HA_TOKEN) {
      return { success: false, output: "HOME_ASSISTANT_TOKEN not configured" };
    }

    try {
      switch (params["action"]) {
        case "get_state": {
          if (!params["entity_id"]) {
            return { success: false, output: "entity_id required for get_state" };
          }
          return { success: true, output: await homeAssistantGetState(params["entity_id"]) };
        }

        case "get_states": {
          return { success: true, output: await homeAssistantGetStates(params["domain"]) };
        }

        case "call_service": {
          if (!params["domain"] || !params["service"]) {
            return { success: false, output: "domain and service required for call_service" };
          }
          const serviceData: Record<string, unknown> = params["service_data"]
            ? (JSON.parse(params["service_data"]) as Record<string, unknown>)
            : {};
          return {
            success: true,
            output: await homeAssistantCallService(params["domain"], params["service"], serviceData),
          };
        }

        default: {
          return {
            success: false,
            output: `Unknown action: ${params["action"]}. Valid actions: get_state, get_states, call_service`,
          };
        }
      }
    } catch (err) {
      logger.warn("homeAssistantTool error", { params, error: String(err) });
      return { success: false, output: `Home Assistant error: ${String(err)}` };
    }
  },
};

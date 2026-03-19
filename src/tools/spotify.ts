// ═══════════════════════════════════════════════════════════════
// PEPAGI — Spotify Web API Tool
// Requires: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET env vars
// Or: SPOTIFY_ACCESS_TOKEN for direct access
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";

const logger = new Logger("Spotify");

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID ?? "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET ?? "";

// ─── Token cache ──────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  // Use direct token if provided
  if (process.env.SPOTIFY_ACCESS_TOKEN) return process.env.SPOTIFY_ACCESS_TOKEN;

  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET required");
  }

  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Spotify auth failed: ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function spotifyFetch(path: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Spotify API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Actions ─────────────────────────────────────────────────

async function searchTracks(query: string, limit = 5): Promise<string> {
  const data = await spotifyFetch(
    `/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`,
  ) as { tracks: { items: Array<{ name: string; artists: Array<{ name: string }>; album: { name: string }; external_urls: { spotify: string } }> } };

  const tracks = data.tracks.items;
  if (tracks.length === 0) return "No tracks found.";
  return tracks.map((t, i) =>
    `${i + 1}. **${t.name}** — ${t.artists.map(a => a.name).join(", ")} (${t.album.name})\n   ${t.external_urls.spotify}`,
  ).join("\n\n");
}

async function searchArtists(query: string, limit = 5): Promise<string> {
  const data = await spotifyFetch(
    `/search?q=${encodeURIComponent(query)}&type=artist&limit=${limit}`,
  ) as { artists: { items: Array<{ name: string; genres: string[]; followers: { total: number }; external_urls: { spotify: string } }> } };

  const artists = data.artists.items;
  if (artists.length === 0) return "No artists found.";
  return artists.map((a, i) =>
    `${i + 1}. **${a.name}** — Genres: ${a.genres.slice(0, 3).join(", ") || "N/A"}\n   Followers: ${a.followers.total.toLocaleString()}\n   ${a.external_urls.spotify}`,
  ).join("\n\n");
}

async function getArtistTopTracks(artistId: string): Promise<string> {
  const data = await spotifyFetch(`/artists/${artistId}/top-tracks?market=US`) as {
    tracks: Array<{ name: string; album: { name: string }; popularity: number; external_urls: { spotify: string } }>
  };

  return data.tracks.slice(0, 5).map((t, i) =>
    `${i + 1}. **${t.name}** (${t.album.name}) — Popularity: ${t.popularity}/100\n   ${t.external_urls.spotify}`,
  ).join("\n\n");
}

async function getRecommendations(seedTrackId: string, limit = 5): Promise<string> {
  const data = await spotifyFetch(
    `/recommendations?seed_tracks=${seedTrackId}&limit=${limit}`,
  ) as { tracks: Array<{ name: string; artists: Array<{ name: string }>; external_urls: { spotify: string } }> };

  if (data.tracks.length === 0) return "No recommendations found.";
  return data.tracks.map((t, i) =>
    `${i + 1}. **${t.name}** — ${t.artists.map(a => a.name).join(", ")}\n   ${t.external_urls.spotify}`,
  ).join("\n\n");
}

// ─── Tool export ─────────────────────────────────────────────

export const spotifyTool = {
  name: "spotify",
  description: "Search Spotify for music: tracks, artists, albums. Get top tracks and recommendations.",
  parameters: [
    { name: "action", type: "string" as const, description: "Action: search_tracks, search_artists, top_tracks, recommendations", required: true },
    { name: "query", type: "string" as const, description: "Search query or artist/track name", required: false },
    { name: "artist_id", type: "string" as const, description: "Spotify artist ID (for top_tracks)", required: false },
    { name: "track_id", type: "string" as const, description: "Spotify track ID (for recommendations seed)", required: false },
    { name: "limit", type: "string" as const, description: "Number of results (default 5)", required: false },
  ],
  execute: async (params: Record<string, string>): Promise<{ success: boolean; output: string }> => {
    if (!SPOTIFY_CLIENT_ID && !process.env.SPOTIFY_ACCESS_TOKEN) {
      return { success: false, output: "Spotify not configured. Set SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET or SPOTIFY_ACCESS_TOKEN in .env" };
    }
    try {
      const limit = params.limit ? parseInt(params.limit, 10) : 5;
      switch (params.action) {
        case "search_tracks":
          if (!params.query) return { success: false, output: "query required" };
          return { success: true, output: await searchTracks(params.query, limit) };
        case "search_artists":
          if (!params.query) return { success: false, output: "query required" };
          return { success: true, output: await searchArtists(params.query, limit) };
        case "top_tracks":
          if (!params.artist_id) return { success: false, output: "artist_id required" };
          return { success: true, output: await getArtistTopTracks(params.artist_id) };
        case "recommendations":
          if (!params.track_id) return { success: false, output: "track_id required" };
          return { success: true, output: await getRecommendations(params.track_id, limit) };
        default:
          return { success: false, output: `Unknown action: ${params.action}. Valid: search_tracks, search_artists, top_tracks, recommendations` };
      }
    } catch (err) {
      logger.debug("Spotify error", { error: String(err) });
      return { success: false, output: `Spotify error: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

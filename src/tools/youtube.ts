// ═══════════════════════════════════════════════════════════════
// PEPAGI — YouTube Data API Tool
// Requires: YOUTUBE_API_KEY env var
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";

const logger = new Logger("YouTube");
const YT_API_KEY = process.env.YOUTUBE_API_KEY ?? "";
const BASE = "https://www.googleapis.com/youtube/v3";

interface YTVideoItem {
  id: { videoId?: string };
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails: { default: { url: string } };
  };
}

interface YTChannelItem {
  id: string;
  snippet: { title: string; description: string; publishedAt: string };
  statistics: { viewCount: string; subscriberCount: string; videoCount: string };
}

interface YTVideoDetails {
  snippet: { title: string; description: string; channelTitle: string; publishedAt: string; tags?: string[] };
  statistics: { viewCount: string; likeCount?: string; commentCount?: string };
  contentDetails: { duration: string };
}

function isoDurationToReadable(iso: string): string {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return iso;
  const parts: string[] = [];
  if (match[1]) parts.push(`${match[1]}h`);
  if (match[2]) parts.push(`${match[2]}m`);
  if (match[3]) parts.push(`${match[3]}s`);
  return parts.join(" ") || "0s";
}

async function ytFetch(endpoint: string, params: Record<string, string>): Promise<unknown> {
  if (!YT_API_KEY) throw new Error("YOUTUBE_API_KEY not configured");
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("key", YT_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function searchVideos(query: string, maxResults = 5): Promise<string> {
  const data = await ytFetch("search", {
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(maxResults),
    relevanceLanguage: "cs",
  }) as { items: YTVideoItem[] };

  if (!data.items.length) return "No videos found.";
  return data.items.map((item, i) => {
    const vid = item.id.videoId ?? "";
    return `${i + 1}. **${item.snippet.title}**\n   Channel: ${item.snippet.channelTitle} | ${new Date(item.snippet.publishedAt).toLocaleDateString("cs-CZ")}\n   https://youtube.com/watch?v=${vid}`;
  }).join("\n\n");
}

async function getVideoDetails(videoId: string): Promise<string> {
  const data = await ytFetch("videos", {
    part: "snippet,statistics,contentDetails",
    id: videoId,
  }) as { items: YTVideoDetails[] };

  if (!data.items.length) return "Video not found.";
  const v = data.items[0]!;
  const views = parseInt(v.statistics.viewCount).toLocaleString();
  const likes = v.statistics.likeCount ? parseInt(v.statistics.likeCount).toLocaleString() : "N/A";
  const duration = isoDurationToReadable(v.contentDetails.duration);
  const tags = v.snippet.tags?.slice(0, 5).join(", ") ?? "none";

  return [
    `**${v.snippet.title}**`,
    `Channel: ${v.snippet.channelTitle}`,
    `Published: ${new Date(v.snippet.publishedAt).toLocaleDateString("cs-CZ")}`,
    `Duration: ${duration} | Views: ${views} | Likes: ${likes}`,
    `Tags: ${tags}`,
    `\n${v.snippet.description.slice(0, 300)}...`,
    `\nhttps://youtube.com/watch?v=${videoId}`,
  ].join("\n");
}

async function getChannelInfo(channelQuery: string): Promise<string> {
  const data = await ytFetch("search", {
    part: "snippet",
    q: channelQuery,
    type: "channel",
    maxResults: "3",
  }) as { items: Array<{ id: { channelId: string }; snippet: { title: string } }> };

  if (!data.items.length) return "Channel not found.";

  const channelIds = data.items.map(i => i.id.channelId).join(",");
  const details = await ytFetch("channels", {
    part: "snippet,statistics",
    id: channelIds,
  }) as { items: YTChannelItem[] };

  return details.items.map((ch, i) =>
    `${i + 1}. **${ch.snippet.title}**\n   Subscribers: ${parseInt(ch.statistics.subscriberCount).toLocaleString()} | Videos: ${ch.statistics.videoCount} | Views: ${parseInt(ch.statistics.viewCount).toLocaleString()}\n   https://youtube.com/channel/${ch.id}`,
  ).join("\n\n");
}

async function getTranscript(videoId: string): Promise<string> {
  // YouTube transcript requires 3rd party API or youtube-transcript package
  // We return the video description as a fallback
  const data = await ytFetch("videos", {
    part: "snippet",
    id: videoId,
  }) as { items: Array<{ snippet: { description: string; title: string } }> };

  if (!data.items.length) return "Video not found.";
  const v = data.items[0]!;
  return `**${v.snippet.title}**\n\nDescription (transcript not directly available via API):\n${v.snippet.description.slice(0, 1000)}`;
}

// ─── Tool export ─────────────────────────────────────────────

export const youtubeTool = {
  name: "youtube",
  description: "Search YouTube, get video details, channel info, and video statistics.",
  parameters: [
    { name: "action", type: "string" as const, description: "Action: search, video_details, channel_info, transcript", required: true },
    { name: "query", type: "string" as const, description: "Search query", required: false },
    { name: "video_id", type: "string" as const, description: "YouTube video ID (for video_details, transcript)", required: false },
    { name: "channel_query", type: "string" as const, description: "Channel name to search (for channel_info)", required: false },
    { name: "max_results", type: "string" as const, description: "Max results for search (default 5)", required: false },
  ],
  execute: async (params: Record<string, string>): Promise<{ success: boolean; output: string }> => {
    if (!YT_API_KEY) {
      return { success: false, output: "YouTube not configured. Set YOUTUBE_API_KEY in .env (get at https://console.cloud.google.com/)" };
    }
    try {
      const maxResults = params.max_results ? parseInt(params.max_results, 10) : 5;
      switch (params.action) {
        case "search":
          if (!params.query) return { success: false, output: "query required" };
          return { success: true, output: await searchVideos(params.query, maxResults) };
        case "video_details":
          if (!params.video_id) return { success: false, output: "video_id required" };
          return { success: true, output: await getVideoDetails(params.video_id) };
        case "channel_info":
          if (!params.channel_query) return { success: false, output: "channel_query required" };
          return { success: true, output: await getChannelInfo(params.channel_query) };
        case "transcript":
          if (!params.video_id) return { success: false, output: "video_id required" };
          return { success: true, output: await getTranscript(params.video_id) };
        default:
          return { success: false, output: `Unknown action: ${params.action}. Valid: search, video_details, channel_info, transcript` };
      }
    } catch (err) {
      logger.debug("YouTube error", { error: String(err) });
      return { success: false, output: `YouTube error: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// PEPAGI — Notion API Tool
// Requires: NOTION_API_KEY env var
// Optional: NOTION_DATABASE_ID for default database
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";

const logger = new Logger("Notion");

const NOTION_API_KEY = process.env.NOTION_API_KEY ?? "";
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID ?? "";
const NOTION_BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ─── Notion API types ─────────────────────────────────────────

interface NotionRichText {
  type: string;
  plain_text: string;
  text?: { content: string };
  annotations?: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
  };
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  paragraph?: { rich_text: NotionRichText[] };
  heading_1?: { rich_text: NotionRichText[] };
  heading_2?: { rich_text: NotionRichText[] };
  heading_3?: { rich_text: NotionRichText[] };
  bulleted_list_item?: { rich_text: NotionRichText[] };
  numbered_list_item?: { rich_text: NotionRichText[] };
  to_do?: { rich_text: NotionRichText[]; checked: boolean };
  code?: { rich_text: NotionRichText[]; language: string };
  quote?: { rich_text: NotionRichText[] };
  callout?: { rich_text: NotionRichText[]; icon?: { emoji?: string } };
  divider?: Record<string, unknown>;
}

interface NotionPage {
  id: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, NotionProperty>;
}

interface NotionProperty {
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  number?: number | null;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  date?: { start: string; end?: string | null } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
}

interface NotionSearchResult {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlocksResult {
  results: NotionBlock[];
  has_more: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────

function notionHeaders(): Record<string, string> {
  return {
    "Authorization": `Bearer ${NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const res = await fetch(`${NOTION_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: notionHeaders(),
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Notion API error ${res.status}: ${errText}`);
  }

  return res.json();
}

/** Extract plain text from Notion rich text array */
function richTextToPlain(richText: NotionRichText[]): string {
  return richText.map(rt => rt.plain_text).join("");
}

/** Apply markdown formatting to rich text */
function richTextToMarkdown(richText: NotionRichText[]): string {
  return richText.map(rt => {
    let text = rt.plain_text;
    if (rt.annotations?.bold) text = `**${text}**`;
    if (rt.annotations?.italic) text = `_${text}_`;
    if (rt.annotations?.code) text = `\`${text}\``;
    if (rt.annotations?.strikethrough) text = `~~${text}~~`;
    return text;
  }).join("");
}

/** Convert a Notion block to markdown string */
function blockToMarkdown(block: NotionBlock): string {
  switch (block.type) {
    case "paragraph":
      return richTextToMarkdown(block.paragraph?.rich_text ?? []);
    case "heading_1":
      return `# ${richTextToMarkdown(block.heading_1?.rich_text ?? [])}`;
    case "heading_2":
      return `## ${richTextToMarkdown(block.heading_2?.rich_text ?? [])}`;
    case "heading_3":
      return `### ${richTextToMarkdown(block.heading_3?.rich_text ?? [])}`;
    case "bulleted_list_item":
      return `- ${richTextToMarkdown(block.bulleted_list_item?.rich_text ?? [])}`;
    case "numbered_list_item":
      return `1. ${richTextToMarkdown(block.numbered_list_item?.rich_text ?? [])}`;
    case "to_do": {
      const checked = block.to_do?.checked ? "x" : " ";
      return `- [${checked}] ${richTextToMarkdown(block.to_do?.rich_text ?? [])}`;
    }
    case "code": {
      const lang = block.code?.language ?? "";
      const code = richTextToPlain(block.code?.rich_text ?? []);
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case "quote":
      return `> ${richTextToMarkdown(block.quote?.rich_text ?? [])}`;
    case "callout": {
      const emoji = block.callout?.icon?.emoji ?? "💡";
      return `${emoji} ${richTextToMarkdown(block.callout?.rich_text ?? [])}`;
    }
    case "divider":
      return "---";
    default:
      return "";
  }
}

/** Extract page title from Notion page properties */
function getPageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title && prop.title.length > 0) {
      return richTextToPlain(prop.title);
    }
  }
  return "(Untitled)";
}

// ─── Actions ─────────────────────────────────────────────────

/**
 * Search Notion for pages/databases by query.
 * @param query - Search text
 * @returns Formatted list of search results
 */
async function searchNotion(query: string): Promise<string> {
  const data = await notionFetch("/search", {
    method: "POST",
    body: {
      query,
      page_size: 10,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    },
  }) as NotionSearchResult;

  if (data.results.length === 0) {
    return `No results found for: "${query}"`;
  }

  const lines = data.results.map((page, i) => {
    const title = getPageTitle(page);
    const edited = new Date(page.last_edited_time).toLocaleDateString();
    return `${i + 1}. **${title}**\n   ID: ${page.id}\n   Last edited: ${edited}\n   URL: ${page.url}`;
  });

  return `Search results for "${query}" (${data.results.length}):\n\n${lines.join("\n\n")}`;
}

/**
 * Read a Notion page and return its content as markdown.
 * @param pageId - Notion page ID
 * @returns Markdown content of the page
 */
async function readPage(pageId: string): Promise<string> {
  // Get page metadata
  const page = await notionFetch(`/pages/${pageId}`) as NotionPage;
  const title = getPageTitle(page);

  // Get page blocks (content)
  const blocks = await notionFetch(`/blocks/${pageId}/children?page_size=100`) as NotionBlocksResult;

  const contentLines: string[] = [`# ${title}`, ""];

  for (const block of blocks.results) {
    const line = blockToMarkdown(block);
    if (line) contentLines.push(line);
  }

  if (blocks.has_more) {
    contentLines.push("\n_(Content truncated — page has more blocks)_");
  }

  contentLines.push(`\n---\n_Page ID: ${pageId} | Last edited: ${new Date(page.last_edited_time).toLocaleString()}_`);

  return contentLines.join("\n");
}

/**
 * Create a new page in a Notion database.
 * @param title - Page title
 * @param content - Page content text
 * @param databaseId - Target database ID (uses NOTION_DATABASE_ID env if omitted)
 * @returns Created page info
 */
async function createPage(title: string, content: string, databaseId?: string): Promise<string> {
  const dbId = databaseId || NOTION_DATABASE_ID;
  if (!dbId) {
    return "Error: database_id required. Provide it as param or set NOTION_DATABASE_ID env var.";
  }

  const page = await notionFetch("/pages", {
    method: "POST",
    body: {
      parent: { database_id: dbId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }],
        },
      },
      children: content.trim()
        ? [
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", text: { content: content.slice(0, 2000) } }],
              },
            },
          ]
        : [],
    },
  }) as NotionPage;

  return `Page created successfully!\n\nTitle: ${title}\nID: ${page.id}\nURL: ${page.url}`;
}

/**
 * Append a text block to an existing Notion page.
 * @param pageId - Target page ID
 * @param content - Text content to append
 * @returns Success message
 */
async function appendBlock(pageId: string, content: string): Promise<string> {
  await notionFetch(`/blocks/${pageId}/children`, {
    method: "PATCH",
    body: {
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: content.slice(0, 2000) } }],
          },
        },
      ],
    },
  });

  return `Block appended to page ${pageId} successfully.`;
}

// ─── Tool export ─────────────────────────────────────────────

export const notionTool = {
  name: "notion",
  description: "Interact with Notion: search pages, read page content, create pages in a database, append blocks.",
  parameters: [
    { name: "action", type: "string" as const, description: "Action: search, read_page, create_page, append_block", required: true },
    { name: "query", type: "string" as const, description: "Search query (for search action)", required: false },
    { name: "page_id", type: "string" as const, description: "Notion page ID (for read_page and append_block)", required: false },
    { name: "title", type: "string" as const, description: "Page title (for create_page)", required: false },
    { name: "content", type: "string" as const, description: "Page content or block text (for create_page and append_block)", required: false },
    { name: "database_id", type: "string" as const, description: "Database ID for create_page (overrides NOTION_DATABASE_ID env)", required: false },
  ],
  execute: async (params: Record<string, string>): Promise<{ success: boolean; output: string }> => {
    if (!NOTION_API_KEY) {
      return {
        success: false,
        output: "Notion not configured. Set NOTION_API_KEY in your .env file. Get your key at https://www.notion.so/my-integrations",
      };
    }

    try {
      switch (params.action) {
        case "search": {
          if (!params.query) return { success: false, output: "query parameter required for search" };
          return { success: true, output: await searchNotion(params.query) };
        }

        case "read_page": {
          if (!params.page_id) return { success: false, output: "page_id parameter required for read_page" };
          return { success: true, output: await readPage(params.page_id) };
        }

        case "create_page": {
          if (!params.title) return { success: false, output: "title parameter required for create_page" };
          const content = params.content ?? "";
          return { success: true, output: await createPage(params.title, content, params.database_id) };
        }

        case "append_block": {
          if (!params.page_id) return { success: false, output: "page_id parameter required for append_block" };
          if (!params.content) return { success: false, output: "content parameter required for append_block" };
          return { success: true, output: await appendBlock(params.page_id, params.content) };
        }

        default:
          return {
            success: false,
            output: `Unknown action: "${params.action}". Valid actions: search, read_page, create_page, append_block`,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Notion tool error", { action: params.action, error: msg });
      return { success: false, output: `Notion error: ${msg}` };
    }
  },
};

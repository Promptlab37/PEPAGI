// ═══════════════════════════════════════════════════════════════
// PEPAGI — Google Drive Tool (OAuth2)
// Actions: list, read, upload, create, share, search
// ═══════════════════════════════════════════════════════════════

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { Logger } from "../core/logger.js";
import { isGoogleAuthenticated, googleFetch } from "../integrations/google-auth.js";
import { validatePath, PathSecurityError } from "../security/path-validator.js";

const logger = new Logger("GoogleDrive");

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const MAX_TEXT_LENGTH = 10_000;

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  shared?: boolean;
  parents?: string[];
}

interface DriveFileList {
  files?: DriveFile[];
  nextPageToken?: string;
}

/** Google Docs MIME types that need export instead of direct download */
const GOOGLE_EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
};

/** Format a Drive file for display */
function formatFile(f: DriveFile): string {
  const size = f.size ? `${(parseInt(f.size, 10) / 1024).toFixed(1)}KB` : "-";
  const owner = f.owners?.[0]?.emailAddress ?? "-";
  const shared = f.shared ? " [shared]" : "";
  return `${f.name} (${f.mimeType}, ${size})${shared}\n  ID: ${f.id}\n  Modified: ${f.modifiedTime ?? "-"}\n  Owner: ${owner}${f.webViewLink ? `\n  Link: ${f.webViewLink}` : ""}`;
}

// ─── Drive API actions ─────────────────────────────────────

async function driveList(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const maxResults = params.maxResults ?? "20";
  const folderId = params.folderId ?? "";
  const orderBy = params.orderBy ?? "modifiedTime desc";

  let q = "";
  if (folderId) {
    q = `'${folderId}' in parents and trashed = false`;
  } else {
    q = "trashed = false";
  }

  const queryParams = new URLSearchParams({
    q,
    pageSize: maxResults,
    orderBy,
    fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,owners,shared,parents),nextPageToken",
  });

  const res = await googleFetch(`${DRIVE_API}/files?${queryParams.toString()}`);
  if (!res.ok) return { success: false, output: `Drive API error: ${res.status} ${await res.text()}` };

  const data = await res.json() as DriveFileList;
  if (!data.files?.length) return { success: true, output: "No files found." };

  const output = data.files.map(formatFile).join("\n---\n");
  return { success: true, output };
}

async function driveRead(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const fileId = params.fileId ?? params.id ?? "";
  if (!fileId) return { success: false, output: "fileId parameter required" };

  // First get file metadata to determine type
  const metaRes = await googleFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`);
  if (!metaRes.ok) return { success: false, output: `Drive API error: ${metaRes.status}` };

  const meta = await metaRes.json() as DriveFile;
  const exportType = GOOGLE_EXPORT_TYPES[meta.mimeType];

  let contentRes: Response;
  if (exportType) {
    // Google Docs — export
    contentRes = await googleFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportType)}`);
  } else {
    // Regular file — download
    contentRes = await googleFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
  }

  if (!contentRes.ok) return { success: false, output: `Download failed: ${contentRes.status}` };

  const contentType = contentRes.headers.get("content-type") ?? "";
  if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml") || contentType.includes("csv")) {
    const text = await contentRes.text();
    return { success: true, output: `File: ${meta.name} (${meta.mimeType})\n\n${text.slice(0, MAX_TEXT_LENGTH)}${text.length > MAX_TEXT_LENGTH ? "\n...(truncated)" : ""}` };
  }

  // Binary file — just report metadata
  const size = meta.size ? `${(parseInt(meta.size, 10) / 1024).toFixed(1)}KB` : "unknown size";
  return { success: true, output: `File: ${meta.name} (${meta.mimeType}, ${size})\nBinary file — cannot display content as text.` };
}

async function driveUpload(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const filePath = params.filePath ?? params.path ?? "";
  const content = params.content ?? "";
  const name = params.name ?? (filePath ? basename(filePath) : "untitled.txt");
  const folderId = params.folderId ?? "";
  const mimeType = params.mimeType ?? "text/plain";

  let fileData: Buffer | string;
  if (filePath) {
    // SECURITY: Validate path to prevent data exfiltration via Drive upload
    let safePath: string;
    try {
      safePath = await validatePath(filePath, "google_drive_upload");
    } catch (err) {
      if (err instanceof PathSecurityError) return { success: false, output: `Access denied: ${err.message}` };
      throw err;
    }
    if (!existsSync(safePath)) return { success: false, output: `File not found: ${safePath}` };
    fileData = await readFile(safePath);
  } else if (content) {
    fileData = content;
  } else {
    return { success: false, output: "Either filePath or content parameter required" };
  }

  // Multipart upload
  const metadata: Record<string, unknown> = { name, mimeType };
  if (folderId) metadata.parents = [folderId];

  const boundary = `pepagi_boundary_${Date.now()}`;
  const bodyParts = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    `Content-Type: ${mimeType}\r\n\r\n`,
  ];

  const prefix = Buffer.from(bodyParts.join(""), "utf8");
  const suffix = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const fileBuffer = typeof fileData === "string" ? Buffer.from(fileData, "utf8") : fileData;
  const body = Buffer.concat([prefix, fileBuffer, suffix]);

  const res = await googleFetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });

  if (!res.ok) return { success: false, output: `Upload failed: ${res.status} ${await res.text()}` };

  const uploaded = await res.json() as DriveFile;
  return { success: true, output: `Uploaded: ${uploaded.name}\nID: ${uploaded.id}${uploaded.webViewLink ? `\nLink: ${uploaded.webViewLink}` : ""}` };
}

async function driveCreate(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const name = params.name ?? "";
  if (!name) return { success: false, output: "name parameter required" };

  const folderId = params.folderId ?? "";
  const type = params.type ?? "file"; // "file" or "folder"

  const metadata: Record<string, unknown> = { name };
  if (type === "folder") {
    metadata.mimeType = "application/vnd.google-apps.folder";
  }
  if (folderId) {
    metadata.parents = [folderId];
  }

  const res = await googleFetch(`${DRIVE_API}/files?fields=id,name,mimeType,webViewLink`, {
    method: "POST",
    body: JSON.stringify(metadata),
  });

  if (!res.ok) return { success: false, output: `Create failed: ${res.status} ${await res.text()}` };

  const created = await res.json() as DriveFile;
  return { success: true, output: `Created: ${created.name} (${created.mimeType})\nID: ${created.id}${created.webViewLink ? `\nLink: ${created.webViewLink}` : ""}` };
}

async function driveShare(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const fileId = params.fileId ?? params.id ?? "";
  const email = params.email ?? "";
  const role = params.role ?? "reader"; // reader, writer, commenter
  if (!fileId || !email) return { success: false, output: "fileId and email parameters required" };

  const res = await googleFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`, {
    method: "POST",
    body: JSON.stringify({
      type: "user",
      role,
      emailAddress: email,
    }),
  });

  if (!res.ok) return { success: false, output: `Share failed: ${res.status} ${await res.text()}` };
  return { success: true, output: `Shared file ${fileId} with ${email} as ${role}` };
}

async function driveSearch(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const query = params.query ?? "";
  if (!query) return { success: false, output: "query parameter required" };

  const maxResults = params.maxResults ?? "20";
  const q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`;

  const queryParams = new URLSearchParams({
    q,
    pageSize: maxResults,
    fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,owners,shared)",
  });

  const res = await googleFetch(`${DRIVE_API}/files?${queryParams.toString()}`);
  if (!res.ok) return { success: false, output: `Search failed: ${res.status}` };

  const data = await res.json() as DriveFileList;
  if (!data.files?.length) return { success: true, output: `No files found matching: ${query}` };

  const output = data.files.map(formatFile).join("\n---\n");
  return { success: true, output };
}

// ─── Tool export ──────────────────────────────────────────────

export const googleDriveTool = {
  name: "google_drive",
  description:
    "Google Drive: list, read, upload, create, share, search files. Requires Google OAuth2 authentication.",
  parameters: [
    { name: "action", type: "string" as const, description: "Action: list, read, upload, create, share, search", required: true },
    { name: "fileId", type: "string" as const, description: "File ID for read/share", required: false },
    { name: "id", type: "string" as const, description: "Alias for fileId", required: false },
    { name: "name", type: "string" as const, description: "File/folder name for create/upload", required: false },
    { name: "filePath", type: "string" as const, description: "Local file path for upload", required: false },
    { name: "path", type: "string" as const, description: "Alias for filePath", required: false },
    { name: "content", type: "string" as const, description: "Text content for upload", required: false },
    { name: "folderId", type: "string" as const, description: "Parent folder ID for list/create/upload", required: false },
    { name: "type", type: "string" as const, description: "Type for create: file or folder", required: false },
    { name: "email", type: "string" as const, description: "Email for share", required: false },
    { name: "role", type: "string" as const, description: "Permission role for share: reader/writer/commenter", required: false },
    { name: "query", type: "string" as const, description: "Search query for search", required: false },
    { name: "maxResults", type: "string" as const, description: "Max results (default: 20)", required: false },
    { name: "mimeType", type: "string" as const, description: "MIME type for upload (default: text/plain)", required: false },
    { name: "orderBy", type: "string" as const, description: "Order for list (default: modifiedTime desc)", required: false },
  ],

  execute: async (
    params: Record<string, string>,
    _taskId?: string,
    guard?: { authorize: (taskId: string, action: unknown, details: string) => Promise<boolean> },
  ): Promise<{ success: boolean; output: string }> => {
    const action = params.action ?? "";
    if (!action) return { success: false, output: "action parameter required" };

    const hasOAuth = await isGoogleAuthenticated();
    if (!hasOAuth) {
      return { success: false, output: "Google Drive requires OAuth2 authentication. Run setup to configure Google OAuth." };
    }

    // Security: share requires network_external authorization
    if (action === "share" && guard) {
      const allowed = await guard.authorize(_taskId ?? "drive", "network_external", `drive:share:${params.email ?? ""}`);
      if (!allowed) return { success: false, output: "Share not authorized by security policy" };
    }

    try {
      switch (action) {
        case "list": return await driveList(params);
        case "read": return await driveRead(params);
        case "upload": return await driveUpload(params);
        case "create": return await driveCreate(params);
        case "share": return await driveShare(params);
        case "search": return await driveSearch(params);
        default:
          return { success: false, output: `Unknown action: ${action}. Valid: list, read, upload, create, share, search` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Google Drive tool error", { action, error: msg });
      return { success: false, output: `Drive error: ${msg}` };
    }
  },
};

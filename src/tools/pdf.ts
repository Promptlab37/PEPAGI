// ═══════════════════════════════════════════════════════════════
// PEPAGI — PDF Tool
// Generates PDF documents from structured content (text, markdown,
// headings, bullet lists, tables). Uses PDFKit.
// No external API key required.
// ═══════════════════════════════════════════════════════════════

import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../core/logger.js";
import type { ToolResult } from "./tool-registry.js";

const logger = new Logger("PDFTool");

/** Default output directory for generated PDFs */
const DEFAULT_OUTPUT_DIR = join(homedir(), "Desktop");

// ─── Markdown-like parser ────────────────────────────────────

interface ContentBlock {
  type: "h1" | "h2" | "h3" | "paragraph" | "bullet" | "numbered" | "hr" | "table" | "code";
  text: string;
  rows?: string[][]; // for tables
}

/**
 * Parse simple markdown-like text into structured content blocks.
 */
function parseContent(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = text.split("\n");
  let i = 0;
  let paragraphBuffer: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphBuffer.length > 0) {
      blocks.push({ type: "paragraph", text: paragraphBuffer.join(" ").trim() });
      paragraphBuffer = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty line — flush paragraph
    if (!trimmed) {
      flushParagraph();
      i++;
      continue;
    }

    // Headings
    if (trimmed.startsWith("### ")) {
      flushParagraph();
      blocks.push({ type: "h3", text: trimmed.slice(4).trim() });
      i++;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushParagraph();
      blocks.push({ type: "h2", text: trimmed.slice(3).trim() });
      i++;
      continue;
    }
    if (trimmed.startsWith("# ")) {
      flushParagraph();
      blocks.push({ type: "h1", text: trimmed.slice(2).trim() });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-=]{3,}$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ type: "hr", text: "" });
      i++;
      continue;
    }

    // Bullet list (- or * or •)
    if (/^[-*•]\s+/.test(trimmed)) {
      flushParagraph();
      blocks.push({ type: "bullet", text: trimmed.replace(/^[-*•]\s+/, "").trim() });
      i++;
      continue;
    }

    // Numbered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph();
      blocks.push({ type: "numbered", text: trimmed.replace(/^\d+[.)]\s+/, "").trim() });
      i++;
      continue;
    }

    // Table detection (pipe-delimited)
    if (trimmed.includes("|") && trimmed.startsWith("|")) {
      flushParagraph();
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const row = lines[i].trim();
        // Skip separator rows like |---|---|
        if (/^\|[\s-:|]+\|$/.test(row)) {
          i++;
          continue;
        }
        const cells = row
          .split("|")
          .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1)
          .map(c => c.trim());
        if (cells.length > 0) {
          rows.push(cells);
        }
        i++;
      }
      if (rows.length > 0) {
        blocks.push({ type: "table", text: "", rows });
      }
      continue;
    }

    // Code block (```)
    if (trimmed.startsWith("```")) {
      flushParagraph();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    // Regular text — accumulate into paragraph
    paragraphBuffer.push(trimmed);
    i++;
  }

  flushParagraph();
  return blocks;
}

// ─── PDF Rendering ───────────────────────────────────────────

/**
 * Build a PDF buffer from parsed content blocks using PDFKit.
 */
async function renderPDF(
  blocks: ContentBlock[],
  options: {
    title?: string;
    author?: string;
    pageSize?: string;
    margin?: number;
    headerColor?: string;
  } = {}
): Promise<Buffer> {
  // Dynamic import because PDFKit is CJS
  const PDFDocument = (await import("pdfkit")).default;

  const { title, author, pageSize = "A4", margin = 50, headerColor = "#1a1a2e" } = options;

  const doc = new PDFDocument({
    size: pageSize as string,
    margin,
    info: {
      Title: title ?? "PEPAGI Document",
      Author: author ?? "PEPAGI AGI System",
      Creator: "PEPAGI v0.5.0",
    },
    bufferPages: true,
  });

  // Collect into buffer
  const chunks: Uint8Array[] = [];
  doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));

  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // ─── Fonts: use built-in Helvetica family ────────
  const FONT_REGULAR = "Helvetica";
  const FONT_BOLD = "Helvetica-Bold";
  const FONT_ITALIC = "Helvetica-Oblique";
  const FONT_MONO = "Courier";

  // ─── Colors ──────────────────────────────────────
  const COLOR_TEXT = "#222222";
  const COLOR_HEADING = headerColor;
  const COLOR_BULLET = "#4a90d9";
  const COLOR_CODE_BG = "#f5f5f5";
  const COLOR_TABLE_HEADER = "#2c3e50";
  const COLOR_TABLE_ALT = "#f8f9fa";
  const COLOR_HR = "#cccccc";

  // ─── Title page header ───────────────────────────
  if (title) {
    doc
      .font(FONT_BOLD)
      .fontSize(24)
      .fillColor(COLOR_HEADING)
      .text(title, { align: "center" });
    doc.moveDown(0.5);

    // Subtitle line
    const now = new Date();
    doc
      .font(FONT_ITALIC)
      .fontSize(10)
      .fillColor("#888888")
      .text(`Generováno: ${now.toLocaleDateString("cs-CZ")} ${now.toLocaleTimeString("cs-CZ")} | PEPAGI AGI`, {
        align: "center",
      });
    doc.moveDown(1.5);

    // Decorative line
    doc
      .moveTo(margin, doc.y)
      .lineTo(doc.page.width - margin, doc.y)
      .strokeColor(COLOR_BULLET)
      .lineWidth(2)
      .stroke();
    doc.moveDown(1);
  }

  // ─── Render blocks ───────────────────────────────
  let numberedCounter = 0;

  for (const block of blocks) {
    // Page break safety: if near bottom, add new page
    if (doc.y > doc.page.height - margin - 60) {
      doc.addPage();
    }

    switch (block.type) {
      case "h1":
        doc.moveDown(0.8);
        doc.font(FONT_BOLD).fontSize(20).fillColor(COLOR_HEADING);
        doc.text(block.text);
        doc.moveDown(0.3);
        // Underline
        doc
          .moveTo(margin, doc.y)
          .lineTo(doc.page.width - margin, doc.y)
          .strokeColor(COLOR_BULLET)
          .lineWidth(1.5)
          .stroke();
        doc.moveDown(0.5);
        numberedCounter = 0;
        break;

      case "h2":
        doc.moveDown(0.6);
        doc.font(FONT_BOLD).fontSize(16).fillColor(COLOR_HEADING);
        doc.text(block.text);
        doc.moveDown(0.3);
        numberedCounter = 0;
        break;

      case "h3":
        doc.moveDown(0.4);
        doc.font(FONT_BOLD).fontSize(13).fillColor(COLOR_HEADING);
        doc.text(block.text);
        doc.moveDown(0.2);
        numberedCounter = 0;
        break;

      case "paragraph":
        doc.font(FONT_REGULAR).fontSize(11).fillColor(COLOR_TEXT);
        doc.text(block.text, { align: "justify", lineGap: 3 });
        doc.moveDown(0.5);
        numberedCounter = 0;
        break;

      case "bullet":
        doc.font(FONT_REGULAR).fontSize(11).fillColor(COLOR_BULLET);
        doc.text("●", margin, doc.y, { continued: true });
        doc.fillColor(COLOR_TEXT);
        doc.text(`  ${block.text}`, { lineGap: 2 });
        doc.moveDown(0.2);
        break;

      case "numbered":
        numberedCounter++;
        doc.font(FONT_BOLD).fontSize(11).fillColor(COLOR_BULLET);
        doc.text(`${numberedCounter}.`, margin, doc.y, { continued: true });
        doc.font(FONT_REGULAR).fillColor(COLOR_TEXT);
        doc.text(`  ${block.text}`, { lineGap: 2 });
        doc.moveDown(0.2);
        break;

      case "hr":
        doc.moveDown(0.5);
        doc
          .moveTo(margin, doc.y)
          .lineTo(doc.page.width - margin, doc.y)
          .strokeColor(COLOR_HR)
          .lineWidth(0.5)
          .stroke();
        doc.moveDown(0.5);
        numberedCounter = 0;
        break;

      case "code": {
        doc.moveDown(0.3);
        const codeX = margin + 5;
        const codeWidth = doc.page.width - 2 * margin - 10;
        // Background rect
        const codeHeight = Math.min(block.text.split("\n").length * 13 + 15, 300);
        doc
          .save()
          .rect(margin, doc.y - 3, doc.page.width - 2 * margin, codeHeight)
          .fill(COLOR_CODE_BG)
          .restore();
        doc.font(FONT_MONO).fontSize(9).fillColor("#333333");
        doc.text(block.text, codeX, doc.y + 5, { width: codeWidth });
        doc.moveDown(0.5);
        numberedCounter = 0;
        break;
      }

      case "table": {
        if (!block.rows || block.rows.length === 0) break;
        doc.moveDown(0.3);

        const tableWidth = doc.page.width - 2 * margin;
        const cols = block.rows[0].length;
        const colWidth = tableWidth / cols;
        const cellPadding = 5;
        const rowHeight = 22;

        for (let r = 0; r < block.rows.length; r++) {
          const row = block.rows[r];
          const y = doc.y;

          // Page break check
          if (y + rowHeight > doc.page.height - margin - 20) {
            doc.addPage();
          }
          const currentY = doc.y;

          // Header row or alternating background
          if (r === 0) {
            doc
              .save()
              .rect(margin, currentY, tableWidth, rowHeight)
              .fill(COLOR_TABLE_HEADER)
              .restore();
            doc.font(FONT_BOLD).fontSize(10).fillColor("#ffffff");
          } else {
            if (r % 2 === 0) {
              doc
                .save()
                .rect(margin, currentY, tableWidth, rowHeight)
                .fill(COLOR_TABLE_ALT)
                .restore();
            }
            doc.font(FONT_REGULAR).fontSize(10).fillColor(COLOR_TEXT);
          }

          // Cell text
          for (let c = 0; c < cols; c++) {
            const cellText = (row[c] ?? "").slice(0, 60);
            doc.text(cellText, margin + c * colWidth + cellPadding, currentY + 6, {
              width: colWidth - cellPadding * 2,
              height: rowHeight,
              ellipsis: true,
            });
          }

          doc.y = currentY + rowHeight;
        }

        // Table border bottom
        doc
          .moveTo(margin, doc.y)
          .lineTo(margin + tableWidth, doc.y)
          .strokeColor(COLOR_HR)
          .lineWidth(0.5)
          .stroke();
        doc.moveDown(0.5);
        numberedCounter = 0;
        break;
      }
    }
  }

  // ─── Footer on each page ─────────────────────────
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc
      .font(FONT_ITALIC)
      .fontSize(8)
      .fillColor("#aaaaaa")
      .text(
        `PEPAGI AGI | Strana ${i + 1}/${pageCount}`,
        margin,
        doc.page.height - margin + 10,
        { align: "center", width: doc.page.width - 2 * margin }
      );
  }

  doc.end();
  return finished;
}

// ─── Tool interface ──────────────────────────────────────────

/**
 * Generate a PDF file from content.
 *
 * @param args.content - Text/markdown content to render
 * @param args.title - Document title (optional)
 * @param args.filename - Output filename without extension (optional, default: generated from title)
 * @param args.path - Full output path (optional, overrides filename)
 * @param args.author - Document author (optional)
 * @param args.page_size - Page size: A4, Letter, etc. (optional, default: A4)
 */
export const pdfTool = {
  name: "generate_pdf",
  description:
    "Generate a PDF document from text/markdown content. Supports headings (#, ##, ###), " +
    "bullet lists (- or *), numbered lists (1.), tables (|col1|col2|), code blocks (```), " +
    "and horizontal rules (---). Output is saved to Desktop by default.",

  async execute(args: Record<string, string>): Promise<ToolResult> {
    const content = args.content ?? "";
    if (!content) {
      return { success: false, output: "", error: "No content provided. Provide 'content' argument with text/markdown." };
    }

    const title = args.title ?? "";
    const author = args.author ?? "PEPAGI";
    const pageSize = args.page_size ?? args.pageSize ?? "A4";

    // Determine output path
    let outputPath: string;
    if (args.path) {
      outputPath = resolve(args.path);
      // Ensure .pdf extension
      if (!outputPath.endsWith(".pdf")) outputPath += ".pdf";
    } else {
      const filename = args.filename ??
        (title ? title.replace(/[^a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF _-]/g, "").replace(/\s+/g, "_").slice(0, 60) : `pepagi_${Date.now()}`);
      const safeName = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
      outputPath = join(DEFAULT_OUTPUT_DIR, safeName);
    }

    try {
      // Parse content
      const blocks = parseContent(content);

      if (blocks.length === 0) {
        return { success: false, output: "", error: "Content parsed to zero blocks. Provide meaningful text content." };
      }

      // Render PDF
      const pdfBuffer = await renderPDF(blocks, {
        title: title || undefined,
        author,
        pageSize,
      });

      // Ensure output directory exists
      await mkdir(dirname(outputPath), { recursive: true });

      // Write file
      await fsWriteFile(outputPath, pdfBuffer);

      const sizeKB = (pdfBuffer.length / 1024).toFixed(1);
      logger.info("PDF generated", { path: outputPath, sizeKB, blocks: blocks.length });

      return {
        success: true,
        output: JSON.stringify({
          path: outputPath,
          sizeBytes: pdfBuffer.length,
          sizeKB: `${sizeKB} KB`,
          blocks: blocks.length,
          pages: pageSize,
          title: title || "(bez názvu)",
        }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("PDF generation failed", { error: msg, outputPath });
      return { success: false, output: "", error: `PDF generation failed: ${msg}` };
    }
  },
};

/** Export parser for testing */
export { parseContent, renderPDF };
export type { ContentBlock };

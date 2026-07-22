/**
 * PDF Inspection Tool Extension
 *
 * Provides Nix-friendly local or AgentSH-supervised PDF inspection tools beyond plain text
 * extraction: document metadata, page rendering, image cropping, text
 * extraction, and embedded image extraction.
 */

import { basename, dirname, extname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  commandString,
  createPdfBackend,
  DEFAULT_MAX_ATTACH_BYTES,
  DEFAULT_TIMEOUT_MS,
  type PdfBackend,
} from "./backend.js";

const DEFAULT_RENDER_DPI = 150;
const DEFAULT_MAX_TEXT_CHARS = 100 * 1024;

type ToolOutputContent = Array<Record<string, unknown>>;

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function sanitizeName(value: string): string {
  return value
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "pdf";
}

function padPage(page: number): string {
  return String(page).padStart(3, "0");
}

async function writeJson(
  backend: PdfBackend,
  path: string,
  data: unknown,
  signal?: AbortSignal,
): Promise<void> {
  await backend.writeText(path, JSON.stringify(data, null, 2) + "\n", signal);
}

async function getImageDimensions(
  backend: PdfBackend,
  imagePath: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const { stdout } = await backend.exec(
    "magick",
    ["identify", "-format", "%w %h", imagePath],
    { signal, timeoutMs: 30_000 },
  );
  const [width, height] = stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Could not determine image dimensions for ${imagePath}`);
  }
  return { width, height };
}

function mimeTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "image/png";
}

async function maybeAttachImage(
  backend: PdfBackend,
  content: ToolOutputContent,
  imagePath: string,
  attach: boolean | undefined,
  maxBytes: number | undefined,
  signal?: AbortSignal,
): Promise<{ attached: boolean; skippedReason?: string }> {
  if (!attach) return { attached: false };
  const attachment = await backend.readAttachment(
    imagePath,
    maxBytes ?? DEFAULT_MAX_ATTACH_BYTES,
    signal,
  );
  if (!attachment.data) {
    return {
      attached: false,
      skippedReason: attachment.skippedReason ?? "Image attachment data was unavailable.",
    };
  }
  content.push({
    type: "image",
    mimeType: mimeTypeForPath(imagePath),
    data: attachment.data,
  });
  return { attached: true };
}

function parsePageSpec(spec: string | undefined, maxPage?: number): number[] {
  if (!spec || spec.trim() === "") {
    throw new Error("pages is required, for example '1', '1-3', or '1,3,5-7'.");
  }

  const pages = new Set<number>();
  for (const partRaw of spec.split(",")) {
    const part = partRaw.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < 1 || end < start) {
        throw new Error(`Invalid page range: ${part}`);
      }
      for (let page = start; page <= end; page++) pages.add(page);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const page = Number(part);
      if (page < 1) throw new Error(`Invalid page number: ${part}`);
      pages.add(page);
      continue;
    }
    throw new Error(`Invalid pages value: ${part}`);
  }

  const result = [...pages].sort((a, b) => a - b);
  if (result.length === 0) throw new Error("No pages selected.");
  if (maxPage !== undefined) {
    const outOfRange = result.find((page) => page > maxPage);
    if (outOfRange !== undefined) {
      throw new Error(`Page ${outOfRange} is out of range; PDF has ${maxPage} pages.`);
    }
  }
  return result;
}

function parsePdfInfo(output: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  const pageSizes: Array<Record<string, unknown>> = [];

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    const normalized = key.toLowerCase().replace(/\s+/g, "_");

    const pageSize = key.match(/^Page\s+(\d+)\s+size$/i);
    if (pageSize) {
      pageSizes.push({ page: Number(pageSize[1]), size: value });
      continue;
    }

    if (normalized === "pages") {
      parsed.pages = Number(value);
    } else if (normalized === "page_size") {
      parsed.pageSize = value;
    } else if (
      [
        "title",
        "subject",
        "keywords",
        "author",
        "creator",
        "producer",
        "creationdate",
        "moddate",
        "tagged",
        "form",
        "javascript",
        "encrypted",
        "page_rot",
        "file_size",
        "pdf_version",
      ].includes(normalized)
    ) {
      parsed[normalized] = value;
    }
  }

  if (pageSizes.length > 0) parsed.pageSizes = pageSizes;
  return parsed;
}

function sidecarPath(outputPath: string): string {
  return `${outputPath}.json`;
}

async function getPopplerVersion(
  backend: PdfBackend,
  command: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stderr, stdout } = await backend.exec(command, ["-v"], {
      signal,
      timeoutMs: 10_000,
    });
    return (stderr || stdout).trim().split(/\r?\n/)[0];
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    return undefined;
  }
}

async function getImageMagickVersion(
  backend: PdfBackend,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stdout } = await backend.exec("magick", ["-version"], {
      signal,
      timeoutMs: 10_000,
    });
    return stdout.trim().split(/\r?\n/)[0];
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    return undefined;
  }
}

export default function pdfExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pdf_info",
    label: "PDF Info",
    description:
      "Inspect a PDF's metadata and page information using Nix-packaged Poppler tools in the active local or AgentSH workspace.",
    parameters: Type.Object({
      pdfPath: Type.String({ description: "Path to the PDF file in the active workspace" }),
      timeoutMs: Type.Optional(
        Type.Number({ description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})` }),
      ),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const backend = createPdfBackend(ctx.cwd, toolCallId, "pdf_info");
      const pdfPath = backend.resolvePath(params.pdfPath, "pdfPath");
      await backend.requireReadableFile(pdfPath, "pdfPath", signal);

      const { stdout } = await backend.exec("pdfinfo", [pdfPath], {
        signal,
        timeoutMs: params.timeoutMs,
      });
      const parsed = parsePdfInfo(stdout);
      const version = await getPopplerVersion(backend, "pdfinfo", signal);
      const details = {
        sourcePdf: pdfPath,
        ...parsed,
        toolVersions: { pdfinfo: version },
        raw: stdout,
      };

      const lines = [
        `PDF: ${pdfPath}`,
        parsed.pages !== undefined ? `Pages: ${parsed.pages}` : undefined,
        parsed.pageSize !== undefined ? `Page size: ${parsed.pageSize}` : undefined,
        parsed.encrypted !== undefined ? `Encrypted: ${parsed.encrypted}` : undefined,
        parsed.title !== undefined ? `Title: ${parsed.title}` : undefined,
        parsed.author !== undefined ? `Author: ${parsed.author}` : undefined,
      ].filter(Boolean) as string[];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "pdf_render_pages",
    label: "Render PDF Pages",
    description:
      "Render selected PDF pages to PNG images for visual inspection in the active local or AgentSH workspace. Writes only to the requested output directory and records JSON sidecars.",
    parameters: Type.Object({
      pdfPath: Type.String({ description: "Path to the PDF file in the active workspace" }),
      pages: Type.String({ description: "Pages to render, e.g. '1', '1-3', or '1,3,5-7'" }),
      outputDir: Type.String({ description: "Directory where rendered page images and sidecars will be written" }),
      dpi: Type.Optional(Type.Number({ description: `Render DPI (default: ${DEFAULT_RENDER_DPI})` })),
      prefix: Type.Optional(Type.String({ description: "Optional filename prefix (default: PDF basename)" })),
      attachImages: Type.Optional(Type.Boolean({ description: "Return rendered images directly to the LLM when they are small enough" })),
      maxAttachBytes: Type.Optional(Type.Number({ description: `Maximum bytes per attached image (default: ${DEFAULT_MAX_ATTACH_BYTES})` })),
      overwrite: Type.Optional(Type.Boolean({ description: "Overwrite existing output files (default: false)" })),
      timeoutMs: Type.Optional(Type.Number({ description: `Timeout per page in milliseconds (default: ${DEFAULT_TIMEOUT_MS})` })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const backend = createPdfBackend(ctx.cwd, toolCallId, "pdf_render_pages");
      const pdfPath = backend.resolvePath(params.pdfPath, "pdfPath");
      const outputDir = backend.resolvePath(params.outputDir, "outputDir");
      await backend.requireReadableFile(pdfPath, "pdfPath", signal);
      await backend.mkdir(outputDir, signal);

      const info = await backend.exec("pdfinfo", [pdfPath], {
        signal,
        timeoutMs: params.timeoutMs,
      });
      const parsedInfo = parsePdfInfo(info.stdout);
      const maxPage = typeof parsedInfo.pages === "number" ? parsedInfo.pages : undefined;
      const pages = parsePageSpec(params.pages, maxPage);
      const dpi = params.dpi ?? DEFAULT_RENDER_DPI;
      if (!Number.isFinite(dpi) || dpi <= 0) throw new Error("dpi must be a positive number.");

      const prefix = sanitizeName(params.prefix ?? basename(pdfPath));
      const rendered: Array<Record<string, unknown>> = [];
      const content: ToolOutputContent = [];
      const pdftoppmVersion = await getPopplerVersion(backend, "pdftoppm", signal);
      const imageMagickVersion = await getImageMagickVersion(backend, signal);

      for (const page of pages) {
        const outputBase = join(outputDir, `${prefix}-page-${padPage(page)}`);
        const outputPath = `${outputBase}.png`;
        const metadataPath = sidecarPath(outputPath);
        if (!params.overwrite && await backend.exists(outputPath, signal)) {
          throw new Error(`Output already exists: ${outputPath}. Set overwrite=true to replace it.`);
        }

        onUpdate?.({ content: [{ type: "text", text: `Rendering page ${page} → ${outputPath}` }] });
        const args = [
          "-png",
          "-r",
          String(dpi),
          "-f",
          String(page),
          "-l",
          String(page),
          "-singlefile",
          pdfPath,
          outputBase,
        ];
        await backend.exec("pdftoppm", args, {
          signal,
          timeoutMs: params.timeoutMs,
        });
        const dimensions = await getImageDimensions(backend, outputPath, signal);
        const metadata = {
          kind: "pdf-rendered-page",
          sourcePdf: pdfPath,
          page,
          dpi,
          format: "png",
          outputPath,
          dimensions,
          command: commandString("pdftoppm", args),
          toolVersions: {
            pdftoppm: pdftoppmVersion,
            imagemagick: imageMagickVersion,
          },
        };
        await writeJson(backend, metadataPath, metadata, signal);
        const attachment = await maybeAttachImage(
          backend,
          content,
          outputPath,
          params.attachImages,
          params.maxAttachBytes,
          signal,
        );
        rendered.push({ ...metadata, metadataPath, attachment });
      }

      const summary = [
        `Rendered ${rendered.length} page(s) from ${pdfPath}`,
        ...rendered.map((item) => {
          const dimensions = item.dimensions as { width: number; height: number };
          return `Page ${item.page}: ${item.outputPath} (${dimensions.width}×${dimensions.height}, ${dpi} DPI)`;
        }),
      ];
      content.unshift({ type: "text", text: summary.join("\n") });

      return {
        content,
        details: {
          sourcePdf: pdfPath,
          pages,
          dpi,
          outputDir,
          rendered,
        },
      };
    },
  });

  pi.registerTool({
    name: "pdf_crop_image",
    label: "Crop PDF Image",
    description:
      "Crop a rectangular pixel region from a rendered PDF page or other workspace image. Writes a normal image plus a JSON sidecar.",
    parameters: Type.Object({
      sourceImagePath: Type.String({ description: "Path to the source image in the active workspace" }),
      crop: Type.Object({
        x: Type.Number({ description: "Left coordinate in pixels" }),
        y: Type.Number({ description: "Top coordinate in pixels" }),
        width: Type.Number({ description: "Crop width in pixels" }),
        height: Type.Number({ description: "Crop height in pixels" }),
      }),
      outputPath: Type.Optional(Type.String({ description: "Exact output image path. If omitted, outputDir is required." })),
      outputDir: Type.Optional(Type.String({ description: "Directory for generated crop when outputPath is omitted" })),
      label: Type.Optional(Type.String({ description: "Optional crop label used in generated filename and metadata" })),
      attachImage: Type.Optional(Type.Boolean({ description: "Return cropped image directly to the LLM when small enough" })),
      maxAttachBytes: Type.Optional(Type.Number({ description: `Maximum bytes for attached image (default: ${DEFAULT_MAX_ATTACH_BYTES})` })),
      overwrite: Type.Optional(Type.Boolean({ description: "Overwrite existing output file (default: false)" })),
      timeoutMs: Type.Optional(Type.Number({ description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})` })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const backend = createPdfBackend(ctx.cwd, toolCallId, "pdf_crop_image");
      const sourceImagePath = backend.resolvePath(params.sourceImagePath, "sourceImagePath");
      await backend.requireReadableFile(sourceImagePath, "sourceImagePath", signal);
      const crop = params.crop as CropRect;
      for (const [key, value] of Object.entries(crop)) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`crop.${key} must be a non-negative number.`);
      }
      if (crop.width <= 0 || crop.height <= 0) {
        throw new Error("crop.width and crop.height must be positive.");
      }

      const label = sanitizeName(params.label ?? "crop");
      const outputPath = params.outputPath
        ? backend.resolvePath(params.outputPath, "outputPath")
        : params.outputDir
          ? join(
              backend.resolvePath(params.outputDir, "outputDir"),
              `${sanitizeName(basename(sourceImagePath))}-${label}.png`,
            )
          : undefined;
      if (!outputPath) throw new Error("Either outputPath or outputDir is required.");
      await backend.mkdir(dirname(outputPath), signal);
      if (!params.overwrite && await backend.exists(outputPath, signal)) {
        throw new Error(`Output already exists: ${outputPath}. Set overwrite=true to replace it.`);
      }

      const sourceDimensions = await getImageDimensions(backend, sourceImagePath, signal);
      if (crop.x + crop.width > sourceDimensions.width || crop.y + crop.height > sourceDimensions.height) {
        throw new Error(
          `Crop rectangle ${crop.width}x${crop.height}+${crop.x}+${crop.y} exceeds source dimensions ${sourceDimensions.width}x${sourceDimensions.height}.`,
        );
      }

      const geometry = `${Math.round(crop.width)}x${Math.round(crop.height)}+${Math.round(crop.x)}+${Math.round(crop.y)}`;
      const args = [sourceImagePath, "-crop", geometry, "+repage", outputPath];
      await backend.exec("magick", args, { signal, timeoutMs: params.timeoutMs });
      const dimensions = await getImageDimensions(backend, outputPath, signal);
      const imageMagickVersion = await getImageMagickVersion(backend, signal);
      const metadata = {
        kind: "pdf-image-crop",
        sourceImagePath,
        outputPath,
        crop: {
          x: Math.round(crop.x),
          y: Math.round(crop.y),
          width: Math.round(crop.width),
          height: Math.round(crop.height),
        },
        sourceDimensions,
        dimensions,
        label,
        command: commandString("magick", args),
        toolVersions: { imagemagick: imageMagickVersion },
      };
      const metadataPath = sidecarPath(outputPath);
      await writeJson(backend, metadataPath, metadata, signal);

      const content: ToolOutputContent = [
        {
          type: "text",
          text: `Cropped ${sourceImagePath}\n→ ${outputPath} (${dimensions.width}×${dimensions.height})\nCrop: ${geometry}`,
        },
      ];
      const attachment = await maybeAttachImage(
        backend,
        content,
        outputPath,
        params.attachImage,
        params.maxAttachBytes,
        signal,
      );

      return {
        content,
        details: { ...metadata, metadataPath, attachment },
      };
    },
  });

  pi.registerTool({
    name: "pdf_extract_text",
    label: "Extract PDF Text",
    description:
      "Extract text from selected pages of a PDF using Poppler pdftotext in the active local or AgentSH workspace. Supports plain, layout-preserving, raw, and bbox modes.",
    parameters: Type.Object({
      pdfPath: Type.String({ description: "Path to the PDF file in the active workspace" }),
      pages: Type.Optional(Type.String({ description: "Optional pages to extract, e.g. '1', '1-3', or '1,3,5-7'. pdftotext receives the min/max range." })),
      mode: Type.Optional(
        Type.Union([
          Type.Literal("plain"),
          Type.Literal("layout"),
          Type.Literal("raw"),
          Type.Literal("bbox"),
          Type.Literal("bbox-layout"),
        ], { description: "Extraction mode (default: plain)" }),
      ),
      outputPath: Type.Optional(Type.String({ description: "Optional file path to write extracted text/XML. If omitted, text is returned." })),
      maxChars: Type.Optional(Type.Number({ description: `Maximum characters returned when outputPath is omitted (default: ${DEFAULT_MAX_TEXT_CHARS})` })),
      timeoutMs: Type.Optional(Type.Number({ description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})` })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const backend = createPdfBackend(ctx.cwd, toolCallId, "pdf_extract_text");
      const pdfPath = backend.resolvePath(params.pdfPath, "pdfPath");
      await backend.requireReadableFile(pdfPath, "pdfPath", signal);
      const outputPath = params.outputPath ? backend.resolvePath(params.outputPath, "outputPath") : undefined;
      if (outputPath) await backend.mkdir(dirname(outputPath), signal);

      let selectedPages: number[] | undefined;
      if (params.pages) {
        const info = await backend.exec("pdfinfo", [pdfPath], { signal, timeoutMs: params.timeoutMs });
        const parsedInfo = parsePdfInfo(info.stdout);
        selectedPages = parsePageSpec(params.pages, typeof parsedInfo.pages === "number" ? parsedInfo.pages : undefined);
      }

      const mode = params.mode ?? "plain";
      const args: string[] = [];
      if (selectedPages && selectedPages.length > 0) {
        args.push("-f", String(Math.min(...selectedPages)), "-l", String(Math.max(...selectedPages)));
      }
      if (mode === "layout") args.push("-layout");
      if (mode === "raw") args.push("-raw");
      if (mode === "bbox") args.push("-bbox");
      if (mode === "bbox-layout") args.push("-bbox-layout");
      args.push(pdfPath, outputPath ?? "-");

      const result = await backend.exec("pdftotext", args, {
        signal,
        timeoutMs: params.timeoutMs,
      });
      const version = await getPopplerVersion(backend, "pdftotext", signal);
      const metadata = {
        kind: "pdf-extracted-text",
        sourcePdf: pdfPath,
        pages: selectedPages,
        mode,
        outputPath,
        command: commandString("pdftotext", args),
        toolVersions: { pdftotext: version },
      };
      if (outputPath) await writeJson(backend, sidecarPath(outputPath), metadata, signal);

      if (outputPath) {
        return {
          content: [{ type: "text", text: `Extracted PDF text from ${pdfPath}\n→ ${outputPath}` }],
          details: { ...metadata, metadataPath: sidecarPath(outputPath) },
        };
      }

      const limit = params.maxChars ?? DEFAULT_MAX_TEXT_CHARS;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error("maxChars must be a positive integer.");
      }
      const text = result.stdout;
      const locallyTruncated = text.length > limit;
      const supervisorTruncated = result.stdoutTruncated === true;
      const notices = [
        locallyTruncated ? `truncated to ${limit} chars` : undefined,
        supervisorTruncated
          ? `AgentSH truncated command stdout${result.stdoutTotalBytes ? ` from ${result.stdoutTotalBytes} bytes` : ""}`
          : undefined,
      ].filter(Boolean);
      return {
        content: [
          {
            type: "text",
            text: notices.length > 0
              ? text.slice(0, limit) + `\n\n[${notices.join("; ")}]`
              : text,
          },
        ],
        details: {
          ...metadata,
          length: text.length,
          truncated: locallyTruncated || supervisorTruncated,
          supervisorStdoutTruncated: supervisorTruncated,
          supervisorStdoutTotalBytes: result.stdoutTotalBytes,
        },
      };
    },
  });

  pi.registerTool({
    name: "pdf_extract_images",
    label: "Extract PDF Images",
    description:
      "Extract embedded bitmap images from a PDF in the active local or AgentSH workspace using Poppler pdfimages. This complements page rendering and is useful when figures are embedded raster assets.",
    parameters: Type.Object({
      pdfPath: Type.String({ description: "Path to the PDF file in the active workspace" }),
      outputDir: Type.String({ description: "Directory where extracted images and sidecar metadata will be written" }),
      pages: Type.Optional(Type.String({ description: "Optional pages to extract, e.g. '1', '1-3', or '1,3,5-7'. pdfimages receives the min/max range." })),
      prefix: Type.Optional(Type.String({ description: "Optional filename prefix (default: PDF basename + '-image')" })),
      format: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("png"), Type.Literal("native")], {
          description: "Extraction format: all preserves native where possible, png converts to PNG, native uses pdfimages defaults (default: all)",
        }),
      ),
      overwrite: Type.Optional(Type.Boolean({ description: "Allow outputs with the same prefix to already exist (default: false)" })),
      timeoutMs: Type.Optional(Type.Number({ description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})` })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const backend = createPdfBackend(ctx.cwd, toolCallId, "pdf_extract_images");
      const pdfPath = backend.resolvePath(params.pdfPath, "pdfPath");
      const outputDir = backend.resolvePath(params.outputDir, "outputDir");
      await backend.requireReadableFile(pdfPath, "pdfPath", signal);
      await backend.mkdir(outputDir, signal);

      const prefix = params.prefix
        ? sanitizeName(params.prefix)
        : `${sanitizeName(basename(pdfPath))}-image`;
      const outputPrefix = join(outputDir, prefix);
      if (!params.overwrite) {
        const existing = (await backend.readdir(outputDir, signal)).filter((entry) => entry.startsWith(`${prefix}-`));
        if (existing.length > 0) {
          throw new Error(`Output files with prefix ${prefix}- already exist in ${outputDir}. Set overwrite=true or choose a different prefix.`);
        }
      }

      let selectedPages: number[] | undefined;
      if (params.pages) {
        const info = await backend.exec("pdfinfo", [pdfPath], { signal, timeoutMs: params.timeoutMs });
        const parsedInfo = parsePdfInfo(info.stdout);
        selectedPages = parsePageSpec(params.pages, typeof parsedInfo.pages === "number" ? parsedInfo.pages : undefined);
      }

      const before = new Set(await backend.readdir(outputDir, signal));
      const args: string[] = [];
      if (selectedPages && selectedPages.length > 0) {
        args.push("-f", String(Math.min(...selectedPages)), "-l", String(Math.max(...selectedPages)));
      }
      const format = params.format ?? "all";
      if (format === "all") args.push("-all");
      if (format === "png") args.push("-png");
      args.push(pdfPath, outputPrefix);
      await backend.exec("pdfimages", args, { signal, timeoutMs: params.timeoutMs });
      const after = await backend.readdir(outputDir, signal);
      const generatedNames = after
        .filter((entry) => entry.startsWith(`${prefix}-`) && (params.overwrite || !before.has(entry)))
        .sort();
      const version = await getPopplerVersion(backend, "pdfimages", signal);
      const imageMagickVersion = await getImageMagickVersion(backend, signal);
      const images: Array<Record<string, unknown>> = [];
      for (const name of generatedNames) {
        const imagePath = join(outputDir, name);
        let dimensions: { width: number; height: number } | undefined;
        try {
          dimensions = await getImageDimensions(backend, imagePath, signal);
        } catch (error) {
          if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
          dimensions = undefined;
        }
        images.push({ imagePath, dimensions, format: extname(imagePath).replace(/^\./, "") || undefined });
      }
      const metadata = {
        kind: "pdf-extracted-images",
        sourcePdf: pdfPath,
        pages: selectedPages,
        outputDir,
        prefix,
        format,
        images,
        command: commandString("pdfimages", args),
        toolVersions: { pdfimages: version, imagemagick: imageMagickVersion },
      };
      const metadataPath = join(outputDir, `${prefix}.images.json`);
      await writeJson(backend, metadataPath, metadata, signal);

      return {
        content: [
          {
            type: "text",
            text: `Extracted ${images.length} embedded image(s) from ${pdfPath}\nOutput directory: ${outputDir}\nMetadata: ${metadataPath}`,
          },
        ],
        details: { ...metadata, metadataPath },
      };
    },
  });
}

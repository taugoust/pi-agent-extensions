/**
 * PDF Inspection Tool Extension
 *
 * Provides local, Nix-friendly PDF inspection tools beyond plain text
 * extraction: document metadata, page rendering, image cropping, text
 * extraction, and embedded image extraction.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RENDER_DPI = 150;
const DEFAULT_MAX_TEXT_CHARS = 100 * 1024;
const DEFAULT_MAX_ATTACH_BYTES = 4 * 1024 * 1024;
const NIX_HINT =
  "Install tools with Nix, for example: nix shell nixpkgs#poppler_utils nixpkgs#imagemagick";

type ToolOutputContent = Array<Record<string, unknown>>;

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isUrlLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function resolveLocalPath(cwd: string, inputPath: string, label: string): string {
  if (!inputPath || inputPath.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  if (isUrlLike(inputPath)) {
    throw new Error(`${label} must be a local file path, not a URL: ${inputPath}`);
  }
  return resolve(cwd, inputPath);
}

async function requireReadableFile(path: string, label: string): Promise<void> {
  try {
    await access(path, fsConstants.R_OK);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not a file")) throw error;
    throw new Error(`${label} is not readable: ${path}`);
  }
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

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function commandString(command: string, args: string[]): string {
  return [command, ...args.map(shellQuote)].join(" ");
}

function execFileAsync(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number; cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & {
            code?: string | number;
            killed?: boolean;
            signal?: string;
          };
          if (err.code === "ENOENT") {
            reject(
              new Error(
                `Missing required command: ${command}. ${NIX_HINT}`,
              ),
            );
            return;
          }
          const message = [
            `Command failed: ${commandString(command, args)}`,
            err.signal ? `Signal: ${err.signal}` : undefined,
            err.killed ? "Process was killed or timed out." : undefined,
            stderr ? `stderr:\n${stderr.trim()}` : undefined,
            stdout ? `stdout:\n${stdout.trim()}` : undefined,
          ]
            .filter(Boolean)
            .join("\n");
          reject(new Error(message));
          return;
        }
        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function getImageDimensions(
  imagePath: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
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
  content: ToolOutputContent,
  imagePath: string,
  attach: boolean | undefined,
  maxBytes: number | undefined,
): Promise<{ attached: boolean; skippedReason?: string }> {
  if (!attach) return { attached: false };
  const limit = maxBytes ?? DEFAULT_MAX_ATTACH_BYTES;
  const info = await stat(imagePath);
  if (info.size > limit) {
    return {
      attached: false,
      skippedReason: `Image is ${info.size} bytes, larger than maxAttachBytes=${limit}.`,
    };
  }
  const data = await readFile(imagePath, "base64");
  content.push({
    type: "image",
    mimeType: mimeTypeForPath(imagePath),
    data,
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

async function getPopplerVersion(command: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const { stderr, stdout } = await execFileAsync(command, ["-v"], {
      signal,
      timeoutMs: 10_000,
    });
    return (stderr || stdout).trim().split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

async function getImageMagickVersion(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("magick", ["-version"], {
      signal,
      timeoutMs: 10_000,
    });
    return stdout.trim().split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

export default function pdfExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pdf_info",
    label: "PDF Info",
    description:
      "Inspect a local PDF's metadata and page information using Nix-packaged Poppler tools.",
    parameters: Type.Object({
      pdfPath: Type.String({ description: "Local path to the PDF file" }),
      timeoutMs: Type.Optional(
        Type.Number({ description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})` }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pdfPath = resolveLocalPath(ctx.cwd, params.pdfPath, "pdfPath");
      await requireReadableFile(pdfPath, "pdfPath");

      const { stdout } = await execFileAsync("pdfinfo", [pdfPath], {
        signal,
        timeoutMs: params.timeoutMs,
      });
      const parsed = parsePdfInfo(stdout);
      const version = await getPopplerVersion("pdfinfo", signal);
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
      "Render selected local PDF pages to PNG images for visual inspection. Writes only to the requested output directory and records JSON sidecars.",
    parameters: Type.Object({
      pdfPath: Type.String({ description: "Local path to the PDF file" }),
      pages: Type.String({ description: "Pages to render, e.g. '1', '1-3', or '1,3,5-7'" }),
      outputDir: Type.String({ description: "Directory where rendered page images and sidecars will be written" }),
      dpi: Type.Optional(Type.Number({ description: `Render DPI (default: ${DEFAULT_RENDER_DPI})` })),
      prefix: Type.Optional(Type.String({ description: "Optional filename prefix (default: PDF basename)" })),
      attachImages: Type.Optional(Type.Boolean({ description: "Return rendered images directly to the LLM when they are small enough" })),
      maxAttachBytes: Type.Optional(Type.Number({ description: `Maximum bytes per attached image (default: ${DEFAULT_MAX_ATTACH_BYTES})` })),
      overwrite: Type.Optional(Type.Boolean({ description: "Overwrite existing output files (default: false)" })),
      timeoutMs: Type.Optional(Type.Number({ description: `Timeout per page in milliseconds (default: ${DEFAULT_TIMEOUT_MS})` })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const pdfPath = resolveLocalPath(ctx.cwd, params.pdfPath, "pdfPath");
      const outputDir = resolveLocalPath(ctx.cwd, params.outputDir, "outputDir");
      await requireReadableFile(pdfPath, "pdfPath");
      await mkdir(outputDir, { recursive: true });

      const info = await execFileAsync("pdfinfo", [pdfPath], {
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
      const pdftoppmVersion = await getPopplerVersion("pdftoppm", signal);
      const imageMagickVersion = await getImageMagickVersion(signal);

      for (const page of pages) {
        const outputBase = join(outputDir, `${prefix}-page-${padPage(page)}`);
        const outputPath = `${outputBase}.png`;
        const metadataPath = sidecarPath(outputPath);
        if (!params.overwrite) {
          try {
            await access(outputPath, fsConstants.F_OK);
            throw new Error(`Output already exists: ${outputPath}. Set overwrite=true to replace it.`);
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("Output already exists")) throw error;
          }
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
        await execFileAsync("pdftoppm", args, {
          signal,
          timeoutMs: params.timeoutMs,
        });
        const dimensions = await getImageDimensions(outputPath, signal);
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
        await writeJson(metadataPath, metadata);
        const attachment = await maybeAttachImage(
          content,
          outputPath,
          params.attachImages,
          params.maxAttachBytes,
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
      "Crop a rectangular pixel region from a rendered PDF page or other local image. Writes a normal image plus a JSON sidecar.",
    parameters: Type.Object({
      sourceImagePath: Type.String({ description: "Local path to the source image" }),
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sourceImagePath = resolveLocalPath(ctx.cwd, params.sourceImagePath, "sourceImagePath");
      await requireReadableFile(sourceImagePath, "sourceImagePath");
      const crop = params.crop as CropRect;
      for (const [key, value] of Object.entries(crop)) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`crop.${key} must be a non-negative number.`);
      }
      if (crop.width <= 0 || crop.height <= 0) {
        throw new Error("crop.width and crop.height must be positive.");
      }

      const label = sanitizeName(params.label ?? "crop");
      const outputPath = params.outputPath
        ? resolveLocalPath(ctx.cwd, params.outputPath, "outputPath")
        : params.outputDir
          ? join(
              resolveLocalPath(ctx.cwd, params.outputDir, "outputDir"),
              `${sanitizeName(basename(sourceImagePath))}-${label}.png`,
            )
          : undefined;
      if (!outputPath) throw new Error("Either outputPath or outputDir is required.");
      await mkdir(dirname(outputPath), { recursive: true });
      if (!params.overwrite) {
        try {
          await access(outputPath, fsConstants.F_OK);
          throw new Error(`Output already exists: ${outputPath}. Set overwrite=true to replace it.`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Output already exists")) throw error;
        }
      }

      const sourceDimensions = await getImageDimensions(sourceImagePath, signal);
      if (crop.x + crop.width > sourceDimensions.width || crop.y + crop.height > sourceDimensions.height) {
        throw new Error(
          `Crop rectangle ${crop.width}x${crop.height}+${crop.x}+${crop.y} exceeds source dimensions ${sourceDimensions.width}x${sourceDimensions.height}.`,
        );
      }

      const geometry = `${Math.round(crop.width)}x${Math.round(crop.height)}+${Math.round(crop.x)}+${Math.round(crop.y)}`;
      const args = [sourceImagePath, "-crop", geometry, "+repage", outputPath];
      await execFileAsync("magick", args, { signal, timeoutMs: params.timeoutMs });
      const dimensions = await getImageDimensions(outputPath, signal);
      const imageMagickVersion = await getImageMagickVersion(signal);
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
      await writeJson(metadataPath, metadata);

      const content: ToolOutputContent = [
        {
          type: "text",
          text: `Cropped ${sourceImagePath}\n→ ${outputPath} (${dimensions.width}×${dimensions.height})\nCrop: ${geometry}`,
        },
      ];
      const attachment = await maybeAttachImage(content, outputPath, params.attachImage, params.maxAttachBytes);

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
      "Extract text from selected pages of a local PDF using Poppler pdftotext. Supports plain, layout-preserving, raw, and bbox modes.",
    parameters: Type.Object({
      pdfPath: Type.String({ description: "Local path to the PDF file" }),
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pdfPath = resolveLocalPath(ctx.cwd, params.pdfPath, "pdfPath");
      await requireReadableFile(pdfPath, "pdfPath");
      const outputPath = params.outputPath ? resolveLocalPath(ctx.cwd, params.outputPath, "outputPath") : undefined;
      if (outputPath) await mkdir(dirname(outputPath), { recursive: true });

      let selectedPages: number[] | undefined;
      if (params.pages) {
        const info = await execFileAsync("pdfinfo", [pdfPath], { signal, timeoutMs: params.timeoutMs });
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

      const result = await execFileAsync("pdftotext", args, {
        signal,
        timeoutMs: params.timeoutMs,
      });
      const version = await getPopplerVersion("pdftotext", signal);
      const metadata = {
        kind: "pdf-extracted-text",
        sourcePdf: pdfPath,
        pages: selectedPages,
        mode,
        outputPath,
        command: commandString("pdftotext", args),
        toolVersions: { pdftotext: version },
      };
      if (outputPath) await writeJson(sidecarPath(outputPath), metadata);

      if (outputPath) {
        return {
          content: [{ type: "text", text: `Extracted PDF text from ${pdfPath}\n→ ${outputPath}` }],
          details: { ...metadata, metadataPath: sidecarPath(outputPath) },
        };
      }

      const limit = params.maxChars ?? DEFAULT_MAX_TEXT_CHARS;
      const text = result.stdout;
      const truncated = text.length > limit;
      return {
        content: [
          {
            type: "text",
            text: truncated ? text.slice(0, limit) + `\n\n[truncated to ${limit} chars]` : text,
          },
        ],
        details: { ...metadata, length: text.length, truncated },
      };
    },
  });

  pi.registerTool({
    name: "pdf_extract_images",
    label: "Extract PDF Images",
    description:
      "Extract embedded bitmap images from a local PDF using Poppler pdfimages. This complements page rendering and is useful when figures are embedded raster assets.",
    parameters: Type.Object({
      pdfPath: Type.String({ description: "Local path to the PDF file" }),
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pdfPath = resolveLocalPath(ctx.cwd, params.pdfPath, "pdfPath");
      const outputDir = resolveLocalPath(ctx.cwd, params.outputDir, "outputDir");
      await requireReadableFile(pdfPath, "pdfPath");
      await mkdir(outputDir, { recursive: true });

      const prefix = sanitizeName(params.prefix ?? `${basename(pdfPath)}-image`);
      const outputPrefix = join(outputDir, prefix);
      if (!params.overwrite) {
        const existing = (await readdir(outputDir)).filter((entry) => entry.startsWith(`${prefix}-`));
        if (existing.length > 0) {
          throw new Error(`Output files with prefix ${prefix}- already exist in ${outputDir}. Set overwrite=true or choose a different prefix.`);
        }
      }

      let selectedPages: number[] | undefined;
      if (params.pages) {
        const info = await execFileAsync("pdfinfo", [pdfPath], { signal, timeoutMs: params.timeoutMs });
        const parsedInfo = parsePdfInfo(info.stdout);
        selectedPages = parsePageSpec(params.pages, typeof parsedInfo.pages === "number" ? parsedInfo.pages : undefined);
      }

      const before = new Set(await readdir(outputDir));
      const args: string[] = [];
      if (selectedPages && selectedPages.length > 0) {
        args.push("-f", String(Math.min(...selectedPages)), "-l", String(Math.max(...selectedPages)));
      }
      const format = params.format ?? "all";
      if (format === "all") args.push("-all");
      if (format === "png") args.push("-png");
      args.push(pdfPath, outputPrefix);
      await execFileAsync("pdfimages", args, { signal, timeoutMs: params.timeoutMs });
      const after = await readdir(outputDir);
      const generatedNames = after
        .filter((entry) => entry.startsWith(`${prefix}-`) && (params.overwrite || !before.has(entry)))
        .sort();
      const version = await getPopplerVersion("pdfimages", signal);
      const imageMagickVersion = await getImageMagickVersion(signal);
      const images: Array<Record<string, unknown>> = [];
      for (const name of generatedNames) {
        const imagePath = join(outputDir, name);
        let dimensions: { width: number; height: number } | undefined;
        try {
          dimensions = await getImageDimensions(imagePath, signal);
        } catch {
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
      await writeJson(metadataPath, metadata);

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

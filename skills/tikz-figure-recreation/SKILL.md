---
name: tikz-figure-recreation
description: Recreate existing paper figures, PDF/image figures, draw.io diagrams, or architecture diagrams as TikZ/LaTeX. Use when the user asks to convert, recreate, trace, port, or redraw a figure in TikZ, especially from a paper PDF, screenshot, PNG/SVG/PDF, or .drawio source, and wants iterative compile-render-inspect refinement.
---

# TikZ Figure Recreation

Use this skill to reconstruct an existing figure as maintainable TikZ/LaTeX, iterating visually until it matches the source closely enough for paper use.

## Core principle

Treat this as **visual reconstruction and typography/layout work**, not generic diagram generation. Visual fidelity matters more than clever abstractions. Explicit coordinates and hand-routed arrows are acceptable when they produce a faithful paper figure.

## Inputs to identify

Before editing, identify as many of these as possible:

- Source figure artifact: paper PDF, standalone figure PDF/PNG/SVG, screenshot, or `.drawio`.
- Figure number/caption/page if the source is a paper PDF.
- Target location: existing paper figure path, desired `figures/<name>.tikz`, or section where it should be included.
- Project build environment: Nix flake, Makefile, latexmk, tectonic, or existing CI command.

Do not ask questions if the user already gave enough information to proceed. If the target figure or output location is genuinely ambiguous, ask briefly.

## Recommended workflow

### 1. Inspect project conventions

- Check existing figure naming, LaTeX preamble, TikZ usage, and build commands.
- If there is a project flake or dev shell, prefer it for full paper builds.
- For ad-hoc standalone TikZ compilation, `tectonic` is usually robust:

```bash
nix run nixpkgs#tectonic -- -X compile figures/<name>-standalone.tex --outdir figures
```

For quick Python/XML inspection, prefer:

```bash
nix run nixpkgs#python312 -- - <<'PY'
print('ok')
PY
```

### 2. Render and crop the reference

For a paper PDF:

1. Use `pdf_info` to get page count and size.
2. Use `pdf_extract_text` to find the figure caption/page if needed.
3. Use `pdf_render_pages` at 200-300 DPI on the relevant page.
4. Use `pdf_crop_image` to create a tight crop of the target figure.
5. Create additional local crops for tricky subregions (arrows, labels, legends, dense hardware blocks).

Keep reference artifacts under `.build/<figure-name>/` or another build scratch directory.

### 3. Inspect auxiliary sources if available

If a `.drawio` source is provided:

- Parse its pages, labels, colors, and coordinates using Python XML tools.
- Use page names and cell labels to locate the relevant diagram.
- Treat draw.io coordinates as layout hints, not as a mandatory conversion.
- Do not blindly translate draw.io XML to TikZ if it would produce messy or unmaintainable output.

Useful pattern:

```bash
nix run nixpkgs#python312 -- - <<'PY'
import xml.etree.ElementTree as ET, html, re
root = ET.parse('path/to/file.drawio').getroot()
for i, d in enumerate(root.findall('diagram'), 1):
    mg = d.find('mxGraphModel')
    cells = list(mg.find('root')) if mg is not None else []
    labels = []
    for c in cells:
        v = c.get('value')
        if v:
            t = html.unescape(re.sub('<[^>]*>', ' ', v))
            t = ' '.join(t.split())
            if t:
                labels.append(t)
    print(i, d.get('name'), 'cells=', len(cells), 'labels=', labels[:20])
PY
```

### 4. Create TikZ source and standalone wrapper

Prefer two files:

- `figures/<name>.tikz` — bare `tikzpicture` suitable for `\input{}`.
- `figures/<name>-standalone.tex` — wrapper for compile/render inspection.

Example wrapper:

```tex
\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{xcolor}
\usepackage{tikz}
\usetikzlibrary{arrows.meta,calc,positioning}
\usepackage[active,tightpage]{preview}
\PreviewEnvironment{tikzpicture}
\setlength\PreviewBorder{1pt}
\begin{document}
\input{<name>.tikz}
\end{document}
```

In the project paper, add only the needed packages/libraries to the main preamble.

### 5. Build, render, inspect, iterate

After each meaningful edit:

1. Compile the standalone PDF.
2. Render it to PNG with `pdf_render_pages`.
3. Visually compare the generated render with the original crop.
4. Crop subregions when details are hard to judge.
5. Iterate in small passes: containers, labels, colors, arrows, then fine alignment.

Always inspect the generated result. Do not rely on LaTeX compilation success alone.

## TikZ reconstruction guidelines

### Coordinate system

For faithful reconstruction, use a direct coordinate system and explicit dimensions:

```tex
\begin{tikzpicture}[
  x=1pt,y=-1pt,scale=<scale>,transform shape,
  font=\fontsize{6.5}{7.2}\selectfont\sffamily,
  >=Latex,
  line cap=round,
  line join=round,
  ... styles ...
]
```

This makes it easy to reason from pixel-like positions in rendered crops. Use `y=-1pt` when matching screen/PDF coordinates from top to bottom.

### Structure the TikZ file

Organize the source in drawing order:

1. Style definitions.
2. Helper macros only if they reduce repetition without hiding geometry.
3. Background containers and lanes.
4. Nodes/labels.
5. Data/control/program paths.
6. Legends and captions/annotations inside the figure.

Prefer named styles for colors and arrows:

```tex
data/.style={blue!90!black,line width=0.55pt,-{Latex[length=3.2pt,width=2.9pt]}},
ctrl/.style={red!90!black,line width=0.55pt,-{Latex[length=3.2pt,width=2.9pt]}},
prog/.style={black,line width=0.55pt,-{Latex[length=3.4pt,width=3pt]}},
```

### Match visual semantics

- Use the same text, capitalization, math subscripts, and line breaks as the original unless adapting intentionally.
- Match fills and strokes approximately; exact RGB is less important than perceived similarity.
- Match font family and relative sizes. Paper figures often use small sans-serif labels even in serif papers.
- Use dotted/dashed boundaries exactly where they carry meaning.

### Arrows and paths

Arrows are usually the most important and most fragile part.

- Hand-route arrows with explicit coordinates; do not expect automatic routing to match a paper figure.
- For fanouts, draw separate rails and drops instead of one ambiguous polyline.
- For short arrows in gaps, draw separate short segments. Do **not** draw a continuous bus if the original shows individual gap arrows.
- For short bidirectional lanes, use adjacent up/down arrows, not overlapping opposing arrows.
- Tune arrowhead sizes for the available gap. Large arrowheads clutter short lanes; tiny arrowheads disappear.
- If arrowheads look wrong, crop just that subregion and compare against the reference.

### Common pitfalls

- Continuous line where the source has separate short arrows.
- Overlapping bidirectional arrows that look like a blob.
- Boundary labels not centered vertically between regions.
- Figure-level scaling that makes fonts too large/small relative to boxes.
- Including caption text inside the TikZ when the paper should provide the caption.
- Blindly converting draw.io coordinates without checking the rendered result.

## Including the result in a paper

For a single-column figure:

```tex
\begin{figure}[t]
  \centering
  \resizebox{\columnwidth}{!}{\input{figures/<name>.tikz}}
  \caption{...}
  \label{fig:<name>}
\end{figure}
```

For a two-column figure:

```tex
\begin{figure*}[t]
  \centering
  \resizebox{0.96\textwidth}{!}{\input{figures/<name>.tikz}}
  \caption{...}
  \label{fig:<name>}
\end{figure*}
```

Ensure the main preamble includes the required packages/libraries:

```tex
\usepackage{xcolor}
\usepackage{tikz}
\usetikzlibrary{arrows.meta,calc,positioning}
```

Only include libraries actually used.

## Deliverables

Unless the user requests otherwise, produce:

- `figures/<name>.tikz` — source to include.
- `figures/<name>-standalone.tex` — preview harness.
- `figures/<name>-standalone.pdf` — compiled preview.
- Optional `figures/<name>.png` — rendered preview for quick inspection.
- Brief final note with files changed and build command used.

## Quality checklist

Before final response:

- [ ] Source figure was rendered/cropped and visually inspected.
- [ ] Generated TikZ was compiled successfully.
- [ ] Generated PDF was rendered to PNG and inspected.
- [ ] At least one comparison pass checked geometry, labels, colors, and arrows.
- [ ] The bare `.tikz` file can be `\input{}` from the paper.
- [ ] The standalone wrapper still builds.
- [ ] Any paper preamble changes are minimal and necessary.

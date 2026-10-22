#!/usr/bin/env python3
"""Make printable "put the blocks in order" worksheets from finished Scratch apps.

For each app (a .sb3 file, or a folder containing project.json), every script is
split into single blocks: each block is disconnected from the blocks before and
after it, C-blocks are emptied, and reporters (such as variables) are taken out
of the inputs they were dropped into. Values typed into blocks are kept. The
blocks are shuffled, but each sprite's blocks stay together under its name and
picture. The result is a PDF with a title, short instructions and the blocks.

    python3 worksheet.py                       # every app in apps/
    python3 worksheet.py "apps/Random Walk.sb3" --seed 7

To set the title and instructions, put a Markdown file named after the app beside
it, e.g. "apps/Random Walk.md" for "apps/Random Walk.sb3" or the "apps/Spinning
Tree" folder. Its first "# " heading is the title, and the rest is the
instructions (paragraphs, "-" or "1." lists, **bold**, *italic*, ## headings).

Blocks are drawn by Scratch's own block library (scratch-blocks, in vendor/)
running in headless Chromium, then made print-friendly by scratch2svg.py.
"""

import argparse
import base64
import functools
import html
import http.server
import json
import random
import re
import subprocess
import sys
import threading
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

import scratch2svg

HERE = Path(__file__).resolve().parent
BUILD_DIR = HERE / "build"
RENDERER = "renderer/render.html"
CHROMIUM = "chromium"

DEFAULT_INSTRUCTIONS = (
    "Cut out the blocks. Then put them together in the right order to make the program."
)
DEFAULT_INSTRUCTIONS_SPRITES = (
    " The blocks for each sprite are grouped together under its name."
)

# Compressed inputs in project.json: [type, value, ...] -> (block type, field name).
PRIMITIVES = {
    4: ("math_number", "NUM"),
    5: ("math_positive_number", "NUM"),
    6: ("math_whole_number", "NUM"),
    7: ("math_integer", "NUM"),
    8: ("math_angle", "NUM"),
    9: ("colour_picker", "COLOUR"),
    10: ("text", "TEXT"),
    11: ("event_broadcast_menu", "BROADCAST_OPTION"),
    12: ("data_variable", "VARIABLE"),
    13: ("data_listcontents", "LIST"),
}
VARIABLE_TYPES = {11: "broadcast_msg", 12: "", 13: "list"}
# Reporters that can be dropped into an input, and so become separate blocks.
REPORTER_PRIMITIVES = {12, 13}

# Field names that refer to variables, lists or broadcasts, and their variable type.
VARIABLE_FIELDS = {"VARIABLE": "", "LIST": "list", "BROADCAST_OPTION": "broadcast_msg"}

# Block sizes to try, largest first, when fitting a worksheet onto one page.
AUTO_SCALES = [1.25, 1.15, 1.05, 1.0, 0.95, 0.9, 0.85, 0.8]

STATEMENT_INPUTS ={"SUBSTACK", "SUBSTACK2", "custom_block"}

# Menus whose options the Scratch editor fills in from the project, and which field
# holds the chosen value.
MENU_FIELDS = {
    "motion_goto_menu": "TO",
    "motion_glideto_menu": "TO",
    "motion_pointtowards_menu": "TOWARDS",
    "looks_costume": "COSTUME",
    "looks_backdrops": "BACKDROP",
    "sound_sounds_menu": "SOUND_MENU",
    "control_create_clone_of_menu": "CLONE_OPTION",
    "sensing_touchingobjectmenu": "TOUCHINGOBJECTMENU",
    "sensing_distancetomenu": "DISTANCETOMENU",
    "sensing_of_object_menu": "OBJECT",
    "pen_menu_colorParam": "colorParam",
    "event_whenbackdropswitchesto": "BACKDROP",
    "sensing_of": "PROPERTY",
}
# How special menu values are shown in Scratch.
MENU_LABELS = {
    "_random_": "random position",
    "_mouse_": "mouse-pointer",
    "_myself_": "myself",
    "_stage_": "Stage",
    "_edge_": "edge",
}
MENU_LABELS_BY_TYPE = {
    ("motion_pointtowards_menu", "_random_"): "random direction",
}


# --- Reading apps ------------------------------------------------------------


class App:
    """A Scratch project read from a .sb3 file or a folder containing project.json."""

    def __init__(self, path):
        self.path = path
        self.name = path.stem if path.is_file() else path.name
        if path.is_file():
            self.archive = zipfile.ZipFile(path)
            self.prefix = self.archive_prefix()
            self.project = json.loads(self.archive.read(self.prefix + "project.json"))
        else:
            self.archive = None
            self.project = json.loads((path / "project.json").read_text(encoding="utf-8"))
        # Optional title and instructions, e.g. "Random Walk.md" beside "Random Walk.sb3".
        self.notes_path = path.parent / f"{self.name}.md"

    def archive_prefix(self):
        """Folder holding project.json in the zip: "" for files saved by Scratch, or e.g.
        "Spinning Tree/" when a project folder was zipped up."""
        names = [n for n in self.archive.namelist() if n.rsplit("/", 1)[-1] == "project.json"]
        if not names:
            raise ValueError("no project.json in the archive")
        return min(names, key=len)[: -len("project.json")]

    def asset(self, filename):
        if self.archive:
            return self.archive.read(self.prefix + filename)
        return (self.path / filename).read_bytes()

    def costume_data_uri(self, target):
        costumes = target.get("costumes") or []
        if not costumes:
            return None
        costume = costumes[min(target.get("currentCostume", 0), len(costumes) - 1)]
        filename = costume.get("md5ext") or f"{costume['assetId']}.{costume['dataFormat']}"
        mime = {"svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg"}.get(
            costume.get("dataFormat"), "application/octet-stream"
        )
        try:
            data = self.asset(filename)
        except (KeyError, OSError):
            return None
        return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def sections(project):
    """Targets that have blocks: the stage first, then sprites in layer order."""
    targets = [t for t in project["targets"] if t.get("blocks")]
    return sorted(targets, key=lambda t: (not t.get("isStage"), t.get("layerOrder", 0)))


def project_variables(project):
    """Every variable, list and broadcast in the project, for the renderer's workspace."""
    found = {}
    for target in project["targets"]:
        for kind, variable_type in (("variables", ""), ("lists", "list")):
            for variable_id, value in target.get(kind, {}).items():
                found[variable_id] = {"id": variable_id, "name": value[0], "type": variable_type}
        for variable_id, name in target.get("broadcasts", {}).items():
            found[variable_id] = {"id": variable_id, "name": name, "type": "broadcast_msg"}
    return list(found.values())


# --- Splitting scripts into single blocks -------------------------------------


def menu_label(block_type, value):
    return MENU_LABELS_BY_TYPE.get((block_type, value)) or MENU_LABELS.get(value, value)


class Splitter:
    """Turns one target's blocks into separate Blockly XML snippets, one per block."""

    def __init__(self, blocks, menus):
        self.blocks = blocks
        self.menus = menus  # block type -> {value: label}, shared across the project

    def split(self):
        """Return a list of XML strings, one per non-shadow block, all disconnected."""
        pieces = []
        for block_id, block in self.blocks.items():
            if isinstance(block, list):
                pieces.append(self.primitive_xml(block, "block"))
            elif not block.get("shadow"):
                pieces.append(self.block_xml(block_id))
                # Variables and lists dropped straight into an input are stored inline.
                for value in block.get("inputs", {}).values():
                    slot = value[1] if len(value) > 1 else None
                    if isinstance(slot, list) and slot and slot[0] in REPORTER_PRIMITIVES:
                        pieces.append(self.primitive_xml(slot, "block"))
        return pieces

    def primitive_xml(self, primitive, tag):
        kind, value = primitive[0], primitive[1]
        block_type, field = PRIMITIVES[kind]
        attributes = ""
        if kind in VARIABLE_TYPES:
            attributes = f" id={quoteattr(primitive[2])} variabletype={quoteattr(VARIABLE_TYPES[kind])}"
        return (
            f'<{tag} type="{block_type}"><field name="{field}"{attributes}>'
            f"{escape(str(value))}</field></{tag}>"
        )

    def block_xml(self, block_id):
        block = self.blocks[block_id]
        tag = "shadow" if block.get("shadow") else "block"
        parts = [f'<{tag} type={quoteattr(block["opcode"])}>']
        parts.append(self.mutation_xml(block.get("mutation")))
        for name, field in block.get("fields", {}).items():
            parts.append(self.field_xml(block["opcode"], name, field))
        for name, value in block.get("inputs", {}).items():
            shadow = self.input_shadow(value)
            if shadow is None:
                continue  # empty, or only held a block that is now separate
            element = "statement" if name in STATEMENT_INPUTS else "value"
            parts.append(f"<{element} name={quoteattr(name)}>{shadow}</{element}>")
        parts.append(f"</{tag}>")
        return "".join(parts)

    def input_shadow(self, value):
        """XML for the shadow left in an input once any dropped-in block is removed."""
        kind = value[0]
        if kind == 1:
            shadow = value[1]
        elif kind == 3:
            shadow = value[2] if len(value) > 2 else None
        else:
            # kind 2: a block with no shadow behind it, unless the block itself is a shadow
            shadow = value[1] if isinstance(value[1], str) and self.is_shadow(value[1]) else None
        if shadow is None:
            return None
        if isinstance(shadow, list):
            return self.primitive_xml(shadow, "shadow")
        return self.block_xml(shadow)

    def is_shadow(self, block_id):
        block = self.blocks.get(block_id)
        return isinstance(block, dict) and block.get("shadow")

    def field_xml(self, block_type, name, field):
        value, field_id = field[0], field[1] if len(field) > 1 else None
        attributes = ""
        if field_id is not None and name in VARIABLE_FIELDS:
            attributes = f" id={quoteattr(field_id)} variabletype={quoteattr(VARIABLE_FIELDS[name])}"
        if MENU_FIELDS.get(block_type) == name:
            self.menus.setdefault(block_type, {})[str(value)] = menu_label(block_type, str(value))
        return f"<field name={quoteattr(name)}{attributes}>{escape(str(value))}</field>"

    @staticmethod
    def mutation_xml(mutation):
        if not mutation:
            return ""
        attributes = "".join(
            f" {key}={quoteattr(str(value))}"
            for key, value in mutation.items()
            if key not in ("tagName", "children")
        )
        return f"<mutation{attributes}></mutation>"


def shuffled(items, rng):
    """Shuffle items, avoiding the original order where possible."""
    original = list(items)
    result = list(items)
    for _ in range(10):
        rng.shuffle(result)
        if result != original or len(result) < 3:
            break
    return result


# --- Rendering blocks in Chromium --------------------------------------------


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def serve(directory):
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def chromium(*args, timeout=180):
    command = [CHROMIUM, "--headless", "--disable-gpu", "--no-first-run", *args]
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout)


def render_blocks(job, job_path, server):
    """Render every block in job with scratch-blocks; return {key: svg markup}."""
    job_path.write_text(json.dumps(job), encoding="utf-8")
    port = server.server_address[1]
    job_url = "/" + job_path.relative_to(HERE).as_posix()
    url = f"http://127.0.0.1:{port}/{RENDERER}?job={job_url}"
    completed = chromium("--virtual-time-budget=60000", "--dump-dom", url)
    match = re.search(r'<textarea id="result">(.*?)</textarea>', completed.stdout, re.S)
    if not match:
        raise RuntimeError(f"renderer produced no result\n{completed.stderr[-2000:]}")
    text = html.unescape(match.group(1))
    if text == "pending":
        raise RuntimeError("renderer did not finish (is Chromium able to load the page?)")
    result = json.loads(text)
    if "fatal" in result:
        raise RuntimeError(f"renderer failed: {result['fatal']}")
    if result["errors"]:
        details = "\n".join(f"  {key}: {error}" for key, error in result["errors"].items())
        raise RuntimeError(f"some blocks could not be drawn:\n{details}")
    return result["blocks"]


def print_friendly(svg_markup, media_dir, text_colour):
    """Clean a rendered block with scratch2svg; return inline <svg> markup and its size."""
    [(_, block)] = scratch2svg.parse_snippet(svg_markup, "block")
    svg = scratch2svg.convert(block, text_colour, margin=1.0, media_dir=media_dir)
    svg = svg.split("?>", 1)[1].strip()  # drop the XML declaration for inline use
    width = float(re.search(r'width="([\d.]+)"', svg).group(1))
    height = float(re.search(r'height="([\d.]+)"', svg).group(1))
    return svg, width, height


# --- Worksheet notes (title and instructions) --------------------------------


def read_notes(path):
    """Read a notes file: return (title or None, instructions HTML or None).

    The first "# " heading is the title; everything else is the instructions.
    """
    if not path.is_file():
        return None, None
    title = None
    body = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"#\s+(.*?)\s*#*\s*$", line)
        if title is None and match and not body_has_text(body):
            title = match.group(1)
        else:
            body.append(line)
    instructions = markdown_to_html("\n".join(body))
    return title, instructions or None


def body_has_text(lines):
    return any(line.strip() for line in lines)


def inline_markdown(text):
    """Escape text and apply **bold**, *italic* / _italic_ and `code`."""
    text = escape(text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*(.+?)\*\*|__(.+?)__", lambda m: f"<strong>{m.group(1) or m.group(2)}</strong>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)",
                  lambda m: f"<em>{m.group(1) or m.group(2)}</em>", text)
    return text


def markdown_to_html(text):
    """Convert simple Markdown: paragraphs, "-"/"*" and "1." lists, and ## headings."""
    html_parts = []
    paragraph_lines = []
    list_tag = None
    items = []

    def flush_paragraph():
        if paragraph_lines:
            html_parts.append(paragraph(" ".join(paragraph_lines), already_markdown=True))
            paragraph_lines.clear()

    def flush_list():
        nonlocal list_tag
        if list_tag:
            body = "".join(f"<li>{inline_markdown(item)}</li>" for item in items)
            html_parts.append(f"<{list_tag}>{body}</{list_tag}>")
            list_tag = None
            items.clear()

    for line in text.splitlines():
        stripped = line.strip()
        bullet = re.match(r"[-*+]\s+(.*)", stripped)
        numbered = re.match(r"\d+[.)]\s+(.*)", stripped)
        heading = re.match(r"#{1,6}\s+(.*?)\s*#*$", stripped)
        if not stripped:
            flush_paragraph()
            continue
        if bullet or numbered:
            tag = "ul" if bullet else "ol"
            flush_paragraph()
            if list_tag != tag:
                flush_list()
                list_tag = tag
            items.append((bullet or numbered).group(1))
        elif heading:
            flush_paragraph()
            flush_list()
            html_parts.append(f"<h3>{inline_markdown(heading.group(1))}</h3>")
        elif list_tag and line[:1].isspace():
            items[-1] += " " + stripped  # continuation of a list item
        else:
            flush_list()
            paragraph_lines.append(stripped)
    flush_paragraph()
    flush_list()
    return "\n".join(html_parts)


def paragraph(text, already_markdown=False):
    return f"<p>{inline_markdown(text) if already_markdown else escape(text)}</p>"


# --- Building the worksheet --------------------------------------------------

PAGE_STYLE = """
@page { size: A4; margin: 15mm; }
body { margin: 0; color: #000; background: #fff;
       font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
h1 { font-size: 26pt; margin: 0 0 3mm; }
.instructions { font-size: 14pt; margin: 0 0 4mm; line-height: 1.4; }
.instructions p, .instructions ul, .instructions ol { margin: 0 0 2mm; }
.instructions ul, .instructions ol { padding-left: 7mm; }
.instructions h3 { font-size: 15pt; margin: 3mm 0 1mm; }
.instructions code { font-family: inherit; font-weight: bold; }
section { margin-top: 8mm; }
h2 { display: flex; align-items: center; gap: 4mm; font-size: 17pt; margin: 0 0 4mm;
     break-after: avoid; }
h2 img { height: 18mm; width: 18mm; object-fit: contain; }
.blocks { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4.5mm 5.5mm; }
.blocks svg { display: block; break-inside: avoid; }
"""


def worksheet_html(title, instructions_html, groups, scale):
    """groups: list of (heading or None, picture data URI or None, [(svg, w, h)])."""
    parts = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        f"<title>{escape(title)}</title><style>{PAGE_STYLE}</style></head><body>",
        f"<h1>{escape(title)}</h1>",
        f"<div class='instructions'>{instructions_html}</div>",
    ]
    for heading, picture, blocks in groups:
        parts.append("<section>")
        if heading:
            image = f"<img src='{picture}' alt=''>" if picture else ""
            parts.append(f"<h2>{image}{escape(heading)}</h2>")
        parts.append("<div class='blocks'>")
        for svg, width, height in blocks:
            sized = re.sub(
                r'width="[\d.]+" height="[\d.]+"',
                f'width="{width * scale:.2f}" height="{height * scale:.2f}"',
                svg,
                count=1,
            )
            parts.append(sized)
        parts.append("</div></section>")
    parts.append("</body></html>")
    return "\n".join(parts)


def make_worksheet(app, args, server, rng):
    project = app.project
    targets = sections(project)
    if not targets:
        raise RuntimeError("the app has no blocks")

    menus = {}
    job_blocks = []
    keys_by_target = []
    for index, target in enumerate(targets):
        pieces = Splitter(target["blocks"], menus).split()
        keys = [f"{index}-{n}" for n in range(len(pieces))]
        job_blocks += [{"key": key, "xml": xml} for key, xml in zip(keys, pieces)]
        keys_by_target.append(keys)

    job = {
        "variables": project_variables(project),
        "menus": {kind: [[label, value] for value, label in values.items()] for kind, values in menus.items()},
        "blocks": job_blocks,
    }
    work_dir = BUILD_DIR / re.sub(r"[^A-Za-z0-9_-]+", "-", app.name)
    work_dir.mkdir(parents=True, exist_ok=True)
    rendered = render_blocks(job, work_dir / "job.json", server)

    show_headings = len(targets) > 1 or not targets[0].get("isStage")
    groups = []
    for target, keys in zip(targets, keys_by_target):
        blocks = [print_friendly(rendered[key], args.media_dir, args.text_colour) for key in keys]
        heading = target["name"] if show_headings else None
        picture = app.costume_data_uri(target) if show_headings else None
        groups.append((heading, picture, shuffled(blocks, rng)))

    # Title and instructions: command line first, then the app's notes file, then defaults.
    notes_title, notes_html = read_notes(app.notes_path)
    title = args.title or notes_title or app.name
    if args.instructions is not None:
        instructions_html = paragraph(args.instructions)
    elif notes_html:
        instructions_html = notes_html
    else:
        instructions_html = paragraph(
            DEFAULT_INSTRUCTIONS + (DEFAULT_INSTRUCTIONS_SPRITES if len(targets) > 1 else "")
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = args.output_dir / f"{app.name}.pdf"
    html_path = work_dir / "worksheet.html"
    # With no --scale, use the largest size that fits on one page (or the smallest size).
    scales = [args.scale] if args.scale else AUTO_SCALES
    for scale in scales:
        page = worksheet_html(title, instructions_html, groups, scale)
        html_path.write_text(page, encoding="utf-8")
        pdf_path.unlink(missing_ok=True)
        completed = chromium("--no-pdf-header-footer", f"--print-to-pdf={pdf_path}", html_path.as_uri())
        if not pdf_path.is_file():
            raise RuntimeError(f"Chromium did not write the PDF\n{completed.stderr[-2000:]}")
        if page_count(pdf_path) == 1:
            break
    return pdf_path, sum(len(blocks) for _, _, blocks in groups), scale


def page_count(pdf_path):
    return len(re.findall(rb"/Type\s*/Page\b", pdf_path.read_bytes()))


def find_apps(paths):
    apps = []
    for path in paths:
        if path.is_dir() and not (path / "project.json").is_file():
            apps += sorted(p for p in path.iterdir() if p.suffix == ".sb3" or (p / "project.json").is_file())
        else:
            apps.append(path)
    return apps


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("apps", nargs="*", type=Path, default=[HERE / "apps"],
                        help=".sb3 files, app folders, or folders of apps (default: apps/)")
    parser.add_argument("-o", "--output-dir", type=Path, default=HERE / "worksheets",
                        help="folder for the PDFs (default: %(default)s)")
    parser.add_argument("--title",
                        help="worksheet title (default: from the app's .md file, else the app's name)")
    parser.add_argument("--instructions",
                        help="instructions shown under the title (default: from the app's .md file, "
                             "else general instructions)")
    parser.add_argument("--seed", type=int, help="random seed, to get the same order again")
    parser.add_argument("--scale", type=float,
                        help="block size on the page, 1 being Scratch's size (default: the largest "
                             f"from {AUTO_SCALES[0]} down to {AUTO_SCALES[-1]} that fits on one page)")
    parser.add_argument("--text-colour", default="#000000", help="block text colour (default: %(default)s)")
    parser.add_argument("--media-dir", type=Path, default=HERE / "media",
                        help="folder of Scratch icon files (default: %(default)s)")
    args = parser.parse_args()

    # Snap-packaged Chromium can only write inside the home folder, so use absolute paths there.
    args.output_dir = args.output_dir.resolve()
    seed = args.seed if args.seed is not None else random.randrange(1_000_000)
    rng = random.Random(seed)

    apps = find_apps(args.apps)
    if not apps:
        print("no apps found", file=sys.stderr)
        return 1

    server = serve(HERE)
    failed = False
    try:
        for path in apps:
            try:
                pdf_path, count, scale = make_worksheet(App(path), args, server, rng)
            except (OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile,
                    subprocess.TimeoutExpired) as error:
                print(f"{path}: {error}", file=sys.stderr)
                failed = True
                continue
            print(f"{path} -> {pdf_path} ({count} blocks, {page_count(pdf_path)} page(s), scale {scale:g})")
    finally:
        server.shutdown()
    print(f"seed {seed} (use --seed {seed} to get the same order again)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

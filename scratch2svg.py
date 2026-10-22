#!/usr/bin/env python3
"""Convert Scratch block HTML snippets into standalone, print-friendly SVG files.

Copy a block's <g class="... blocklyBlock ..."> element from the browser's
developer tools into a .html file, then run:

    python3 scratch2svg.py move-n-steps.html when-green-flag-clicked.html

Each input produces an .svg file with the same name.

An input may instead contain a whole <g class="blocklyBlockCanvas"> (for example
the block palette). Then every block in it becomes its own .svg file, named after
the block's first class, e.g. event_whenflagclicked.svg:

    python3 scratch2svg.py -o blocks all.html

The script:

- removes the block's position on the Scratch canvas and crops to the block,
- removes hidden helper elements (connection highlights and so on),
- makes all text black (or --text-colour) so it prints clearly,
- embeds icons (green flag, dropdown arrow, repeat, rotate arrows and so on)
  from a local folder: by default the "media" folder next to this script, or
  --media-dir. The snippet only links to most of them on the Scratch website.
"""

import argparse
import base64
import math
import mimetypes
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"

FONT_FAMILY = "'Helvetica Neue', Helvetica, Arial, sans-serif"
FONT_SIZE = "12pt"
FONT_WEIGHT = "500"

# Attributes that only matter inside the Scratch editor.
DROP_ATTRIBUTES = {"id", "class", "data-id", "tabindex", "style", "alt"}

SAMPLES_PER_CURVE = 32


class SnippetParser(HTMLParser):
    """Build an ElementTree from an HTML snippet (which is often not valid XML)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = ET.Element("root")
        self.stack = [self.root]
        self.last = None

    def handle_starttag(self, tag, attrs):
        element = ET.SubElement(self.stack[-1], tag, {k: v or "" for k, v in attrs})
        self.stack.append(element)
        self.last = None

    def handle_startendtag(self, tag, attrs):
        element = ET.SubElement(self.stack[-1], tag, {k: v or "" for k, v in attrs})
        self.last = element

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                self.last = self.stack[i]
                del self.stack[i:]
                return

    def handle_data(self, data):
        if not data.strip():
            return
        if self.last is not None:
            self.last.tail = (self.last.tail or "") + data
        else:
            self.stack[-1].text = (self.stack[-1].text or "") + data


def classes(element):
    return element.get("class", "").split()


def parse_snippet(text, default_name):
    """Return a list of (name, block) pairs found in the snippet.

    If the snippet contains a <g class="blocklyBlockCanvas">, every block directly
    inside it is returned, named after its first class (e.g. event_whenflagclicked).
    Otherwise the first <g> is returned, named default_name.
    """
    parser = SnippetParser()
    parser.feed(text)
    parser.close()

    canvas = next((g for g in parser.root.iter("g") if "blocklyBlockCanvas" in classes(g)), None)
    if canvas is None:
        blocks = [child for child in parser.root if child.tag == "g"]
        if not blocks:
            raise ValueError("no <g> element found in snippet")
        return [(default_name, blocks[0])]

    found = []
    seen = {}
    for child in canvas:
        # Skip flyout labels and buttons, which are not blocks.
        if child.tag != "g" or "blocklyBlock" not in classes(child):
            continue
        name = classes(child)[0]
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:
            name = f"{name}-{seen[name]}"
        found.append((name, child))
    if not found:
        raise ValueError("no blocks found in blocklyBlockCanvas")
    return found


def is_hidden(element):
    style = element.get("style", "").replace(" ", "")
    return "display:none" in style


def remove_hidden(element):
    for child in list(element):
        if is_hidden(child):
            element.remove(child)
        else:
            remove_hidden(child)


def parse_translate(transform):
    """Return the (x, y) offset of a translate() transform; warn about anything else."""
    if not transform:
        return 0.0, 0.0
    match = re.fullmatch(r"\s*translate\(\s*([-\d.eE]+)(?:[\s,]+([-\d.eE]+))?\s*\)\s*", transform)
    if not match:
        print(f"warning: ignoring unsupported transform {transform!r} when sizing", file=sys.stderr)
        return 0.0, 0.0
    return float(match.group(1)), float(match.group(2) or 0)


def length(value):
    return float(re.sub(r"[a-z%]+$", "", value.strip())) if value else 0.0


# --- Path bounding box -------------------------------------------------------

PATH_TOKEN = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
ARG_COUNTS = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}


def cubic_points(p0, p1, p2, p3):
    for i in range(1, SAMPLES_PER_CURVE + 1):
        t = i / SAMPLES_PER_CURVE
        u = 1 - t
        yield tuple(
            u**3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t**3 * d
            for a, b, c, d in zip(p0, p1, p2, p3)
        )


def arc_points(start, rx, ry, phi_degrees, large_arc, sweep, end):
    """Sample an SVG elliptical arc (endpoint form, see SVG spec appendix F.6)."""
    (x1, y1), (x2, y2) = start, end
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0 or start == end:
        yield end
        return
    phi = math.radians(phi_degrees)
    cos_phi, sin_phi = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p = cos_phi * dx + sin_phi * dy
    y1p = -sin_phi * dx + cos_phi * dy
    scale = x1p**2 / rx**2 + y1p**2 / ry**2
    if scale > 1:
        rx, ry = rx * math.sqrt(scale), ry * math.sqrt(scale)
    numerator = rx**2 * ry**2 - rx**2 * y1p**2 - ry**2 * x1p**2
    denominator = rx**2 * y1p**2 + ry**2 * x1p**2
    coefficient = math.sqrt(max(0.0, numerator / denominator))
    if large_arc == sweep:
        coefficient = -coefficient
    cxp = coefficient * rx * y1p / ry
    cyp = -coefficient * ry * x1p / rx
    cx = cos_phi * cxp - sin_phi * cyp + (x1 + x2) / 2
    cy = sin_phi * cxp + cos_phi * cyp + (y1 + y2) / 2
    theta1 = math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
    theta2 = math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx)
    delta = theta2 - theta1
    if not sweep and delta > 0:
        delta -= 2 * math.pi
    elif sweep and delta < 0:
        delta += 2 * math.pi
    for i in range(1, SAMPLES_PER_CURVE + 1):
        t = theta1 + delta * i / SAMPLES_PER_CURVE
        yield (
            cx + rx * cos_phi * math.cos(t) - ry * sin_phi * math.sin(t),
            cy + rx * sin_phi * math.cos(t) + ry * cos_phi * math.sin(t),
        )


def path_points(d):
    """Yield points on (and closely following) the outline described by path data d."""
    tokens = PATH_TOKEN.findall(d)
    pos = (0.0, 0.0)
    subpath_start = pos
    last_control = None
    command = None
    i = 0
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
        elif command is None:
            raise ValueError(f"path data does not start with a command: {d!r}")
        upper = command.upper()
        relative = command.islower()
        count = ARG_COUNTS[upper]
        args = [float(t) for t in tokens[i : i + count]]
        i += count
        ox, oy = pos if relative else (0.0, 0.0)

        if upper == "Z":
            pos = subpath_start
            last_control = None
            continue
        if upper == "M":
            pos = (ox + args[0], oy + args[1])
            subpath_start = pos
            command = "l" if relative else "L"  # further pairs are line-tos
            yield pos
        elif upper == "L" or upper == "T":
            pos = (ox + args[0], oy + args[1])
            yield pos
        elif upper == "H":
            pos = ((ox if relative else 0.0) + args[0], pos[1])
            yield pos
        elif upper == "V":
            pos = (pos[0], (oy if relative else 0.0) + args[0])
            yield pos
        elif upper in ("C", "S", "Q"):
            if upper == "C":
                c1 = (ox + args[0], oy + args[1])
                c2 = (ox + args[2], oy + args[3])
                end = (ox + args[4], oy + args[5])
            elif upper == "S":
                c1 = (2 * pos[0] - last_control[0], 2 * pos[1] - last_control[1]) if last_control else pos
                c2 = (ox + args[0], oy + args[1])
                end = (ox + args[2], oy + args[3])
            else:
                q = (ox + args[0], oy + args[1])
                end = (ox + args[2], oy + args[3])
                c1 = tuple(p + 2 / 3 * (c - p) for p, c in zip(pos, q))
                c2 = tuple(p + 2 / 3 * (c - p) for p, c in zip(end, q))
            yield from cubic_points(pos, c1, c2, end)
            pos = end
            last_control = c2
            continue
        elif upper == "A":
            end = (ox + args[5], oy + args[6])
            yield from arc_points(pos, args[0], args[1], args[2], bool(args[3]), bool(args[4]), end)
            pos = end
        last_control = None


class BoundingBox:
    def __init__(self):
        self.min_x = self.min_y = math.inf
        self.max_x = self.max_y = -math.inf

    def add(self, x, y):
        self.min_x, self.max_x = min(self.min_x, x), max(self.max_x, x)
        self.min_y, self.max_y = min(self.min_y, y), max(self.max_y, y)

    @property
    def empty(self):
        return self.min_x == math.inf


def measure(element, box, offset=(0.0, 0.0)):
    """Add the extent of element's paths and images to box. Text sits inside the block shape."""
    dx, dy = parse_translate(element.get("transform"))
    ox, oy = offset[0] + dx, offset[1] + dy
    if element.tag == "path" and element.get("d"):
        for x, y in path_points(element.get("d")):
            box.add(ox + x, oy + y)
    elif element.tag in ("image", "rect"):
        x, y = ox + length(element.get("x", "0")), oy + length(element.get("y", "0"))
        box.add(x, y)
        box.add(x + length(element.get("width", "0")), y + length(element.get("height", "0")))
    for child in element:
        measure(child, box, (ox, oy))


# --- Icons -------------------------------------------------------------------


def find_media(media_dir, name):
    """Find name in media_dir, ignoring hyphens (green-flag.svg matches greenflag.svg)."""
    if not media_dir or not name or not media_dir.is_dir():
        return None
    exact = media_dir / name
    if exact.is_file():
        return exact
    wanted = name.replace("-", "").lower()
    return next(
        (path for path in sorted(media_dir.iterdir())
         if path.is_file() and path.name.replace("-", "").lower() == wanted),
        None,
    )


def image_href(element):
    return element.get("xlink:href") or element.get("href") or ""


def icon_name(href):
    """Return the icon's file name, e.g. green-flag.svg.

    Embedded SVG images are named from their <title>, as Scratch's icons have one.
    """
    if href.startswith("data:image/svg+xml;base64,"):
        try:
            svg = base64.b64decode(href.split(",", 1)[1]).decode("utf-8")
        except ValueError:
            return ""
        match = re.search(r"<title>\s*([^<]+?)\s*</title>", svg)
        return f"{match.group(1)}.svg" if match else ""
    if href.startswith("data:"):
        return ""
    return href.rsplit("/", 1)[-1]


def embed_images(element, media_dir):
    """Embed each image from media_dir, so the SVG does not depend on the Scratch website.

    Images that are already embedded are replaced too if media_dir has a file of the
    same name, so a local copy (e.g. a recoloured dropdown-arrow.svg) takes priority.
    """
    for child in element:
        if child.tag != "image":
            embed_images(child, media_dir)
            continue
        href = image_href(child)
        width, height = length(child.get("width", "0")), length(child.get("height", "0"))

        local = find_media(media_dir, icon_name(href))
        if local:
            mime = mimetypes.guess_type(local.name)[0] or "application/octet-stream"
            data = base64.b64encode(local.read_bytes()).decode("ascii")
            child.attrib.pop("href", None)
            child.set("xlink:href", f"data:{mime};base64,{data}")
            child.set("width", f"{width:g}")
            child.set("height", f"{height:g}")
            continue

        if href.startswith("data:"):
            continue  # already embedded

        print(
            f"warning: image {href!r} was not found in the media folder; it will be missing",
            file=sys.stderr,
        )


# --- Clean-up and output -----------------------------------------------------


def clean(element, text_colour):
    for name in DROP_ATTRIBUTES:
        element.attrib.pop(name, None)
    if element.get("d"):
        element.set("d", " ".join(element.get("d").split()))
    if element.tag == "text":
        element.set("fill", text_colour)
        element.set("font-family", FONT_FAMILY)
        element.set("font-size", FONT_SIZE)
        element.set("font-weight", FONT_WEIGHT)
    if element.text:
        element.text = element.text.strip()
    for child in element:
        clean(child, text_colour)


def convert(block, text_colour="#000000", margin=1.0, media_dir=None):
    block.attrib.pop("transform", None)  # position on the Scratch canvas
    remove_hidden(block)

    box = BoundingBox()
    measure(block, box)
    if box.empty:
        raise ValueError("snippet contains no shapes to draw")

    embed_images(block, media_dir)
    clean(block, text_colour)
    block.set("transform", f"translate({margin - box.min_x:g},{margin - box.min_y:g})")

    width = box.max_x - box.min_x + 2 * margin
    height = box.max_y - box.min_y + 2 * margin
    svg = ET.Element("svg", {
        "xmlns": SVG_NS,
        "xmlns:xlink": XLINK_NS,
        "width": f"{width:.2f}",
        "height": f"{height:.2f}",
        "viewBox": f"0 0 {width:.2f} {height:.2f}",
    })
    svg.append(block)
    ET.indent(svg)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(svg, encoding="unicode") + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="+", type=Path, help="HTML snippet files")
    parser.add_argument("-o", "--output-dir", type=Path,
                        help="folder for the SVG files (default: next to each input)")
    parser.add_argument("--text-colour", default="#000000", help="text colour (default: %(default)s)")
    parser.add_argument("--margin", type=float, default=1.0,
                        help="space around the block, in pixels (default: %(default)s)")
    parser.add_argument("--media-dir", type=Path, default=Path(__file__).resolve().parent / "media",
                        help="folder of Scratch icon files to embed, e.g. rotate-left.svg "
                             "(default: %(default)s)")
    args = parser.parse_args()

    if args.output_dir:
        args.output_dir.mkdir(parents=True, exist_ok=True)

    failed = False
    for source in args.inputs:
        try:
            blocks = parse_snippet(source.read_text(encoding="utf-8"), source.stem)
        except (OSError, ValueError) as error:
            print(f"{source}: {error}", file=sys.stderr)
            failed = True
            continue
        for name, block in blocks:
            target = (args.output_dir or source.parent) / (name + ".svg")
            try:
                svg = convert(block, args.text_colour, args.margin, args.media_dir)
            except ValueError as error:
                print(f"{source} ({name}): {error}", file=sys.stderr)
                failed = True
                continue
            target.write_text(svg, encoding="utf-8")
            print(f"{source} -> {target}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

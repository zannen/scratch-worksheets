// Turning a block drawn by scratch-blocks into a standalone, print-friendly <svg>:
//
// - removes the block's position on the workspace and crops to the block,
// - removes hidden helper elements (connection highlights and so on),
// - makes all text black so it prints clearly,
// - embeds icons (green flag, dropdown arrow, repeat, rotate arrows and so on).

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const FONT_FAMILY = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const FONT_SIZE = '12pt';
const FONT_WEIGHT = '500';

// Attributes that only matter inside the Scratch editor.
const DROP_ATTRIBUTES = ['id', 'class', 'data-id', 'tabindex', 'style', 'alt'];

/**
 * Copy a drawn block (its root <g>, still on the workspace) as print-friendly SVG.
 *
 * @param icons Map of icon file name (e.g. "greenflag.svg") -> data URI
 * @param warnings Set to add warnings to, e.g. about icons that could not be embedded
 * @returns {svg, width, height}: an <svg> element (not in the document) and its size
 */
export function printFriendly(root, icons, warnings, {textColour = '#000000', margin = 1} = {}) {
  const box = root.getBBox();
  if (!box.width && !box.height) {
    throw new Error('the block has no shapes to draw');
  }
  const block = root.cloneNode(true);
  removeHidden(root, block);
  embedImages(block, icons, warnings);
  clean(block, textColour);
  block.setAttribute('transform', `translate(${num(margin - box.x)},${num(margin - box.y)})`);

  const width = (box.width + 2 * margin).toFixed(2);
  const height = (box.height + 2 * margin).toFixed(2);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.append(block);
  return {svg, width: Number(width), height: Number(height)};
}

/** Remove the copies of elements that are not displayed in the drawn block. */
function removeHidden(original, copy) {
  const originals = [...original.children];
  const copies = [...copy.children];
  originals.forEach((child, i) => {
    if (getComputedStyle(child).display === 'none') {
      copies[i].remove();
    } else {
      removeHidden(child, copies[i]);
    }
  });
}

function num(value) {
  return String(Number(value.toFixed(4)));
}

/** Find an icon by file name, ignoring hyphens (green-flag.svg matches greenflag.svg). */
function findIcon(icons, name) {
  if (!name) {
    return null;
  }
  if (icons.has(name)) {
    return icons.get(name);
  }
  const wanted = name.replace(/-/g, '').toLowerCase();
  for (const [file, uri] of icons) {
    if (file.replace(/-/g, '').toLowerCase() === wanted) {
      return uri;
    }
  }
  return null;
}

/** The icon's file name, e.g. green-flag.svg. Embedded SVG images are named from
 * their <title>, as Scratch's icons have one. */
function iconName(href) {
  const svgData = href.match(/^data:image\/svg\+xml(;base64)?,(.*)$/s);
  if (svgData) {
    let svg;
    try {
      svg = svgData[1] ? atob(svgData[2]) : decodeURIComponent(svgData[2]);
    } catch {
      return '';
    }
    const title = svg.match(/<title>\s*([^<]+?)\s*<\/title>/);
    return title ? `${title[1]}.svg` : '';
  }
  if (href.startsWith('data:')) {
    return '';
  }
  return href.split(/[?#]/)[0].split('/').pop();
}

/** Embed each icon, so the SVG does not depend on other files. Images that are
 * already embedded are replaced too if there is an icon of the same name. */
function embedImages(element, icons, warnings) {
  for (const image of element.querySelectorAll('image')) {
    const href = image.getAttribute('href') || image.getAttributeNS(XLINK_NS, 'href') || '';
    const icon = findIcon(icons, iconName(href));
    if (icon) {
      image.removeAttributeNS(XLINK_NS, 'href');
      image.setAttribute('href', icon);
    } else if (!href.startsWith('data:')) {
      warnings.add(`image ${href} could not be embedded; it may be missing from the worksheet`);
    }
  }
}

function clean(element, textColour) {
  for (const name of DROP_ATTRIBUTES) {
    element.removeAttribute(name);
  }
  const d = element.getAttribute('d');
  if (d) {
    element.setAttribute('d', d.trim().split(/\s+/).join(' '));
  }
  if (element.tagName === 'text') {
    element.setAttribute('fill', textColour);
    element.setAttribute('font-family', FONT_FAMILY);
    element.setAttribute('font-size', FONT_SIZE);
    element.setAttribute('font-weight', FONT_WEIGHT);
  }
  const first = element.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE) {
    first.textContent = first.textContent.trim();
  }
  for (const child of element.children) {
    clean(child, textColour);
  }
}

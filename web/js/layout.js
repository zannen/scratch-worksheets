// Laying out the worksheet: a title, instructions, then each sprite's blocks under
// its name and picture. The page is styled for A4 in index.html.

// Block sizes to try, largest first, when fitting a worksheet onto one page.
export const AUTO_SCALES = [1.25, 1.15, 1.05, 1.0, 0.95, 0.9, 0.85, 0.8];

const PX_PER_MM = 96 / 25.4;
// A4 is 297mm tall; the page has a 15mm margin at the top and bottom.
const CONTENT_HEIGHT = (297 - 2 * 15) * PX_PER_MM;

/**
 * Fill content (an element sized like the page's content area) with the worksheet.
 *
 * @param groups list of {heading, picture, blocks: [{svg, width, height}]}; heading
 *   and picture may be null
 * @param level shown in a circle in the top-right corner, if not empty
 */
export function fillWorksheet(content, {title, level, instructionsHtml, groups, scale}) {
  const h1 = document.createElement('h1');
  h1.textContent = title;
  const instructions = document.createElement('div');
  instructions.className = 'instructions';
  instructions.innerHTML = instructionsHtml; // made by markdown.js, which escapes the text
  content.replaceChildren(h1, instructions);
  if (level) {
    const badge = document.createElement('div');
    badge.className = 'level';
    if ([...level].length > 2) {
      badge.classList.add(`chars-${Math.min([...level].length, 4)}`);
    }
    badge.setAttribute('aria-label', `Level ${level}`);
    badge.textContent = level;
    content.prepend(badge);
  }

  for (const {heading, picture, blocks} of groups) {
    const section = document.createElement('section');
    if (heading) {
      const h2 = document.createElement('h2');
      if (picture) {
        const image = document.createElement('img');
        image.src = picture;
        image.alt = '';
        h2.append(image);
      }
      h2.append(heading);
      section.append(h2);
    }
    const list = document.createElement('div');
    list.className = 'blocks';
    for (const {svg, width, height} of blocks) {
      const copy = svg.cloneNode(true);
      copy.setAttribute('width', (width * scale).toFixed(2));
      copy.setAttribute('height', (height * scale).toFixed(2));
      list.append(copy);
    }
    section.append(list);
    content.append(section);
  }
}

/** Roughly how many pages the content will print on. */
export function pageCount(content) {
  return Math.max(1, Math.ceil((content.offsetHeight - 0.5) / CONTENT_HEIGHT));
}

/**
 * Lay out the worksheet. With no scale, use the largest block size that fits on one
 * page (or the smallest size). Returns {scale, pages}.
 */
export async function layoutWorksheet(content, options, scale = null) {
  const scales = scale ? [scale] : AUTO_SCALES;
  let pages;
  for (scale of scales) {
    fillWorksheet(content, {...options, scale});
    await imagesLoaded(content);
    pages = pageCount(content);
    if (pages === 1) {
      break;
    }
  }
  return {scale, pages};
}

/** Wait for the sprite pictures to load, as they affect the height of the page. */
function imagesLoaded(content) {
  return Promise.all([...content.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
}

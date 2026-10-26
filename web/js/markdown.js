// A small Markdown converter for worksheet instructions: paragraphs, "-"/"*"/"+"
// and "1." lists, "#" headings, **bold**, *italic* / _italic_ and `code`.

import {escapeXml} from './splitter.js';

// A "word" character, as in Python's re module (Unicode letters, digits and _).
const W = '[\\p{L}\\p{N}_]';
const W_OR_STAR = '[\\p{L}\\p{N}_*]';
const ITALIC = new RegExp(
  `(?<!${W_OR_STAR})\\*(?!\\s)(.+?)(?<!\\s)\\*(?!${W_OR_STAR})` +
  `|(?<!${W})_(?!\\s)(.+?)(?<!\\s)_(?!${W})`,
  'gu',
);

/** Escape text and apply **bold**, *italic* / _italic_ and `code`. */
export function inlineMarkdown(text) {
  text = escapeXml(text);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (m, a, b) => `<strong>${a ?? b}</strong>`);
  text = text.replace(ITALIC, (m, a, b) => `<em>${a ?? b}</em>`);
  return text;
}

/** Convert simple Markdown to HTML. */
export function markdownToHtml(text) {
  const htmlParts = [];
  const paragraphLines = [];
  let listTag = null;
  const items = [];

  const flushParagraph = () => {
    if (paragraphLines.length) {
      htmlParts.push(`<p>${inlineMarkdown(paragraphLines.join(' '))}</p>`);
      paragraphLines.length = 0;
    }
  };
  const flushList = () => {
    if (listTag) {
      const body = items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('');
      htmlParts.push(`<${listTag}>${body}</${listTag}>`);
      listTag = null;
      items.length = 0;
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    const bullet = stripped.match(/^[-*+]\s+(.*)$/);
    const numbered = stripped.match(/^\d+[.)]\s+(.*)$/);
    const heading = stripped.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (!stripped) {
      flushParagraph();
      continue;
    }
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      flushParagraph();
      if (listTag !== tag) {
        flushList();
        listTag = tag;
      }
      items.push((bullet || numbered)[1]);
    } else if (heading) {
      flushParagraph();
      flushList();
      htmlParts.push(`<h3>${inlineMarkdown(heading[1])}</h3>`);
    } else if (listTag && /^\s/.test(line)) {
      items[items.length - 1] += ' ' + stripped; // continuation of a list item
    } else {
      flushList();
      paragraphLines.push(stripped);
    }
  }
  flushParagraph();
  flushList();
  return htmlParts.join('\n');
}

export function paragraph(text) {
  return `<p>${escapeXml(text)}</p>`;
}

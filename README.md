# scratch-worksheets

A web page for taking a Scratch exported app (an `sb3` file), separating the
blocks and randomising the order, then making a printable PDF worksheet with a
title and some instructions.

Everything happens in the browser: the `sb3` file is not uploaded anywhere, so the
page can be hosted as plain static files.

## Process

1. Save your app to your computer:

   ![Scratch's File menu, with "Save to your computer" highlighted](readme_images/scratch-save-to-computer.png)
1. Open the web page and choose (or drop) the `sb3` file.
1. Type a title (the default is the app's name), an optional level (e.g. `1`,
   `5B` or `10`, up to 4 characters, shown in a circle in the top-right corner of
   the worksheet), and the instructions. The
   instructions can use Markdown: paragraphs, `-` or `1.` lists, `**bold**`,
   `*italic*` and `## headings`.
1. Optionally, use **Shuffle again** for a different order of blocks (the same
   order number always gives the same order), or choose a block size. By default
   the blocks are as large as possible while still fitting on one page.
1. Click **Download PDF…**, and choose **Save as PDF** as the destination in the
   print window.

## How it works

Each script is split into single blocks: each block is disconnected from the
blocks before and after it, C-blocks are emptied, and reporters (such as
variables) are taken out of the inputs they were dropped into. Values typed into
blocks are kept. The blocks are shuffled, but each sprite's blocks stay together
under its name and picture.

The blocks are drawn by Scratch's own block library
([scratch-blocks](https://github.com/scratchfoundation/scratch-blocks), in
`web/vendor/`), then made print-friendly (cropped, black text, icons embedded).

| File | What it does |
| --- | --- |
| `web/index.html` | The page, and the worksheet's A4 page style |
| `web/js/app.js` | Wires the page together |
| `web/js/sb3.js` | Reads the `sb3` file (a zip file, read with [fflate](https://github.com/101arrowz/fflate)) |
| `web/js/splitter.js` | Splits the scripts into single blocks, and shuffles them |
| `web/js/render.js` | Draws the blocks with scratch-blocks |
| `web/js/printfriendly.js` | Makes each drawn block a standalone, print-friendly SVG |
| `web/js/markdown.js` | Converts the instructions from Markdown |
| `web/js/layout.js` | Lays out the worksheet and picks the block size |

## Hosting

Publish the contents of the `web` directory with any static web server. The page
uses JavaScript modules, so it must be served over HTTP(S); opening
`web/index.html` straight from disk does not work.

## Development

- `make web-test` serves the page at <http://localhost:8080/> (needs Python 3).
- `make test` runs the unit tests (needs Node.js).
- `make e2e-test` makes a worksheet for each app in `apps/` in headless Chromium
  and headless Firefox, checks the blocks and the level circle, and saves the PDFs
  in `build/e2e/<browser>/` (needs Node.js, Chromium, and Firefox with
  [geckodriver](https://github.com/mozilla/geckodriver)). `make e2e-chromium` and
  `make e2e-firefox` test one browser. Set `CHROMIUM`, `FIREFOX` or `GECKODRIVER`
  to use other browser binaries. An app is a `.sb3` file or a folder containing
  `project.json`; its title and instructions come from a Markdown file of the same
  name, e.g. `apps/RandomWalk.md`, whose first `# ` heading is the title.

The fixtures in `tests/fixtures/` were made by the original Python version of this
program, which the web page replaces, so the tests check the page splits blocks,
converts Markdown and draws blocks just as it did.

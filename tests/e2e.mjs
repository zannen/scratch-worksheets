// End-to-end test of the web app in headless Chromium and Firefox.
//
// For each app in apps/ (a .sb3 file, or a folder containing project.json, which is
// zipped up first), this loads the page, gives it the file as if it was uploaded,
// fills in the title and instructions from the app's .md file (if any), checks the
// blocks were drawn the same size as the original Python program drew them, and
// prints the worksheet to a PDF in build/e2e/<browser>/. It also loads the apps in
// SCRATCH_PROJECTS from their links on the Scratch website, which needs the internet
// (set E2E_OFFLINE=1 to skip that).
//
// The page is served by a test server like `make web-test`, or set E2E_URL to test
// a real deployment, e.g. E2E_URL=https://www.example.org/scratch2worksheet/.
//
//     node tests/e2e.mjs                    # both browsers; or: make e2e-test
//     node tests/e2e.mjs firefox            # one browser
//     CHROMIUM=google-chrome node tests/e2e.mjs chromium
//     FIREFOX=/path/to/firefox GECKODRIVER=/path/to/geckodriver node tests/e2e.mjs firefox

import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {extname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzlibSync, zipSync} from '../web/vendor/fflate-0.8.3.mjs';
import {AUTO_SCALES} from '../web/js/layout.js';
import {BROWSERS, launch} from './browsers.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(ROOT, 'web');
const APPS = join(ROOT, 'apps');
const OUT = join(ROOT, 'build', 'e2e');
// Apps in apps/ that are also shared on the Scratch website.
const SCRATCH_PROJECTS = {RandomWalk: {link: 'https://scratch.mit.edu/projects/1394156249/', title: 'Random Walk'}};
const MIME_TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml'};

// --- A static web server for web/ -------------------------------------------

/** Forward a request to the Scratch API, as the real web server's proxy does. */
async function proxyScratchApi(id, response) {
  try {
    const reply = await fetch(`https://api.scratch.mit.edu/projects/${id}`);
    response.writeHead(reply.status, {'Content-Type': reply.headers.get('Content-Type') || 'application/json'});
    response.end(Buffer.from(await reply.arrayBuffer()));
  } catch (error) {
    response.writeHead(502).end(String(error));
  }
}

function serve() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://x').pathname;
    const api = pathname.match(/^\/scratch-api\/projects\/(\d+)\/?$/);
    if (api) {
      proxyScratchApi(api[1], response);
      return;
    }
    const path = join(WEB, decodeURIComponent(pathname));
    const file = path.endsWith('/') ? join(path, 'index.html') : path;
    if (relative(WEB, file).startsWith('..') || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {'Content-Type': MIME_TYPES[extname(file)] || 'application/octet-stream'});
    response.end(readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitFor(evaluate, expression, what, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// --- The apps ---------------------------------------------------------------

/** Each app in apps/ as {name, fixture, bytes} of a .sb3 file, then the apps that
 * are on the Scratch website as {name, fixture, link, title}. */
function findApps() {
  const apps = [];
  for (const entry of readdirSync(APPS).sort()) {
    const path = join(APPS, entry);
    if (entry.endsWith('.sb3')) {
      const name = entry.slice(0, -4);
      apps.push({name, fixture: name, bytes: readFileSync(path)});
    } else if (existsSync(join(path, 'project.json')) && !existsSync(`${path}.sb3`)) {
      const files = {};
      for (const file of readdirSync(path)) {
        files[`${entry}/${file}`] = new Uint8Array(readFileSync(join(path, file)));
      }
      apps.push({name: entry, fixture: entry, bytes: zipSync(files)});
    }
  }
  if (!process.env.E2E_OFFLINE) {
    for (const [fixture, project] of Object.entries(SCRATCH_PROJECTS)) {
      apps.push({name: `${fixture}-link`, fixture, ...project});
    }
  }
  return apps;
}

/** Title and instructions from an app's .md file: the first "# " heading is the title. */
function readNotes(name) {
  const path = join(APPS, `${name}.md`);
  if (!existsSync(path)) {
    return {title: '', instructions: ''};
  }
  const lines = readFileSync(path, 'utf-8').split('\n');
  const index = lines.findIndex(line => line.trim());
  const match = index >= 0 && lines[index].match(/^#\s+(.*?)\s*#*\s*$/);
  if (!match) {
    return {title: '', instructions: lines.join('\n').trim()};
  }
  lines.splice(index, 1);
  return {title: match[1], instructions: lines.join('\n').trim()};
}

// How far block sizes may be from the Python program's, which drew them in Chromium.
// Firefox measures some fields slightly differently (e.g. the key menu is 4px taller).
const SIZE_TOLERANCE = {chromium: 1, firefox: 5};

/** Compare block sizes with those the Python program drew (at an unknown scale). */
function checkSizes(name, sizes, tolerance) {
  const fixture = join(ROOT, 'tests', 'fixtures', `${name}.sizes.json`);
  if (!existsSync(fixture)) {
    return 'no sizes to compare with';
  }
  const sortKey = ([w, h]) => w * 10_000 + h;
  const ours = [...sizes].sort((a, b) => sortKey(a) - sortKey(b));
  const expected = JSON.parse(readFileSync(fixture, 'utf-8'));
  if (expected.length !== ours.length) {
    throw new Error(`${name}: ${ours.length} blocks, but the Python program drew ${expected.length}`);
  }
  let best = null;
  for (const scale of AUTO_SCALES) {
    const theirs = expected.map(([w, h]) => [w / scale, h / scale]).sort((a, b) => sortKey(a) - sortKey(b));
    const error = Math.max(...ours.flatMap(([w, h], i) => [Math.abs(w - theirs[i][0]), Math.abs(h - theirs[i][1])]));
    if (!best || error < best.error) {
      best = {scale, error};
    }
  }
  if (best.error > tolerance) {
    throw new Error(`${name}: block sizes differ from the Python program's by up to ${best.error.toFixed(2)}px`);
  }
  return `block sizes match the Python program's to within ${best.error.toFixed(2)}px`;
}

/** Count the pages in a PDF. Some browsers (e.g. Firefox) compress the objects that
 * describe the pages, so look inside compressed streams too. */
function pdfPageCount(bytes) {
  const text = bytes.toString('latin1');
  const parts = [text];
  for (const match of text.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    try {
      parts.push(Buffer.from(unzlibSync(bytes.subarray(start, end))).toString('latin1'));
    } catch {
      // not compressed, or not with zlib
    }
  }
  return parts.reduce((count, part) => count + (part.match(/\/Type\s*\/Page\b/g) || []).length, 0);
}

// --- The test ---------------------------------------------------------------

// Levels to show on the worksheets, to try one, two and three characters.
const LEVELS = ['5B', '7', '10A'];

async function testApp(browser, url, app, level, out) {
  const page = await browser.open(url);
  try {
    await checkApp(page, browser.name, app, level, out);
  } finally {
    await page.close();
  }
}

/** Set the block size, and wait for the worksheet to be laid out again. */
function setScale(page, value) {
  return page.evaluate(`(async () => {
    const select = document.getElementById('scale');
    select.value = ${JSON.stringify(String(value))};
    select.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 300));
  })()`);
}

/**
 * @param app {name, fixture, bytes} for a .sb3 file, or {name, fixture, link, title}
 *   for a project on the Scratch website; fixture names the app's files in apps/
 *   and tests/fixtures/
 */
async function checkApp(page, browserName, app, level, out) {
  const {name, fixture} = app;
  await waitFor(page.evaluate, `document.readyState === 'complete' && !!document.getElementById('file')`, 'the page');

  // From a link, the title comes from the Scratch website.
  const notes = readNotes(fixture);
  await page.evaluate(`(() => {
    document.getElementById('title').value = ${JSON.stringify(app.link ? '' : notes.title)};
    document.getElementById('instructions').value = ${JSON.stringify(notes.instructions)};
    document.getElementById('level').value = ${JSON.stringify(level)};
  })()`);
  if (app.link) {
    await page.evaluate(`(() => {
      document.getElementById('tab-link').click();
      document.getElementById('link').value = ${JSON.stringify(app.link)};
      document.getElementById('link-load').click();
    })()`);
  } else {
    await page.evaluate(`(() => {
      document.getElementById('tab-file').click();
      const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(app.bytes).toString('base64'))}), c => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], ${JSON.stringify(fixture + '.sb3')}));
      const input = document.getElementById('file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
    })()`);
  }
  const ready = `!document.getElementById('print').disabled || document.getElementById('status').classList.contains('error')`;
  await waitFor(page.evaluate, ready, 'the worksheet');
  const statusText = await page.evaluate(`document.getElementById('status').textContent`);
  if (await page.evaluate(`document.getElementById('status').classList.contains('error')`)) {
    throw new Error(`${name}: ${statusText}`);
  }

  // Block sizes at 100%, to compare with the Python program's.
  await setScale(page, 1);
  const sizes = await page.evaluate(`[...document.querySelectorAll('#content .blocks svg')]
    .map(svg => [Number(svg.getAttribute('width')), Number(svg.getAttribute('height'))])`);
  await setScale(page, '');
  const sizeCheck = checkSizes(fixture, sizes, SIZE_TOLERANCE[browserName]);
  // An empty title is filled in (so it can be edited), and typed-in text is kept.
  const inputs = await page.evaluate(`({title: document.getElementById('title').value,
    instructions: document.getElementById('instructions').value})`);
  const expectedTitle = app.link ? app.title : notes.title;
  if (inputs.title !== expectedTitle || (notes.instructions && inputs.instructions !== notes.instructions)) {
    throw new Error(`${name}: the title or instructions are not as expected: ${JSON.stringify(inputs)}`);
  }
  if (app.title) {
    const heading = await page.evaluate(`document.querySelector('#content h1').textContent`);
    if (heading !== app.title) {
      throw new Error(`${name}: the title is ${JSON.stringify(heading)}, not ${JSON.stringify(app.title)}`);
    }
  }
  const pictures = await page.evaluate(`document.querySelectorAll('#content h2 img').length`);
  if (pictures !== await page.evaluate(`document.querySelectorAll('#content h2').length`)) {
    throw new Error(`${name}: some sprites have no picture`);
  }

  // The level: in a round badge, in the top-right corner of the page's content.
  const badge = await page.evaluate(`(() => {
    const badge = document.querySelector('#content .level');
    if (!badge) return null;
    const box = badge.getBoundingClientRect();
    const content = document.getElementById('content').getBoundingClientRect();
    const style = getComputedStyle(badge);
    return {text: badge.textContent, top: box.top - content.top, right: content.right - box.right,
            width: box.width, height: box.height, radius: style.borderTopLeftRadius,
            fits: badge.scrollWidth <= badge.clientWidth};
  })()`);
  const badgeOk = badge && badge.text === level && Math.abs(badge.top) <= 1 && Math.abs(badge.right) <= 1 &&
    Math.abs(badge.width - badge.height) <= 1 && badge.radius === '50%' && badge.fits;
  if (!badgeOk) {
    throw new Error(`${name}: level ${level} is not in a circle in the top-right corner: ${JSON.stringify(badge)}`);
  }
  const finalStatus = await page.evaluate(`document.getElementById('status').textContent`);

  const pdf = await page.print();
  const pdfPath = join(out, `${name}.pdf`);
  writeFileSync(pdfPath, pdf);
  const pages = pdfPageCount(pdf);
  console.log(`  ${name}: ${finalStatus}\n    ${sizeCheck}\n    level ${level} OK\n` +
    `    -> ${relative(ROOT, pdfPath)} (${pages} page(s))`);
  if (pages !== 1) {
    throw new Error(`${name}: the PDF has ${pages} pages`);
  }

  // The block size chosen should be the largest that fits: check the next size up
  // really does need another page.
  const percent = Number(finalStatus.match(/block size (\d+)%/)[1]);
  const larger = AUTO_SCALES.filter(scale => Math.round(scale * 100) > percent).pop();
  if (larger) {
    await setScale(page, larger);
    const largerPdf = await page.print();
    writeFileSync(join(out, `${name}-larger.pdf`), largerPdf);
    const largerPages = pdfPageCount(largerPdf);
    console.log(`    at ${Math.round(larger * 100)}% it would print on ${largerPages} pages`);
    if (largerPages === 1) {
      throw new Error(`${name}: the blocks would fit on one page at ${Math.round(larger * 100)}%`);
    }
  }
}

async function main() {
  const browsers = process.argv.slice(2).length ? process.argv.slice(2) : BROWSERS;
  const apps = findApps();
  if (!apps.length) {
    throw new Error('no apps found in apps/');
  }
  const server = process.env.E2E_URL ? null : await serve();
  const url = process.env.E2E_URL || `http://127.0.0.1:${server.address().port}/`;
  console.log(`testing ${url}`);
  const failures = [];
  try {
    for (const name of browsers) {
      console.log(`${name}:`);
      const out = join(OUT, name);
      mkdirSync(out, {recursive: true});
      let browser;
      try {
        browser = await launch(name);
      } catch (error) {
        console.error(`  FAIL ${error.message}`);
        failures.push(name);
        continue;
      }
      try {
        for (const [i, app] of apps.entries()) {
          try {
            await testApp(browser, url, app, LEVELS[i % LEVELS.length], out);
          } catch (error) {
            console.error(`  FAIL ${error.message}`);
            failures.push(`${name}/${app.name}`);
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server?.close();
  }
  if (failures.length) {
    console.error(`failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('all apps OK');
  }
}

await main();

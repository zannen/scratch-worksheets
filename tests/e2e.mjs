// End-to-end test of the web app in headless Chromium.
//
// For each app in apps/ (a .sb3 file, or a folder containing project.json, which is
// zipped up first), this loads the page, gives it the file as if it was uploaded,
// fills in the title and instructions from the app's .md file (if any), checks the
// blocks were drawn the same size as the original Python program drew them, and
// prints the worksheet to a PDF in build/e2e/.
//
//     node tests/e2e.mjs            # or: make e2e-test
//     CHROMIUM=google-chrome node tests/e2e.mjs

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {extname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {strToU8, zipSync} from '../web/vendor/fflate-0.8.3.mjs';
import {AUTO_SCALES} from '../web/js/layout.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(ROOT, 'web');
const APPS = join(ROOT, 'apps');
const OUT = join(ROOT, 'build', 'e2e');
const CHROMIUM = process.env.CHROMIUM || 'chromium';
const MIME_TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml'};

// --- A static web server for web/ -------------------------------------------

function serve() {
  const server = createServer((request, response) => {
    const path = join(WEB, decodeURIComponent(new URL(request.url, 'http://x').pathname));
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

// --- Chromium, driven over the DevTools protocol --------------------------------

function launchChromium() {
  const child = spawn(CHROMIUM, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`${CHROMIUM} exited (${code})\n${stderr}`)));
    child.stderr.on('data', data => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\S+)/);
      if (match) {
        resolve({child, url: match[1]});
      }
    });
  });
}

class DevTools {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      }
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve);
      this.socket.addEventListener('error', reject);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({id, method, params, sessionId}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
}

async function openPage(devtools, url) {
  const {targetId} = await devtools.send('Target.createTarget', {url});
  const {sessionId} = await devtools.send('Target.attachToTarget', {targetId, flatten: true});
  const evaluate = async (expression) => {
    const {result, exceptionDetails} = await devtools.send(
      'Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId);
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    }
    return result.value;
  };
  const send = (method, params) => devtools.send(method, params, sessionId);
  return {evaluate, send};
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

/** Each app in apps/ as {name, bytes} of a .sb3 file. */
function findApps() {
  const apps = [];
  for (const entry of readdirSync(APPS).sort()) {
    const path = join(APPS, entry);
    if (entry.endsWith('.sb3')) {
      apps.push({name: entry.slice(0, -4), bytes: readFileSync(path)});
    } else if (existsSync(join(path, 'project.json')) && !existsSync(`${path}.sb3`)) {
      const files = {};
      for (const file of readdirSync(path)) {
        files[`${entry}/${file}`] = new Uint8Array(readFileSync(join(path, file)));
      }
      apps.push({name: entry, bytes: zipSync(files)});
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

/** Compare block sizes with those the Python program drew (at an unknown scale). */
function checkSizes(name, sizes) {
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
  if (best.error > 1) {
    throw new Error(`${name}: block sizes differ from the Python program's by up to ${best.error.toFixed(2)}px`);
  }
  return `block sizes match the Python program's to within ${best.error.toFixed(2)}px`;
}

function pdfPageCount(bytes) {
  return (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
}

// --- The test ---------------------------------------------------------------

async function testApp(devtools, url, {name, bytes}) {
  const page = await openPage(devtools, url);
  await page.send('Page.enable');
  await waitFor(page.evaluate, `document.readyState === 'complete' && !!document.getElementById('file')`, 'the page');

  const notes = readNotes(name);
  await page.evaluate(`(() => {
    document.getElementById('title').value = ${JSON.stringify(notes.title)};
    document.getElementById('instructions').value = ${JSON.stringify(notes.instructions)};
    const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], ${JSON.stringify(name + '.sb3')}));
    const input = document.getElementById('file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  })()`);
  const ready = `!document.getElementById('print').disabled || document.getElementById('status').classList.contains('error')`;
  await waitFor(page.evaluate, ready, 'the worksheet');
  const statusText = await page.evaluate(`document.getElementById('status').textContent`);
  if (await page.evaluate(`document.getElementById('status').classList.contains('error')`)) {
    throw new Error(`${name}: ${statusText}`);
  }

  // Block sizes at 100%, to compare with the Python program's.
  const sizesAt100 = `(async () => {
    const select = document.getElementById('scale');
    const auto = select.value;
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 300));
    const sizes = [...document.querySelectorAll('#content .blocks svg')]
      .map(svg => [Number(svg.getAttribute('width')), Number(svg.getAttribute('height'))]);
    select.value = auto;
    select.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 300));
    return sizes;
  })()`;
  const sizeCheck = checkSizes(name, await page.evaluate(sizesAt100));
  const finalStatus = await page.evaluate(`document.getElementById('status').textContent`);

  const {data} = await page.send('Page.printToPDF', {preferCSSPageSize: true, printBackground: true});
  const pdf = Buffer.from(data, 'base64');
  const pdfPath = join(OUT, `${name}.pdf`);
  writeFileSync(pdfPath, pdf);
  const pages = pdfPageCount(pdf);
  console.log(`${name}: ${finalStatus}\n  ${sizeCheck}\n  -> ${relative(ROOT, pdfPath)} (${pages} page(s))`);
  if (pages !== 1) {
    throw new Error(`${name}: the PDF has ${pages} pages`);
  }

  // The block size chosen should be the largest that fits: check the next size up
  // really does need another page.
  const percent = Number(finalStatus.match(/block size (\d+)%/)[1]);
  const larger = AUTO_SCALES.filter(scale => Math.round(scale * 100) > percent).pop();
  if (larger) {
    await page.evaluate(`(async () => {
      const select = document.getElementById('scale');
      select.value = '${larger}';
      select.dispatchEvent(new Event('change'));
      await new Promise(resolve => setTimeout(resolve, 300));
    })()`);
    const {data: largerData} = await page.send('Page.printToPDF', {preferCSSPageSize: true, printBackground: true});
    const largerPdf = Buffer.from(largerData, 'base64');
    writeFileSync(join(OUT, `${name}-larger.pdf`), largerPdf);
    const largerPages = pdfPageCount(largerPdf);
    console.log(`  at ${Math.round(larger * 100)}% it would print on ${largerPages} pages`);
    if (largerPages === 1) {
      throw new Error(`${name}: the blocks would fit on one page at ${Math.round(larger * 100)}%`);
    }
  }
}

async function main() {
  const apps = findApps();
  if (!apps.length) {
    throw new Error('no apps found in apps/');
  }
  mkdirSync(OUT, {recursive: true});
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const {child, url: devtoolsUrl} = await launchChromium();
  let failed = false;
  try {
    const devtools = new DevTools(devtoolsUrl);
    await devtools.opened;
    for (const app of apps) {
      try {
        await testApp(devtools, url, app);
      } catch (error) {
        console.error(`FAIL ${error.message}`);
        failed = true;
      }
    }
  } finally {
    child.kill();
    server.close();
  }
  if (failed) {
    process.exitCode = 1;
  } else {
    console.log('all apps OK');
  }
}

await main();

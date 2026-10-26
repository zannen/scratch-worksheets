// The worksheet page: read a .sb3 file, split and draw its blocks, lay out the
// worksheet, and print it (the browser's print window can save it as a PDF).

import {AUTO_SCALES, layoutWorksheet} from './layout.js';
import {markdownToHtml, paragraph} from './markdown.js';
import {renderBlocks} from './render.js';
import {App, projectVariables, sections} from './sb3.js';
import {seededRandom, shuffled, splitProject} from './splitter.js';

const DEFAULT_INSTRUCTIONS =
  'Cut out the blocks. Then put them together in the right order to make the program.';
const DEFAULT_INSTRUCTIONS_SPRITES = ' The blocks for each sprite are grouped together under its name.';

const $ = id => document.getElementById(id);
const fileInput = $('file');
const drop = $('drop');
const titleInput = $('title');
const instructionsInput = $('instructions');
const seedInput = $('seed');
const scaleSelect = $('scale');
const printButton = $('print');
const status = $('status');
const sheet = $('sheet');
const content = $('content');

// The app being worked on: {name, targets: [{heading, picture, blocks}], warnings}.
let current = null;

for (const scale of AUTO_SCALES) {
  scaleSelect.add(new Option(`${Math.round(scale * 100)}%`, scale));
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function newSeed() {
  seedInput.value = Math.floor(Math.random() * 1_000_000);
}

function defaultInstructions() {
  const sprites = current && current.targets.length > 1;
  return DEFAULT_INSTRUCTIONS + (sprites ? DEFAULT_INSTRUCTIONS_SPRITES : '');
}

async function readApp(file) {
  const name = file.name.replace(/\.sb3$/i, '');
  const app = new App(name, new Uint8Array(await file.arrayBuffer()));
  const targets = sections(app.project);
  if (!targets.length) {
    throw new Error('the app has no blocks');
  }
  const {menus, pieces} = splitProject(targets);
  const {blocks, errors, warnings} = await renderBlocks({variables: projectVariables(app.project), menus, pieces});
  if (errors.length) {
    const details = errors.map(({xml, error}) => `  ${xml}: ${error}`).join('\n');
    throw new Error(`some blocks could not be drawn:\n${details}`);
  }
  const showHeadings = targets.length > 1 || !targets[0].isStage;
  return {
    name,
    warnings,
    targets: targets.map((target, i) => ({
      heading: showHeadings ? target.name : null,
      picture: showHeadings ? app.costumeDataUri(target) : null,
      blocks: blocks[i],
    })),
  };
}

async function loadFile(file) {
  if (!file) {
    return;
  }
  current = null;
  printButton.disabled = true;
  sheet.hidden = true;
  $('drop-text').textContent = file.name;
  showStatus(`Reading ${file.name}…`);
  try {
    current = await readApp(file);
  } catch (error) {
    console.error(error);
    showStatus(`${file.name}: ${error.message}`, true);
    return;
  }
  newSeed();
  await update();
}

let updating = Promise.resolve();

/** Lay out the worksheet again, after a change to the app or any setting. */
function update() {
  updating = updating.then(async () => {
    if (!current) {
      return;
    }
    let seed = Number.parseInt(seedInput.value, 10);
    if (!Number.isFinite(seed) || seed < 0) {
      newSeed();
      seed = Number(seedInput.value);
    }
    const random = seededRandom(seed);
    const groups = current.targets.map(target => ({...target, blocks: shuffled(target.blocks, random)}));
    const instructions = instructionsInput.value.trim();
    instructionsInput.placeholder = defaultInstructions();
    titleInput.placeholder = current.name;

    sheet.hidden = false;
    const {scale, pages} = await layoutWorksheet(content, {
      title: titleInput.value.trim() || current.name,
      instructionsHtml: instructions ? markdownToHtml(instructions) : paragraph(defaultInstructions()),
      groups,
    }, Number(scaleSelect.value) || null);

    const count = groups.reduce((total, group) => total + group.blocks.length, 0);
    const pageText = pages === 1 ? '1 page' : `about ${pages} pages`;
    const messages = [`${count} blocks, ${pageText}, block size ${Math.round(scale * 100)}%.`];
    messages.push(...current.warnings);
    showStatus(messages.join(' '));
    printButton.disabled = false;
  }).catch(error => {
    console.error(error);
    showStatus(error.message, true);
  });
  return updating;
}

let typingTimer;
function updateSoon() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(update, 250);
}

fileInput.addEventListener('change', () => {
  loadFile(fileInput.files[0]);
});
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, event => {
    event.preventDefault();
    drop.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, () => drop.classList.remove('dragging'));
}
document.addEventListener('drop', event => {
  event.preventDefault();
  loadFile(event.dataTransfer.files[0]);
});

titleInput.addEventListener('input', updateSoon);
instructionsInput.addEventListener('input', updateSoon);
seedInput.addEventListener('input', updateSoon);
scaleSelect.addEventListener('change', update);
$('shuffle').addEventListener('click', () => {
  newSeed();
  update();
});

// The browser names the PDF after the page title, so use the app's name, as before.
let pageTitle = document.title;
addEventListener('beforeprint', () => {
  pageTitle = document.title;
  if (current) {
    document.title = current.name;
  }
});
addEventListener('afterprint', () => {
  document.title = pageTitle;
});
printButton.addEventListener('click', async () => {
  clearTimeout(typingTimer);
  await update();
  print();
});

instructionsInput.placeholder = DEFAULT_INSTRUCTIONS;

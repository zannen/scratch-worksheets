// The worksheet page: load a Scratch project (from the Scratch website, or a .sb3
// file), split and draw its blocks, lay out the worksheet, and print it (the
// browser's print window can save it as a PDF).

import {AUTO_SCALES, layoutWorksheet} from './layout.js';
import {markdownToHtml, paragraph} from './markdown.js';
import {renderBlocks} from './render.js';
import {App, projectVariables, sections} from './sb3.js';
import {API_PROXY, loadProject, projectId} from './scratchsite.js';
import {seededRandom, shuffled, splitProject} from './splitter.js';

const DEFAULT_INSTRUCTIONS =
  'Put the blocks together in the right order to make the program.';
const DEFAULT_INSTRUCTIONS_SPRITES = ' The blocks for each sprite are grouped together under its name.';

const $ = id => document.getElementById(id);
const fileInput = $('file');
const linkInput = $('link');
const drop = $('drop');
const titleInput = $('title');
const levelInput = $('level');
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

// The text last filled in for each input, so it can be replaced for the next app.
const filledIn = new Map();

/**
 * Fill in the title and instructions for a newly loaded app, so they can be edited.
 * Text typed in by the user is kept: an input is only filled in if it is empty or
 * still holds the text filled in for the previous app.
 */
function fillInDefaults() {
  for (const [input, value] of [[titleInput, current.name], [instructionsInput, defaultInstructions()]]) {
    if (!input.value.trim() || input.value === filledIn.get(input)) {
      input.value = value;
      filledIn.set(input, value);
    }
  }
}

/** Split and draw an app's blocks. */
async function prepareApp(app) {
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
    name: app.name,
    warnings,
    targets: targets.map((target, i) => ({
      heading: showHeadings ? target.name : null,
      picture: showHeadings ? app.costumeDataUri(target) : null,
      blocks: blocks[i],
    })),
  };
}

let loads = 0;

/**
 * Load an app, replacing the current one.
 *
 * @param description what is being loaded, for messages
 * @param readApp async function returning an App
 */
async function load(description, readApp) {
  const thisLoad = ++loads;
  current = null;
  printButton.disabled = true;
  sheet.hidden = true;
  showStatus(`Loading ${description}…`);
  let app;
  try {
    app = await prepareApp(await readApp());
  } catch (error) {
    console.error(error);
    if (thisLoad === loads) {
      showStatus(`${description}: ${error.message}`, true);
    }
    return;
  }
  if (thisLoad !== loads) {
    return; // something else was loaded meanwhile
  }
  current = app;
  fillInDefaults();
  newSeed();
  await update();
}

function loadFile(file) {
  if (!file) {
    return;
  }
  $('drop-text').textContent = file.name;
  const name = file.name.replace(/\.sb3$/i, '');
  return load(file.name, async () => App.fromSb3(name, new Uint8Array(await file.arrayBuffer())));
}

function loadLink() {
  const text = linkInput.value.trim();
  if (!text) {
    return;
  }
  const id = projectId(text);
  if (!id) {
    showStatus(`“${text}” is not a link to a Scratch project, like https://scratch.mit.edu/projects/1394156249`, true);
    return;
  }
  const apiProxy = new URL(API_PROXY, document.baseURI).href;
  return load(`Scratch project ${id}`, () => loadProject(id, {apiProxy}));
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
      level: levelInput.value.trim(),
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

// --- Choosing the project: tabs for a link or a file ---------------------------

const tabs = [...document.querySelectorAll('[role=tab]')];

function selectTab(tab, focus = false) {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', selected);
    other.tabIndex = selected ? 0 : -1;
    $(other.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) {
    tab.focus();
  }
  try {
    localStorage.setItem('scratch-worksheets-tab', tab.id);
  } catch {
    // storage may be unavailable; the first tab is used next time
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const step = {ArrowRight: 1, ArrowLeft: -1}[event.key];
    if (step) {
      selectTab(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length], true);
    }
  });
}
try {
  const saved = $(localStorage.getItem('scratch-worksheets-tab') || '');
  if (tabs.includes(saved)) {
    selectTab(saved);
  }
} catch {
  // storage may be unavailable
}

$('link-form').addEventListener('submit', event => {
  event.preventDefault();
  loadLink();
});
linkInput.addEventListener('paste', () => setTimeout(loadLink));

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
  const file = event.dataTransfer.files[0];
  if (file) {
    selectTab($('tab-file'));
    loadFile(file);
  }
});

// --- Settings -------------------------------------------------------------------

titleInput.addEventListener('input', updateSoon);
levelInput.addEventListener('input', updateSoon);
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

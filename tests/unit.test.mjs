// Unit tests for the parts of the web app that do not need a browser.
// Run with: node --test tests/
//
// The fixtures were made by the original Python program (worksheet.py), so these
// tests check that the JavaScript port splits blocks and converts Markdown the same way.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {zipSync, strToU8} from '../web/vendor/fflate-0.8.3.mjs';
import {markdownToHtml} from '../web/js/markdown.js';
import {App, projectVariables, sections} from '../web/js/sb3.js';
import {seededRandom, shuffled, splitProject} from '../web/js/splitter.js';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf-8');

for (const name of ['RandomWalk', 'SpinningTree']) {
  test(`${name}: blocks are split as by worksheet.py`, () => {
    const expected = JSON.parse(read(`tests/fixtures/${name}.job.json`));
    const project = JSON.parse(read(`apps/${name}/project.json`));
    const targets = sections(project);
    const {menus, pieces} = splitProject(targets);

    assert.deepEqual(projectVariables(project), expected.variables);
    assert.deepEqual(menus, expected.menus);
    assert.deepEqual(targets.map(t => t.name), expected.targets.map(t => t.name));
    assert.deepEqual(pieces, expected.targets.map(t => t.pieces));
  });
}

test('a project folder zipped up is read like a .sb3 file', () => {
  const project = read('apps/SpinningTree/project.json');
  const bytes = zipSync({'Spinning Tree/project.json': strToU8(project), 'Spinning Tree/a.svg': strToU8('<svg/>')});
  const app = App.fromSb3('Spinning Tree', bytes);
  assert.equal(app.prefix, 'Spinning Tree/');
  assert.deepEqual(app.project, JSON.parse(project));
});

test('a file without project.json is rejected', () => {
  const bytes = zipSync({'hello.txt': strToU8('hi')});
  assert.throws(() => App.fromSb3('x', bytes), /no project.json/);
});

test('a file that is not a zip file is rejected', () => {
  assert.throws(() => App.fromSb3('x', strToU8('not a zip file')), /is it a Scratch .sb3 file/);
});

test('costume pictures become data URIs', () => {
  const bytes = zipSync({'project.json': strToU8('{"targets": []}'), 'abc.svg': strToU8('<svg/>')});
  const app = App.fromSb3('x', bytes);
  const target = {costumes: [{assetId: 'abc', md5ext: 'abc.svg', dataFormat: 'svg'}], currentCostume: 0};
  assert.equal(app.costumeDataUri(target), 'data:image/svg+xml;base64,' + btoa('<svg/>'));
  assert.equal(app.costumeDataUri({costumes: []}), null);
});

const markdown = JSON.parse(read('tests/fixtures/markdown.json'));
for (const [name, {text, html}] of Object.entries(markdown)) {
  test(`markdown "${name}" converts as by worksheet.py`, () => {
    assert.equal(markdownToHtml(text), html);
  });
}

test('markdown escapes HTML', () => {
  assert.equal(markdownToHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('shuffling is repeatable for a seed and changes the order', () => {
  const items = Array.from({length: 12}, (_, i) => i);
  const first = shuffled(items, seededRandom(42));
  assert.deepEqual(shuffled(items, seededRandom(42)), first);
  assert.notDeepEqual(first, items);
  assert.deepEqual([...first].sort((a, b) => a - b), items);
  assert.notDeepEqual(shuffled(items, seededRandom(43)), first);
});

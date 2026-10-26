// Unit tests for loading projects from the Scratch website, with the website's
// replies stood in for, so they run offline. Run with: make test

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadProject, projectId} from '../web/js/scratchsite.js';
import {sections} from '../web/js/sb3.js';

const root = new URL('../', import.meta.url);
const projectJson = readFileSync(new URL('apps/RandomWalk/project.json', root));
const costume = 'bcf454acf82e4504149f7ffe07081dbc.svg';
const costumeSvg = readFileSync(new URL(`apps/RandomWalk/${costume}`, root));
const apiProxy = 'https://example.org/scratch2worksheet/scratch-api/';

/** A stand-in for fetch: replies maps URL -> Response (or a function making one). */
function fakeFetch(replies) {
  const requested = [];
  const fetchImpl = async url => {
    url = String(url);
    requested.push(url);
    const reply = replies[url];
    if (!reply) {
      return new Response('not found', {status: 404});
    }
    return typeof reply === 'function' ? reply() : reply.clone();
  };
  return {fetchImpl, requested};
}

const details = new Response(JSON.stringify({id: 123, title: 'Random Walk', project_token: 'tok en'}));
const scratchSite = {
  [`${apiProxy}projects/123`]: details,
  'https://projects.scratch.mit.edu/123?token=tok%20en': new Response(projectJson),
  [`https://assets.scratch.mit.edu/internalapi/asset/${costume}/get/`]: new Response(costumeSvg),
};

test('project numbers are found in links', () => {
  for (const text of [
    '1394156249',
    ' 1394156249 ',
    'https://scratch.mit.edu/projects/1394156249',
    'https://scratch.mit.edu/projects/1394156249/',
    'https://scratch.mit.edu/projects/1394156249/editor/',
    'https://scratch.mit.edu/projects/1394156249/fullscreen/',
    'https://scratch.mit.edu/projects/1394156249/#comments',
    'scratch.mit.edu/projects/1394156249',
    'http://www.scratch.mit.edu/projects/1394156249?x=1',
  ]) {
    assert.equal(projectId(text), '1394156249', text);
  }
  for (const text of ['', 'hello', 'https://example.org/projects/1394156249', 'https://scratch.mit.edu/users/abc',
    'https://scratch.mit.edu.example.org/projects/1', '12a']) {
    assert.equal(projectId(text), null, text);
  }
});

test('a shared project is loaded, with the pictures of sprites that have blocks', async () => {
  const {fetchImpl, requested} = fakeFetch(scratchSite);
  const app = await loadProject('123', {apiProxy, fetchImpl});
  assert.equal(app.name, 'Random Walk');
  assert.deepEqual(app.project, JSON.parse(projectJson));
  const [sprite] = sections(app.project);
  assert.equal(app.costumeDataUri(sprite), `data:image/svg+xml;base64,${costumeSvg.toString('base64')}`);
  // Only the sprite's current costume is downloaded: not the stage's, nor sounds.
  assert.deepEqual(requested.filter(url => url.includes('/asset/')),
    [`https://assets.scratch.mit.edu/internalapi/asset/${costume}/get/`]);
});

test('a picture that cannot be downloaded is left out', async () => {
  const {fetchImpl} = fakeFetch({...scratchSite, [`https://assets.scratch.mit.edu/internalapi/asset/${costume}/get/`]: undefined});
  const app = await loadProject('123', {apiProxy, fetchImpl});
  assert.equal(app.costumeDataUri(sections(app.project)[0]), null);
});

test('a project that is not shared (or does not exist) gives a helpful error', async () => {
  const {fetchImpl} = fakeFetch({});
  await assert.rejects(loadProject('999', {apiProxy, fetchImpl}), /not found.*Upload a file/s);
});

test('a missing proxy gives a helpful error', async () => {
  // Without the proxy, the site's own page (HTML) or an error comes back instead.
  const {fetchImpl} = fakeFetch({[`${apiProxy}projects/123`]: new Response('<!doctype html>')});
  await assert.rejects(loadProject('123', {apiProxy, fetchImpl}), /Is the proxy for the Scratch API set up/);
  const failing = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(loadProject('123', {apiProxy, fetchImpl: failing}), /could not be reached/);
});

test('an old Scratch 2 project is rejected', async () => {
  const {fetchImpl} = fakeFetch({
    ...scratchSite,
    'https://projects.scratch.mit.edu/123?token=tok%20en': new Response('{"objName": "Stage", "children": []}'),
  });
  await assert.rejects(loadProject('123', {apiProxy, fetchImpl}), /Scratch 2/);
});

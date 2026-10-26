// Loading a shared project straight from the Scratch website.
//
// Three requests are needed:
//
// 1. The project's details, including its title and a short-lived token, from the
//    Scratch API. The API only lets scratch.mit.edu read its replies, so this goes
//    through a reverse proxy on the same site as this page (see the README).
// 2. The project itself (project.json), using the token.
// 3. The costume pictures shown beside each sprite's name.
//
// The project and asset servers let any site read their replies, so steps 2 and 3
// go straight to Scratch.

import {App, sections} from './sb3.js';

// The proxy for the Scratch API, relative to the page. It must forward
// <API_PROXY>projects/<id> to https://api.scratch.mit.edu/projects/<id>.
export const API_PROXY = 'scratch-api/';
const PROJECTS = 'https://projects.scratch.mit.edu/';
const ASSETS = 'https://assets.scratch.mit.edu/internalapi/asset/';

/**
 * The project number from a project's link (e.g.
 * https://scratch.mit.edu/projects/1394156249/editor) or the number itself.
 * Returns null if there is no project number.
 */
export function projectId(text) {
  text = text.trim();
  if (/^\d+$/.test(text)) {
    return text;
  }
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'scratch.mit.edu' && !host.endsWith('.scratch.mit.edu')) {
    return null;
  }
  const match = url.pathname.match(/^\/projects\/(\d+)(\/|$)/);
  return match ? match[1] : null;
}

/**
 * Load a shared project from the Scratch website.
 *
 * @param id the project number
 * @param apiProxy URL of the proxy for the Scratch API (see API_PROXY)
 * @param fetchImpl fetch, or a stand-in for testing
 * @returns an App, named after the project's title
 */
export async function loadProject(id, {apiProxy, fetchImpl = fetch}) {
  const details = await projectDetails(id, apiProxy, fetchImpl);

  let response;
  try {
    response = await fetchImpl(`${PROJECTS}${id}?token=${encodeURIComponent(details.project_token)}`);
  } catch (error) {
    throw new Error(`the project could not be downloaded from Scratch (${error.message})`);
  }
  if (!response.ok) {
    throw new Error(`the project could not be downloaded from Scratch (error ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const name = details.title || `Scratch project ${id}`;

  // Projects are usually stored as project.json, but may be a whole .sb3 file.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // "PK", a zip file
    return App.fromSb3(name, bytes);
  }
  const app = new App(name, {'project.json': bytes});
  if (!Array.isArray(app.project.targets)) {
    throw new Error('this is an old Scratch 2 project, which is not supported. Open it in Scratch, ' +
      'save it to your computer, and use "Upload a file" instead');
  }
  await addCostumes(app, fetchImpl);
  return app;
}

async function projectDetails(id, apiProxy, fetchImpl) {
  const url = new URL(`projects/${id}`, apiProxy);
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`the Scratch website could not be reached (${error.message})`);
  }
  if (response.status === 404) {
    throw new Error('the project was not found. It may not be shared: for projects that are not ' +
      'shared, save the project to your computer in Scratch, and use "Upload a file" instead');
  }
  let details = null;
  if (response.ok) {
    try {
      details = await response.json();
    } catch {
      // not JSON: probably the proxy is not set up, and this is the site's own page
    }
  }
  if (!details || !details.project_token) {
    throw new Error(`the project's details could not be read from the Scratch API through ${url} ` +
      `(error ${response.status}). Is the proxy for the Scratch API set up? (See the README.)`);
  }
  return details;
}

/** Download the costume pictures that the worksheet shows beside each sprite's name.
 * A picture that cannot be downloaded is left out. */
async function addCostumes(app, fetchImpl) {
  const files = new Set();
  for (const target of sections(app.project)) {
    const costumes = target.costumes || [];
    const costume = costumes[Math.min(target.currentCostume || 0, costumes.length - 1)];
    if (costume) {
      files.add(costume.md5ext || `${costume.assetId}.${costume.dataFormat}`);
    }
  }
  await Promise.all([...files].map(async file => {
    try {
      const response = await fetchImpl(`${ASSETS}${encodeURIComponent(file)}/get/`);
      if (response.ok) {
        app.files[file] = new Uint8Array(await response.arrayBuffer());
      }
    } catch {
      // leave the picture out
    }
  }));
}

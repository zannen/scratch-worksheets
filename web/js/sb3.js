// Reading Scratch projects (.sb3 files).

import {unzipSync, strFromU8} from '../vendor/fflate-0.8.3.mjs';

const MIME_TYPES = {svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg'};

/** A Scratch project: its project.json and asset files (costumes and so on). */
export class App {
  /**
   * @param files object of file name -> bytes, as in a .sb3 file, including project.json
   */
  constructor(name, files) {
    this.name = name;
    this.files = files;
    this.prefix = this.archivePrefix();
    try {
      this.project = JSON.parse(strFromU8(this.files[this.prefix + 'project.json']));
    } catch (error) {
      throw new Error(`the project could not be read: ${error.message}`);
    }
  }

  /** Read a project from the bytes of a .sb3 file. */
  static fromSb3(name, bytes) {
    let files;
    try {
      files = unzipSync(bytes);
    } catch (error) {
      throw new Error(`the file could not be read (is it a Scratch .sb3 file?): ${error.message}`);
    }
    return new App(name, files);
  }

  /** Folder holding project.json in the zip: "" for files saved by Scratch, or e.g.
   * "Spinning Tree/" when a project folder was zipped up. */
  archivePrefix() {
    const names = Object.keys(this.files).filter(n => n.split('/').pop() === 'project.json');
    if (!names.length) {
      throw new Error('no project.json in the file (is it a Scratch .sb3 file?)');
    }
    const shortest = names.reduce((a, b) => (b.length < a.length ? b : a));
    return shortest.slice(0, -'project.json'.length);
  }

  asset(filename) {
    return this.files[this.prefix + filename];
  }

  costumeDataUri(target) {
    const costumes = target.costumes || [];
    if (!costumes.length) {
      return null;
    }
    const costume = costumes[Math.min(target.currentCostume || 0, costumes.length - 1)];
    const filename = costume.md5ext || `${costume.assetId}.${costume.dataFormat}`;
    const mime = MIME_TYPES[costume.dataFormat] || 'application/octet-stream';
    const data = this.asset(filename);
    return data ? `data:${mime};base64,${bytesToBase64(data)}` : null;
  }
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Targets that have blocks: the stage first, then sprites in layer order. */
export function sections(project) {
  const targets = project.targets.filter(t => t.blocks && Object.keys(t.blocks).length);
  return targets.sort((a, b) =>
    (!a.isStage - !b.isStage) || ((a.layerOrder || 0) - (b.layerOrder || 0)));
}

/** Every variable, list and broadcast in the project, for the renderer's workspace. */
export function projectVariables(project) {
  const found = new Map();
  for (const target of project.targets) {
    for (const [kind, type] of [['variables', ''], ['lists', 'list']]) {
      for (const [id, value] of Object.entries(target[kind] || {})) {
        found.set(id, {id, name: value[0], type});
      }
    }
    for (const [id, name] of Object.entries(target.broadcasts || {})) {
      found.set(id, {id, name, type: 'broadcast_msg'});
    }
  }
  return [...found.values()];
}

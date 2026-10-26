// Splitting scripts into single blocks.
//
// Every script is split into single blocks: each block is disconnected from the
// blocks before and after it, C-blocks are emptied, and reporters (such as
// variables) are taken out of the inputs they were dropped into. Values typed
// into blocks are kept. Each block becomes a Blockly XML snippet for the renderer.

// Compressed inputs in project.json: [type, value, ...] -> [block type, field name].
const PRIMITIVES = {
  4: ['math_number', 'NUM'],
  5: ['math_positive_number', 'NUM'],
  6: ['math_whole_number', 'NUM'],
  7: ['math_integer', 'NUM'],
  8: ['math_angle', 'NUM'],
  9: ['colour_picker', 'COLOUR'],
  10: ['text', 'TEXT'],
  11: ['event_broadcast_menu', 'BROADCAST_OPTION'],
  12: ['data_variable', 'VARIABLE'],
  13: ['data_listcontents', 'LIST'],
};
const VARIABLE_TYPES = {11: 'broadcast_msg', 12: '', 13: 'list'};
// Reporters that can be dropped into an input, and so become separate blocks.
const REPORTER_PRIMITIVES = new Set([12, 13]);

// Field names that refer to variables, lists or broadcasts, and their variable type.
const VARIABLE_FIELDS = {VARIABLE: '', LIST: 'list', BROADCAST_OPTION: 'broadcast_msg'};

const STATEMENT_INPUTS = new Set(['SUBSTACK', 'SUBSTACK2', 'custom_block']);

// Menus whose options the Scratch editor fills in from the project, and which field
// holds the chosen value.
const MENU_FIELDS = {
  motion_goto_menu: 'TO',
  motion_glideto_menu: 'TO',
  motion_pointtowards_menu: 'TOWARDS',
  looks_costume: 'COSTUME',
  looks_backdrops: 'BACKDROP',
  sound_sounds_menu: 'SOUND_MENU',
  control_create_clone_of_menu: 'CLONE_OPTION',
  sensing_touchingobjectmenu: 'TOUCHINGOBJECTMENU',
  sensing_distancetomenu: 'DISTANCETOMENU',
  sensing_of_object_menu: 'OBJECT',
  pen_menu_colorParam: 'colorParam',
  event_whenbackdropswitchesto: 'BACKDROP',
  sensing_of: 'PROPERTY',
};
// How special menu values are shown in Scratch.
const MENU_LABELS = {
  _random_: 'random position',
  _mouse_: 'mouse-pointer',
  _myself_: 'myself',
  _stage_: 'Stage',
  _edge_: 'edge',
};
const MENU_LABELS_BY_TYPE = {
  'motion_pointtowards_menu _random_': 'random direction',
};

export function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quoteAttr(text) {
  return '"' + escapeXml(text).replace(/"/g, '&quot;').replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;').replace(/\t/g, '&#9;') + '"';
}

function menuLabel(blockType, value) {
  return MENU_LABELS_BY_TYPE[`${blockType} ${value}`] || MENU_LABELS[value] || value;
}

/** Turns one target's blocks into separate Blockly XML snippets, one per block. */
export class Splitter {
  /**
   * @param blocks the target's blocks from project.json
   * @param menus Map of block type -> Map of value -> label, shared across the project
   */
  constructor(blocks, menus) {
    this.blocks = blocks;
    this.menus = menus;
  }

  /** Return a list of XML strings, one per non-shadow block, all disconnected. */
  split() {
    const pieces = [];
    for (const [blockId, block] of Object.entries(this.blocks)) {
      if (Array.isArray(block)) {
        pieces.push(this.primitiveXml(block, 'block'));
      } else if (!block.shadow) {
        pieces.push(this.blockXml(blockId));
        // Variables and lists dropped straight into an input are stored inline.
        for (const value of Object.values(block.inputs || {})) {
          const slot = value.length > 1 ? value[1] : null;
          if (Array.isArray(slot) && slot.length && REPORTER_PRIMITIVES.has(slot[0])) {
            pieces.push(this.primitiveXml(slot, 'block'));
          }
        }
      }
    }
    return pieces;
  }

  primitiveXml(primitive, tag) {
    const [kind, value] = primitive;
    const [blockType, field] = PRIMITIVES[kind];
    let attributes = '';
    if (kind in VARIABLE_TYPES) {
      attributes = ` id=${quoteAttr(primitive[2])} variabletype=${quoteAttr(VARIABLE_TYPES[kind])}`;
    }
    return `<${tag} type="${blockType}"><field name="${field}"${attributes}>` +
      `${escapeXml(value)}</field></${tag}>`;
  }

  blockXml(blockId) {
    const block = this.blocks[blockId];
    const tag = block.shadow ? 'shadow' : 'block';
    const parts = [`<${tag} type=${quoteAttr(block.opcode)}>`];
    parts.push(mutationXml(block.mutation));
    for (const [name, field] of Object.entries(block.fields || {})) {
      parts.push(this.fieldXml(block.opcode, name, field));
    }
    for (const [name, value] of Object.entries(block.inputs || {})) {
      const shadow = this.inputShadow(value);
      if (shadow === null) {
        continue; // empty, or only held a block that is now separate
      }
      const element = STATEMENT_INPUTS.has(name) ? 'statement' : 'value';
      parts.push(`<${element} name=${quoteAttr(name)}>${shadow}</${element}>`);
    }
    parts.push(`</${tag}>`);
    return parts.join('');
  }

  /** XML for the shadow left in an input once any dropped-in block is removed. */
  inputShadow(value) {
    const kind = value[0];
    let shadow;
    if (kind === 1) {
      shadow = value[1];
    } else if (kind === 3) {
      shadow = value.length > 2 ? value[2] : null;
    } else {
      // kind 2: a block with no shadow behind it, unless the block itself is a shadow
      shadow = typeof value[1] === 'string' && this.isShadow(value[1]) ? value[1] : null;
    }
    if (shadow === null || shadow === undefined) {
      return null;
    }
    if (Array.isArray(shadow)) {
      return this.primitiveXml(shadow, 'shadow');
    }
    return this.blockXml(shadow);
  }

  isShadow(blockId) {
    const block = this.blocks[blockId];
    return Boolean(block && !Array.isArray(block) && block.shadow);
  }

  fieldXml(blockType, name, field) {
    const value = field[0];
    const fieldId = field.length > 1 ? field[1] : null;
    let attributes = '';
    if (fieldId !== null && fieldId !== undefined && name in VARIABLE_FIELDS) {
      attributes = ` id=${quoteAttr(fieldId)} variabletype=${quoteAttr(VARIABLE_FIELDS[name])}`;
    }
    if (MENU_FIELDS[blockType] === name) {
      if (!this.menus.has(blockType)) {
        this.menus.set(blockType, new Map());
      }
      this.menus.get(blockType).set(String(value), menuLabel(blockType, String(value)));
    }
    return `<field name=${quoteAttr(name)}${attributes}>${escapeXml(value)}</field>`;
  }
}

function mutationXml(mutation) {
  if (!mutation) {
    return '';
  }
  const attributes = Object.entries(mutation)
    .filter(([key]) => key !== 'tagName' && key !== 'children')
    .map(([key, value]) => ` ${key}=${quoteAttr(value)}`)
    .join('');
  return `<mutation${attributes}></mutation>`;
}

/** Split every target: returns {variables, menus, targets: [[xml, ...], ...]}. */
export function splitProject(targets) {
  const menus = new Map();
  const pieces = targets.map(target => new Splitter(target.blocks, menus).split());
  const menuOptions = {};
  for (const [kind, values] of menus) {
    menuOptions[kind] = [...values].map(([value, label]) => [label, value]);
  }
  return {menus: menuOptions, pieces};
}

/** A seeded random number generator (mulberry32): returns floats in [0, 1). */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shuffle items, avoiding the original order where possible. */
export function shuffled(items, random) {
  const result = [...items];
  for (let attempt = 0; attempt < 10; attempt++) {
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    if (result.length < 3 || result.some((item, i) => item !== items[i])) {
      break;
    }
  }
  return result;
}

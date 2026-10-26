// Drawing blocks with scratch-blocks, Scratch's own block library.
//
// The blocks are drawn on a workspace that is kept off-screen, then each one is
// copied out as a print-friendly <svg> (see printfriendly.js).

import {printFriendly} from './printfriendly.js';

const VENDOR = new URL('../vendor/scratch-blocks-2.1.30.mjs', import.meta.url);
const MEDIA = new URL('../media/', import.meta.url);
// Icons used by the blocks, embedded in the print-friendly copies.
const ICON_FILES = ['dropdown-arrow.svg', 'greenflag.svg', 'repeat.svg', 'rotate-left.svg', 'rotate-right.svg'];

// Block colours, as set by the Scratch editor (scratch-blocks itself has none).
function style(primary, secondary, tertiary) {
  return {colourPrimary: primary, colourSecondary: secondary, colourTertiary: tertiary, colourQuaternary: tertiary};
}
const BLOCK_STYLES = {
  motion: style('#4C97FF', '#4280D7', '#3373CC'),
  looks: style('#9966FF', '#855CD6', '#774DCB'),
  sounds: style('#CF63CF', '#C94FC9', '#BD42BD'),
  event: style('#FFBF00', '#E6AC00', '#CC9900'),
  control: style('#FFAB19', '#EC9C13', '#CF8B17'),
  sensing: style('#5CB1D6', '#47A8D1', '#2E8EB8'),
  operators: style('#59C059', '#46B946', '#389438'),
  data: style('#FF8C1A', '#FF8000', '#DB6E00'),
  data_lists: style('#FF661A', '#FF5500', '#E64D00'),
  more: style('#FF6680', '#FF4D6A', '#FF3355'),
  pen: style('#0FBD8C', '#0DA57A', '#0B8E69'),
  textField: style('#FFFFFF', '#FFFFFF', '#FFFFFF'),
};

// Menus that the Scratch editor defines at run time. Their options come from the project.
const MENUS = {
  motion_goto_menu: ['TO', 'motion'],
  motion_glideto_menu: ['TO', 'motion'],
  motion_pointtowards_menu: ['TOWARDS', 'motion'],
  looks_costume: ['COSTUME', 'looks'],
  looks_backdrops: ['BACKDROP', 'looks'],
  sound_sounds_menu: ['SOUND_MENU', 'sounds'],
  control_create_clone_of_menu: ['CLONE_OPTION', 'control'],
  sensing_touchingobjectmenu: ['TOUCHINGOBJECTMENU', 'sensing'],
  sensing_distancetomenu: ['DISTANCETOMENU', 'sensing'],
  sensing_of_object_menu: ['OBJECT', 'sensing'],
  pen_menu_colorParam: ['colorParam', 'pen'],
};

function options(menus, type) {
  const found = menus[type];
  return found && found.length ? found : [['', '']];
}

function defineEditorBlocks(SB, menus, penIcon) {
  const definitions = [];
  for (const [type, [field, category]] of Object.entries(MENUS)) {
    definitions.push({
      type,
      message0: '%1',
      args0: [{type: 'field_dropdown', name: field, options: options(menus, type)}],
      output: 'String',
      outputShape: 2,
      extensions: ['colours_' + category],
    });
  }
  definitions.push({
    type: 'event_whenbackdropswitchesto',
    message0: 'when backdrop switches to %1',
    args0: [{type: 'field_dropdown', name: 'BACKDROP', options: options(menus, 'event_whenbackdropswitchesto')}],
    extensions: ['colours_event', 'shape_hat'],
  });
  definitions.push({
    type: 'sensing_of',
    message0: '%1 of %2',
    args0: [
      {type: 'field_dropdown', name: 'PROPERTY', options: options(menus, 'sensing_of')},
      {type: 'input_value', name: 'OBJECT'},
    ],
    output: true,
    outputShape: 2,
    extensions: ['colours_sensing'],
  });

  // Pen extension blocks, as scratch-vm describes them.
  const pen = (type, text, args = [], shape = 'shape_statement') => definitions.push({
    type,
    message0: '%1 %2',
    args0: [
      {type: 'field_image', src: penIcon, width: 40, height: 40},
      {type: 'field_vertical_separator'},
    ],
    message1: text,
    args1: args,
    extensions: ['colours_pen', shape, 'scratch_extension'],
  });
  const value = name => ({type: 'input_value', name});
  pen('pen_clear', 'erase all');
  pen('pen_stamp', 'stamp');
  pen('pen_penDown', 'pen down');
  pen('pen_penUp', 'pen up');
  pen('pen_setPenColorToColor', 'set pen color to %1', [value('COLOR')]);
  pen('pen_changePenColorParamBy', 'change pen %1 by %2', [value('COLOR_PARAM'), value('VALUE')]);
  pen('pen_setPenColorParamTo', 'set pen %1 to %2', [value('COLOR_PARAM'), value('VALUE')]);
  pen('pen_changePenSizeBy', 'change pen size by %1', [value('SIZE')]);
  pen('pen_setPenSizeTo', 'set pen size to %1', [value('SIZE')]);

  SB.defineBlocksWithJsonArray(definitions);
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not load ${url} (${response.status})`);
  }
  return response.text();
}

const svgDataUri = text => 'data:image/svg+xml;base64,' + btoa(text);

let loaded = null;

/** Load scratch-blocks and the icons, once. */
function load() {
  loaded ??= (async () => {
    const [SB, penIcon, ...icons] = await Promise.all([
      import(VENDOR.href),
      fetchText(new URL('pen-icon.svg', MEDIA)),
      ...ICON_FILES.map(name => fetchText(new URL(name, MEDIA))),
    ]);
    SB.ScratchMsgs.setLocale('en');
    const iconUris = new Map(ICON_FILES.map((name, i) => [name, svgDataUri(icons[i])]));
    return {SB, penIcon: svgDataUri(penIcon), icons: iconUris};
  })();
  loaded.catch(() => { loaded = null; });
  return loaded;
}

/**
 * Draw every block.
 *
 * @param job {variables, menus, pieces}: pieces is a list (one per target) of lists
 *   of Blockly XML snippets
 * @returns {blocks, errors, warnings}: blocks is a list (one per target) of lists of
 *   {svg, width, height}; errors lists blocks that could not be drawn
 */
export async function renderBlocks(job) {
  const {SB, penIcon, icons} = await load();
  defineEditorBlocks(SB, job.menus, penIcon);
  const theme = SB.Theme.defineTheme('scratch_worksheet', {base: SB.Themes.Classic, blockStyles: BLOCK_STYLES});

  const container = document.createElement('div');
  container.className = 'render-workspace';
  document.body.append(container);
  const workspace = SB.inject(container, {media: MEDIA.href, theme, scrollbars: false, zoom: {startScale: 1}});
  const errors = [];
  const warnings = new Set();
  try {
    for (const variable of job.variables) {
      workspace.createVariable(variable.name, variable.type, variable.id);
    }
    const blocks = job.pieces.map(pieces => pieces.map(xml => {
      try {
        const block = SB.Xml.domToBlock(SB.utils.xml.textToDom(xml), workspace);
        SB.renderManagement.triggerQueuedRenders();
        const result = printFriendly(block.getSvgRoot(), icons, warnings);
        block.dispose(false);
        return result;
      } catch (error) {
        errors.push({xml, error: String(error)});
        return null;
      }
    }).filter(Boolean));
    return {blocks, errors, warnings: [...warnings]};
  } finally {
    workspace.dispose();
    container.remove();
  }
}

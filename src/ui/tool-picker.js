import { app } from '../core/app.js';
import { el } from '../core/util.js';
import { icon } from './icons.js';
import { Dialog } from './dialog.js';
import { toolGroups } from '../tools/base.js';
import './tool-picker.css';

/**
 * Searchable index of every registered tool. The toolbar intentionally shows
 * one button per group, so this gives mouse, touch and keyboard users a direct
 * way to reach tools that would otherwise be tucked into a fly-out.
 */
export function openToolPicker() {
  const dialog = new Dialog({ title: 'Find a Tool', width: 430, className: 'pk-tool-picker-dialog' });
  const search = el('input.pk-input.pk-tool-picker-search', {
    type: 'search',
    placeholder: 'Search tools…',
    'aria-label': 'Search tools',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const list = el('div.pk-tool-picker-list', { role: 'listbox', 'aria-label': 'Tools' });
  const empty = el('div.pk-tool-picker-empty', { text: 'No matching tools.' });
  const entries = toolGroups.flatMap((group) => group.tools.map((tool) => ({ group, tool })));

  const render = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const matches = entries.filter(({ group, tool }) =>
      !query || tool.name.toLocaleLowerCase().includes(query)
        || tool.id.toLocaleLowerCase().includes(query)
        || group.id.toLocaleLowerCase().includes(query)
        || (tool.shortcut && tool.shortcut.toLocaleLowerCase() === query)
    );
    list.replaceChildren();
    for (const { group, tool } of matches) {
      const active = !!app.tool && app.tool.id === tool.id;
      const item = el('button.pk-tool-picker-item' + (active ? '.active' : ''), {
        type: 'button',
        role: 'option',
        'aria-selected': String(active),
        onclick: () => {
          dialog.close(tool.id);
          app.setTool(tool.id);
        },
      },
        el('span.pk-tool-picker-icon', { html: icon(tool.icon || tool.id, { size: 17 }) }),
        el('span.pk-tool-picker-copy', {},
          el('span.pk-tool-picker-name', { text: tool.name }),
          el('span.pk-tool-picker-group', { text: group.id.replaceAll('-', ' ') })
        ),
        tool.shortcut ? el('span.pk-tool-picker-key', { text: tool.shortcut.toUpperCase() }) : null
      );
      list.appendChild(item);
    }
    empty.hidden = matches.length > 0;
    list.hidden = matches.length === 0;
  };

  search.addEventListener('input', render);
  dialog.setBody(search, list, empty);
  dialog.setButtons([{ label: 'Close', subtle: true, value: null }]);
  render();
  dialog.open().then(() => { /* selection is applied by the row itself */ });
}

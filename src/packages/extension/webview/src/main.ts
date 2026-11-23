/**
 * The file-browser client.
 *
 * Typed TypeScript bundled by esbuild, not a string literal in the host code -- condition C1
 * of ADR-0001. It runs in a sandboxed iframe with DOM access only.
 *
 * Two rules hold throughout:
 *   - remote-controlled text is written with `textContent`, never `innerHTML`;
 *   - rows use ARIA grid roles with a roving tabindex, so the list is navigable by keyboard
 *     (condition C3; the previous implementation put role="tree" on plain buttons, which is
 *     an invalid pattern that screen readers cannot follow).
 */

interface BrowserEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  sizeLabel: string;
  modifiedLabel: string;
  sizeBytes: number;
  mtime: number;
  canFavorite: boolean;
}

interface BrowserState {
  alias: string;
  path: string;
  rootPath: string;
  entries: BrowserEntry[];
  history: string[];
  offline: boolean;
  status: string;
  error?: string;
}

type ResizableColumn = 'size';
type SortKey = 'name' | 'size' | 'modified';
type SortDirection = 'asc' | 'desc';

interface SortOrder {
  key: SortKey;
  direction: SortDirection;
}

/** Persisted across a webview reload, so these are set once rather than every time. */
interface PersistedState {
  widths?: Partial<Record<ResizableColumn, number>>;
  sort?: SortOrder;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const pathInput = document.getElementById('path') as HTMLInputElement;
const recentList = document.getElementById('recent') as HTMLDivElement;
const head = document.getElementById('head') as HTMLDivElement;
const sortBar = document.querySelector('.sortbar') as HTMLDivElement;
const rowsContainer = document.getElementById('rows') as HTMLDivElement;
const statusBar = document.getElementById('status') as HTMLDivElement;
const footer = document.getElementById('footer') as HTMLDivElement;
const menu = document.getElementById('menu') as HTMLDivElement;

/** As received from the host, in whatever order it sent them. */
let received: BrowserEntry[] = [];
/** What is actually on screen, after sorting. Row indices refer to this. */
let entries: BrowserEntry[] = [];
let recentHistory: string[] = [];
/** The paths the open dropdown is showing, in order. Option indices refer to this. */
let shownRecent: string[] = [];
let activeRecent = -1;
/** Where the host says we are, so Escape can put the field back without asking it again. */
let displayedPath = '';
let focusedIndex = 0;
let sort: SortOrder = { key: 'name', direction: 'asc' };

function post(message: unknown): void {
  vscode.postMessage(message);
}

// ---------------------------------------------------------------------------
// Column widths
// ---------------------------------------------------------------------------

const DEFAULT_WIDTHS: Record<ResizableColumn, number> = { size: 90 };
const MIN_WIDTH = 48;
/** The name column must keep a usable share of a narrow sidebar, whatever the user drags. */
const MAX_WIDTH = 320;

const widths: Record<ResizableColumn, number> = { ...DEFAULT_WIDTHS };

function clampWidth(value: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)));
}

function applyWidths(): void {
  document.documentElement.style.setProperty('--w-size', `${widths.size}px`);
}

function restorePreferences(): void {
  const stored = vscode.getState();
  const width = stored?.widths?.size;
  if (typeof width === 'number' && Number.isFinite(width)) widths.size = clampWidth(width);

  const storedSort = stored?.sort;
  if (
    storedSort !== undefined &&
    ['name', 'size', 'modified'].includes(storedSort.key) &&
    ['asc', 'desc'].includes(storedSort.direction)
  ) {
    sort = { key: storedSort.key, direction: storedSort.direction };
  }
}

function savePreferences(): void {
  vscode.setState({ ...vscode.getState(), widths: { ...widths }, sort: { ...sort } });
}

/**
 * Drag a column boundary.
 *
 * Each handle sits on the left edge of the column it resizes, so dragging left widens that
 * column -- the boundary tracks the pointer, which is what makes it feel like grabbing an edge
 * rather than operating a control.
 *
 * Pointer capture keeps the drag alive when the pointer leaves the 7px handle, which it will
 * immediately; without it the resize would stop the moment the mouse moved faster than the
 * layout.
 */
head.addEventListener('pointerdown', (event: PointerEvent) => {
  const target = event.target as HTMLElement | null;
  const column = target?.dataset['resize'] as ResizableColumn | undefined;
  if (target === null || column === undefined) return;

  event.preventDefault();
  target.setPointerCapture(event.pointerId);
  target.classList.add('dragging');
  document.body.classList.add('resizing');

  const startX = event.clientX;
  const startWidth = widths[column];

  const onMove = (move: PointerEvent): void => {
    widths[column] = clampWidth(startWidth + (startX - move.clientX));
    applyWidths();
  };

  const onEnd = (): void => {
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onEnd);
    target.removeEventListener('pointercancel', onEnd);
    target.classList.remove('dragging');
    document.body.classList.remove('resizing');
    savePreferences();
  };

  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onEnd);
  target.addEventListener('pointercancel', onEnd);
});

/** Double-clicking a boundary restores that column's default, the usual escape hatch. */
head.addEventListener('dblclick', (event) => {
  const column = (event.target as HTMLElement | null)?.dataset['resize'] as
    | ResizableColumn
    | undefined;
  if (column === undefined) return;
  widths[column] = DEFAULT_WIDTHS[column];
  applyWidths();
  savePreferences();
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function compareNames(a: string, b: string): number {
  // numeric:true so file10 sorts after file9 rather than before it.
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Order the rows.
 *
 * Directories always come first, whatever the key or direction -- sorting folders in among the
 * files by size or date makes a listing much harder to navigate, and every file manager keeps
 * them grouped for that reason.
 *
 * Name is the final tiebreaker, so equal sizes or equal timestamps produce a stable order
 * rather than shuffling between listings.
 */
function sortEntries(rows: readonly BrowserEntry[]): BrowserEntry[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aDir = a.type === 'directory' ? 0 : 1;
    const bDir = b.type === 'directory' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;

    let compared = 0;
    if (sort.key === 'size') compared = a.sizeBytes - b.sizeBytes;
    else if (sort.key === 'modified') compared = a.mtime - b.mtime;
    else compared = compareNames(a.name, b.name);

    if (compared !== 0) return compared * sign;
    return compareNames(a.name, b.name);
  });
}

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  size: 'Size',
  modified: 'Modified'
};

function renderSortBar(): void {
  for (const button of sortBar.querySelectorAll<HTMLButtonElement>('.sort')) {
    const key = button.dataset['sort'] as SortKey | undefined;
    if (key === undefined) continue;
    const active = key === sort.key;
    button.setAttribute('aria-pressed', String(active));
    // The arrow marks direction, and only on the active key -- an arrow on every button would
    // suggest all three are in effect.
    button.textContent = active
      ? `${SORT_LABELS[key]} ${sort.direction === 'asc' ? '↑' : '↓'}`
      : SORT_LABELS[key];
    button.title = active
      ? `Sorted by ${SORT_LABELS[key].toLowerCase()}, ${
          sort.direction === 'asc' ? 'ascending' : 'descending'
        }. Click to reverse.`
      : `Sort by ${SORT_LABELS[key].toLowerCase()}`;
  }
}

sortBar.addEventListener('click', (event) => {
  const key = (event.target as HTMLElement | null)?.dataset['sort'] as SortKey | undefined;
  if (key === undefined) return;
  // Clicking the active key reverses it; choosing a different key starts ascending, so the
  // first click on a column always means the same thing.
  sort =
    key === sort.key
      ? { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' };
  savePreferences();
  renderSortBar();
  renderRows();
});

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

interface MenuItem {
  label: string;
  run(): void;
  /** Draw a separating rule above this item. */
  dividerBefore?: boolean;
  /** Mark the item as destructive. */
  danger?: boolean;
}

/** Where focus was before the menu opened, so Escape can hand it back. */
let menuReturnFocus: HTMLElement | undefined;

function menuItems(): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('.menuitem')];
}

function closeMenu(restoreFocus: boolean): void {
  if (menu.hidden) return;
  menu.hidden = true;
  menu.replaceChildren();
  const previous = menuReturnFocus;
  menuReturnFocus = undefined;
  // Only on a deliberate dismissal. After activating an item the action decides where focus
  // belongs -- often a VS Code input box, which pulling focus back here would fight.
  if (restoreFocus) previous?.focus();
}

function openMenu(x: number, y: number, items: readonly MenuItem[]): void {
  if (items.length === 0) return;
  closeMenu(false);
  menuReturnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menuitem${item.dividerBefore === true ? ' divider' : ''}${
      item.danger === true ? ' danger' : ''
    }`;
    button.setAttribute('role', 'menuitem');
    // Roving focus: the menu owns Tab while it is open, so no item is in the page's tab order.
    button.tabIndex = -1;
    // A label can carry a remote filename, so it is written as text and never as markup.
    button.textContent = item.label;
    button.addEventListener('click', () => {
      closeMenu(false);
      item.run();
    });
    fragment.append(button);
  }
  menu.replaceChildren(fragment);

  // Place it at the origin and reveal it before measuring: the height depends on how many
  // items were just built, and a menu opened near the bottom edge would otherwise appear in
  // the wrong place for one frame before being corrected.
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.hidden = false;
  const bounds = menu.getBoundingClientRect();
  const margin = 2;
  menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - bounds.width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - bounds.height - margin))}px`;

  menuItems()[0]?.focus();
}

menu.addEventListener('keydown', (event) => {
  const items = menuItems();
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLButtonElement);

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      // Wrapping, as menus do: reaching the end and pressing down again returns to the top.
      items[(index + 1) % items.length]?.focus();
      return;
    case 'ArrowUp':
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
      return;
    case 'Home':
      event.preventDefault();
      items[0]?.focus();
      return;
    case 'End':
      event.preventDefault();
      items[items.length - 1]?.focus();
      return;
    case 'Escape':
    case 'Tab':
      event.preventDefault();
      closeMenu(true);
      return;
    default:
  }
});

// Capture, so a click anywhere dismisses the menu before that click does anything else.
document.addEventListener(
  'pointerdown',
  (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node)) closeMenu(false);
  },
  true
);
// A menu positioned in viewport coordinates would be left behind by any of these.
document.addEventListener('scroll', () => closeMenu(false), true);
window.addEventListener('resize', () => closeMenu(false));
window.addEventListener('blur', () => closeMenu(false));

function entryMenu(entry: BrowserEntry): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: entry.type === 'directory' ? 'Open Folder' : 'Open',
      run: () => openEntry(entry)
    },
    { label: 'New File', dividerBefore: true, run: () => post({ type: 'createFile' }) },
    { label: 'New Folder', run: () => post({ type: 'createDirectory' }) },
    {
      label: 'Download\u2026',
      dividerBefore: true,
      run: () => post({ type: 'download', path: entry.path })
    },
    { label: 'Upload Here\u2026', run: () => post({ type: 'upload' }) },
    {
      label: 'Rename\u2026',
      dividerBefore: true,
      run: () => post({ type: 'rename', path: entry.path })
    },
    { label: 'Delete\u2026', danger: true, run: () => post({ type: 'delete', path: entry.path }) }
  ];
  if (entry.canFavorite) {
    items.push({
      label: 'Add to Favorites',
      dividerBefore: true,
      run: () => post({ type: 'addFavorite', path: entry.path })
    });
  }
  return items;
}

/** The menu for empty space: there is no entry under the pointer, so nothing targets one. */
function directoryMenu(): MenuItem[] {
  return [
    { label: 'New File', run: () => post({ type: 'createFile' }) },
    { label: 'New Folder', run: () => post({ type: 'createDirectory' }) },
    { label: 'Upload Here\u2026', dividerBefore: true, run: () => post({ type: 'upload' }) },
    { label: 'Refresh', dividerBefore: true, run: () => post({ type: 'refresh' }) }
  ];
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function icon(type: BrowserEntry['type']): string {
  switch (type) {
    case 'directory':
      return '📁';
    case 'symlink':
      return '🔗';
    case 'file':
      return '📄';
    default:
      return '❓';
  }
}

/** Only the focused row is tabbable, so Tab moves past the list rather than through it. */
function applyRovingTabIndex(): void {
  const rows = rowsContainer.querySelectorAll<HTMLDivElement>('[role="row"]');
  rows.forEach((row, index) => {
    row.tabIndex = index === focusedIndex ? 0 : -1;
  });
}

function focusRow(index: number): void {
  if (entries.length === 0) return;
  focusedIndex = Math.max(0, Math.min(index, entries.length - 1));
  applyRovingTabIndex();
  const rows = rowsContainer.querySelectorAll<HTMLDivElement>('[role="row"]');
  rows[focusedIndex]?.focus();
  updateFooter();
}

function updateFooter(): void {
  const entry = entries[focusedIndex];
  footer.textContent =
    entry === undefined ? `${entries.length} items` : `${entry.path} — ${entries.length} items`;
}

function openEntry(entry: BrowserEntry): void {
  post({ type: 'openEntry', path: entry.path });
}

/**
 * Tell the host which row is highlighted.
 *
 * This is what lets Rename and Delete work from the command palette, where there is no row to
 * pass. Nothing is sent for an empty listing: the host re-resolves the path against its own
 * entries, so a stale selection resolves to nothing rather than to the wrong file.
 */
function notifySelection(): void {
  const entry = entries[focusedIndex];
  if (entry !== undefined) post({ type: 'select', path: entry.path });
}

function cell(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.setAttribute('role', 'gridcell');
  element.className = `cell ${className}`;
  // textContent, never innerHTML: a filename is remote-controlled input.
  element.textContent = text;
  return element;
}

function buildRow(entry: BrowserEntry, index: number): HTMLDivElement {
  const row = document.createElement('div');
  row.className = `row ${entry.type}`;
  row.setAttribute('role', 'row');
  row.tabIndex = index === focusedIndex ? 0 : -1;

  const name = cell('name', `${icon(entry.type)} ${entry.name}`);
  // The modified time has no column of its own any more, so the tooltip is where it lives.
  // SFTP v3 carries no creation time at all -- the protocol simply does not transmit one --
  // so there is nothing else honest to show here.
  name.title =
    entry.modifiedLabel === ''
      ? `${entry.name}\nModified: unknown`
      : `${entry.name}\nModified: ${entry.modifiedLabel}`;

  row.append(name, cell('size', entry.sizeLabel));

  row.addEventListener('click', () => {
    focusRow(index);
  });
  row.addEventListener('dblclick', () => openEntry(entry));
  row.addEventListener('focus', () => {
    focusedIndex = index;
    updateFooter();
    notifySelection();
  });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    // Without this the container's own handler would also fire and replace this menu with the
    // empty-space one.
    event.stopPropagation();
    focusRow(index);
    openMenu(event.clientX, event.clientY, entryMenu(entry));
  });

  return row;
}

/**
 * Show the end of the path rather than its start.
 *
 * A deep path overflows the field, and the leading `/home/user/...` is the least useful part
 * of it -- the current directory and its immediate parents are what the reader needs. Scrolling
 * to the end keeps those visible.
 *
 * Never do this while the field has focus: it would fight the user's cursor as they type.
 */
function showPathTail(): void {
  if (document.activeElement === pathInput) return;
  // scrollLeft only takes effect once the browser has laid the new value out.
  requestAnimationFrame(() => {
    if (document.activeElement === pathInput) return;
    pathInput.scrollLeft = pathInput.scrollWidth;
  });
}

function renderRows(): void {
  entries = sortEntries(received);
  focusedIndex = Math.min(focusedIndex, Math.max(entries.length - 1, 0));

  const rows = document.createDocumentFragment();
  entries.forEach((entry, index) => rows.append(buildRow(entry, index)));
  rowsContainer.replaceChildren(rows);

  applyRovingTabIndex();
  updateFooter();
  notifySelection();
}

function render(state: BrowserState): void {
  received = state.entries;

  displayedPath = state.path;
  // Do not clobber a path the user is part-way through typing.
  if (document.activeElement !== pathInput) {
    pathInput.value = state.path;
    // The full path is always available on hover, however narrow the sidebar is.
    pathInput.title = state.path;
    showPathTail();
  }

  renderRows();

  recentHistory = state.history;

  statusBar.textContent = state.error ?? state.status;
  statusBar.className = `status${state.error !== undefined ? ' error' : ''}${
    state.offline ? ' offline' : ''
  }`;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

document.getElementById('up')?.addEventListener('click', () => post({ type: 'navigateParent' }));

// ---------------------------------------------------------------------------
// Recent directories
// ---------------------------------------------------------------------------

/**
 * Show the dropdown.
 *
 * Opening it from focus or the arrow key passes an empty filter, so every visited directory is
 * offered. Filtering by the field's contents at that moment -- which is the current path -- is
 * exactly what made the native datalist useless: it only ever showed where you already were
 * and the directories below it. Only text the user has actually typed narrows the list.
 */
function openRecent(filter: string): void {
  const needle = filter.trim();
  shownRecent =
    needle === '' ? [...recentHistory] : recentHistory.filter((path) => path.includes(needle));
  if (shownRecent.length === 0) {
    closeRecent();
    return;
  }

  const fragment = document.createDocumentFragment();
  shownRecent.forEach((path, index) => {
    const option = document.createElement('div');
    option.id = `recent-${index}`;
    option.className = 'option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    // A remote path, so text and never markup.
    option.textContent = path;
    option.title = path;
    // Keep focus in the field: a blur would close the list before the click arrived.
    option.addEventListener('pointerdown', (event) => event.preventDefault());
    option.addEventListener('click', () => chooseRecent(path));
    fragment.append(option);
  });
  recentList.replaceChildren(fragment);
  activeRecent = -1;
  pathInput.removeAttribute('aria-activedescendant');

  // Fixed and placed from the field's box, like the context menu, so the grid scrolling or
  // overflowing underneath cannot clip it.
  const bounds = pathInput.getBoundingClientRect();
  recentList.style.left = `${bounds.left}px`;
  recentList.style.top = `${bounds.bottom + 1}px`;
  recentList.style.width = `${bounds.width}px`;
  recentList.hidden = false;
  pathInput.setAttribute('aria-expanded', 'true');
}

function closeRecent(): void {
  if (recentList.hidden) return;
  recentList.hidden = true;
  recentList.replaceChildren();
  shownRecent = [];
  activeRecent = -1;
  pathInput.setAttribute('aria-expanded', 'false');
  pathInput.removeAttribute('aria-activedescendant');
}

function highlightRecent(index: number): void {
  if (shownRecent.length === 0) return;
  activeRecent = (index + shownRecent.length) % shownRecent.length;
  const options = recentList.querySelectorAll<HTMLDivElement>('[role="option"]');
  options.forEach((option, position) => {
    option.setAttribute('aria-selected', String(position === activeRecent));
  });
  const active = options[activeRecent];
  if (active !== undefined) {
    // Focus stays in the field; this is how a screen reader learns which option is current.
    pathInput.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }
}

/** Picking a recent directory is the whole action: no Enter afterwards. */
function chooseRecent(path: string): void {
  closeRecent();
  pathInput.value = path;
  post({ type: 'navigateHistory', path });
  pathInput.blur();
}

pathInput.addEventListener('focus', () => openRecent(''));

// A click on a field that already has focus fires no focus event, so reopen from here after
// Escape or a pick has closed the list.
pathInput.addEventListener('click', () => {
  if (recentList.hidden) openRecent('');
});

pathInput.addEventListener('input', () => openRecent(pathInput.value));

pathInput.addEventListener('keydown', (event) => {
  const open = !recentList.hidden;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (open) highlightRecent(activeRecent + 1);
      else openRecent('');
      return;
    case 'ArrowUp':
      if (!open) return;
      event.preventDefault();
      highlightRecent(activeRecent < 0 ? shownRecent.length - 1 : activeRecent - 1);
      return;
    case 'Enter': {
      event.preventDefault();
      const picked = open && activeRecent >= 0 ? shownRecent[activeRecent] : undefined;
      if (picked !== undefined) {
        chooseRecent(picked);
        return;
      }
      closeRecent();
      post({ type: 'navigate', path: pathInput.value });
      pathInput.blur();
      return;
    }
    case 'Escape':
      event.preventDefault();
      // First Escape closes the list; the next abandons the edit. Restoring the field locally
      // costs nothing, where asking the host to refresh re-listed the directory over the wire.
      if (open) {
        closeRecent();
        return;
      }
      pathInput.value = displayedPath;
      pathInput.blur();
      return;
    case 'Tab':
      closeRecent();
      return;
    default:
  }
});

pathInput.addEventListener('blur', () => {
  closeRecent();
  showPathTail();
});

// Positioned in viewport coordinates, so it would be left behind by either of these. Scrolling
// inside the list itself is how a long history is browsed, and must not close it.
document.addEventListener(
  'scroll',
  (event) => {
    if (event.target !== recentList) closeRecent();
  },
  true
);
window.addEventListener('resize', () => closeRecent());

/**
 * Right-clicking below the last row targets the directory rather than an entry.
 *
 * Rows stop their own contextmenu event, so reaching here means the pointer was over empty
 * space -- the one place where "new file here" is unambiguous and nothing else applies.
 */
rowsContainer.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openMenu(event.clientX, event.clientY, directoryMenu());
});

rowsContainer.addEventListener('keydown', (event) => {
  // The menu key and Shift+F10 are how a keyboard reaches a context menu; without them every
  // one of these actions would be mouse-only.
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault();
    const selected = entries[focusedIndex];
    if (selected === undefined) return;
    // Anchor it to the row, not the pointer: there is no pointer in this path.
    const rows = rowsContainer.querySelectorAll<HTMLDivElement>('[role="row"]');
    const rect = rows[focusedIndex]?.getBoundingClientRect();
    openMenu(rect?.left ?? 0, rect?.bottom ?? 0, entryMenu(selected));
    return;
  }

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusRow(focusedIndex + 1);
      return;
    case 'ArrowUp':
      event.preventDefault();
      focusRow(focusedIndex - 1);
      return;
    case 'Home':
      event.preventDefault();
      focusRow(0);
      return;
    case 'End':
      event.preventDefault();
      focusRow(entries.length - 1);
      return;
    case 'Enter': {
      event.preventDefault();
      const entry = entries[focusedIndex];
      if (entry !== undefined) openEntry(entry);
      return;
    }
    case 'Backspace':
      event.preventDefault();
      post({ type: 'navigateParent' });
      return;
    default:
  }
});

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  // Validate what the host sends too, rather than trusting the shape.
  if (typeof message !== 'object' || message === null) return;
  const candidate = message as { type?: unknown; state?: unknown };
  if (candidate.type !== 'state' || typeof candidate.state !== 'object' || candidate.state === null) {
    return;
  }
  render(candidate.state as BrowserState);
});

restorePreferences();
applyWidths();
renderSortBar();
post({ type: 'ready' });

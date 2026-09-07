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
const recentList = document.getElementById('recent') as HTMLDataListElement;
const head = document.getElementById('head') as HTMLDivElement;
const sortBar = document.querySelector('.sortbar') as HTMLDivElement;
const rowsContainer = document.getElementById('rows') as HTMLDivElement;
const statusBar = document.getElementById('status') as HTMLDivElement;
const footer = document.getElementById('footer') as HTMLDivElement;

/** As received from the host, in whatever order it sent them. */
let received: BrowserEntry[] = [];
/** What is actually on screen, after sorting. Row indices refer to this. */
let entries: BrowserEntry[] = [];
let recentHistory: string[] = [];
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
  });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (entry.canFavorite) post({ type: 'addFavorite', path: entry.path });
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
}

function render(state: BrowserState): void {
  received = state.entries;

  // Do not clobber a path the user is part-way through typing.
  if (document.activeElement !== pathInput) {
    pathInput.value = state.path;
    // The full path is always available on hover, however narrow the sidebar is.
    pathInput.title = state.path;
    showPathTail();
  }

  renderRows();

  // Recent directories are offered by the path field itself rather than a separate control.
  recentHistory = state.history;
  const options = document.createDocumentFragment();
  for (const path of state.history) {
    const option = document.createElement('option');
    option.value = path;
    options.append(option);
  }
  recentList.replaceChildren(options);

  statusBar.textContent = state.error ?? state.status;
  statusBar.className = `status${state.error !== undefined ? ' error' : ''}${
    state.offline ? ' offline' : ''
  }`;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

document.getElementById('up')?.addEventListener('click', () => post({ type: 'navigateParent' }));

pathInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    post({ type: 'navigate', path: pathInput.value });
    pathInput.blur();
    return;
  }
  if (event.key === 'Escape') {
    // Abandon the edit and go back to showing where we actually are.
    pathInput.blur();
    post({ type: 'refresh' });
  }
});

pathInput.addEventListener('input', (event) => {
  // Picking from the dropdown navigates immediately; typing does not. Chromium reports a
  // datalist selection as `insertReplacementText`, which distinguishes the two reliably --
  // matching the typed text against the history list instead would navigate mid-keystroke
  // whenever someone typed a path they had visited before.
  const inputType = (event as InputEvent).inputType;
  if (inputType === 'insertReplacementText' && recentHistory.includes(pathInput.value)) {
    post({ type: 'navigateHistory', path: pathInput.value });
    pathInput.blur();
  }
});

pathInput.addEventListener('blur', () => showPathTail());

rowsContainer.addEventListener('keydown', (event) => {
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

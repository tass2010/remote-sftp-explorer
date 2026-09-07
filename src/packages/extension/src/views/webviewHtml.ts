export interface BrowserHtmlOptions {
  nonce: string;
  cspSource: string;
  /** The bundled client, inlined so no local resource needs to be addressable. */
  script: string;
  style: string;
}

/**
 * Escape text destined for an HTML attribute or body.
 *
 * Nothing remote-controlled is interpolated into this page -- the client builds every row with
 * createElement and textContent -- but the nonce and CSP source still pass through here so a
 * malformed value can never break out of its attribute.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/**
 * The browser page.
 *
 * The CSP is the load-bearing part: `default-src 'none'` with per-resolve nonces and no
 * `'unsafe-inline'`. Combined with `localResourceRoots: []`, a remote filename cannot become
 * executable content even if the row-building code were one day changed to interpolate.
 */
export function renderBrowserHtml(options: BrowserHtmlOptions): string {
  const nonce = escapeHtml(options.nonce);
  const cspSource = escapeHtml(options.cspSource);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Remote Files</title>
<style nonce="${nonce}">
${options.style}
</style>
</head>
<body>
<!-- Two controls only. Refresh and Disconnect live in the view title bar, and the recent
     directories are folded into the path field's own dropdown, so nothing competes with the
     path for horizontal space. Enter navigates; there is no separate Go button.

     The parent button sits after the field so the path starts at the panel's left edge, where
     the eye lands first, and the control the mouse reaches for stays in one place as the path
     changes length. -->
<div class="toolbar">
  <input id="path" type="text" spellcheck="false" autocomplete="off"
         list="recent" aria-label="Remote path" placeholder="Not connected">
  <datalist id="recent"></datalist>
  <button id="up" type="button" title="Parent directory" aria-label="Parent directory">
    <!-- Inline SVG rather than a text arrow or an icon font: it renders identically on every
         platform, inherits the theme colour through currentColor, and needs no font-src in
         the CSP. Drawn to codicon proportions so it sits naturally beside VS Code's own. -->
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 2.22l4.66 4.66-1.06 1.06-2.85-2.85V13.5h-1.5V5.09L4.4 7.94 3.34 6.88 8 2.22z"/>
    </svg>
  </button>
</div>
<div id="status" class="status" role="status" aria-live="polite"></div>
<!-- Sorting is a toolbar rather than clickable column headers, because the key the user most
     often wants to sort by -- modified time -- no longer has a column to click. -->
<div class="sortbar" role="toolbar" aria-label="Sort order">
  <button class="sort" data-sort="name" type="button" aria-pressed="false">Name</button>
  <button class="sort" data-sort="size" type="button" aria-pressed="false">Size</button>
  <button class="sort" data-sort="modified" type="button" aria-pressed="false">Modified</button>
</div>
<div class="grid" role="grid" aria-label="Remote directory contents" aria-readonly="true">
  <!-- Column widths live in a CSS custom property so a drag can move them without touching
       every row. The handle resizes the column to its right. -->
  <div id="head" class="head" role="row">
    <span role="columnheader">Name</span>
    <span class="handle" data-resize="size" role="separator" aria-orientation="vertical"
          aria-label="Resize the Size column" tabindex="-1"></span>
    <span role="columnheader">Size</span>
  </div>
  <div id="rows" class="rows"></div>
</div>
<div id="footer" class="footer"></div>
<script nonce="${nonce}">
${options.script}
</script>
</body>
</html>`;
}

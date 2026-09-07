/**
 * The security posture that ADR-0001 depends on.
 *
 * Keeping the file browser as a webview is only defensible because these properties hold, so
 * they are pinned here rather than left to review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, renderBrowserHtml } from '../src/views/webviewHtml.ts';

const extensionRoot = path.resolve(fileURLToPath(import.meta.url), '../..');

function render(overrides: Partial<Parameters<typeof renderBrowserHtml>[0]> = {}): string {
  return renderBrowserHtml({
    nonce: 'TESTNONCE',
    cspSource: 'vscode-webview://abc',
    script: 'console.log("client");',
    style: 'body { margin: 0; }',
    ...overrides
  });
}

test('the CSP denies everything by default and allows only nonced script and style', () => {
  const html = render();
  const csp = /content="([^"]+)"/u.exec(html)?.[1] ?? '';

  assert.match(csp, /default-src 'none'/u);
  assert.match(csp, /script-src 'nonce-TESTNONCE'/u);
  assert.match(csp, /style-src 'nonce-TESTNONCE'/u);
  assert.ok(!csp.includes("'unsafe-inline'"), "'unsafe-inline' would defeat the nonce");
  assert.ok(!csp.includes("'unsafe-eval'"));
  assert.ok(!/script-src[^;]*https?:/u.test(csp), 'no remote script origin may be allowed');
});

test('script and style tags carry the nonce', () => {
  const html = render();
  assert.match(html, /<script nonce="TESTNONCE">/u);
  assert.match(html, /<style nonce="TESTNONCE">/u);
});

test('a hostile nonce or csp source cannot break out of its attribute', () => {
  const html = render({
    nonce: 'abc"><script>alert(1)</script>',
    cspSource: 'x" onload="evil()'
  });

  assert.ok(!html.includes('<script>alert(1)</script>'), 'the injected tag must be escaped');
  assert.ok(!html.includes('onload="evil()'), 'the injected attribute must be escaped');
  assert.match(html, /&quot;/u);
});

test('escapeHtml covers every character that can end an attribute or start a tag', () => {
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml('plain text'), 'plain text');
});

test('the page declares the ARIA grid structure the client relies on', () => {
  // role="tree" over plain buttons -- what the previous implementation shipped -- is an
  // invalid pattern that screen readers cannot navigate. A three-column list is a grid.
  const html = render();
  assert.match(html, /role="grid"/u);
  assert.match(html, /role="row"/u);
  assert.match(html, /role="columnheader"/u);
  assert.ok(!html.includes('role="tree"'), 'a columnar list is not a tree');
  assert.match(html, /aria-live="polite"/u, 'status changes must be announced');
});

test('every interactive control has an accessible name', () => {
  const html = render();

  // Visible text is an accessible name in its own right, and is the better one: adding
  // aria-label to a button that already reads "Size" makes the spoken name differ from the
  // visible one, which breaks voice control. So a control needs a label only when it has no
  // text of its own.
  const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/gu)];
  assert.ok(buttons.length > 0);
  for (const [, attributes, content] of buttons) {
    const visibleText = (content ?? '').replace(/<[^>]*>/gu, '').replace(/<!--[\s\S]*?-->/gu, '');
    const named = (attributes ?? '').includes('aria-label=') || visibleText.trim().length > 0;
    assert.ok(named, `button without an accessible name: ${attributes}`);
  }

  // Inputs and selects have no text content, so they always need one.
  for (const control of html.match(/<(?:input|select)[^>]*>/gu) ?? []) {
    assert.ok(control.includes('aria-label='), `control without an accessible name: ${control}`);
  }
});

test('the toolbar holds only the parent button and the path field', () => {
  // Every other control competes with the path for width in a narrow sidebar. Refresh and
  // Disconnect belong to the view title bar, and recent directories are folded into the path
  // field's own dropdown.
  const html = render();
  const toolbar = /<div class="toolbar">([\s\S]*?)\n<\/div>/u.exec(html)?.[1] ?? '';

  const buttons = toolbar.match(/<button[^>]*id="([^"]+)"/gu) ?? [];
  assert.equal(buttons.length, 1, `expected one button, found: ${buttons.join(', ')}`);
  assert.match(toolbar, /id="up"/u);

  assert.ok(!toolbar.includes('id="go"'), 'Enter navigates; a Go button is redundant');
  assert.ok(!toolbar.includes('id="refresh"'), 'Refresh lives in the view title bar');
  assert.ok(!/<select/u.test(toolbar), 'the history dropdown is merged into the path field');
});

test('the parent button follows the path field and carries an inline icon', () => {
  // Placed after the field so the path starts at the panel edge and the button does not move
  // as the path changes length. The icon is inline SVG rather than an icon font, which would
  // need font-src in the CSP, or a text arrow, which renders differently per platform.
  const html = render();
  const toolbar = /<div class="toolbar">([\s\S]*?)\n<\/div>/u.exec(html)?.[1] ?? '';

  assert.ok(
    toolbar.indexOf('id="path"') < toolbar.indexOf('id="up"'),
    'the path field must come before the parent button'
  );
  assert.match(toolbar, /<svg viewBox="0 0 16 16"[^>]*>/u);
  assert.match(toolbar, /fill="currentColor"/u, 'the icon must follow the theme colour');
  assert.match(toolbar, /aria-hidden="true"/u, 'the button already has an accessible name');
  // Scoped to the CSP itself: prose elsewhere in the page may legitimately mention font-src.
  const csp = /content="([^"]+)"/u.exec(html)?.[1] ?? '';
  assert.ok(!csp.includes('font-src'), 'an inline icon needs no font origin in the CSP');
});

test('the list shows Name and Size, with a handle on their boundary', () => {
  const html = render();
  const headers = [...html.matchAll(/role="columnheader"[^>]*>([^<]+)</gu)].map((m) => m[1]);
  assert.deepEqual(headers, ['Name', 'Size'], 'modified time moved to the tooltip');

  const handles = [...html.matchAll(/data-resize="([^"]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(handles, ['size'], 'one boundary, one handle');
  // Separators, not buttons: they adjust layout and are not part of the tab order.
  assert.match(html, /class="handle"[^>]*role="separator"/u);
  assert.match(html, /aria-orientation="vertical"/u);
});

test('the sort toolbar offers all three keys, including the hidden one', () => {
  // Modified has no column to click any more, which is why sorting is a toolbar rather than
  // clickable headers.
  const html = render();
  const bar = /<div class="sortbar"[\s\S]*?<\/div>/u.exec(html)?.[0] ?? '';
  const keys = [...bar.matchAll(/data-sort="([^"]+)"/gu)].map((m) => m[1]);

  assert.deepEqual(keys, ['name', 'size', 'modified']);
  assert.match(bar, /role="toolbar"/u);
  assert.match(bar, /aria-label="Sort order"/u);
  // aria-pressed makes the active key audible, not just visible.
  assert.equal((bar.match(/aria-pressed=/gu) ?? []).length, 3);
});

test('column widths come from a custom property so a drag can move them', () => {
  // The header and the rows must share one template, or they drift out of alignment.
  const style = readFileSync(
    path.join(extensionRoot, 'webview', 'src', 'style.css'),
    'utf8'
  );
  assert.match(style, /--w-size/u);
  assert.ok(!style.includes('--w-modified'), 'the modified column is gone');
  assert.match(
    style,
    /\.head,\s*\n\.row \{[\s\S]*?grid-template-columns:[^;]*var\(--w-size\)/u,
    'header and rows must share the same column template'
  );
});

test('the row tooltip carries the modified time, not the path', () => {
  const client = readFileSync(
    path.join(extensionRoot, 'webview', 'src', 'main.ts'),
    'utf8'
  );
  assert.match(client, /name\.title =/u);
  assert.match(client, /Modified: /u);
  assert.ok(
    !/name\.title = entry\.path/u.test(client),
    'the full path is in the footer; the tooltip is where the time now lives'
  );
});

test('the path field offers recent directories through its own dropdown', () => {
  const html = render();
  assert.match(html, /<input id="path"[^>]*list="recent"/u);
  assert.match(html, /<datalist id="recent">/u);
  // Browser autocomplete would otherwise compete with our own suggestions.
  assert.match(html, /<input id="path"[^>]*autocomplete="off"/u);
});

test('the built client contains no innerHTML assignment', () => {
  // Remote filenames flow into this file. textContent is the invariant that keeps them inert.
  const client = readFileSync(
    path.join(extensionRoot, 'webview', 'src', 'main.ts'),
    'utf8'
  );
  assert.ok(!/\.innerHTML\s*=/u.test(client), 'rows must be built with textContent');
  assert.ok(!/\.outerHTML\s*=/u.test(client));
  assert.ok(!/insertAdjacentHTML/u.test(client));
  assert.ok(!/\beval\(/u.test(client));
});

test('the client validates messages from the host rather than trusting their shape', () => {
  const client = readFileSync(
    path.join(extensionRoot, 'webview', 'src', 'main.ts'),
    'utf8'
  );
  assert.match(client, /candidate\.type !== 'state'/u);
});

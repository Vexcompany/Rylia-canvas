import { suite } from '../harness.js';
import { createCanvas } from '/src/core/util.js';
import { createRasterLayer } from '/src/core/layer.js';
import { droppedImageUrl, placeAsLayer } from '/src/io/open.js';
import { paste } from '/src/edit/clipboard.js';
import {
  artworkOf, clearDropTarget, copyIntoDocument, cropTo, documentForTab, setDropTarget,
} from '/src/ui/cross-doc-drag.js';

/**
 * Dragging an image in from another browser tab, and pasting one, without
 * losing any of it.
 *
 * The drop listener is installed on `window` by `installFileDrop` at boot, so
 * these tests drive the real one. `DataTransfer` is stubbed rather than
 * constructed: the constructor is not available everywhere, and a plain object
 * exercises exactly the properties the handler reads.
 */

/** A stand-in DataTransfer carrying the strings a browser puts on a drag. */
function fakeDrag(strings) {
  return {
    types: Object.keys(strings),
    files: [],
    items: [],
    dropEffect: 'none',
    getData: (type) => strings[type] || '',
  };
}

function fireOnWindow(type, dataTransfer) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer });
  Object.defineProperty(e, 'shiftKey', { value: false });
  window.dispatchEvent(e);
  return e;
}

const dropOnWindow = (dataTransfer) => fireOnWindow('drop', dataTransfer);

/** A PNG data: URL — fetchable with no network, so the drop path runs offline. */
function pngDataUrl(w, h, color) {
  const cv = createCanvas(w, h);
  const c = cv.getContext('2d');
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  return cv.toDataURL('image/png');
}

/** Poll until `fn` is truthy. Bounded by the clock, so a failure cannot hang. */
async function waitFor(fn, budgetMs = 8000) {
  const started = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - started > budgetMs) return null;
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

suite('drop / a dragged image beats the link it sits in', async (t) => {
  /*
   * The defect: reading `text/uri-list` first. On most sites the image you
   * drag is wrapped in a link, and the browser puts the LINK's href there —
   * so dragging a thumbnail off a search page opened the page, not the
   * picture. Verified to fail by reordering `droppedImageUrl` to try
   * `data.uriList` before the markup: it returns the article URL below.
   */
  const found = droppedImageUrl({
    html: '<meta charset="utf-8"><a href="https://news.example/article">'
      + '<img src="https://cdn.example/photos/sunset.jpg" alt="Sunset over the bay"></a>',
    uriList: 'https://news.example/article',
    plain: 'https://news.example/article',
  });
  t.eq(found && found.url, 'https://cdn.example/photos/sunset.jpg', 'the image, not the article');
  t.eq(found && found.alt, 'Sunset over the bay', 'alt text comes along as a name');

  // With no markup there is nothing better than the uri-list.
  const bare = droppedImageUrl({ uriList: '# a comment line\r\nhttps://cdn.example/a.png\r\n' });
  t.eq(bare && bare.url, 'https://cdn.example/a.png', 'uri-list comments are skipped');
});

suite('drop / only schemes we are willing to fetch', async (t) => {
  /*
   * Verified to fail by dropping the DROP_SCHEMES check from `usableUrl`:
   * every one of these comes back as a URL to fetch.
   */
  t.eq(droppedImageUrl({ uriList: 'javascript:alert(1)' }), null, 'javascript: refused');
  t.eq(droppedImageUrl({ uriList: 'file:///etc/passwd' }), null, 'file: refused');
  t.eq(droppedImageUrl({ uriList: '/relative/path.png' }), null, 'a relative path is not a URL');
  t.eq(droppedImageUrl({ html: '<img src="/relative.png">', uriList: 'https://ok.example/x.png' }),
    { url: 'https://ok.example/x.png', alt: '' }, 'a relative src falls through to the uri-list');
  t.ok(droppedImageUrl({ uriList: 'https://ok.example/x.png' }), 'https accepted');
  t.ok(droppedImageUrl({ uriList: 'data:image/png;base64,iVBORw0KGgo=' }), 'data: accepted');
});

suite('drop / dragover opts in, or the drop never happens', async (t) => {
  /*
   * A drop event only fires at all when dragover called preventDefault, so the
   * drop test above — which dispatches `drop` directly — would keep passing
   * with the feature dead in a real browser. Verified to fail by restoring the
   * 'Files'-only guard: the overlay stays hidden and the drag is not accepted.
   */
  const dt = fakeDrag({ 'text/uri-list': 'https://cdn.example/a.png' });
  const enter = fireOnWindow('dragenter', dt);
  const over = fireOnWindow('dragover', dt);
  const overlay = document.querySelector('.pk-drop-overlay');
  t.ok(over.defaultPrevented, 'dragover accepts the drag, which is what lets drop fire');
  t.ok(enter.defaultPrevented, 'dragenter accepts it too');
  t.eq(dt.dropEffect, 'copy', 'the cursor says it will be copied');
  t.ok(overlay && overlay.classList.contains('is-active'), 'the drop target shows');
  fireOnWindow('dragleave', dt);
  fireOnWindow('dragleave', dt);
  t.notOk(overlay && overlay.classList.contains('is-active'), 'and goes away again');
});

suite('drop / a dragged text selection is left alone', async (t) => {
  /*
   * A text selection carries `text/plain` and `text/html` and no
   * `text/uri-list`. Claiming it would call preventDefault on every drag of
   * text across the window. Verified to fail by adding 'text/html' to the
   * accepted types in `isOpenableDrag`: defaultPrevented flips to true.
   */
  const e = dropOnWindow(fakeDrag({ 'text/plain': 'hello', 'text/html': '<b>hello</b>' }));
  t.notOk(e.defaultPrevented, 'the browser keeps a plain text drag');
});

suite('drop / an image dragged from another tab opens whole', async (t) => {
  /*
   * The defect: `hasFiles` accepted only `dataTransfer.types` containing
   * 'Files'. An image dragged out of a web page has an EMPTY `files` list and
   * arrives as text/uri-list, so the handler returned without calling
   * preventDefault — and the browser navigated the tab to the image, taking
   * the editor with it. Verified to fail by restoring the 'Files'-only guard:
   * defaultPrevented is false and no document ever appears.
   */
  const url = pngDataUrl(37, 23, '#3366cc');
  const before = t.app.docs.length;
  const e = dropOnWindow(fakeDrag({ 'text/uri-list': url }));
  t.ok(e.defaultPrevented, 'the drop is claimed, so the tab cannot navigate away');

  const doc = await waitFor(() => t.app.docs.length > before && t.app.docs[t.app.docs.length - 1]);
  try {
    t.ok(doc, 'the dragged image opened');
    if (doc) {
      t.eq([doc.width, doc.height], [37, 23], 'opened at the image size, not scaled or cropped');
      t.pixel(doc.layers[0].canvas, 18, 11, '51,102,204,255', 'the pixels are the dragged ones');
    }
  } finally {
    if (doc) t.app.closeDocument(doc);
  }
});

suite('drop / pasting an image larger than the canvas keeps all of it', async (t) => {
  /*
   * The defect: `placedCanvas` drew the clip at 1:1 into a document-sized
   * buffer, so an image copied out of another tab lost everything past the
   * canvas edge — permanently, since a layer buffer has no room outside the
   * document. Verified to fail by passing `clip.canvas` to `pastePosition`
   * and `placedCanvas` again instead of the fitted art: inked() reports
   * 10000 (the clipped square) and all four corner colours are gone.
   */
  const doc = t.doc(100, 100, '#ffffff');
  const art = createCanvas(200, 150);
  const c = art.getContext('2d');
  c.fillStyle = '#808080';
  c.fillRect(0, 0, 200, 150);
  const corners = [
    ['#ff0000', 0, 0, '255,0,0,255', 4, 17],
    ['#00ff00', 180, 0, '0,255,0,255', 95, 17],
    ['#0000ff', 0, 130, '0,0,255,255', 4, 82],
    ['#ffff00', 180, 130, '255,255,0,255', 95, 82],
  ];
  for (const [fill, x, y] of corners) {
    c.fillStyle = fill;
    c.fillRect(x, y, 20, 20);
  }

  const held = t.app.clipboard;
  t.app.clipboard = {
    canvas: art, bounds: { x: 0, y: 0, width: 200, height: 150 },
    docId: null, width: 200, height: 150,
  };
  try {
    const layer = await paste(doc);
    t.ok(layer, 'the paste produced a layer');
    // 200x150 into 100x100 fits at exactly one half: 100x75 opaque pixels.
    t.eq(t.inked(layer.canvas), 7500, 'the whole image is there, at half size');
    for (const [, , , expected, px, py] of corners) {
      t.pixel(layer.canvas, px, py, expected, `corner ${expected} survived`);
    }
  } finally {
    t.app.clipboard = held;
  }
});

suite('drop / a paste that already fits still lands where it was copied', async (t) => {
  /*
   * The fit must be a no-op when nothing needs fitting, or every
   * same-document paste stops restoring its original coordinates. Verified to
   * fail by removing the `if (scale >= 1) return src` early exit from
   * `fitToDocument`: the clip becomes a different canvas object, so
   * `pastePosition` treats it as scaled and centres it at (30, 37) instead.
   */
  const doc = t.doc(100, 100, '#ffffff');
  const art = createCanvas(40, 25);
  const c = art.getContext('2d');
  c.fillStyle = '#ff0000';
  c.fillRect(0, 0, 40, 25);

  const held = t.app.clipboard;
  t.app.clipboard = {
    canvas: art, bounds: { x: 20, y: 30, width: 40, height: 25 },
    docId: doc.id, width: 40, height: 25,
  };
  try {
    const layer = await paste(doc);
    t.pixel(layer.canvas, 20, 30, '255,0,0,255', 'the top-left corner is back at (20, 30)');
    t.pixel(layer.canvas, 59, 54, '255,0,0,255', 'and the bottom-right at (59, 54)');
    t.pixel(layer.canvas, 19, 29, '0,0,0,0', 'nothing spilled outside it');
    t.eq(t.inked(layer.canvas), 1000, 'exactly the 40x25 that was copied');
  } finally {
    t.app.clipboard = held;
  }
});

/* ------------------------------------------------------------------ */
/* Dragging between two open Pikado documents                          */
/* ------------------------------------------------------------------ */

/** A document-sized layer holding one solid rectangle, and nothing else. */
function objectLayer(doc, color, x, y, w, h, name = 'object') {
  const layer = createRasterLayer(doc.width, doc.height, name);
  const c = layer.canvas.getContext('2d');
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
  doc.addLayer(layer);
  return layer;
}

/** A stand-in tab, so the lookup can be tested without `elementFromPoint`. */
function fakeTab(doc) {
  const tab = document.createElement('div');
  tab.className = 'pk-tab';
  if (doc) tab.dataset.docId = doc.id;
  const name = document.createElement('span');
  name.className = 'pk-tab-name';
  tab.appendChild(name);
  return tab;
}

suite('drop / a picture from another document arrives whole', async (t) => {
  /*
   * The defect this guards: drawing the source at its own size. A layer buffer
   * is document-sized with no offset, so a 400x300 document copied into a
   * 100x100 one at 1:1 keeps a 100x100 window and loses the rest. Verified to
   * fail by replacing the fit in `placeAsLayer` with `c.drawImage(source, 0, 0)`:
   * inked() reports 10000 rather than 7500 and three of the four corners vanish.
   */
  const src = t.doc(400, 300, '#ffffff');
  const art = createCanvas(400, 300);
  const c = art.getContext('2d');
  c.fillStyle = '#808080';
  c.fillRect(0, 0, 400, 300);
  const corners = [
    ['#ff0000', 0, 0, '255,0,0,255', 2, 2],
    ['#00ff00', 360, 0, '0,255,0,255', 97, 2],
    ['#0000ff', 0, 260, '0,0,255,255', 2, 72],
    ['#ffff00', 360, 260, '255,255,0,255', 97, 72],
  ];
  for (const [fill, x, y] of corners) { c.fillStyle = fill; c.fillRect(x, y, 40, 40); }

  const dest = t.doc(100, 100, '#ffffff');
  const layer = placeAsLayer(dest, art, 'from big');
  t.ok(layer, 'a layer was placed');
  // 400x300 into 100x100 fits at one quarter: 100x75 opaque pixels, centred.
  t.eq(t.inked(layer.canvas), 7500, 'the whole picture is there, at a quarter size');
  for (const [, , , expected, px, py] of corners) {
    t.pixel(layer.canvas, px, py + 13, expected, `corner ${expected} survived`);
  }
  t.ok(src, 'source document still open');
});

suite('drop / a dragged layer arrives at a size you can use', async (t) => {
  /*
   * `flattenLayers` returns a canvas the size of the SOURCE document, so a
   * 40x30 object living in a 400x300 document would be fitted as if it were
   * 400x300 and land in a small document as a speck in the corner —
   * uncropped and useless. Verified to fail by returning `flat` from
   * `artworkOf` without `cropTo`: the canvas comes back 400x300 instead of
   * 40x30, and the object measures 12x9 once placed rather than 40x30.
   */
  const src = t.doc(400, 300, '#ffffff');
  const obj = objectLayer(src, '#ff0000', 20, 20, 40, 30, 'red square');
  const art = artworkOf(src, [obj]);
  t.eq([art.width, art.height], [40, 30], 'trimmed to what the layer actually covers');
  t.eq(t.inked(art), 1200, 'and it is all object, no transparent margin');

  const dest = t.doc(120, 90, '#ffffff');
  const placed = placeAsLayer(dest, art, 'red square');
  t.eq(t.inked(placed.canvas), 1200, 'it fits without scaling, so it stays 40x30');
});

suite('drop / a full-bleed layer is not needlessly recopied', async (t) => {
  /*
   * The identity path: when a layer covers its whole canvas there is nothing to
   * trim, and `cropTo` must hand back the very same canvas rather than an
   * equal-looking copy. Verified to fail by deleting the early return in
   * `cropTo`: t.is drops to a different object. t.eq would NOT catch this — it
   * is deep, so two identical canvases compare equal.
   */
  const src = t.doc(60, 40, '#ffffff');
  const full = createCanvas(60, 40);
  t.is(cropTo(full, { x: 0, y: 0, width: 60, height: 40 }), full, 'the same canvas, not a copy');
  t.is(cropTo(full, null), full, 'and null bounds mean nothing to trim');
  t.ok(src, 'source document still open');
});

suite('drop / copying into another document leaves the source alone', async (t) => {
  /*
   * Dragging a layer between documents copies it, as it does in Photoshop —
   * the source must not lose the layer or gain a history step. Verified to
   * fail by making `copyIntoDocument` remove the layer from the source first:
   * the source drops to one layer and gains an undo step.
   */
  const src = t.doc(200, 200, '#ffffff');
  const obj = objectLayer(src, '#ff0000', 10, 10, 50, 50, 'red square');
  const dest = t.doc(100, 100, '#ffffff');
  const srcLayers = src.layers.length;
  const srcHistory = src.history.states.length;

  t.app.setActiveDoc(src);
  const placed = copyIntoDocument(dest, artworkOf(src, [obj]), 'red square');

  t.ok(placed, 'the layer landed');
  t.eq(dest.layers.length, 2, 'the destination gained exactly one layer');
  t.eq(dest.layers[0].name, 'red square', 'and it kept its name');
  t.is(t.app.activeDoc, dest, 'and we are now looking at the destination');
  t.eq(src.layers.length, srcLayers, 'the source kept every layer');
  t.eq(src.history.states.length, srcHistory, 'and gained no undo step');
});

suite('drop / a tab lookup finds its document, and never the one dragged', async (t) => {
  /*
   * Two failures this catches. Dropping a document on its own tab would
   * duplicate it into itself; and a drag released anywhere that is not a tab —
   * a Layers panel row, say — must not be read as a cross-document drop, or an
   * ordinary reorder would turn into a copy. Verified to fail by removing the
   * `exclude` comparison: "its own tab is refused" comes back with the source
   * document instead of null.
   *
   * The `[data-doc-id]` in the selector is belt-and-braces and is NOT what
   * these assertions rest on — a tab carrying no id looks up `undefined` and
   * misses either way, so loosening the selector to `.pk-tab` changes no
   * behaviour and turns nothing red. Said plainly, because a comment claiming
   * a check that does not exist is worse than no comment.
   */
  const a = t.doc(50, 50, '#ffffff', 'doc A');
  const b = t.doc(50, 50, '#ffffff', 'doc B');
  const tabA = fakeTab(a);
  const tabB = fakeTab(b);

  t.is(documentForTab(tabB, a), b, 'another document’s tab resolves to it');
  t.is(documentForTab(tabB.querySelector('.pk-tab-name'), a), b, 'a child of the tab counts too');
  t.eq(documentForTab(tabA, a), null, 'but its own tab is refused');
  t.eq(documentForTab(fakeTab(null), a), null, 'a tab naming no document is refused');

  const row = document.createElement('div');
  row.className = 'pk-lay-main';
  t.eq(documentForTab(row, a), null, 'and a Layers panel row is not a tab');
  t.eq(documentForTab(null, a), null, 'nor is nothing at all');
});

suite('drop / the drop target survives the tab bar rebuilding under it', async (t) => {
  /*
   * `tabbar.js` calls `root.replaceChildren()` on five different app events,
   * including `doc-change` — so a highlight class written onto a tab node is
   * thrown away the moment anything edits a document mid-drag. The id is the
   * state, and `render()` re-applies it from that at the end of every rebuild.
   *
   * This drives the REAL render rather than repainting by hand, because the
   * defect is precisely that `render()` might not repaint: a test that called
   * `paintDropTarget()` itself would still pass with that call missing, which
   * is the vacuous version of this test and the first one I wrote.
   * `buildTabBar` renders synchronously, which also keeps this clear of rAF —
   * a backgrounded tab never fires one.
   *
   * Verified to fail by having `setDropTarget` write the class onto the nodes
   * itself and dropping the `paintDropTarget()` call from `render()`: the
   * rebuilt bar comes back with nothing lit.
   */
  const { buildTabBar } = await import('/src/ui/tabbar.js');
  const a = t.doc(50, 50, '#ffffff', 'doc A');
  const b = t.doc(50, 50, '#ffffff', 'doc B');
  const realRoot = document.getElementById('tabbar');
  const scratch = document.createElement('div');
  document.body.appendChild(scratch);

  try {
    setDropTarget(b);
    buildTabBar(scratch);                      // a real, synchronous rebuild
    const tabs = scratch.querySelectorAll('.pk-tab');
    t.gt(tabs.length, 1, 'the rebuild produced tabs');
    t.ok([...tabs].every((n) => n.dataset.docId), 'every tab names its document');

    const lit = scratch.querySelectorAll('.pk-tab.is-drop-target');
    t.eq(lit.length, 1, 'exactly one tab is still lit after the rebuild');
    t.eq(lit[0].dataset.docId, b.id, 'and it is the one being dragged to');

    clearDropTarget();
    buildTabBar(scratch);
    t.eq(scratch.querySelectorAll('.pk-tab.is-drop-target').length, 0, 'cleared, it stays dark');
    t.ok(a, 'doc A still open');
  } finally {
    scratch.remove();
    clearDropTarget();
    if (realRoot) buildTabBar(realRoot);       // put the live tab bar back
  }
});

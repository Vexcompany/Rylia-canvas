import { app } from '../core/app.js';
import { createCanvas, ctx2d } from '../core/util.js';
import { flattenLayers, getComposite } from '../render/compositor.js';
import { layersBounds } from '../core/layer-bounds.js';
import { placeAsLayer } from '../io/open.js';
import './cross-doc-drag.css';

/**
 * Taking pixels from one open document into another by dragging.
 *
 * Three gestures end up here — a document's tab dragged onto the canvas, a
 * layer dragged onto another document's tab, and a Move-tool drag released over
 * one — so the parts they share live here and each gesture keeps only its own
 * pointer loop. What they share is small: find the tab under the cursor, light
 * it, and hand a canvas to `placeAsLayer`.
 *
 * `placeAsLayer` is the whole reason none of this crops. It scales down to fit
 * and centres, which matters here more than anywhere else: two open documents
 * are routinely different sizes, and a layer buffer is document-sized with no
 * offset (ARCHITECTURE.md golden rule 3), so anything drawn past the
 * destination's edge would not be stored anywhere at all.
 *
 * Everything hit-tests with `elementFromPoint` rather than pointer events on
 * the tabs. That is not a shortcut: `src/ui/canvas-view.js` takes
 * `setPointerCapture` on pointerdown, so during a canvas drag every pointer
 * event is delivered to the canvas and a tab never sees one.
 */

/** Id of the document whose tab is currently lit, or null. */
let targetId = null;

/**
 * The document a node belongs to, if the node is inside a tab, ignoring
 * `exclude` so a drag can never land back where it started.
 *
 * Split from the hit test below so it can be tested: the suite boots the app
 * shell off-screen at `left: -20000px`, which puts every real tab outside the
 * viewport, and `elementFromPoint` answers null for anything out there.
 *
 * @param {Element|null} node
 * @param {import('../core/document.js').PikaDocument|null} [exclude]
 */
export function documentForTab(node, exclude = null) {
  const tab = node && node.closest ? node.closest('.pk-tab[data-doc-id]') : null;
  if (!tab) return null;
  const doc = app.docs.find((d) => d.id === tab.dataset.docId);
  return doc && doc !== exclude ? doc : null;
}

/**
 * The document whose tab is under the cursor, ignoring `exclude`.
 * @param {number} clientX
 * @param {number} clientY
 * @param {import('../core/document.js').PikaDocument|null} [exclude]
 */
export function documentTabUnder(clientX, clientY, exclude = null) {
  return documentForTab(document.elementFromPoint(clientX, clientY), exclude);
}

/** Whether the cursor is over the canvas area rather than a panel or the tabs. */
export function overCanvasArea(clientX, clientY) {
  const node = document.elementFromPoint(clientX, clientY);
  return !!(node && node.closest && node.closest('#canvas-area'));
}

/** Light the tab of `doc` as the drop target, or clear it with null. */
export function setDropTarget(doc) {
  const id = doc ? doc.id : null;
  if (id === targetId) return;
  targetId = id;
  paintDropTarget();
}

/** Clear the drop target and any canvas-area highlight. */
export function clearDropTarget() {
  targetId = null;
  paintDropTarget();
  setCanvasTarget(false);
}

/**
 * Put the highlight on whichever tabs exist at this moment.
 *
 * The id is the state and the class is derived from it, because `tabbar.js`
 * rebuilds every tab from scratch on five different app events — a class set on
 * the node itself would disappear the first time anything emitted `doc-change`
 * mid-drag. `tabbar.render()` calls this at the end of every rebuild.
 */
export function paintDropTarget() {
  for (const tab of document.querySelectorAll('.pk-tab')) {
    tab.classList.toggle('is-drop-target', !!targetId && tab.dataset.docId === targetId);
  }
}

/** Outline the canvas area while a tab is being dragged over it. */
export function setCanvasTarget(on) {
  const area = document.getElementById('canvas-area');
  if (area) area.classList.toggle('pk-crossdoc-target', !!on);
}

/**
 * Copy `canvas` into `dest` as a new layer and go there.
 *
 * Activating first so the layer appears in the document you are then looking
 * at, rather than landing silently in one you are not.
 */
export function copyIntoDocument(dest, canvas, name) {
  if (!dest || !canvas) return null;
  app.setActiveDoc(dest);
  return placeAsLayer(dest, canvas, name);
}

/** The part of `src` inside `bounds` — `src` itself when that is all of it. */
export function cropTo(src, bounds) {
  if (!bounds || !src) return src || null;
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const w = Math.min(src.width - x, Math.ceil(bounds.width));
  const h = Math.min(src.height - y, Math.ceil(bounds.height));
  if (w <= 0 || h <= 0) return src;
  if (x === 0 && y === 0 && w === src.width && h === src.height) return src;
  const out = createCanvas(w, h);
  ctx2d(out).drawImage(src, -x, -y);
  return out;
}

/**
 * The pixels of `layers` as one canvas, trimmed to what they actually cover.
 *
 * `flattenLayers` returns a canvas the size of the SOURCE document, so a 40x30
 * object living in a 4000x3000 document would arrive in a small one scaled to
 * nothing in a corner — technically uncropped and completely useless. Trimming
 * to the content first is what makes a dragged layer land at a size you can
 * work with. Where a layer fills its canvas the two are the same thing, so this
 * only ever helps.
 *
 * `layersBounds` is cached on the pixel buffer and is already tile-aware, so
 * this does not rescan or expand a compact layer. It returns null for a group
 * (a group holds no pixels of its own), and then the untrimmed flatten is used,
 * which is correct if not tight.
 */
export function artworkOf(doc, layers) {
  const flat = flattenLayers(doc, layers);
  return cropTo(flat, layersBounds(layers));
}

/** A whole document flattened, for a tab dragged onto another document. */
export function artworkOfDocument(doc) {
  // `getComposite` is cached and shared — read it, never hold or write to it.
  return getComposite(doc);
}

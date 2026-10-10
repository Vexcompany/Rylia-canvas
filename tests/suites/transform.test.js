import { suite } from '../harness.js';
import { createRasterLayer } from '/src/core/layer.js';

suite('transform / numeric scaling, aspect lock, skew, flip and rotate', async (t) => {
  const doc = t.doc(120, 80, null, 'transform-controls');
  const layer = createRasterLayer(doc.width, doc.height, 'Transform target');
  const ctx = layer.canvas.getContext('2d');
  ctx.fillStyle = '#e63946';
  ctx.fillRect(12, 14, 40, 20);
  doc.layers.unshift(layer);
  doc.setActiveLayer(layer.id);

  const before = t.bytes(layer.canvas).slice();
  const transform = await import('/src/tools/transform.js');
  const session = transform.startTransform(doc, { layers: [layer] });
  t.ok(session, 'a transform session starts for an editable pixel layer');
  if (!session) return;

  t.eq(transform.getTransformNumeric().lockAspectRatio, false, 'aspect lock starts off');
  transform.setTransformAspectLock(true);
  transform.setTransformNumeric({ width: 150 });
  let values = transform.getTransformNumeric();
  t.close(values.width, 150, 0.01, 'numeric width updates to 150%');
  t.close(values.height, 150, 0.01, 'a locked width scales height proportionally');

  transform.setTransformNumeric({ height: 50 });
  values = transform.getTransformNumeric();
  t.close(values.width, 50, 0.01, 'editing height also updates width proportionally');
  t.close(values.height, 50, 0.01, 'numeric height updates to 50%');

  transform.setTransformNumeric({ skewY: 12 });
  t.close(transform.getTransformNumeric().skewY, 12, 0.01, 'vertical skew is numerically editable');

  transform.flipTransform('h');
  t.close(transform.getTransformNumeric().width, -50, 0.01, 'horizontal flip is reflected in the scale field');
  transform.rotateTransform(90);
  t.close(transform.getTransformNumeric().angle, 90, 0.01, 'quick rotation updates the numeric angle');

  transform.cancelTransform();
  t.eq(t.mad(before, t.bytes(layer.canvas)), 0, 'cancel restores the original layer pixels exactly');
});

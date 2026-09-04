/*
 * LoadImageCrop - visual crop for the official Load Image preview.
 *
 * Architecture:
 *  - No static ES imports: the frontend serves /scripts/app.js as a shim that
 *    reads window.comfyAPI at evaluation time, so it is imported dynamically
 *    (absolute path) with a retry loop.
 *  - The official image preview is the canvas-drawn custom widget
 *    "$$canvas-image-preview". We wrap its drawWidget (called with
 *    (ctx, {width, previewImages}) and reading widget.y / widget.computedHeight)
 *    to:
 *      1. let the core draw the image (it defers the drawImage to a
 *         queueMicrotask, so a synchronous overlay would be covered);
 *      2. queue our own microtask AFTER the core's, and draw the crop
 *         overlay (dim outside + red border + output size) using the same
 *         transform the core captured -> pixel-perfect alignment.
 *  - Interaction:
 *      * crop drag  -> wraps widget.onPointerDown: the drag starts only when
 *        the pointer is INSIDE the crop box (clicks elsewhere keep the core
 *        canvas behavior); in Free mode a corner hit resizes the box instead
 *        of moving it. The pointer session's onDrag plus the node-level
 *        onMouseMove / onMouseUp track the drag.
 *      * wheel zoom -> capture-phase "wheel" listener on document with a
 *        manual hit-test (there is no node-level onWheel hook), so the
 *        canvas pan/zoom is preempted only while the cursor is on the preview.
 *  - The crop is stored as normalized floats in the (hidden) crop_x/y/w/h
 *    widgets so it serializes into the workflow and is usable via API.
 *  - "Original" aspect ratio (default): no crop area is drawn, drag/zoom are
 *    disabled and the (hidden) crop widgets hold the full frame, so the image
 *    passes through uncropped.
 *  - "Free (Custom)" aspect ratio: the box can be any size. Drag a corner
 *    handle to resize it freely (the opposite corner stays fixed), drag
 *    inside to move it; the wheel zooms keeping the box's own ratio.
 *  - 2.0 / Vue nodes mode (LiteGraph.vueNodesMode): the canvas preview
 *    widget does not exist there - the image is a DOM <img> (object-contain)
 *    inside the node's [data-node-id] element. The overlay is a positioned
 *    div on top of that image and pointer/wheel events are handled directly
 *    on the DOM element (the node's DOM is pointer-events-none, so without
 *    this the canvas pan/zoom would swallow the interaction). The same
 *    normalized crop state and the same crop_* widgets are used, so the
 *    behavior is identical in both modes.
 */
const LIRC = {
  NODE_NAME: "LoadImageCrop",
  PREVIEW_WIDGET: "$$canvas-image-preview",
  CROP_KEYS: ["crop_x", "crop_y", "crop_w", "crop_h"],
  TAG: "[LoadImageCrop]"
};

let lircApp = null;

/* ------------------------------ helpers ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function widgetOf(node, name) {
  return node.widgets ? node.widgets.find((w) => w.name === name) : null;
}

function getState(node) {
  if (!node.__lirc) {
    node.__lirc = {
      inited: false,
      crop: null,      // {x,y,w,h} normalized 0..1 in image space
      cropFromWorkflow: false,
      rect: null,      // cached displayed image rect, node-local {x,y,w,h}
      dragging: false,
      dragOff: null,   // grab state: {nx, ny} pointer offset, {cx, cy, cw, ch} box at grab,
                      // {corner} "nw"/"ne"/"sw"/"se" while resizing (Free mode)
      lastKey: null,
      lastSrc: null,   // last displayed image src (file-change detection)
    };
  }
  return node.__lirc;
}

/** Aspect-ratio mode: null ("Original" = no crop), "free" (user-shaped
 * box), or a positive number for the preset "W:H" entries. */
function ratioOf(node) {
  const w = widgetOf(node, "aspect_ratio");
  const v = w ? String(w.value) : "Original";
  // "Original" (or no ratio match) -> no crop at all
  if (/^\s*original\b/i.test(v)) return null;
  // "Free (Custom)" -> user-drawn box, any shape
  if (/^\s*free\b/i.test(v)) return "free";
  // values look like "3:2 (Photo)" -> take the leading "W:H"
  const m = v.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const r = parseFloat(m[1]) / parseFloat(m[2]);
    if (isFinite(r) && r > 0) return r;
  }
  return 1;
}

function imgOf(node) {
  const imgs = node.imgs;
  if (!Array.isArray(imgs) || !imgs.length) return null;
  const idx = Number.isInteger(node.imageIndex) ? node.imageIndex : 0;
  return imgs[idx] || imgs[0];
}

function naturalSize(node) {
  const img = imgOf(node);
  if (!img) return null;
  return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height, src: img.src };
}

/** Largest rect (normalized) with the given aspect ratio fitting the image. */
function maxFitRatio(ratio, imgW, imgH) {
  if (ratio <= imgW / imgH) return { w: (ratio * imgH) / imgW, h: 1 };
  return { w: 1, h: imgW / (ratio * imgH) };
}

/** The default Free box: a centered 90x90% area. With a full-frame box the
 * corner handles would sit exactly on the image corners, i.e. on the node
 * border, where the core canvas grabs the pointer for a node drag instead of
 * letting us start the resize. Dragging a handle to the edge still reaches
 * the exact full-frame crop (the clamping allows it). */
function freeCrop() {
  return { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
}

function resetCrop(node) {
  const st = getState(node);
  const m = ratioOf(node);
  if (m == null) {
    // "Original": no crop
    st.crop = null;
    st.cropFromWorkflow = false;
    return;
  }
  const n = naturalSize(node);
  if (!n) return;
  if (m === "free") {
    // Free keeps the current box (e.g. left over from a preset) or starts
    // with the default Free box; the user then shapes it with the handles.
    st.crop = st.crop || freeCrop();
    fitCrop(node, st.crop);
    st.cropFromWorkflow = false;
    return;
  }
  const fr = maxFitRatio(m, n.w, n.h);
  st.crop = { x: (1 - fr.w) / 2, y: (1 - fr.h) / 2, w: fr.w, h: fr.h };
  st.cropFromWorkflow = false;
}

/** Clamp crop to image bounds. Presets keep the ratio (height-driven);
 * "free" keeps the drawn shape (min size + bounds only). */
function fitCrop(node, c) {
  const n = naturalSize(node);
  if (!n) return c;
  const ratio = ratioOf(node);
  if (ratio === "free") {
    c.w = Math.min(Math.max(c.w, 0.02), 1);
    c.h = Math.min(Math.max(c.h, 0.02), 1);
    c.x = Math.min(Math.max(0, c.x), Math.max(0, 1 - c.w));
    c.y = Math.min(Math.max(0, c.y), Math.max(0, 1 - c.h));
    return c;
  }
  // normalized image space: w/h = ratio * (imgH/imgW)
  const k = ratio * (n.h / n.w);
  const fr = maxFitRatio(ratio, n.w, n.h);
  c.h = Math.min(Math.max(c.h, 0.02), fr.h);
  c.w = c.h * k;
  c.x = Math.min(Math.max(0, c.x), Math.max(0, 1 - c.w));
  c.y = Math.min(Math.max(0, c.y), Math.max(0, 1 - c.h));
  return c;
}

function initCropFromWidgets(node) {
  const st = getState(node);
  const m = ratioOf(node);
  if (m == null) {
    // "Original": ignore any saved crop, always full frame
    st.crop = null;
    writeCrop(node);
    return;
  }
  if (st.crop) return;
  const g = (k) => {
    const w = widgetOf(node, k);
    return w && Number.isFinite(w.value) ? w.value : undefined;
  };
  let x = g("crop_x"), y = g("crop_y"), w = g("crop_w"), h = g("crop_h");
  if (x == null || y == null || w == null || h == null) {
    resetCrop(node);
    writeCrop(node);
  } else if (m !== "free" && x === 0 && y === 0 && w === 1 && h === 1) {
    // Python defaults == "no crop saved yet" -> derive from the ratio
    // (a full-frame Free box is a legitimate saved shape, keep it)
    resetCrop(node);
    writeCrop(node);
  } else {
    st.crop = { x, y, w, h };
    st.cropFromWorkflow = true;
    fitCrop(node, st.crop);
  }
}

function writeCrop(node) {
  const st = getState(node);
  // no crop yet: full frame for "Original"/presets, default Free box for Free
  const c = st.crop || (ratioOf(node) === "free" ? freeCrop() : { x: 0, y: 0, w: 1, h: 1 });
  // "Original" -> write the full frame so a run without frontend interaction
  // returns the image as-is
  const map = { crop_x: "x", crop_y: "y", crop_w: "w", crop_h: "h" };
  for (const [key, prop] of Object.entries(map)) {
    const w = widgetOf(node, key);
    if (w) w.value = c[prop];
  }
}

function markDirty(node) {
  try {
    if (node.graph && typeof node.graph.setDirtyCanvas === "function") {
      node.graph.setDirtyCanvas(true);
    }
  } catch (_) { /* ignore */ }
}

/** Is the node-local point p inside the displayed crop box (rect + crop)? */
function insideCropBox(p, st) {
  const r = st.rect, c = st.crop;
  if (!r || !c) return false;
  const nx = (p[0] - r.x) / r.w;
  const ny = (p[1] - r.y) / r.h;
  return nx >= c.x && nx <= c.x + c.w && ny >= c.y && ny <= c.y + c.h;
}

/** Free mode: the crop-box corner the node-local point p is near (within a
 * screen-pixel threshold, so it works at any zoom), or null. */
function cornerAt(p, node) {
  const st = node.__lirc;
  const nat = naturalSize(node);
  const r = st && st.rect, c = st && st.crop;
  if (!r || !c || !nat) return null;
  // screen px -> node-local units through the canvas zoom
  const z = (lircApp && lircApp.canvas && lircApp.canvas.ds && lircApp.canvas.ds.scale) || 1;
  const th = 18 / z; // 18 screen px, in node-local units
  const cx = r.x + c.x * r.w, cy = r.y + c.y * r.h;
  const cw = c.w * r.w, ch = c.h * r.h;
  const pts = { nw: [cx, cy], ne: [cx + cw, cy], sw: [cx, cy + ch], se: [cx + cw, cy + ch] };
  let best = th, hit = null;
  for (const k of Object.keys(pts)) {
    const d = Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]);
    if (d < best) { best = d; hit = k; }
  }
  return hit;
}

function pointInRect(p, r) {
  return p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
}

function nodeLocalPos(node, canvas) {
  // graph_mouse is in the same coordinate space as node.pos (the core
  // compares graph_mouse against node.pos + offsets)
  const gm = canvas && canvas.graph_mouse;
  if (!gm) return null;
  return [gm[0] - node.pos[0], gm[1] - node.pos[1]];
}

/**
 * Node-local position of a DOM pointer/mouse event. Uses clientX/clientY
 * (no assumptions about which element received the event), converted with
 * the canvas' viewport math. Returns [x, y] in node-local canvas units.
 */
function eventToNodeLocal(e, node, canvas) {
  if (!e || !canvas || typeof canvas.clientPosToCanvasPos !== "function") {
    return null;
  }
  try {
    const p = canvas.clientPosToCanvasPos([e.clientX, e.clientY]);
    if (!p) return null;
    return [p[0] - node.pos[0], p[1] - node.pos[1]];
  } catch (_) {
    return null;
  }
}

/* --------------------------- overlay drawing -------------------------- */

/**
 * Called from the wrapped widget.drawWidget, AFTER the core's renderPreview
 * ran. Mirrors the core's single-image fit math exactly:
 *   dw = options.width, dh = computedHeight - d, d = 15 when the
 *   "Comfy.Node.AllowImageSizeDraw" setting is on (default), 0 otherwise.
 *   scale = min(dw/nw, dh/nh, 1); x = (dw-w)/2; y = (dh-h)/2 + widget.y
 */
function sizeDrawOffset() {
  try {
    // The setting store is not exposed globally; default is true (15).
    // If a future build exposes it, honor it.
    const st = window.comfyAPI?.settingStore;
    if (st && typeof st.get === "function") {
      return st.get("Comfy.Node.AllowImageSizeDraw") === false ? 0 : 15;
    }
  } catch (_) { /* ignore */ }
  return 15;
}

function scheduleOverlay(node, ctx, widget, width, imgsArg) {
  const st = getState(node);
  const imgs = imgsArg || node.imgs;
  if (!Array.isArray(imgs) || !imgs.length || !node.size) {
    st.rect = null;
    return;
  }
  let idx = node.imageIndex;
  if (imgs.length === 1 && !idx) idx = 0;
  const img = imgs[idx];
  if (!img) { st.rect = null; return; }
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (!nw || !nh) { st.rect = null; return; }

  // grid mode (multiple images, no selection) -> the core draws a grid we
  // don't model; skip the overlay until the user picks one cell
  if (node.imageIndex == null) {
    st.rect = null;
    return;
  }

  const dw = width;
  const dh = (widget.computedHeight || 0) - sizeDrawOffset();
  if (!(dw > 0) || !(dh > 0)) { st.rect = null; return; }

  const scale = Math.min(dw / nw, dh / nh, 1);
  const w = nw * scale;
  const h = nh * scale;
  const x = (dw - w) / 2;
  const y = (dh - h) / 2 + (widget.y || 0);
  st.rect = { x, y, w, h };

  // If the displayed image or the ratio changed -> (re)initialize the crop.
  const key = `${img.src}|${ratioOf(node)}`;
  if (st.lastKey !== key) {
    st.lastKey = key;
    // a Free crop starts full-frame on a new image
    if (ratioOf(node) === "free" && st.lastSrc !== img.src) st.crop = null;
    st.lastSrc = img.src;
    if (!st.cropFromWorkflow) {
      resetCrop(node);
      // write the crop into the (hidden) widgets so a run without mouse
      // interaction crops exactly what the overlay shows
      writeCrop(node);
    } else {
      if (st.crop) {
        fitCrop(node, st.crop);
      } else {
        resetCrop(node);
      }
      writeCrop(node);
    }
    st.cropFromWorkflow = false;
  }

  const transform = ctx.getTransform();
  const filter = ctx.filter;
  // Queued after the core's deferred drawImage microtask (FIFO) -> the
  // overlay is painted over the image, before the browser paints the frame.
  queueMicrotask(() => drawOverlay(node, ctx, transform, filter));
}

function drawOverlay(node, ctx, transform, filter) {
  const st = node.__lirc;
  if (!st || !st.rect || !st.crop) return;
  const { x: px, y: py, w: pw, h: ph } = st.rect;
  const c = st.crop;
  const rx = px + c.x * pw;
  const ry = py + c.y * ph;
  const rw = c.w * pw;
  const rh = c.h * ph;
  try {
    ctx.save();
    ctx.setTransform(transform);
    ctx.filter = filter;
    // dim everything outside the crop, clipped to the image rect
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, pw, ph);
    ctx.clip();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(px, py, pw, ry - py);
    ctx.fillRect(px, ry + rh, pw, py + ph - ry - rh);
    ctx.fillRect(px, ry, rx - px, rh);
    ctx.fillRect(rx + rw, ry, px + pw - rx - rw, rh);
    ctx.restore();
    // crop border
    ctx.strokeStyle = "#ff4040";
    ctx.lineWidth = 2;
    ctx.strokeRect(rx + 1, ry + 1, Math.max(2, rw - 2), Math.max(2, rh - 2));
    // Free-mode corner handles (white squares on the box corners)
    if (ratioOf(node) === "free") {
      const hs = 7;
      const corners = [
        [rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]
      ];
      for (const [hx, hy] of corners) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
      }
    }
    // output size label
    const img = imgOf(node);
    if (img) {
      const ow = Math.round(c.w * (img.naturalWidth || img.width));
      const oh = Math.round(c.h * (img.naturalHeight || img.height));
      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      const label = `${ow} × ${oh}`;
      let ly = ry - 6;
      if (ly < py + 12) ly = ry + 14;
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      const tw = ctx.measureText(label).width;
      ctx.fillRect(rx + 4, ly - 11, tw + 8, 14);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, rx + 8, ly);
    }
    ctx.restore();
  } catch (e) {
    console.warn(LIRC.TAG, "overlay draw failed", e);
  }
}

/* --------------------------- crop drag -------------------------------- */

/** Shared drag-end: finalize the crop (also called from the pointer session). */
function endCropDrag(node) {
  const s = getState(node);
  if (s.dragging) {
    s.dragging = false;
    s.dragOff = null;
    if (s.crop) {
      fitCrop(node, s.crop);
      writeCrop(node);
    }
    markDirty(node);
  }
  try {
    const c = lircApp && lircApp.canvas && lircApp.canvas.canvas;
    if (c) c.style.cursor = "";
  } catch (_) { /* ignore */ }
}

/** Apply one drag step: move the box (grab point follows the pointer), or
 * resize it from a corner when corner is set (the opposite corner stays
 * fixed). p is the pointer in normalized image space. */
function stepCropDrag(node, off, p) {
  const s = getState(node);
  if (!s.crop) return;
  if (off.corner) {
    const fx = off.corner === "nw" || off.corner === "sw" ? off.cx + off.cw : off.cx;
    const fy = off.corner === "nw" || off.corner === "ne" ? off.cy + off.ch : off.cy;
    s.crop.x = Math.min(fx, p[0]);
    s.crop.y = Math.min(fy, p[1]);
    s.crop.w = Math.abs(p[0] - fx);
    s.crop.h = Math.abs(p[1] - fy);
  } else {
    s.crop.x = p[0] - off.nx + off.cx;
    s.crop.y = p[1] - off.ny + off.cy;
  }
  fitCrop(node, s.crop);
  writeCrop(node);
  markDirty(node);
}

/** Move (or resize, in Free mode) the crop toward the DOM pointer event. */
function dragCropTo(e, node, canvas) {
  const s = getState(node);
  if (!s.dragging || !s.rect || !s.crop || !s.dragOff) return;
  const p = eventToNodeLocal(e, node, canvas) || nodeLocalPos(node, canvas);
  if (!p) return;
  const r = s.rect;
  stepCropDrag(node, s.dragOff, [(p[0] - r.x) / r.w, (p[1] - r.y) / r.h]);
}

/* --------------------------- widget wrapping -------------------------- */

function wrapPreviewWidget(node) {
  const w = widgetOf(node, LIRC.PREVIEW_WIDGET);
  if (!w || w.__lircWrapped) return;
  w.__lircWrapped = true;

  const origDraw = w.drawWidget ? w.drawWidget.bind(w) : null;
  w.drawWidget = (ctx, options) => {
    try {
      if (origDraw) origDraw(ctx, options);
    } catch (e) {
      console.warn(LIRC.TAG, "core preview draw", e);
    }
    try {
      scheduleOverlay(node, ctx, w, options && options.width, options && options.previewImages);
    } catch (e) {
      console.warn(LIRC.TAG, "overlay schedule", e);
    }
  };

  const origPointerDown = w.onPointerDown ? w.onPointerDown.bind(w) : null;
  w.onPointerDown = (pointer, nodeArg, canvas) => {
    const st = getState(node);
    // Prefer the DOM event (clientX/Y -> viewport math): the mini-canvas
    // pointer path in the Vue frontend overwrites graph_mouse with
    // widget-row-relative offsets, so graph_mouse is not reliable here.
    const ev = pointer && pointer.eDown;
    const p = (ev ? eventToNodeLocal(ev, node, canvas) : null) || nodeLocalPos(node, canvas);
    // Free mode: a hit on a box corner resizes the box (opposite corner
    // fixed); elsewhere inside the box it moves as before
    const corner = st.rect && st.crop && p && ratioOf(node) === "free" ? cornerAt(p, node) : null;
    if (st.rect && st.crop && p && (corner || insideCropBox(p, st))) {
      // consume: crop drag instead of node drag; remember where (in
      // normalized image space) the grab happened so the rectangle follows
      // the pointer without jumping
      const nx = (p[0] - st.rect.x) / st.rect.w;
      const ny = (p[1] - st.rect.y) / st.rect.h;
      st.dragging = true;
      st.dragOff = { nx, ny, cx: st.crop.x, cy: st.crop.y, cw: st.crop.w, ch: st.crop.h, corner };
      // Drive the drag from the pointer session itself. In the Vue frontend
      // the widget's mini-canvas captures the pointer and stops propagation,
      // so the node-level onMouseDown/onMouseMove are never fired there;
      // the session's onDrag is the only reliable path (legacy mode keeps
      // node.onMouseMove as a fallback, same absolute math).
      if (pointer) {
        pointer.onDragStart = () => {};
        pointer.onDrag = (e) => dragCropTo(e, node, canvas);
        pointer.onDragEnd = () => endCropDrag(node);
      }
      try {
        const cur = corner ? (corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize") : "move";
        if (canvas && canvas.canvas) canvas.canvas.style.cursor = cur;
      } catch (_) { /* ignore */ }
      return true;
    }
    // outside the crop box -> keep the core canvas behavior (node
    // select/move), same as the official Load Image
    if (origPointerDown) return origPointerDown(pointer, nodeArg, canvas);
    return false;
  };
}

/* --------------------------- node init/hooking ------------------------ */

function initNode(node) {
  try {
    if (!node || node.type !== LIRC.NODE_NAME) return;
    const st = getState(node);
    // remove unlinked FLOAT slots: this node has no linkable inputs
    const inputs = node.inputs;
    if (Array.isArray(inputs)) {
      for (let i = inputs.length - 1; i >= 0; i--) {
        const slot = inputs[i];
        if (slot && slot.type === "FLOAT" && slot.link == null) {
          try {
            if (typeof node.removeInput === "function") node.removeInput(slot);
          } catch (_) { /* ignore */ }
          if (Array.isArray(node.inputs)) {
            const j = node.inputs.indexOf(slot);
            if (j !== -1) node.inputs.splice(j, 1);
          }
        }
      }
    }
    if (!st.inited) {
      st.inited = true;
      // hide the crop_* fields on the node (they still serialize); the 2.0
      // renderer filters on options.hidden, classic litegraph on hidden
      for (const key of LIRC.CROP_KEYS) {
        const w = widgetOf(node, key);
        if (!w) continue;
        w.hidden = true;
        if (!w.options || typeof w.options !== "object") w.options = {};
        w.options.hidden = true;
      }
      // keep the aspect_ratio widget's change in sync with the crop
      const ar = widgetOf(node, "aspect_ratio");
      if (ar && !ar.__lircBound) {
        ar.__lircBound = true;
        const prev = ar.callback;
        ar.callback = (v) => {
          const n = naturalSize(node);
          const r = ratioOf(node);
          if (r == null) {
            // "Original": drop the crop area entirely
            st.crop = null;
          } else if (r === "free") {
            // Free keeps the box the user has drawn (or the default Free box)
            if (n) {
              st.crop = st.crop || freeCrop();
              fitCrop(node, st.crop);
            }
          } else if (n) {
            const fr = maxFitRatio(r, n.w, n.h);
            st.crop = { x: (1 - fr.w) / 2, y: (1 - fr.h) / 2, w: fr.w, h: fr.h };
          }
          st.cropFromWorkflow = false;
          writeCrop(node);
          if (typeof prev === "function") prev(v);
          if (isVueMode()) layoutVueOverlay(node);
          markDirty(node);
        };
      }
      // image change -> refresh combo values are handled by the core; we just
      // re-sync the crop when the displayed image changes (done in overlay).
      const imgW = widgetOf(node, "image");
      if (imgW && !imgW.__lircBound) {
        imgW.__lircBound = true;
        const prev = imgW.callback;
        imgW.callback = (v) => {
          if (typeof prev === "function") prev(v);
          // let the core load the image; crop resets when the overlay sees a
          // new image key (handled in scheduleOverlay)
        };
      }
      // mouse tracking (node-level; fallback for non-Vue frontends plus
      // cursor feedback whenever the mouse is over the node)
      node.onMouseMove = (e, pos) => {
        const s = getState(node);
        if (s.dragging && s.rect && s.crop && s.dragOff) {
          const r = s.rect;
          // pointer in normalized image space
          stepCropDrag(node, s.dragOff, [(pos[0] - r.x) / r.w, (pos[1] - r.y) / r.h]);
        } else if (s.rect) {
          let cur = "";
          if (s.crop) {
            const corner = ratioOf(node) === "free" ? cornerAt(pos, node) : null;
            if (corner) {
              cur = corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
            } else if (insideCropBox(pos, s)) {
              cur = "move";
            }
          }
          try {
            const c = lircApp && lircApp.canvas && lircApp.canvas.canvas;
            if (c) c.style.cursor = cur;
          } catch (_) { /* ignore */ }
        }
      };
      node.onMouseUp = () => endCropDrag(node);
      node.onMouseLeave = () => endCropDrag(node);
      // the core adds the preview widget asynchronously (when the image has
      // loaded), so re-check every frame and wrap it lazily
      const prevDrawFg = node.onDrawForeground;
      node.onDrawForeground = (ctx, canvas, canvasEl) => {
        try { wrapPreviewWidget(node); } catch (_) { /* ignore */ }
        if (typeof prevDrawFg === "function") prevDrawFg.call(node, ctx, canvas, canvasEl);
      };
      // context menu: the 2.0 menu already contains the core "Paste Image"
      // entry, so ours is added only in classic mode; both entries drive
      // the native node.pasteFile / node.pasteFiles methods
      node.getExtraMenuOptions = (canvas, options) => {
        const items = [];
        if (!isVueMode()) {
          items.push({
            content: "Paste Image from Clipboard",
            callback: () => pasteFromClipboard(node)
          });
        }
        return items.concat(options || []);
      };
      initCropFromWidgets(node);
    }
    wrapPreviewWidget(node);
  } catch (e) {
    console.warn(LIRC.TAG, "initNode", e);
  }
}

/* --------------------- 2.0 / Vue nodes mode (DOM) -------------------- */

function isVueMode() {
  try {
    return typeof LiteGraph !== "undefined" && LiteGraph.vueNodesMode === true;
  } catch (_) {
    return false;
  }
}

/** Locate the 2.0 preview DOM: panel + <img> inside the node element. */
function vuePartsOf(node) {
  const root = document.querySelector(`[data-node-id="${node.id}"]`);
  if (!root) return null;
  const img = root.querySelector('div[class*="image-preview"] img');
  if (!img) return null;
  const panel =
    img.closest('div[class*="group/panel"]') || img.parentElement;
  return { img, panel };
}

function removeVueOverlay(node) {
  const st = node.__lirc;
  if (st && st.vue && st.vue.ov && st.vue.ov.parentElement) {
    st.vue.ov.parentElement.removeChild(st.vue.ov);
  }
  if (st && st.vue && st.vue.ro) {
    try { st.vue.ro.disconnect(); } catch (_) { /* ignore */ }
  }
  if (st) st.vue = null;
}

/**
 * Re-sync the DOM overlay: (re)create it when the panel or the <img> changed
 * under us (Vue re-renders replace DOM elements), re-init the crop on image
 * or ratio change, and position the crop box over the object-contain area.
 */
function layoutVueOverlay(node) {
  const st = getState(node);
  const parts = vuePartsOf(node);
  if (!parts || !parts.img.complete || !parts.img.naturalWidth) return;

  const vw = parts.img.naturalWidth;
  const vh = parts.img.naturalHeight;
  const key = `${parts.img.src}|${ratioOf(node)}|${vw}x${vh}`;
  if (st.lastKey !== key) {
    st.lastKey = key;
    const r = ratioOf(node);
    if (r == null) {
      st.crop = null;
    } else if (r === "free") {
      // Free: the default Free box on a new image, keep the drawn box on a
      // ratio-only change; clamp to bounds + min size
      if (st.lastSrc !== parts.img.src || !st.crop) st.crop = freeCrop();
      st.crop.w = Math.min(Math.max(st.crop.w, 0.02), 1);
      st.crop.h = Math.min(Math.max(st.crop.h, 0.02), 1);
      st.crop.x = Math.min(Math.max(0, st.crop.x), Math.max(0, 1 - st.crop.w));
      st.crop.y = Math.min(Math.max(0, st.crop.y), Math.max(0, 1 - st.crop.h));
    } else if (!st.cropFromWorkflow) {
      const fr = maxFitRatio(r, vw, vh);
      st.crop = { x: (1 - fr.w) / 2, y: (1 - fr.h) / 2, w: fr.w, h: fr.h };
    } else if (st.crop) {
      // same clamp as the classic path (fitCrop): keep the saved size and
      // position, clamped to the image bounds
      const k = r * (vh / vw);
      const fr = maxFitRatio(r, vw, vh);
      const h = Math.min(Math.max(st.crop.h, 0.02), fr.h);
      const w = h * k;
      st.crop = {
        x: Math.min(Math.max(0, st.crop.x), Math.max(0, 1 - w)),
        y: Math.min(Math.max(0, st.crop.y), Math.max(0, 1 - h)),
        w,
        h,
      };
    } else {
      // no saved box (e.g. the ratio was Original before): derive the default
      const fr = maxFitRatio(r, vw, vh);
      st.crop = { x: (1 - fr.w) / 2, y: (1 - fr.h) / 2, w: fr.w, h: fr.h };
    }
    st.lastSrc = parts.img.src;
    st.cropFromWorkflow = false;
    writeCrop(node);
  }

  const same =
    st.vue && st.vue.panel === parts.panel && st.vue.img === parts.img;
  if (!same) buildVueOverlay(node, parts);
  if (!st.vue) return;

  const ov = st.vue.ov;
  const box = st.vue.box;
  const label = st.vue.label;
  const c = st.crop;
  if (!c) {
    ov.style.display = "none";
    return;
  }
  ov.style.display = "";
  // displayed image area inside the panel (object-contain)
  const pw = parts.panel.clientWidth || 1;
  const ph = parts.panel.clientHeight || 1;
  const s = Math.min(pw / vw, ph / vh);
  const dw = vw * s;
  const dh = vh * s;
  const ox = (pw - dw) / 2;
  const oy = (ph - dh) / 2;
  const l = ((ox + c.x * dw) / pw) * 100;
  const t = ((oy + c.y * dh) / ph) * 100;
  const ww = (c.w * dw) / pw * 100;
  const hh = (c.h * dh) / ph * 100;
  box.style.left = l + "%";
  box.style.top = t + "%";
  box.style.width = ww + "%";
  box.style.height = hh + "%";
  const ow = Math.round(c.w * vw);
  const oh = Math.round(c.h * vh);
  label.textContent = `${ow} × ${oh}`;
  // room for the label inside the box?
  label.style.display = box.offsetHeight > 18 ? "" : "none";
  // corner handles are only useful in Free mode (presets keep their ratio)
  const hs = st.vue.handles;
  if (hs) for (const h of hs) h.style.display = ratioOf(node) === "free" ? "" : "none";
}

function buildVueOverlay(node, parts) {
  const st = getState(node);
  if (st.vue) removeVueOverlay(node);

  const ov = document.createElement("div");
  ov.dataset.lircOverlay = "1";
  ov.style.cssText =
    "position:absolute;inset:0;z-index:1;touch-action:none;cursor:default;";
  const box = document.createElement("div");
  box.style.cssText =
    "position:absolute;box-sizing:border-box;border:2px solid #ff4040;box-shadow:0 0 0 4000px rgba(0,0,0,0.55);";
  const label = document.createElement("div");
  label.style.cssText =
    "position:absolute;left:4px;top:2px;font:11px monospace;color:#fff;background:rgba(0,0,0,0.8);padding:0 4px;white-space:nowrap;";
  box.appendChild(label);
  // Free-mode corner handles (shown only while aspect_ratio is Free):
  // dragging one resizes the box freely, the opposite corner stays fixed
  const handles = [];
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const h = document.createElement("div");
    h.style.cssText =
      "position:absolute;box-sizing:border-box;width:12px;height:12px;" +
      "background:#fff;border:1px solid #ff4040;display:none;" +
      (corner.startsWith("n") ? "top:-6px;" : "bottom:-6px;") +
      (corner.endsWith("w") ? "left:-6px;" : "right:-6px;");
    box.appendChild(h);
    handles.push(h);
  }
  ov.appendChild(box);
  parts.panel.appendChild(ov);

  // pointer in normalized image space, mapped the same way as the overlay
  // box (object-contain inside the panel). Using the <img> element rect
  // directly drifts when the element doesn't exactly cover the contained
  // image area (the dragged corner then lags the pointer).
  const imgPos = (e) => {
    const pr = parts.panel.getBoundingClientRect();
    const vw = parts.img.naturalWidth || 1;
    const vh = parts.img.naturalHeight || 1;
    const pw = pr.width || 1;
    const ph = pr.height || 1;
    const s = Math.min(pw / vw, ph / vh);
    const dw = vw * s, dh = vh * s;
    const ox = (pw - dw) / 2, oy = (ph - dh) / 2;
    return {
      nx: (e.clientX - pr.left - ox) / (dw || 1),
      ny: (e.clientY - pr.top - oy) / (dh || 1)
    };
  };
  // displayed image width in screen px (for screen-pixel paddings)
  const imgScreenW = () => {
    const pr = parts.panel.getBoundingClientRect();
    const s = Math.min((pr.width || 1) / (parts.img.naturalWidth || 1), (pr.height || 1) / (parts.img.naturalHeight || 1));
    return (parts.img.naturalWidth || 1) * s;
  };
  // inside the crop box; in Free mode the test is padded (screen px) so
  // the corner handles stay grabbable from outside the box
  const inBox = (nx, ny, c) => {
    if (!c) return false;
    // Free: pad the hit area by a few screen px so the corner handles stay
    // grabbable from outside the box
    const m = ratioOf(node) === "free" ? 8 / (imgScreenW() || 1) : 0;
    return nx >= c.x - m && nx <= c.x + c.w + m && ny >= c.y - m && ny <= c.y + c.h + m;
  };
  // the crop-box corner near the client point (Free mode), or null
  const cornerAtClient = (cx, cy) => {
    const br = box.getBoundingClientRect();
    const pts = {
      nw: [br.left, br.top], ne: [br.right, br.top],
      sw: [br.left, br.bottom], se: [br.right, br.bottom]
    };
    let best = 18, hit = null;
    for (const k of Object.keys(pts)) {
      const d = Math.hypot(cx - pts[k][0], cy - pts[k][1]);
      if (d < best) { best = d; hit = k; }
    }
    return hit;
  };

  let drag = null;
  ov.addEventListener("pointerdown", (e) => {
    const s = getState(node);
    const { nx, ny } = imgPos(e);
    if (!s.crop || !inBox(nx, ny, s.crop)) return;
    // consume only inside the crop box: outside, let the event reach the
    // panel (2.0 opens the mask editor on preview click)
    e.preventDefault();
    e.stopPropagation();
    // Free mode: a hit on a box corner resizes it (opposite corner fixed)
    const corner = ratioOf(node) === "free" ? cornerAtClient(e.clientX, e.clientY) : null;
    drag = { nx, ny, cx: s.crop.x, cy: s.crop.y, cw: s.crop.w, ch: s.crop.h, corner };
    s.dragging = true;
    try { ov.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    ov.style.cursor = corner
      ? (corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize")
      : "move";
  });
  ov.addEventListener("pointermove", (e) => {
    const s = getState(node);
    const { nx, ny } = imgPos(e);
    if (drag && s.crop) {
      if (drag.corner) {
        // resize: the opposite corner (from the box at drag start) stays
        // fixed, the box grows/shrinks toward the pointer
        const fx = drag.corner === "nw" || drag.corner === "sw" ? drag.cx + drag.cw : drag.cx;
        const fy = drag.corner === "nw" || drag.corner === "ne" ? drag.cy + drag.ch : drag.cy;
        s.crop.x = Math.min(fx, nx);
        s.crop.y = Math.min(fy, ny);
        s.crop.w = Math.abs(nx - fx);
        s.crop.h = Math.abs(ny - fy);
      } else {
        s.crop.x = nx - drag.nx + drag.cx;
        s.crop.y = ny - drag.ny + drag.cy;
      }
      fitCrop(node, s.crop);
      writeCrop(node);
      layoutVueOverlay(node);
    } else {
      let cur = "default";
      if (inBox(nx, ny, s.crop)) {
        cur = "move";
        if (ratioOf(node) === "free" && s.crop) {
          const cn = cornerAtClient(e.clientX, e.clientY);
          if (cn) cur = cn === "nw" || cn === "se" ? "nwse-resize" : "nesw-resize";
        }
      }
      ov.style.cursor = cur;
    }
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    const s = getState(node);
    s.dragging = false;
    if (s.crop) {
      fitCrop(node, s.crop);
      writeCrop(node);
    }
    try { ov.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    ov.style.cursor = "default";
  };
  ov.addEventListener("pointerup", endDrag);
  ov.addEventListener("pointercancel", endDrag);
  ov.addEventListener("wheel", (e) => {
    const s = getState(node);
    if (!s.crop) return;
    e.preventDefault();
    e.stopPropagation();
    const n = { w: parts.img.naturalWidth, h: parts.img.naturalHeight };
    const r = ratioOf(node);
    if (r == null) return;
    // Free: zoom keeps the box's own (drawn) ratio
    const rr = r === "free" ? (s.crop.w * n.w) / (s.crop.h * n.h) : r;
    const fr = maxFitRatio(rr, n.w, n.h);
    const c = s.crop;
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    let newH = c.h * factor;
    if (newH > fr.h) newH = fr.h;
    if (newH < 0.02) newH = 0.02;
    if (Math.abs(newH - c.h) <= 1e-6) return;
    const k = rr * (n.h / n.w);
    const newW = newH * k;
    const { nx, ny } = imgPos(e);
    const cx = nx - c.x;
    const cy = ny - c.y;
    c.x = c.x + (c.w - newW) * cx;
    c.y = c.y + (c.h - newH) * cy;
    c.w = newW;
    c.h = newH;
    fitCrop(node, c);
    writeCrop(node);
    layoutVueOverlay(node);
  }, { passive: false });

  let ro = null;
  try {
    ro = new ResizeObserver(() => layoutVueOverlay(node));
    ro.observe(parts.panel);
  } catch (_) { /* ResizeObserver optional */ }

  st.vue = { ov, box, label, handles, panel: parts.panel, img: parts.img, ro };
  layoutVueOverlay(node);
}

/**
 * 2.0 has no canvas redraw we can hook into, so a light timer keeps the
 * overlays in sync with the DOM (image load, ratio change, Vue re-render).
 */
let vuePollerStarted = false;

function startVuePoller(app) {
  if (vuePollerStarted) return;
  vuePollerStarted = true;
  setInterval(() => {
    try {
      if (!app || !app.graph) return;
      const vue = isVueMode();
      for (const n of app.graph.nodes || []) {
        if (!n || n.type !== LIRC.NODE_NAME || !n.__lirc || !n.__lirc.inited)
          continue;
        if (vue) {
          layoutVueOverlay(n);
        } else if (n.__lirc.vue) {
          // the 2.0 setting was switched off at runtime: drop the DOM
          // overlay so the classic canvas path takes over again
          removeVueOverlay(n);
        }
      }
    } catch (_) { /* ignore */ }
  }, 250);
}

/* --------------------------- wheel zoom ------------------------------- */

let wheelInstalled = false;

function installWheelInterceptor(app) {
  if (wheelInstalled) return;
  wheelInstalled = true;
  document.addEventListener(
    "wheel",
    (e) => {
      try {
        if (!app || !app.graph || !app.canvas) return;
        // find a LoadImageCrop node whose preview contains the pointer
        const pos = app.clientPosToCanvasPos
          ? app.clientPosToCanvasPos([e.clientX, e.clientY])
          : null;
        if (!pos) return;
        const nodes = app.graph.nodes || [];
        for (const n of nodes) {
          if (n.type !== LIRC.NODE_NAME || !n.__lirc) continue;
          const st = n.__lirc;
          // 2.0: the wheel may never reach the DOM overlay (the Vue layer
          // forwards it to the canvas), so the zoom is handled here, at
          // document capture time, before anything else sees the event.
          if (isVueMode()) {
            if (!st.vue || !st.vue.ov) continue;
            const boxEl = st.vue.box;
            const imgEl = st.vue.img;
            if (!boxEl || !imgEl) continue;
            const br = boxEl.getBoundingClientRect();
            const overBox =
              e.clientX >= br.left &&
              e.clientX <= br.right &&
              e.clientY >= br.top &&
              e.clientY <= br.bottom;
            if (!overBox) continue; // outside the crop: normal canvas behavior
            if (st.crop) {
              e.preventDefault();
              e.stopPropagation();
              // same object-contain mapping as the overlay layout (the <img>
              // element rect can drift from the contained image area)
              const pr = (st.vue.panel || imgEl.parentElement).getBoundingClientRect();
              const nat = { w: imgEl.naturalWidth, h: imgEl.naturalHeight };
              const r = ratioOf(n);
              if (r == null) return;
              // Free: zoom keeps the box's own (drawn) ratio
              const rr = r === "free" ? (st.crop.w * nat.w) / (st.crop.h * nat.h) : r;
              const fr = maxFitRatio(rr, nat.w, nat.h);
              const c = st.crop;
              const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
              let newH = c.h * factor;
              if (newH > fr.h) newH = fr.h;
              if (newH < 0.02) newH = 0.02;
              if (Math.abs(newH - c.h) > 1e-6) {
                const k = rr * (nat.h / nat.w);
                const newW = newH * k;
                const zs = Math.min((pr.width || 1) / nat.w, (pr.height || 1) / nat.h);
                const dw = nat.w * zs, dh = nat.h * zs;
                const ox = (pr.width - dw) / 2, oy = (pr.height - dh) / 2;
                const nx = (e.clientX - pr.left - ox) / (dw || 1);
                const ny = (e.clientY - pr.top - oy) / (dh || 1);
                c.x = c.x + (c.w - newW) * (nx - c.x);
                c.y = c.y + (c.h - newH) * (ny - c.y);
                c.w = newW;
                c.h = newH;
                fitCrop(n, c);
                writeCrop(n);
                layoutVueOverlay(n);
              }
            }
            return;
          }
          const local = [pos[0] - n.pos[0], pos[1] - n.pos[1]];
          if (st.rect && pointInRect(local, st.rect) && !st.crop) {
            // "Original": no crop to zoom, keep the core canvas behavior
            return;
          }
          if (st.rect && pointInRect(local, st.rect) && st.crop) {
            // always consume the wheel over the preview (no canvas zoom/pan)
            e.preventDefault();
            e.stopPropagation();
            const img = naturalSize(n);
            if (img) {
              const c = st.crop;
              const rm = ratioOf(n);
              // Free: zoom keeps the box's own (drawn) ratio
              const rr = rm === "free" ? (c.w * img.w) / (c.h * img.h) : rm;
              const fr = maxFitRatio(rr, img.w, img.h);
              const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
              // clamp the TARGET size first: at a limit the size stays the
              // same, so the rectangle must not move
              let newH = c.h * factor;
              if (newH > fr.h) newH = fr.h;
              if (newH < 0.02) newH = 0.02;
              if (Math.abs(newH - c.h) > 1e-6) {
                const k = rr * (img.h / img.w);
                const newW = newH * k;
                const r = st.rect;
                // zoom around the cursor
                const cx = (local[0] - r.x) / r.w;
                const cy = (local[1] - r.y) / r.h;
                c.x = c.x + (c.w - newW) * cx;
                c.y = c.y + (c.h - newH) * cy;
                c.w = newW;
                c.h = newH;
                fitCrop(n, c);
                writeCrop(n);
                markDirty(n);
              }
            }
            return;
          }
        }
      } catch (err) {
        console.warn(LIRC.TAG, "wheel", err);
      }
    },
    { passive: false, capture: true }
  );
}

/* --------------------------- paste ------------------------------------ */

/**
 * Context-menu paste for classic nodes: the frontend already handles
 * Ctrl+V natively in both designs, but classic exposes no menu entry for
 * it. This mirrors the core "Paste Image" entry: read the clipboard and
 * hand the image to the node's native paste methods (node.pasteFile /
 * node.pasteFiles), the same path the core uses. Like the core entry it
 * only covers clipboard images (screenshots); OS file copies work via
 * Ctrl+V.
 */
async function pasteFromClipboard(node) {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    alert("Clipboard access is not available in this browser. Use Chrome/Edge over http://localhost and allow clipboard access.");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) {
        const blob = await item.getType(type);
        const ext = (type.split("/")[1] || "png").split(";")[0];
        const file = new File([blob], `pasted-image.${ext}`, { type });
        if (typeof node.pasteFile === "function") node.pasteFile(file);
        if (typeof node.pasteFiles === "function") node.pasteFiles([file]);
        return;
      }
    }
    alert("No image found in the clipboard.");
  } catch (e) {
    console.error(LIRC.TAG, "paste failed", e);
    alert("Paste from clipboard failed: " + (e && e.message ? e.message : e));
  }
}

/* --------------------------- registration ----------------------------- */

function register(app) {
  lircApp = app;
  app.registerExtension({
    name: "LoadImageCrop",
    nodeCreated: (node) => initNode(node),
    loadedGraphNode: (node) => initNode(node),
    beforeRegisterNodeDef: (nodeType, nodeData) => {
      if (nodeData && nodeData.name !== LIRC.NODE_NAME) return;
      const proto = nodeType.prototype;
      const prevConfigure = proto.onConfigure;
      proto.onConfigure = function (data) {
        const r = prevConfigure ? prevConfigure.call(this, data) : undefined;
        initNode(this);
        return r;
      };
      const prevAdded = proto.onAdded;
      proto.onAdded = function (graph) {
        const r = prevAdded ? prevAdded.call(this, graph) : undefined;
        initNode(this);
        return r;
      };
    }
  });
  installWheelInterceptor(app);
  startVuePoller(app);
  console.log(LIRC.TAG, "extension registered");
}

(async function boot() {
  let mod = null;
  for (let i = 0; i < 100; i++) {
    try {
      mod = await import("/scripts/app.js");
      if (mod && mod.app) break;
      mod = null;
    } catch (_) { /* retry */ }
    await sleep(50);
  }
  if (!mod || !mod.app) {
    console.error(LIRC.TAG, "could not load /scripts/app.js - extension not started");
    return;
  }
  try {
    register(mod.app);
  } catch (e) {
    console.error(LIRC.TAG, "register failed", e);
  }
})();

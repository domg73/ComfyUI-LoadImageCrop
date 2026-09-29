# Changelog

## v1.0.7 (2026-09-29)

**Added**
- Optional **pre-crop flip** (`flip` input: `None` / `Horizontal` / `Vertical`, default `None`). Selecting a flip mirrors the image in the browser (canvas), saves the result to `input/` as `{name}-flipH.png` / `{name}-flipV.png`, and switches the node's image input to the flipped file. The flipped image is used everywhere (preview, mask editor, output); the crop rectangle is framed on it (WYSIWYG). `None` reverts to the original image. A flip does not change the image size, only mirrors it.

## v1.0.6 (2026-09-28)

**Fixed**
- Context menu duplication: the `getExtraMenuOptions` override previously returned `items.concat(base)`, concatenating the base menu list. On ComfyUI nightly/dev builds the base node no longer implements `getExtraMenuOptions` (its menu entries are provided by the Vue frontend), so the canvas' `options = extra.concat(options)` duplicated the base menu list, making the whole context menu appear twice. The override now returns only its own "Paste Image from Clipboard" entry, which is robust across all ComfyUI builds (stable and nightly, classic and Vue nodes).

## v1.0.5 (2026-09-07)

- Fixed the node's right-click context menu: it now preserves the core's extra entries (Open Image, Save Image, Bypass, Clipspace, and "Open in MaskEditor | Image Canvas"). The node's menu hook replaced the core implementation instead of chaining into it, which silently dropped those entries.
- The node now reliably exposes its loaded preview to the core image checks (`node.imgs` / `previewMediaType`) in both the classic and the 2.0 layouts, so the Mask Editor and the image menu actions operate on it.

## v1.0.4 (2026-09-04)

- Added the **Free (Custom)** aspect-ratio option (both the classic and the 2.0 layouts): it lifts the ratio lock so the crop box can be any shape. The four box corners show resize handles — dragging one resizes the box freely (the opposite corner stays fixed), dragging inside the box still moves it, and the wheel zooms it at the box's own drawn ratio. The box starts as a centered 90×90% area so the handles stay inside the preview; a new image starts from that box too. The default (Original) and the preset ratios are unchanged.

## v1.0.3 (2026-09-03)

- Classic nodes: the crop drag now starts only when the pointer is inside the crop box (the "move" cursor follows the same area); clicks and drags elsewhere keep the core node behavior, matching the official Load Image passthrough.

## v1.0.2 (2026-09-02)

- Added ComfyUI 2.0 (Vue nodes) support: the crop overlay is rendered as a DOM element on top of the preview image, with drag and wheel zoom; the overlay is created/removed automatically when the nodes mode is switched at runtime, so no page reload is needed.
- Clipboard paste unified on the native pipeline: the context-menu entry now drives the node's native paste methods, identical to the core 2.0 "Paste Image" entry (screenshots; OS file copies work via Ctrl+V). The custom upload path was removed.

## v1.0.1 (2026-09-01)

- Added "Original" as the default `aspect_ratio`: the image passes through uncropped (W×H, no resample), with no crop overlay and no mouse interaction — the node behaves exactly like the official Load Image node.

## v1.0.0 (2026-08-31, initial release)

- Node based on the official Load Image: same file dialog, drag & drop, and preview.
- Visual crop rectangle drawn on top of the official preview: drag to move, mouse wheel to zoom, locked to a fixed aspect-ratio list (1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9).
- WYSIWYG: the cropped IMAGE and MASK outputs exactly match the framed area on the preview.
- Paste image from clipboard, available from the node's right-click context menu (saves to `input/` and auto-selects the file).

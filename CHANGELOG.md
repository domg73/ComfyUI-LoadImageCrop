# Changelog

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

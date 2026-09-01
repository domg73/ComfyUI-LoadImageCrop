# Changelog

## 2026-09-01

- Added "Original" as the default `aspect_ratio`: the image passes through uncropped (W×H, no resample), with no crop overlay and no mouse interaction — the node behaves exactly like the official Load Image node.

## 2026-08-31 (initial release)

- Node based on the official Load Image: same file dialog, drag & drop, and preview.
- Visual crop rectangle drawn on top of the official preview: drag to move, mouse wheel to zoom, locked to a fixed aspect-ratio list (1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9).
- WYSIWYG: the cropped IMAGE and MASK outputs exactly match the framed area on the preview.
- Paste image from clipboard, available from the node's right-click context menu (saves to `input/` and auto-selects the file).

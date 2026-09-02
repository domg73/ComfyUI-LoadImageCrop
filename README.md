# ComfyUI-LoadImageCrop

A native ComfyUI node: the official **Load Image**, extended with an aspect-ratio-locked, WYSIWYG crop rectangle drawn directly on the preview. What you frame is exactly what gets executed — the node outputs the cropped **IMAGE** and **MASK**.

Works with **classic nodes** and **ComfyUI 2.0 (Vue nodes)**.

https://github.com/user-attachments/assets/207d909e-f521-4166-b3c7-e60b2ee0724f

## Install

Drop the folder into `ComfyUI/custom_nodes/` and restart ComfyUI. No extra dependencies.

## Usage

The node looks and behaves like the official Load Image: same file picker, drag & drop and preview.

- **Aspect Ratio** — default **Original**: the image passes through **uncropped** (W×H, no resample), no crop area is shown and the node behaves exactly like the official Load Image. The other ratios are locked: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `21:9`.
- With any locked ratio, a crop rectangle appears on the preview:
  - **Move it**: click and drag the rectangle.
  - **Zoom it: keep the mouse pointer over the preview (inside the crop area) and turn the mouse wheel** — wheel up enlarges, wheel down shrinks, always around the pointer. While the pointer is over the preview the wheel is captured by the crop, so the canvas behind does not pan/zoom; outside the preview the wheel works normally.
  - The rectangle is locked to the selected ratio and the output size is shown on the frame.
- The crop is stored in the workflow and is also exposed via the hidden `crop_x` / `crop_y` / `crop_w` / `crop_h` inputs (normalized 0..1), so it can be set from an API script.

## Paste

- **Ctrl+V** (node focused): pastes a clipboard **image or file** — native ComfyUI behavior, works in both designs.
- **Right-click → Paste Image from Clipboard** (classic) / **Paste Image** (2.0): pastes a clipboard **image** (e.g. a screenshot). Files copied from the OS file manager cannot be read from a menu click — that is a browser limitation, identical to the official entry — so use **Ctrl+V** for files.
- Requires Chrome/Edge over `http://localhost` (or HTTPS) with clipboard permission granted.

## Notes

- WYSIWYG: the output matches the framed area (±1 px integer rounding).
- Animated images in 2.0 mode: the first frame is shown.
- In 2.0 the overlay follows the frontend's DOM structure; if a future frontend release changes the preview markup, the overlay layer may need a selector update.

## License & Copyright

Copyright (c) 2026 domg73 (aka MayaProphecy).

This project is licensed under the MIT License. You are free to use, modify, and distribute this software under the terms specified in the license.

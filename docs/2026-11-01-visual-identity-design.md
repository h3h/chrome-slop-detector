# Slop Flag visual identity

The extension's first icons were solid red squares and every surface used error red (`#c62828`). This replaces them with one mark and one palette.

## Palette

Plum, chosen because it is distinct from error red and from warning amber, so a flag reads as "worth a look" rather than "something broke".

| Role | Light | Dark |
| --- | --- | --- |
| Brand / icon tile / accent | `#7d3f8a` | `#c48ccd` (text on dark surfaces) |
| Toolbar badge "AI" | `#3c1f42` | same (Chrome badge has no dark mode) |
| Banner background | `#f4eaf6` | `#2f1f33` |
| Banner text | `#562a5c` | `#e1c2e6` |

The "?" badge stays neutral gray `#757575`. The badge is darker than the tile so the two do not merge where the badge overlaps the icon's bottom-right corner.

## Mark

A plum rounded-square tile holding a white pole and waving flag, with a four-point sparkle (the common "AI" glyph) cut into the flag in the tile colour. The flag sits in the top-left of the tile, the corner the toolbar badge never covers.

Icons are rendered by `scripts/icons.mjs`, a dependency-free rasterizer (polygons flattened from the shapes, supersampled, written as RGBA PNG). Sizes: 16, 32, 48, 128. The 32px size is new and only used by the toolbar action, for high-DPI screens. Run `npm run icons` after changing the shapes; the PNGs are committed, and the build regenerates any that are missing.

## Surfaces

- In-page banner: soft tint with a 4px plum left accent instead of a solid red bar, in light and dark variants following the page's `prefers-color-scheme`.
- Popup: the flagged verdict uses the brand colour; the heading shows the icon.
- Options page: the heading shows the icon; form controls (`accent-color`) and focus rings use the brand colour.

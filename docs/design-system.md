# Design system

This app follows the FlyCockpit template's design system (`patterns/design-system.md` in the template repo). This file records only where Cockpit Chess differs from it or goes further.

## Edge lines

These are the horizontal edges every container sits on, measured on ink: glyph and icon bounds, or a boxed control's box. Change a value only with the owner's approval, and record the new value here.

Terms: the **text line** is where labels, headings and bare icons start. The **box line** is where filled, bordered or shadowed controls start. The **trailing line** is where the last item in a row ends. An item is within tolerance when its ink is within 1px of its line.

Two rules decide the cases the tables do not list:

- **Boxes share the text line** inside pages, cards, panels and forms. A box does not outdent by its own padding. Ghost icon buttons are centred items, not edge items.
- **Fix a miss in the container**: its padding, a shared inset (`inset`, `--cc-panel-inset`, `px-*` on a track), or the shared component's placement. Never fix one item with a one-off margin.

### Signed-in shell (`_app` layouts)

The shell is the template's, and so are its lines: header and page content 16px (`px-4`), default cards 16px, `size="sm"` cards 12px, dropdown menus, the Select listbox, horizontal selector rows and `SegmentedControl`. Differences and additions:

| Container | Text line | Box line | Trailing line | Centre / icon column |
|---|---|---|---|---|
| Dialog (`DialogContent p-4`) | 16px | Same as the text line | 16px. The close X's glyph ink ends on this line. | The close button is 28px (`icon-sm`) at every width, at `top-3 right-2`, centred on the title line. Its hit area is 44px: `after:-inset-[9px]` is laid out from the padding box, inside the button's 1px border, so it reaches 8px past the 28px button on each side. |
| Sheet (`SheetContent`, header and footer `p-4`) | 16px inside the border | Same as the text line | 16px. The close X's glyph ink ends on this line. | Same close button as Dialog: 28px at `top-3 right-2`, centred on the title line. No screen uses a Sheet yet. |
| Dropdown menu (user menu) | 32px when any row has an icon. Rows without an icon take `inset`, including Sign Out. | — | — | The icon column sits 10px in (`size-4`, no extra margin on the icon). "My Account" and the email line start on the icon column's edge (10px) as the group header. The menu is at least 224px wide (`min-w-56`), or the trigger's width if wider. The email row stays on one line: a longer address ends in an ellipsis (`truncate`), and the full one is in its `title`. |
| Vertical nav list (settings sub-nav at `md:`) | The icon column sits on the page text line, under the "Settings" heading. Labels follow after `gap-2`. | The highlight box is outdented by the item padding (12px, `md:-ml-3` on the track). | — | Icons are `size-4` on one column. |

### Arena (`_public` routes and the CLI local lab, `index.css` `.cc-*`)

The arena is its own broadcast surface in plain CSS. Its lines step down at two breakpoints:

| Container | Above 900px | 900px and below | 650px and below |
|---|---|---|---|
| Arena header (`.cc-header`, at most 1440px wide) | Text and trailing lines 40px inside the safe-area frame | 24px | 16px. The nav wraps to its own row, spread with `space-between`. |
| Header nav (`.cc-nav a`) | Each label starts where its 44px hit box starts (`justify-content: flex-start`), not centred inside it. The nav follows the brand, so its labels are a row, not an edge. | Same | Same. Here the nav wraps to its own row, so the first label sits on the 16px header line in every language, and the last ends on the trailing line. |
| Page content (`.cc-app`, at most 1360px wide) | 40px inside the container: headings, hero, section bars, tables, footer. Buttons and panels start on the same line. | 24px | 16px |
| Bordered panels: game, board, decision log and rule cards | `--cc-panel-inset` (20px, the board panel's own padding) inside the 1px border, so the inner text line is 21px in. Stacked and side-by-side panels share it. The variable sets only the inline padding; each panel keeps its own block padding, and the playable board keeps its size. | 14px (15px in) | 14px. The exception is the board panel, which goes full width (`padding: 0; margin-inline: -14px`). Its player rows sit 1px outside the page line. |
| Lab instructions card (`.cc-lab-instructions`) | 26px inside the border (27px in). It stays off `--cc-panel-inset` because its padding sets the lab grid's minimum second column, so changing it would resize the board. It sits beside the board, not stacked with another panel. | Same | Same (stacked under the full-width board). |
| Leaderboard table (`.cc-table`) | Its first and last cells have no inline padding. The first column's text starts on the page text line, and the last column's box ends on the trailing line; its left-aligned values do not reach it. Inner cells keep 14px. | Same | Same. The table scrolls inside `WideContent`. |
| Section bar (`.cc-section-bar`) | The heading is on the page text line. The pill ends on the trailing line. | Same | Same |
| Decision-log timeline rows (`.cc-timeline button`) | The row box is on the panel's text line. The move number and text sit 8px inside it (`padding: 10px 8px`). | Same | Same |

At viewports wider than 1360px, the arena header (40px inside its 1440px frame) and the page content (40px inside its 1360px column) do not share a leading line. At 1440px the content line is 73px from the viewport's left edge and the header's is 40px. The two maximum widths are a page-width decision, not a padding one.

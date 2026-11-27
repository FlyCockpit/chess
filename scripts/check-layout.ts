/**
 * `pnpm check:layout`: real-browser geometry check of the shell rules
 * against a running dev stack, see docs/design-system.md § Shell rules
 * It is not part of CI:
 * it needs agent-browser and its Chromium plus the app's server and database.
 * Run it after touching a shell, the footer, the header, page-level chrome or
 * the toast theme.
 *
 *   pnpm check:layout --url http://localhost:3001
 *   CHECK_LAYOUT_PASSWORD=… pnpm check:layout --url … --login admin@example.test
 *   … --no-sandbox                       Ubuntu 23.10+ (AppArmor) Chromium
 *
 * The app has no mock mode, so `--url` points at `pnpm dev` (web + server).
 * `--login` signs in with that account (the password comes from
 * CHECK_LAYOUT_PASSWORD, never the command line; an account with a second
 * factor also needs a current code in CHECK_LAYOUT_TOTP) and adds the
 * signed-in pages; without it they are skipped. Use an admin account: the admin users page is
 * the one with a sticky sub-nav, and an admin without a second factor also
 * shows the 2FA banner inside the scroller.
 *
 * At 390×844, 1280×800, 1440×1600 and 390×300 (where every page scrolls), on
 * the arena, the rules, the leaderboard and the studio (the arena's public
 * tabs), the 404, the sign-in page and (signed in) the settings and admin
 * users pages, it checks that:
 * - the document never scrolls and the shell's `<main>` is the scroller;
 * - the public shell's footer is the scroller's last box: scrolled to the end,
 *   its bottom is the scroller's bottom (±1px), so on a short page it sits at
 *   the bottom of the viewport and on a long one it follows the content;
 * - the 404 renders inside the public shell (header and footer present);
 * - `<main>` reserves no scrollbar gutter, and every full-width rule (the
 *   arena header's `border-b`, the app header's `<hr>`, the footer's
 *   `border-t`, the admin sub-nav's and the setup banners' `border-b`) reaches
 *   from 0 to the viewport's right edge (inside a scrolling `<main>`, its
 *   visible scrollbar);
 * - with a cookie banner's reserve applied (`--consent-inset` set as the
 *   banner sets it; the banner itself shows only in an app with analytics),
 *   the shell frame, `<main>`'s box and anything beside it keep their full
 *   height to the bottom of the viewport, and the page's content, scrolled to
 *   its end, ends above where the banner starts;
 * - a toast (the file-drop notice), stored theme light then dark with the OS
 *   set to the other one, renders in the stored theme and is filled with its
 *   popover colour (not inverted) and its title and badge reach 4.5:1 on it.
 *
 * And the arena header's controls (language, theme, Studio and, signed in,
 * the account link) in every shipped locale (packages/locales/src/*) at
 * HEADER_WIDTHS from 320 to 3840px, signed out and (with `--login`) signed
 * in: every control lies inside the viewport, the signed-in account link is
 * there, the header row itself does not overflow (the tabs scroll inside
 * `.cc-nav` instead), and no tab label runs out of its tab or into the next
 * one (a squeezed strip must scroll, not overlap its labels).
 *
 * Classic (non-overlay) scrollbars are what expose a reserved gutter; headless
 * Chromium on Linux draws them, overlay scrollbars on macOS hide the defect.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CheckRun,
  decideConsent,
  formSignIn,
  sessionName,
  withBrowser,
} from "./browser-check-lib.ts";
import { loginAccount } from "./browser-checks.config.ts";

// One session per run: two checks running at once (two checkouts, two agents) must not share a browser.
const SESSION = sessionName("check-layout");
const THEME_KEY = "vite-ui-theme";

/** What the in-page probe reports. Pure data, so `judgeLayout` is testable. */
export interface Probe {
  vw: number;
  docScroll: number;
  header: boolean;
  /** `scrollbar`: the width `<main>` gives up to a scrollbar right now (offsetWidth − clientWidth). */
  main: { bottom: number; scrollable: boolean; scrollbar: number } | null;
  /** The public footer after scrolling `<main>` to its end, or null. */
  footer: { bottom: number; lastInMain: boolean } | null;
  /**
   * `inMain`: the rule is inside the scroller, so a visible scrollbar is its right edge. `start`:
   * where its left edge belongs: 0, or the left of a `#main-content` column that is not `<main>` itself
   * (none in this app today: both shells' `<main>` is `#main-content`).
   */
  rules: { name: string; left: number; right: number; inMain: boolean; start?: number }[];
  toast: {
    dark: boolean;
    fill: string;
    popover: string;
    title: number;
    badge: number;
    button: number | null;
  } | null;
}

export interface Expect {
  footer: boolean;
  /** The theme the stored choice asks for; the OS is set to the opposite one. */
  toast?: "light" | "dark";
}

/** Returns one message per broken rule; empty means the page passes. */
export function judgeLayout(page: string, probe: Probe, expect: Expect): string[] {
  const bad: string[] = [];
  if (probe.docScroll > 0)
    bad.push(`${page}: the document scrolls by ${probe.docScroll}px; only <main> may scroll`);
  if (!probe.main) bad.push(`${page}: no <main> page scroller`);
  if (!probe.header) bad.push(`${page}: no shell header`);
  if (expect.footer) {
    if (!probe.footer) bad.push(`${page}: no public footer`);
    else {
      if (!probe.footer.lastInMain)
        bad.push(`${page}: the footer is not the last box in the scroller's content column`);
      if (probe.main && Math.abs(probe.footer.bottom - probe.main.bottom) > 1)
        bad.push(
          `${page}: scrolled to the end, the footer ends at ${probe.footer.bottom}px, the scroller at ${probe.main.bottom}px (${probe.main.scrollable ? "long" : "short"} page)`,
        );
    }
  }
  // A scrollable scroller shows a scrollbar at the viewport's right edge, and a
  // rule inside it meets that scrollbar, as on any scrolling page. A scroller
  // that does not scroll but still gives up width reserves an empty gutter.
  const scrollbar = probe.main?.scrollable ? probe.main.scrollbar : 0;
  if (probe.main && !probe.main.scrollable && probe.main.scrollbar > 0)
    bad.push(
      `${page}: <main> reserves a ${probe.main.scrollbar}px scrollbar gutter on a page that does not scroll`,
    );
  for (const rule of probe.rules) {
    const edge = probe.vw - (rule.inMain ? scrollbar : 0);
    const start = rule.start ?? 0;
    if (rule.left > start || edge - rule.right > 0)
      bad.push(
        `${page}: ${rule.name} spans ${rule.left}…${rule.right}px, not ${start}…${edge}px; full-bleed rules reach both edges of their column`,
      );
  }
  if (expect.toast) {
    const toast = probe.toast;
    if (!toast) bad.push(`${page}: no toast appeared`);
    else {
      if (toast.dark !== (expect.toast === "dark"))
        bad.push(
          `${page}: the stored ${expect.toast} theme lost to the OS (the page rendered ${toast.dark ? "dark" : "light"})`,
        );
      if (toast.fill !== toast.popover)
        bad.push(
          `${page}: the toast is filled ${toast.fill}, not the ${toast.dark ? "dark" : "light"} theme's popover ${toast.popover}`,
        );
      for (const [part, ratio] of [
        ["title", toast.title],
        ["badge", toast.badge],
        ["action", toast.button],
      ] as const) {
        if (ratio !== null && ratio < 4.5)
          bad.push(`${page}: toast ${part} contrast ${ratio}:1 is below 4.5:1`);
      }
    }
  }
  return bad;
}

/** What the arena-header probe reports. Pure data, so `judgeHeader` is testable. */
export interface HeaderProbe {
  vw: number;
  /** The `[data-header-controls]` group's box, or null when the header has none. */
  controls: { left: number; right: number } | null;
  /** Each control in the group, by name (`account` is the signed-in account link). */
  items: { name: string; left: number; right: number; width: number }[];
  /** How far the header row's content runs past its box (scrollWidth − clientWidth). */
  rowOverflow: number;
  /** How far the tab strip scrolls sideways (reported, not judged: it may). */
  navOverflow: number;
  /**
   * Each tab link in `.cc-nav`, in order: its box, and the extent of its label
   * text (a Range over the link's contents, so a word overflowing the box shows).
   */
  tabs: { name: string; left: number; right: number; labelLeft: number; labelRight: number }[];
}

/**
 * One message per broken header rule: the controls never run past the
 * viewport's edges (a control pushed off-screen is unreachable; signed in, the
 * account link is the only way to Settings, Admin and Sign out), and the row
 * never overflows. Rounded boxes, so a 1px tolerance for subpixel layout.
 */
export function judgeHeader(page: string, probe: HeaderProbe, signedIn: boolean): string[] {
  if (!probe.controls) return [`${page}: no [data-header-controls] in the arena header`];
  const bad: string[] = [];
  if (probe.controls.left < -1 || probe.controls.right > probe.vw + 1)
    bad.push(
      `${page}: the header controls span ${probe.controls.left}…${probe.controls.right}px, outside the ${probe.vw}px viewport`,
    );
  for (const item of probe.items) {
    if (item.width <= 0) bad.push(`${page}: the header's ${item.name} control has no width`);
    else if (item.left < -1 || item.right > probe.vw + 1)
      bad.push(
        `${page}: the header's ${item.name} control spans ${item.left}…${item.right}px, past the ${probe.vw}px viewport`,
      );
  }
  if (signedIn && !probe.items.some((item) => item.name === "account"))
    bad.push(`${page}: signed in, but the header has no account link`);
  if (probe.rowOverflow > 1)
    bad.push(
      `${page}: the header row overflows by ${probe.rowOverflow}px; only the tab strip may scroll`,
    );
  probe.tabs.forEach((tab, i) => {
    if (tab.labelLeft < tab.left - 1 || tab.labelRight > tab.right + 1)
      bad.push(
        `${page}: the "${tab.name}" tab's label spans ${tab.labelLeft}…${tab.labelRight}px, past its ${tab.left}…${tab.right}px tab`,
      );
    const next = probe.tabs[i + 1];
    if (next && Math.max(tab.right, tab.labelRight) > Math.min(next.left, next.labelLeft) + 1)
      bad.push(
        `${page}: the "${tab.name}" and "${next.name}" tabs overlap (${tab.right}px past ${next.left}px); the strip must scroll instead`,
      );
  });
  return bad;
}

/** The widths the header is measured at (the phone, the breakpoints around 640/650, tablets, desktops, 4K). */
export const HEADER_WIDTHS = [
  320, 390, 640, 650, 651, 768, 1024, 1279, 1280, 1440, 1920, 3840,
] as const;

/** Every shipped locale bundle, so a new one is measured without editing this file. */
export function shippedLocales(root = resolve(import.meta.dirname, "..")): string[] {
  return readdirSync(resolve(root, "packages/locales/src"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z]{2}(-[A-Z]{2})?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// Runs in the page (agent-browser eval). Self-contained: no closures.
const HEADER_PROBE = `(async () => {
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const vw = document.documentElement.clientWidth;
  const group = document.querySelector("header [data-header-controls]");
  const row = group ? group.parentElement : null;
  const nav = row ? row.querySelector("nav") : null;
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; };
  const name = (el) => el.hasAttribute("data-account-link") ? "account" : el.classList.contains("cc-signin") ? "studio" : el.dataset.slot === "select-trigger" ? "language" : (el.getAttribute("aria-label") || el.tagName.toLowerCase());
  const items = group ? [...group.children].map((el) => ({ name: name(el), ...box(el) })) : [];
  const tabs = nav ? [...nav.querySelectorAll("a")].map((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    const { left, right } = box(el);
    return { name: (el.textContent || "").trim(), left, right, labelLeft: Math.round(text.left), labelRight: Math.round(text.right) };
  }) : [];
  return JSON.stringify({
    vw,
    controls: group ? (({ left, right }) => ({ left, right }))(box(group)) : null,
    items,
    rowOverflow: row ? row.scrollWidth - row.clientWidth : 0,
    navOverflow: nav ? nav.scrollWidth - nav.clientWidth : 0,
    tabs,
  });
})()`;

/** The banner-reserve probe: the same boxes measured without and with the reserve. */
export interface ReserveProbe {
  vh: number;
  inset: number;
  /** `<main>` and its ancestors (the outermost is the frame), each followed by what sits beside it. */
  before: { name: string; bottom: number }[];
  after: { name: string; bottom: number }[];
  /** With the reserve, scrolled to the end: the bottom of `<main>`'s rendered content. */
  contentEnd: number;
  /** The public footer's bottom at that point, or null (the app shell has none). */
  footer: number | null;
}

/** One message per broken reserve rule (docs/design-system.md § Shell rules). */
export function judgeReserve(page: string, probe: ReserveProbe | null): string[] {
  if (!probe) return [`${page}: no <main id="main-content"> scroller`];
  const bad: string[] = [];
  const frame = probe.before.filter((box) => !box.name.startsWith("beside ")).at(-1);
  if (frame && Math.abs(frame.bottom - probe.vh) > 1)
    bad.push(
      `${page}: the shell frame ends at ${frame.bottom}px, not the viewport bottom (${probe.vh}px)`,
    );
  probe.before.forEach((box, i) => {
    const moved = probe.after[i];
    if (!moved || moved.name !== box.name || Math.abs(moved.bottom - box.bottom) > 1)
      bad.push(
        `${page}: with a cookie banner's reserve, ${box.name} ends at ${moved?.bottom ?? "?"}px instead of ${box.bottom}px; the shell chrome keeps the full height, only <main>'s padding makes room`,
      );
  });
  const bannerTop = probe.vh - probe.inset;
  if (probe.contentEnd > bannerTop + 1)
    bad.push(
      `${page}: scrolled to the end, the page ends at ${probe.contentEnd}px, under a banner starting at ${bannerTop}px`,
    );
  // A short public page's footer sits right on top of the banner, as it sits on the viewport bottom without one.
  if (probe.footer !== null && Math.abs(probe.footer - bannerTop) > 1)
    bad.push(
      `${page}: scrolled to the end, the footer ends at ${probe.footer}px, not where the banner starts (${bannerTop}px)`,
    );
  return bad;
}

/**
 * The most the reserve probe pretends a banner covers, and its share of a
 * short viewport: on phones a real banner's own content is about 90px (one
 * line over two buttons; over the BottomNav it reserves that plus the nav's
 * 3.5rem and the safe area), and as a desktop card it stays under 200px, so a
 * fixed 200px would leave no room under a tall header at 390×300. Both exceed
 * the BottomNav's reserve while the safe area is under about 34px.
 */
const RESERVE_INSET = 200;
const RESERVE_SHARE = 0.3;

// Runs in the page (agent-browser eval). Self-contained: no closures.
const RESERVE_PROBE = `(async () => {
  const html = document.documentElement;
  const main = document.getElementById("main-content");
  if (!main) return JSON.stringify(null);
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const label = (el) => el === main ? "<main>" : el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.dataset.slot ? "[data-slot=" + el.dataset.slot + "]" : "");
  const boxes = () => {
    const out = [];
    for (let el = main; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      out.push({ name: label(el), bottom: Math.round(r.bottom) });
      for (const sib of el.parentElement ? el.parentElement.children : []) {
        if (sib === el || ["absolute", "fixed"].includes(getComputedStyle(sib).position)) continue;
        const s = sib.getBoundingClientRect();
        // Beside, not above: a sidebar starts no lower than this box and sits left or right of it.
        if (s.width && s.height && s.top <= r.top + 1 && (s.right <= r.left + 1 || s.left >= r.right - 1))
          out.push({ name: "beside " + label(el) + ": " + label(sib), bottom: Math.round(s.bottom) });
      }
    }
    return out;
  };
  const before = boxes();
  // A real banner's reservation (an app with analytics) is put back afterwards.
  const previous = html.style.getPropertyValue("--consent-inset");
  const inset = Math.min(${RESERVE_INSET}, Math.round(window.innerHeight * ${RESERVE_SHARE}));
  html.style.setProperty("--consent-inset", inset + "px");
  await settle();
  const after = boxes();
  // Where the content would be scrolled to the end, computed rather than
  // scrolled: a late scroll reset (hydration, restoration) cannot skew it.
  const toEnd = main.scrollHeight - main.clientHeight - main.scrollTop;
  // Through \`display: contents\` wrappers (pull-to-refresh), which have no box of their own.
  const end = (el) => {
    let bottom = 0;
    for (const child of el.children) {
      const style = getComputedStyle(child);
      if (["absolute", "fixed"].includes(style.position) || style.display === "none") continue;
      bottom = Math.max(bottom, style.display === "contents" ? end(child) : Math.round(child.getBoundingClientRect().bottom));
    }
    return bottom;
  };
  const contentEnd = end(main) - toEnd;
  const footer = main.querySelector("footer[data-public-footer]");
  const footerEnd = footer ? Math.round(footer.getBoundingClientRect().bottom) - toEnd : null;
  if (previous) html.style.setProperty("--consent-inset", previous);
  else html.style.removeProperty("--consent-inset");
  return JSON.stringify({ vh: window.innerHeight, inset, before, after, contentEnd, footer: footerEnd });
})()`;

/** What the app marks as still loading: a `Skeleton`, or a busy region (the route skeleton). */
export const LOADING_MARKER = '[data-slot="skeleton"], [aria-busy="true"]';

/**
 * Runs in the page before the probes: waits (8s at most) until `<main>`
 * shows no loading marker and its content stops growing for half a second.
 * The footer is there before the cards, the leaderboard rows and the
 * demonstration board, so a page measured as soon as it shows grows after the
 * probe scrolled to its end, and the footer it measured is no longer the
 * scroller's last box. A skeleton can hold one height for a while before the
 * data comes, so reads while a marker is present never count as still.
 * Returns (JSON-encoded, as every page script) "settled", or why it was not:
 * "loading" (a marker was still there after 8s) or "changing" (the height
 * kept moving). Self-contained: no closures.
 */
export const SETTLED = `(async () => {
  const main = document.querySelector('[data-scroll-restoration-id="app-main"]');
  if (!main) return JSON.stringify("settled");
  let last = -1;
  let still = 0;
  let loading = false;
  for (let i = 0; i < 80 && still < 5; i++) {
    const height = main.scrollHeight;
    loading = !!main.querySelector(${JSON.stringify(LOADING_MARKER)});
    still = !loading && height === last ? still + 1 : 0;
    last = loading ? -1 : height;
    await new Promise((r) => setTimeout(r, 100));
  }
  return JSON.stringify(still >= 5 ? "settled" : loading ? "loading" : "changing");
})()`;

// Runs in the page (agent-browser eval). Self-contained: no closures.
const PROBE = `(async () => {
  const html = document.documentElement;
  const vw = html.clientWidth;
  const main = document.querySelector('[data-scroll-restoration-id="app-main"]');
  const out = { vw, docScroll: document.scrollingElement.scrollHeight - window.innerHeight, header: !!document.querySelector("header"), main: null, footer: null, rules: [], toast: null };
  if (main) {
    main.scrollTop = main.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.main = { bottom: Math.round(main.getBoundingClientRect().bottom), scrollable: main.scrollHeight > main.clientHeight, scrollbar: main.offsetWidth - main.clientWidth };
    const footer = main.querySelector("footer[data-public-footer]");
    if (footer) {
      const column = footer.parentElement;
      out.footer = { bottom: Math.round(footer.getBoundingClientRect().bottom), lastInMain: column.parentElement === main && column.lastElementChild === footer && main.children.length === 1 };
      out.rules.push({ name: "footer border-t", left: Math.round(footer.getBoundingClientRect().left), right: Math.round(footer.getBoundingClientRect().right), inMain: true });
    }
    main.scrollTop = 0;
  }
  // The arena header draws its rule as its own border-b; the app header uses an <hr>.
  for (const header of document.querySelectorAll("header")) if (parseFloat(getComputedStyle(header).borderBottomWidth) > 0) out.rules.push({ name: "header border-b", left: Math.round(header.getBoundingClientRect().left), right: Math.round(header.getBoundingClientRect().right), inMain: !!main && main.contains(header) });
  for (const hr of document.querySelectorAll("header hr")) out.rules.push({ name: "header <hr>", left: Math.round(hr.getBoundingClientRect().left), right: Math.round(hr.getBoundingClientRect().right), inMain: !!main && main.contains(hr) });
  // Bands inside a #main-content column narrower than <main> start where that column starts.
  const column = document.getElementById("main-content");
  const startOf = (el) => (column && column !== main && column.contains(el) ? Math.round(column.getBoundingClientRect().left) : 0);
  for (const nav of document.querySelectorAll("main nav.border-b")) out.rules.push({ name: "sub-nav border-b", left: Math.round(nav.getBoundingClientRect().left), right: Math.round(nav.getBoundingClientRect().right), inMain: true, start: startOf(nav) });
  for (const banner of document.querySelectorAll("main [role=alert].border-b")) out.rules.push({ name: "banner border-b", left: Math.round(banner.getBoundingClientRect().left), right: Math.round(banner.getBoundingClientRect().right), inMain: true, start: startOf(banner) });
  const pill = document.querySelector("[data-sileo-viewport] [data-sileo-pill]");
  if (pill) {
    const ctx = document.createElement("canvas").getContext("2d");
    const rgb = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
    const probe = document.createElement("div");
    probe.style.color = "var(--popover)";
    document.body.append(probe);
    const popover = rgb(getComputedStyle(probe).color);
    probe.remove();
    const fill = rgb(getComputedStyle(pill).fill);
    const color = (sel) => { const el = document.querySelector("[data-sileo-viewport] " + sel); return el ? rgb(getComputedStyle(el).color) : null; };
    const title = color("[data-sileo-title]"), badge = color("[data-sileo-badge]"), button = color("[data-sileo-button]");
    out.toast = { dark: html.classList.contains("dark"), fill: fill.join(","), popover: popover.join(","), title: title ? ratio(title, fill) : 0, badge: badge ? ratio(badge, fill) : 0, button: button ? ratio(button, fill) : null };
  }
  return JSON.stringify(out);
})()`;

interface Page {
  name: string;
  path: string;
  expect: Expect;
  /** Wait for this selector before probing. */
  ready: string;
  signedIn?: boolean;
}

const PAGES: Page[] = [
  { name: "arena", path: "/en-US", expect: { footer: true }, ready: "footer[data-public-footer]" },
  {
    name: "the rules",
    path: "/en-US?tab=methodology",
    expect: { footer: true },
    ready: "footer[data-public-footer]",
  },
  {
    name: "leaderboard",
    path: "/en-US?tab=leaderboard",
    expect: { footer: true },
    ready: "footer[data-public-footer]",
  },
  {
    name: "studio",
    path: "/en-US?tab=studio",
    expect: { footer: true },
    ready: "footer[data-public-footer]",
  },
  {
    name: "404",
    path: "/en-US/check-layout-missing",
    expect: { footer: true },
    ready: "footer[data-public-footer]",
  },
  { name: "sign-in", path: "/en-US/login", expect: { footer: false }, ready: "form" },
  {
    name: "settings",
    path: "/en-US/settings",
    expect: { footer: false },
    ready: 'main input[autocomplete="name"]',
    signedIn: true,
  },
  {
    name: "admin users",
    path: "/en-US/admin/users",
    expect: { footer: false },
    ready: "main nav.border-b",
    signedIn: true,
  },
];
const VIEWPORTS = [
  [390, 844],
  [1280, 800],
  [1440, 1600],
  [390, 300],
] as const;

// An unclaimed file drop shows the neutral "file ignored" toast (FileDropGuard). The guard mounts
// after hydration (ClientOnly), so drop again every half second until a toast shows (20s at most).
const DROP_FILE = `(async () => {
  const pill = () => document.querySelector("[data-sileo-viewport] [data-sileo-pill]");
  for (let i = 0; i < 40 && !pill(); i++) {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "x.txt"));
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 500));
  }
  return !!pill();
})()`;

async function measure(run: CheckRun): Promise<string[]> {
  const { base, browser, args } = run;
  // Read before the browser work starts, so a missing password fails at once.
  const account = args.includes("--login") ? loginAccount(args) : undefined;
  const failures: string[] = [];
  await browser.run(["cookies", "clear"]);
  // A decided consent, so an app with analytics shows no banner while the
  // shell is measured; the banner's reserve is probed on its own (judgeReserve).
  await browser.run(["open", `${base}/en-US/login`]);
  await decideConsent(run);
  const pages = PAGES.filter((page) => !page.signedIn || account);
  if (pages.length < PAGES.length)
    console.log("check:layout: no --login, so the signed-in pages are skipped");
  const anonymous = pages.filter((page) => !page.signedIn);
  const signedIn = pages.filter((page) => page.signedIn);
  const measurePages = async (list: Page[]) => {
    for (const [w, h] of VIEWPORTS) {
      await browser.run(["set", "viewport", String(w), String(h)]);
      for (const page of list) {
        await browser.run(["open", `${base}${page.path}`]);
        await browser.run(["wait", page.ready]);
        const label = `${page.name} ${w}×${h}`;
        const settled = await browser.evalJson<"settled" | "loading" | "changing">(SETTLED);
        if (settled !== "settled") {
          failures.push(
            settled === "loading"
              ? `${label}: still showing a loading skeleton after 8s, so it was not measured; check that its data loads`
              : `${label}: the content kept changing for 8s, so it was not measured`,
          );
          continue;
        }
        const probe = await browser.evalJson<Probe>(PROBE);
        failures.push(...judgeLayout(label, probe, page.expect));
        failures.push(
          ...judgeReserve(label, await browser.evalJson<ReserveProbe | null>(RESERVE_PROBE)),
        );
        console.log(
          `check:layout: ${label} measured (${probe.main?.scrollable ? "long" : "short"} page)`,
        );
      }
    }
  };
  // The arena header in every shipped locale, at every width from 320 to 3840px.
  const locales = shippedLocales();
  const measureHeader = async (signedInNow: boolean) => {
    for (const w of HEADER_WIDTHS) {
      await browser.run(["set", "viewport", String(w), "800"]);
      for (const locale of locales) {
        await browser.run(["open", `${base}/${locale}`]);
        // The `_public` layout seeds the session hint, so a signed-in account
        // link is in the first HTML; its absence is judged, not waited for.
        await browser.run(["wait", "header [data-header-controls]"]);
        const label = `header ${locale} ${w}px signed ${signedInNow ? "in" : "out"}`;
        const probe = await browser.evalJson<HeaderProbe>(HEADER_PROBE);
        failures.push(...judgeHeader(label, probe, signedInNow));
        console.log(
          `check:layout: ${label} measured${probe.navOverflow > 0 ? ` (tabs scroll ${probe.navOverflow}px)` : ""}`,
        );
      }
    }
  };
  // Signed-in pages first, then sign out (dropping the cookies).
  if (account && signedIn.length) {
    await formSignIn(run, account);
    await measurePages(signedIn);
    await measureHeader(true);
    await browser.run(["cookies", "clear"]);
  }
  await measurePages(anonymous);
  await measureHeader(false);
  // Toasts, light and dark at one width, each with the OS set to the other.
  await browser.run(["set", "viewport", "1280", "800"]);
  for (const theme of ["light", "dark"] as const) {
    await browser.run(["set", "media", theme === "dark" ? "light" : "dark"]);
    await browser.run(["open", `${base}/en-US`]);
    await browser.run(["eval", `localStorage.setItem('${THEME_KEY}', '${theme}'); true`]);
    await browser.run(["open", `${base}/en-US`]);
    await browser.run(["wait", "footer[data-public-footer]"]);
    await browser.run(["eval", "--stdin"], DROP_FILE);
    await browser.run(["wait", "[data-sileo-viewport] [data-sileo-pill]"]);
    await browser.run(["wait", "800"]);
    failures.push(
      ...judgeLayout(`toast ${theme}`, await browser.evalJson<Probe>(PROBE), {
        footer: true,
        toast: theme,
      }),
    );
    console.log(`check:layout: toast ${theme} measured`);
  }
  return failures;
}

if (import.meta.filename === process.argv[1])
  process.exitCode = await withBrowser("check:layout", SESSION, measure, { mockServer: false });

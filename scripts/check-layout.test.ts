/** Fixtures for the pure judge in scripts/check-layout.ts: node --test scripts/check-layout.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HEADER_WIDTHS,
  type HeaderProbe,
  judgeHeader,
  judgeLayout,
  judgeReserve,
  type Probe,
  type ReserveProbe,
  shippedLocales,
} from "./check-layout.ts";

const good: Probe = {
  vw: 1280,
  docScroll: 0,
  header: true,
  main: { bottom: 800, scrollable: false, scrollbar: 0 },
  footer: { bottom: 800, lastInMain: true },
  rules: [
    { name: "header <hr>", left: 0, right: 1280, inMain: false },
    { name: "footer border-t", left: 0, right: 1280, inMain: true },
  ],
  toast: null,
};

const toast = {
  dark: true,
  fill: "22,27,29",
  popover: "22,27,29",
  title: 16.7,
  badge: 8.5,
  button: 16.7,
};

describe("judgeLayout", () => {
  it("passes a short page whose footer ends at the scroller's bottom", () => {
    assert.deepEqual(judgeLayout("landing", good, { footer: true }), []);
    assert.deepEqual(
      judgeLayout(
        "landing",
        { ...good, footer: { bottom: 801, lastInMain: true } },
        { footer: true },
      ),
      [],
    );
  });

  it("reports the landing footer gap, a missing footer and a footer that is not last", () => {
    assert.match(
      judgeLayout(
        "landing",
        { ...good, footer: { bottom: 353, lastInMain: true } },
        { footer: true },
      ).join("\n"),
      /footer ends at 353px, the scroller at 800px \(short page\)/,
    );
    assert.match(
      judgeLayout(
        "404",
        { ...good, footer: null, header: false, main: null },
        { footer: true },
      ).join("\n"),
      /no <main[\s\S]*no shell header[\s\S]*no public footer/,
    );
    assert.match(
      judgeLayout(
        "landing",
        { ...good, footer: { bottom: 800, lastInMain: false } },
        { footer: true },
      ).join("\n"),
      /not the last box/,
    );
  });

  it("reports a document scroll, a reserved gutter and rules stopped short by it", () => {
    const bad = judgeLayout(
      "admin",
      {
        ...good,
        docScroll: 12,
        main: { bottom: 800, scrollable: false, scrollbar: 15 },
        rules: [{ name: "sub-nav border-b", left: 0, right: 1265, inMain: true }],
      },
      { footer: false },
    );
    assert.equal(bad.length, 3, bad.join("\n"));
    assert.match(bad.join("\n"), /document scrolls by 12px/);
    assert.match(bad.join("\n"), /reserves a 15px scrollbar gutter on a page that does not scroll/);
    assert.match(bad.join("\n"), /sub-nav border-b spans 0…1265px, not 0…1280px/);
  });

  it("lets a rule inside a scrolling scroller meet the visible scrollbar, never one outside it", () => {
    const scrolling = { bottom: 800, scrollable: true, scrollbar: 15 };
    assert.deepEqual(
      judgeLayout(
        "admin long",
        {
          ...good,
          main: scrolling,
          rules: [
            { name: "header <hr>", left: 0, right: 1280, inMain: false },
            { name: "sub-nav border-b", left: 0, right: 1265, inMain: true },
          ],
        },
        { footer: false },
      ),
      [],
    );
    assert.equal(
      judgeLayout(
        "admin long",
        {
          ...good,
          main: scrolling,
          rules: [{ name: "header <hr>", left: 0, right: 1265, inMain: false }],
        },
        { footer: false },
      ).length,
      1,
    );
  });

  it("lets a band inside AppFrame's content column start after the sidebar, not before it", () => {
    const band = { name: "banner border-b", right: 1280, inMain: true, start: 240 };
    assert.deepEqual(
      judgeLayout("ongoing", { ...good, rules: [{ ...band, left: 240 }] }, { footer: false }),
      [],
    );
    assert.match(
      judgeLayout("ongoing", { ...good, rules: [{ ...band, left: 256 }] }, { footer: false }).join(
        "",
      ),
      /banner border-b spans 256…1280px, not 240…1280px/,
    );
    assert.equal(
      judgeLayout(
        "ongoing",
        { ...good, rules: [{ ...band, left: 240, right: 1265 }] },
        { footer: false },
      ).length,
      1,
    );
  });

  it("checks the toast fill against the theme's popover, its contrast and the stored theme", () => {
    assert.deepEqual(
      judgeLayout("toast dark", { ...good, toast }, { footer: false, toast: "dark" }),
      [],
    );
    const inverted = judgeLayout(
      "toast dark",
      { ...good, toast: { ...toast, fill: "242,242,242", title: 3.4, badge: 3.4, button: 3.4 } },
      { footer: false, toast: "dark" },
    );
    assert.equal(inverted.length, 4, inverted.join("\n"));
    assert.match(inverted[0] ?? "", /filled 242,242,242, not the dark theme's popover 22,27,29/);
    assert.match(
      judgeLayout("toast light", good, { footer: false, toast: "light" }).join(""),
      /no toast appeared/,
    );
    assert.match(
      judgeLayout("toast light", { ...good, toast }, { footer: false, toast: "light" }).join(""),
      /stored light theme lost to the OS/,
    );
  });
});

describe("judgeReserve", () => {
  // kb-like desktop shell: frame > row > [sidebar, main]; banner reserve 200px.
  const before = [
    { name: "<main>", bottom: 800 },
    { name: "beside <main>: aside[data-slot=sidebar]", bottom: 800 },
    { name: "div", bottom: 800 },
    { name: "div", bottom: 800 },
  ];
  const reserve: ReserveProbe = {
    vh: 800,
    inset: 200,
    before,
    after: before,
    contentEnd: 600,
    footer: null,
  };

  it("passes when only <main>'s content makes room above the banner", () => {
    assert.deepEqual(judgeReserve("settings", reserve), []);
  });

  it("reports a frame or sidebar that the banner's reserve shortens (the owner's cut-off sidebar)", () => {
    const shrunk = before.map((box) => ({ ...box, bottom: box.name === "<main>" ? 800 : 600 }));
    const bad = judgeReserve("settings", { ...reserve, after: shrunk });
    assert.equal(bad.length, 3);
    assert.match(bad[0] ?? "", /sidebar\] ends at 600px instead of 800px/);
  });

  it("reports content left under the banner and a frame short of the viewport", () => {
    assert.match(
      judgeReserve("landing", { ...reserve, contentEnd: 700 })[0] ?? "",
      /under a banner starting at 600px/,
    );
    const short = before.map((box) => ({ ...box, bottom: 790 }));
    assert.match(
      judgeReserve("landing", { ...reserve, before: short, after: short })[0] ?? "",
      /frame ends at 790px, not the viewport bottom \(800px\)/,
    );
    assert.deepEqual(judgeReserve("x", null), ['x: no <main id="main-content"> scroller']);
  });

  it("pins a short public page's footer to the banner's top, not anywhere above it", () => {
    assert.deepEqual(judgeReserve("landing", { ...reserve, footer: 600 }), []);
    assert.match(
      judgeReserve("landing", { ...reserve, contentEnd: 500, footer: 500 })[0] ?? "",
      /footer ends at 500px, not where the banner starts \(600px\)/,
    );
  });
});

describe("judgeHeader", () => {
  // es-MX, 768px, signed in: the 24px row padding puts the controls' end at 744.
  const header: HeaderProbe = {
    vw: 768,
    controls: { left: 473, right: 744 },
    items: [
      { name: "language", left: 473, right: 539, width: 66 },
      { name: "theme", left: 547, right: 591, width: 44 },
      { name: "studio", left: 599, right: 692, width: 93 },
      { name: "account", left: 700, right: 744, width: 44 },
    ],
    rowOverflow: 0,
    navOverflow: 0,
    // Squeezed to each label's longest word, two labels wrapped, the strip scrolling.
    tabs: [
      { name: "Arena", left: 132, right: 176, labelLeft: 132, labelRight: 167 },
      { name: "Tabla de clasificación", left: 192, right: 276, labelLeft: 192, labelRight: 276 },
      { name: "Laboratorio local", left: 292, right: 362, labelLeft: 292, labelRight: 361 },
      { name: "Las reglas", left: 378, right: 422, labelLeft: 378, labelRight: 414 },
    ],
  };

  it("passes controls inside the viewport, also while the tabs scroll", () => {
    assert.deepEqual(judgeHeader("header", header, true), []);
    assert.deepEqual(judgeHeader("header", { ...header, navOverflow: 120 }, true), []);
    assert.deepEqual(judgeHeader("header", { ...header, rowOverflow: 1 }, true), []);
  });

  it("reports the account link pushed off-screen by the tabs (Codex round 2)", () => {
    const pushed: HeaderProbe = {
      ...header,
      controls: { left: 600, right: 871 },
      items: header.items.map((item) => ({
        ...item,
        left: item.left + 127,
        right: item.right + 127,
      })),
      rowOverflow: 127,
    };
    const bad = judgeHeader("header es-MX 768px signed in", pushed, true);
    assert.match(bad.join("\n"), /controls span 600…871px, outside the 768px viewport/);
    assert.match(bad.join("\n"), /account control spans 827…871px, past the 768px viewport/);
    assert.match(bad.join("\n"), /header row overflows by 127px/);
  });

  it("reports tabs squeezed below their labels, overlapping the next tab (Codex round 3)", () => {
    // es-MX, 651px, signed in: every link at its old explicit 44px floor.
    const squeezed: HeaderProbe = {
      ...header,
      vw: 651,
      navOverflow: 0,
      tabs: [
        { name: "Arena", left: 132, right: 176, labelLeft: 132, labelRight: 167 },
        { name: "Tabla de clasificación", left: 192, right: 236, labelLeft: 192, labelRight: 276 },
        { name: "Laboratorio local", left: 252, right: 296, labelLeft: 252, labelRight: 321 },
        { name: "Las reglas", left: 312, right: 356, labelLeft: 312, labelRight: 348 },
      ],
    };
    const bad = judgeHeader("header es-MX 651px signed in", squeezed, true).join("\n");
    assert.match(
      bad,
      /"Tabla de clasificación" tab's label spans 192…276px, past its 192…236px tab/,
    );
    assert.match(bad, /"Laboratorio local" tab's label spans 252…321px, past its 252…296px tab/);
    assert.match(bad, /"Tabla de clasificación" and "Laboratorio local" tabs overlap/);
    assert.match(bad, /"Laboratorio local" and "Las reglas" tabs overlap/);
    assert.doesNotMatch(bad, /"Arena" tab's label|"Las reglas" tab's label|"Arena" and/);
  });

  it("reports two tab boxes that intersect even when each label fits its own box", () => {
    const tabs = header.tabs.map((tab) => ({ ...tab }));
    tabs[2] = { ...tabs[2], left: 260, labelLeft: 260 } as HeaderProbe["tabs"][number];
    assert.deepEqual(judgeHeader("x", { ...header, tabs }, false), [
      'x: the "Tabla de clasificación" and "Laboratorio local" tabs overlap (276px past 260px); the strip must scroll instead',
    ]);
    assert.deepEqual(judgeHeader("x", { ...header, tabs: [] }, false), []);
  });

  it("requires the account link signed in, and not signed out", () => {
    const signedOut = { ...header, items: header.items.slice(0, 3) };
    assert.deepEqual(judgeHeader("header", signedOut, false), []);
    assert.match(
      judgeHeader("header", signedOut, true)[0] ?? "",
      /signed in, but the header has no account link/,
    );
  });

  it("reports a missing group and a collapsed control", () => {
    assert.deepEqual(judgeHeader("x", { ...header, controls: null }, false), [
      "x: no [data-header-controls] in the arena header",
    ]);
    const collapsed = { ...header, items: [{ name: "theme", left: 0, right: 0, width: 0 }] };
    assert.match(judgeHeader("x", collapsed, false)[0] ?? "", /theme control has no width/);
  });

  it("measures every shipped locale from a phone to 4K, around each header breakpoint", () => {
    const locales = shippedLocales();
    assert.ok(locales.includes("en-US") && locales.includes("es-MX"), locales.join(","));
    for (const w of [320, 390, 640, 650, 651, 768, 1024, 1279, 1280, 1440, 1920, 3840])
      assert.ok((HEADER_WIDTHS as readonly number[]).includes(w), `${w}px`);
  });
});

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, bigFamily, sleep } from "../helpers/app.mjs";

const SIZES = { phone: [390, 844], "small phone": [360, 640], tablet: [820, 1180], "tablet landscape": [1180, 820], desktop: [1440, 900] };
const sideways = (page) => page.evaluate(() => ({
  page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  header: [...document.querySelectorAll(".top button, .top a, .top .chip")].filter((e) => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.id || e.textContent.trim()),
}));

describe("layout works on phones, tablets and desktops", () => {
  let app, page;
  before(async () => { app = await startApp({ graph: bigFamily(4, 3) }); page = app.page; });
  after(() => app.close());

  for (const [name, [w, h]] of Object.entries(SIZES)) {
    test("public page at " + name + ": nothing spills sideways, header fits, the tree and controls are reachable", async () => {
      await page.setViewportSize({ width: w, height: h });
      await app.open("/index.html"); await sleep(1200);
      const s = await sideways(page);
      assert.equal(s.page, 0, "no horizontal page scroll");
      assert.deepEqual(s.header, [], "every header control is on screen");
      assert.ok((await page.evaluate(() => cy.nodes().length)) > 0, "the tree is drawn");
      const tree = await page.locator("#tree").boundingBox();
      assert.ok(tree.width >= Math.min(w, 320) && tree.height > h * 0.55, "the canvas has room: " + JSON.stringify(tree));
      if (w <= 1050) {
        // the details panel is a drawer: its button must be reachable without scrolling the toolbar, and it must open and close
        const btn = page.locator(".toolbar .openPanel");
        const b = await btn.boundingBox();
        assert.ok(b && b.x >= 0 && b.x + b.width <= w, "Panel button is on screen: " + JSON.stringify(b));
        await btn.click(); await sleep(400);
        assert.equal(await page.evaluate(() => document.getElementById("sidePanel").classList.contains("open")), true);
        const side = await page.locator("#sidePanel").boundingBox();
        assert.ok(side.x >= -1 && side.x + side.width <= w + 1, "drawer fits the screen: " + JSON.stringify(side));
        await page.click("#sideClose"); await sleep(400);
        assert.equal(await page.evaluate(() => document.getElementById("sidePanel").classList.contains("open")), false);
      }
    });
  }

  for (const [name, [w, h]] of Object.entries(SIZES)) {
    test("Admin Studio at " + name + ": header fits and forms are single-column on phones", async () => {
      await page.setViewportSize({ width: w, height: h });
      await app.open(); await sleep(700);
      const s = await sideways(page);
      assert.equal(s.page, 0, "no horizontal page scroll");
      assert.deepEqual(s.header, [], "every header control is on screen");
      if (w <= 700) {
        const cols = await page.evaluate(() => getComputedStyle(document.querySelector(".grid2")).gridTemplateColumns.split(" ").length);
        assert.equal(cols, 1, "form fields stack on phones");
      }
    });
  }

  test("handles and the collapse pill get larger touch targets on touch screens", async () => {
    await app.open("/index.html"); await sleep(1000);
    const css = await page.evaluate(() => { const s = document.getElementById("nh-style"); return s ? s.textContent : ""; });
    assert.match(css, /pointer:coarse[^}]*\.nh-btn\{width:38px/);
  });

  test("a phone quick-add sheet never grows taller than the screen", async () => {
    await page.setViewportSize({ width: 360, height: 640 });
    await app.open("/index.html"); await sleep(1200);
    const id = await page.evaluate(() => data.persons[3].id);
    await page.evaluate((id) => openQuickAdd("child", id, { x: 180, y: 300 }), id); await sleep(400);
    const box = await page.locator("#quickAdd").boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 640 + 1, "sheet fits: " + JSON.stringify(box));
  });
});

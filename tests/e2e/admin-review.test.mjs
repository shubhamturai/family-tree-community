import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, bigFamily, sleep, PASSWORD } from "../helpers/app.mjs";

const stats = (page) => page.evaluate(() => ({
  nodes: cy.nodes().length, pend: cy.nodes(".pend").length, dim: cy.elements(".dim").length, bar: !document.getElementById("rvBar").classList.contains("hidden"),
  cur: cy.elements(".ghost.cur").length, acc: cy.elements(".ghost.acc").length, fut: cy.elements(".ghost.fut").length,
}));
const bar = (page) => page.innerText("#rvBar").then((t) => t.replace(/\s+/g, " "));

describe("in-tree review of community requests", () => {
  let app, page, family;
  before(async () => {
    family = bigFamily(5, 3);
    app = await startApp({ graph: family });
    page = app.page;
    const P = family.persons, deep = P[P.length - 1], mid = P[Math.floor(P.length / 2)];
    const parents = family.relationships.parentChild.filter((r) => r.childId === deep.id).map((r) => r.parentId);
    app.addRequest("r1", "2026-10-01T10:00:00Z", [
      { type: "ADD_PERSON", payload: { person: { id: "P900001", firstName: "Baby", familyName: "Rao", displayName: "Baby Rao", gender: "female", dateOfBirth: "2024-05-01" } } },
      { type: "ADD_PARENT_CHILD", payload: { parentId: parents[0], childId: "P900001", role: "father", order: 9 } },
      { type: "ADD_PARENT_CHILD", payload: { parentId: parents[1], childId: "P900001", role: "mother", order: 9 } },
    ]);
    app.addRequest("r2", "2026-10-02T10:00:00Z", [
      { type: "UPDATE_PERSON", payload: { personId: mid.id, occupation: "Surgeon", birthPlace: "Chennai" } },
      { type: "DELETE_PERSON", payload: { personId: P[3].id } },
    ]);
    await app.open();
    await app.unlock();
    await sleep(900);
  });
  after(() => app.close());

  test("the whole tree is drawn on the main canvas with pending people ringed", async () => {
    const s = await stats(page);
    assert.equal(s.nodes, family.persons.length);
    assert.ok(s.pend >= 3, "pending people are ringed: " + s.pend);
  });

  test("the layout has no overlaps and children sit below their parents", async () => {
    const r = await page.evaluate(() => {
      const ns = cy.nodes().map((n) => ({ id: n.id(), x: n.position("x"), y: n.position("y") }));
      let overlaps = 0;
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) if (Math.abs(ns[i].y - ns[j].y) < 40 && Math.abs(ns[i].x - ns[j].x) < 140) overlaps++;
      const pos = Object.fromEntries(ns.map((n) => [n.id, n]));
      let wrong = 0;
      cy.edges().forEach((e) => { if (!e.hasClass("sp") && pos[e.target().id()].y <= pos[e.source().id()].y) wrong++; });
      return { overlaps, wrong };
    });
    assert.equal(r.overlaps, 0);
    assert.equal(r.wrong, 0);
  });

  test("review walks the changes in order, previews them on the tree, and applies only after a summary", async () => {
    await page.click("#rvStart");
    await sleep(800);
    let s = await stats(page);
    assert.ok(s.bar && s.cur === 1 && s.fut >= 2, "ghost for the current change and faint ghosts for the rest: " + JSON.stringify(s));
    assert.ok(s.dim > s.nodes / 2, "the rest of the tree is dimmed");
    let t = await bar(page);
    assert.match(t, /Request 1 of 2/); assert.match(t, /change 1 of 3/); assert.match(t, /New person: Baby Rao/);

    await page.keyboard.press("a"); await sleep(600);
    t = await bar(page);
    assert.match(t, /change 2 of 3/); assert.match(t, /becomes the father of Baby Rao/);
    s = await stats(page);
    assert.equal(s.acc, 1, "the accepted person stays on the tree");

    await page.keyboard.press("r"); await sleep(500);   // reject the father link
    await page.keyboard.press("a"); await sleep(600);   // accept the mother link
    t = await bar(page);
    assert.match(t, /summary/); assert.match(t, /Ready to apply/); assert.match(t, /2 accepted/); assert.match(t, /1 rejected/);
    assert.equal(app.gh.commits.length, 0, "nothing is committed before the explicit apply");

    await page.fill("#rvNote", "Thanks!");
    await page.dblclick("#rvApply"); await sleep(1800);
    assert.equal(app.gh.commits.length, 1, "double-clicking Apply commits once");
    const baby = app.gh.graph.persons.find((p) => p.displayName === "Baby Rao");
    assert.ok(baby);
    assert.equal(app.gh.graph.relationships.parentChild.filter((r) => r.childId === baby.id).length, 1, "only the accepted link was committed");
    assert.match(app.env.DB.requests.get("r1").note, /\[2 of 3 changes approved\] Thanks!/);

    t = await bar(page);
    assert.match(t, /Request 1 of 1/); assert.match(t, /Edit/, "the next request opens automatically");
    assert.equal((await stats(page)).nodes, app.gh.graph.persons.length, "the tree is redrawn with what was just applied");
  });

  test("rejecting everything demands a note, then completes the review", async () => {
    await page.keyboard.press("r"); await sleep(400);
    await page.keyboard.press("r"); await sleep(600);
    assert.match(await bar(page), /Nothing accepted/);
    await page.click("#rvApply"); await sleep(300);
    assert.match(await app.toastText(), /note/i);
    await page.fill("#rvNote", "Not needed");
    await page.click("#rvApply"); await sleep(1500);
    assert.equal(app.env.DB.requests.get("r2").status, "rejected");
    assert.match(await page.innerText("#reviewStatus"), /Review complete/);
    assert.deepEqual(app.errors, []);
  });
});

describe("session and tab behaviour", () => {
  let app;
  after(() => app?.close());

  test("only a session token is stored in the browser, never the password", async () => {
    app = await startApp({ graph: bigFamily(3, 2) });
    app.addRequest("r1", "2026-10-01T10:00:00Z", [{ type: "ADD_PERSON", payload: { person: { displayName: "New Person" } } }]);
    await app.open(); await app.unlock();
    const stored = await app.page.evaluate(() => sessionStorage.getItem("familyGraphAdminSession"));
    assert.ok(stored && stored !== PASSWORD && !stored.includes(PASSWORD));
    assert.equal(await app.page.inputValue("#password"), "", "password field is cleared after login");
    assert.deepEqual(app.errors, []);
  });

  test("reloading restores the session and opens the pending requests, polling keeps running", async () => {
    await app.page.reload(); await sleep(1500);
    assert.equal(await app.page.isVisible("#reviewPane"), true);
    assert.match(await app.page.innerText("#count"), /1/);
    assert.equal(await app.page.isVisible("#tokenBox"), true);
  });

  test("Lock ends the session cleanly", async () => {
    await app.page.click("#lock"); await sleep(300);
    assert.equal(await app.page.evaluate(() => sessionStorage.getItem("familyGraphAdminSession")), null);
    assert.equal(await app.page.inputValue("#password"), "");
    assert.equal(await app.page.isVisible("#editPane"), true);
    assert.equal(await app.page.innerHTML("#requests"), "");
  });

  test("an expired or invalid session is dropped without errors", async () => {
    await app.page.evaluate(() => sessionStorage.setItem("familyGraphAdminSession", "forged.token"));
    await app.page.reload(); await sleep(1200);
    assert.equal(await app.page.evaluate(() => sessionStorage.getItem("familyGraphAdminSession")), null);
    assert.match(await app.page.innerText("#loginStatus"), /expired/i);
  });

  test("a wrong password shows a clear message and keeps the form usable", async () => {
    await app.page.fill("#password", "wrong-password-xx"); await app.page.click("#login"); await sleep(600);
    assert.match(await app.page.innerText("#loginStatus"), /Incorrect|failed/i);
    assert.equal(await app.page.isVisible("#password"), true);
  });

  test("a hostile request id cannot run script", async () => {
    app.addRequest("x');window.__pwn=1;('", "2026-10-03T10:00:00Z", [{ type: "ADD_PERSON", payload: { person: { displayName: "Sneaky" } } }]);
    await app.page.fill("#password", PASSWORD); await app.page.click("#login"); await sleep(1200);
    await app.page.click(".issue button[data-review]"); await sleep(600);
    assert.equal(await app.page.evaluate(() => window.__pwn), undefined);
  });
});

describe("editing tab", () => {
  let app;
  before(async () => {
    app = await startApp({ graph: bigFamily(3, 2) });
    app.addRequest("r1", "2026-10-01T10:00:00Z", [{ type: "ADD_PERSON", payload: { person: { displayName: "New Person" } } }]);
    await app.open(); await app.unlock();
  });
  after(() => app.close());

  test("toolbar actions that need the tree explain themselves instead of throwing", async () => {
    await app.page.click("#editTab"); await sleep(300);
    await app.page.fill("#search", "abc"); await app.page.click("#treeMode"); await app.page.click("#addPerson"); await sleep(300);
    assert.match(await app.toastText(), /Connect GitHub/);
    assert.deepEqual(app.errors, []);
  });

  test("connecting keeps the Edit tab, tapping a person opens the editor, a failed save explains and reloads", async () => {
    await app.page.fill("#token", "ghp_test"); await app.page.click("#connect"); await sleep(900);
    assert.equal(await app.page.isVisible("#editPane"), true);
    assert.equal(await app.page.evaluate(() => cy.nodes().length), app.gh.graph.persons.length);
    await app.page.evaluate(() => cy.getElementById("P000001").emit("tap")); await sleep(300);
    assert.equal(await app.page.isVisible("#save"), true);
    app.net.githubFail = 1;
    await app.page.fill("#notes", "changed"); await app.page.click("#save"); await sleep(900);
    assert.match(await app.toastText(), /does not match/);
    assert.equal(await app.page.inputValue("#notes"), "", "the form reverts to the stored data");
    await app.page.fill("#notes", "ok"); await app.page.click("#save"); await sleep(600);
    assert.equal(await app.page.textContent("#connection"), "Saved");
    assert.deepEqual(app.errors.filter((e) => !/409/.test(e)), [], "only the deliberate 409 is logged");
  });

  test("hovering a person shows + handles that open the relationship dialogs, and dragging one onto someone preselects them", async () => {
    const center = (id) => app.page.evaluate((id) => { const n = cy.getElementById(id), p = n.renderedPosition(), r = document.getElementById("tree").getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }, id);
    const ids = app.gh.graph.persons.map((p) => p.id), a = ids[2], b = ids[4];
    let c = await center(a);
    await app.page.mouse.move(c.x - 20, c.y - 5); await app.page.mouse.move(c.x, c.y, { steps: 3 }); await sleep(350);
    assert.equal(await app.page.locator(".nh-layer.on .nh-btn").count(), 3, "parent, child and spouse handles");
    let box = await app.page.locator('.nh-layer.on .nh-btn[data-kind="child"]').boundingBox();
    await app.page.mouse.move(box.x + 14, box.y + 14); await app.page.mouse.down(); await app.page.mouse.up(); await sleep(400);
    assert.match(await app.page.innerText("#modalTitle"), /Add child/);
    await app.page.click("#modalCancel"); await sleep(200);
    c = await center(a);
    await app.page.mouse.move(c.x - 20, c.y - 5); await app.page.mouse.move(c.x, c.y, { steps: 3 }); await sleep(350);
    box = await app.page.locator('.nh-layer.on .nh-btn[data-kind="spouse"]').boundingBox();
    const t = await center(b);
    await app.page.mouse.move(box.x + 14, box.y + 14); await app.page.mouse.down(); await app.page.mouse.move(t.x, t.y, { steps: 10 }); await app.page.mouse.up(); await sleep(400);
    assert.match(await app.page.innerText("#modalTitle"), /Add spouse/);
    assert.equal(await app.page.inputValue("#mExisting"), b, "the person it was dropped on is preselected");
    await app.page.click("#modalCancel");
    assert.deepEqual(app.errors.filter((e) => !/409/.test(e)), []);
  });

  test("Admin Studio's edit canvas can fold branches too, and selecting a hidden person opens the fold", async () => {
    const p = app.page, vis = () => p.evaluate(() => cy.nodes().length);
    await p.evaluate(() => showTab("edit"));
    await p.fill("#search", ""); await sleep(500);
    const total = await vis(), root = await p.evaluate(() => data.persons[0].id), deep = await p.evaluate(() => data.persons[data.persons.length - 1].id);
    await p.evaluate((id) => toggleBranch(id), root); await sleep(400);
    const folded = await vis();
    assert.ok(folded < total / 2, "most of the tree folds away: " + folded + " of " + total);
    assert.match(await p.evaluate((id) => cy.getElementById(id).data("label"), root), /▸ \d+ hidden/);
    await p.evaluate((id) => select(id), deep); await sleep(500);
    assert.equal(await p.evaluate((id) => cy.getElementById(id).length, deep), 1, "selecting someone inside the fold reveals them");
    await p.click("#collapseBtn"); await sleep(400);
    assert.equal(await p.evaluate(() => document.getElementById("collapseBtn").textContent.trim()), "⇱ Expand all");
    await p.click("#collapseBtn"); await sleep(400);
    assert.equal(await vis(), total);
    assert.deepEqual(app.errors.filter((e) => !/409/.test(e)), []);
  });
});

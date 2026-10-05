import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, bigFamily, sleep } from "../helpers/app.mjs";
import { applyProposal, integrityIssues } from "../../backend/src/graph.js";

const center = (page, id) => page.evaluate((id) => {
  const n = cy.getElementById(id), p = n.renderedPosition(), r = document.getElementById("tree").getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, id);
const handle = async (page, kind) => {
  const loc = page.locator('.nh-layer.on .nh-btn[data-kind="' + kind + '"]');
  try { await loc.waitFor({ timeout: 3000 }); } catch (e) { await page.screenshot({ path: process.env.SHOT || "/tmp/handle-fail.png" }); throw new Error("handle '" + kind + "' did not appear (screenshot saved): " + JSON.stringify(await page.evaluate(() => ({ z: cy.zoom(), sel: cy.$("node:selected").map((n) => n.id()), layer: document.querySelector(".nh-layer")?.className, target: handles && handles.target() })))); }
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const hover = async (page, id) => { const c = await center(page, id); await page.mouse.move(c.x - 20, c.y - 5); await page.mouse.move(c.x, c.y, { steps: 3 }); await sleep(350); };
const counts = (page) => page.evaluate(() => ({ people: data.persons.filter((p) => p.recordStatus !== "deleted").length, pc: data.relationships.parentChild.length, sp: data.relationships.spouses.length, changes: changes.length }));

describe("draw.io-style editing on the tree", () => {
  let app, page, family, couple, kid, root;
  before(async () => {
    family = bigFamily(3, 2);
    app = await startApp({ graph: family });
    page = app.page;
    await app.open("/index.html");
    await sleep(1300);
    root = family.persons[0].id;                                   // Arjun Rao (no parents)
    kid = family.relationships.parentChild[0].childId;            // Child1_0_0 (has both parents)
    couple = family.relationships.spouses[0];
  });
  after(() => app.close());

  test("hovering a person shows four + handles; moving away hides them", async () => {
    await hover(page, kid);
    assert.equal(await page.locator(".nh-layer.on .nh-btn").count(), 4);
    for (const kind of ["parent", "child", "spouse", "sibling"]) assert.ok(await page.locator('.nh-layer.on .nh-btn[data-kind="' + kind + '"]').isVisible(), kind + " handle visible");
    assert.match(await page.getAttribute('.nh-btn[data-kind="child"]', "aria-label"), /Add a child — Child1_0_0/);
    await page.mouse.move(5, 500); await sleep(500);
    assert.equal(await page.locator(".nh-layer.on").count(), 0);
  });

  test("+ child: quick-add popover → Enter adds the person, links them, selects them, and Undo reverts", async () => {
    const before = await counts(page);
    await hover(page, kid);
    const h = await handle(page, "child");
    await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.up(); await sleep(300);
    assert.equal(await page.isVisible("#quickAdd"), true);
    assert.match(await page.innerText("#quickAdd h3"), /Add a child of Child1_0_0/);
    assert.equal(await page.inputValue("#qaFamily"), "Rao", "the family name is prefilled");
    await page.keyboard.type("Baby");
    await page.keyboard.press("Enter"); await sleep(600);
    const after = await counts(page);
    assert.equal(after.people, before.people + 1); assert.equal(after.pc, before.pc + 1); assert.equal(after.changes, before.changes + 2);
    assert.equal(await page.isVisible("#quickAdd"), false);
    assert.match(await page.innerText("#modeChip"), /Edit draft/, "editing switched on automatically");
    assert.match(await page.innerText("#pname"), /Baby Rao/, "the new person is selected");
    const edge = await page.evaluate(() => { const n = cy.nodes().filter((x) => x.data("label").includes("Baby Rao"))[0]; const p = cy.edges().filter((e) => e.target().id() === n.id())[0]; return { found: !!p, below: p && n.position("y") > p.source().position("y") }; });
    assert.deepEqual(edge, { found: true, below: true });
    assert.match(await app.toastText(), /Added Baby Rao as a child of Child1_0_0/);
    await page.click(".toast .tact"); await sleep(500);
    assert.deepEqual(await counts(page), before, "Undo restores the previous state");
    assert.equal(await page.locator("#undoBtn:disabled").count(), 1);
    assert.equal(await page.locator("#redoBtn:disabled").count(), 0, "Redo is available");
  });

  test("Ctrl+Z / Ctrl+Shift+Z and the Undo/Redo buttons walk the history", async () => {
    await page.click("#redoBtn"); await sleep(400);
    assert.equal((await counts(page)).people, family.persons.length + 1);
    await page.keyboard.press("Control+z"); await sleep(400);
    assert.equal((await counts(page)).people, family.persons.length);
    await page.keyboard.press("Control+Shift+z"); await sleep(400);
    assert.equal((await counts(page)).people, family.persons.length + 1);
    await page.click("#undoBtn"); await sleep(300);
  });

  test("+ spouse suggests the opposite gender and records the marriage; + parent adds above", async () => {
    const lone = family.persons.find((p) => p.displayName.startsWith("Child1_0_1"));   // female
    await hover(page, lone.id);
    let h = await handle(page, "spouse");
    await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.up(); await sleep(300);
    assert.equal(await page.inputValue("#qaGender"), "male");
    await page.fill("#qaFirst", "Partner"); await page.fill("#qaMarried", "02/03/2010"); await page.keyboard.press("Enter"); await sleep(500);
    assert.equal(await page.evaluate(() => data.relationships.spouses.at(-1).marriageDate), "2010-03-02");
    await page.evaluate(() => closeQuickAdd());
    await hover(page, lone.id);
    h = await handle(page, "parent");
    await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.up(); await sleep(300);
    await page.fill("#qaFirst", "Grandparent"); await page.selectOption("#qaGender", "male"); await page.keyboard.press("Enter"); await sleep(500);
    const rel = await page.evaluate(() => data.relationships.parentChild.at(-1));
    assert.equal(rel.childId, lone.id); assert.equal(rel.role, "father");
    await page.click("#undoBtn"); await page.click("#undoBtn"); await sleep(300);
  });

  test("+ sibling copies the parents; for someone without parents it explains and offers + parent", async () => {
    const before = await counts(page);
    await hover(page, kid);
    let h = await handle(page, "sibling");
    await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.up(); await sleep(300);
    await page.fill("#qaFirst", "Sis"); await page.keyboard.press("Enter"); await sleep(500);
    const after = await counts(page);
    assert.equal(after.people, before.people + 1); assert.equal(after.pc, before.pc + 2, "linked to both parents");
    await page.click("#undoBtn"); await sleep(300);
    await hover(page, root);
    h = await handle(page, "sibling");
    await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.up(); await sleep(300);
    assert.match(await page.innerText("#quickAdd"), /no parents in the tree yet/);
    await page.click("#qaParentFirst"); await sleep(200);
    assert.match(await page.innerText("#quickAdd h3"), /Add a parent of/);
    await page.keyboard.press("Escape"); await sleep(200);
  });

  test("dragging a handle onto another person connects them (with a details dialog); a loop is refused", async () => {
    const a = family.persons.find((p) => p.displayName.startsWith("Child2_0_0")), b = family.persons.find((p) => p.displayName.startsWith("Child1_0_1"));
    await hover(page, a.id);
    const h = await handle(page, "child"), t = await center(page, b.id);
    await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(t.x, t.y, { steps: 10 });
    assert.equal(await page.locator(".nh-hit").isVisible(), true, "the drop target is highlighted");
    await page.mouse.up(); await sleep(400);
    assert.match(await page.innerText("#modalTitle"), /Create connection/);
    assert.equal(await page.inputValue("#connType"), "child", "preset from the handle that was dragged");
    await page.click("#modalSave"); await sleep(500);
    const rel = await page.evaluate(() => data.relationships.parentChild.at(-1));
    assert.deepEqual([rel.parentId, rel.childId], [a.id, b.id]);
    // b is now a child of a; making a the child of b (a's parent handle dropped on b) must be refused
    await hover(page, b.id);
    const h2 = await handle(page, "child"), t2 = await center(page, a.id);
    await page.mouse.move(h2.x, h2.y); await page.mouse.down(); await page.mouse.move(t2.x, t2.y, { steps: 10 }); await page.mouse.up(); await sleep(400);
    await page.click("#modalSave"); await sleep(400);
    assert.match(await app.toastText(), /descendant|cannot also be their parent/i);
    await page.evaluate(() => closeModal());
    await page.click("#undoBtn"); await sleep(300);
  });

  test("dragging a handle onto empty canvas starts a quick-add there; searching links an existing person", async () => {
    await hover(page, kid);
    let h = await handle(page, "child");
    await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(h.x + 10, 780, { steps: 10 }); await page.mouse.up(); await sleep(300);
    assert.equal(await page.isVisible("#quickAdd"), true);
    const other = family.persons.find((p) => p.displayName.startsWith("Child2_1_0"));
    await page.click("#quickAdd summary");
    await page.fill("#qaFind", "Child2_1_0"); await sleep(200);
    const before = await counts(page);
    await page.click('#qaResults [data-pick="' + other.id + '"]'); await sleep(500);
    const after = await counts(page);
    assert.equal(after.people, before.people); assert.equal(after.pc, before.pc + 1, "only a link was added");
    await page.click("#undoBtn"); await sleep(300);
  });

  test("the Person panel's Add relative buttons work too, even before editing was switched on", async () => {
    await page.reload(); await sleep(1500);
    assert.match(await page.innerText("#modeChip"), /View/);
    await page.click('#people .person-row:has-text("Child1_0_1")'); await sleep(300);
    await page.click('#editActions [data-add="child"]'); await sleep(300);
    assert.equal(await page.isVisible("#quickAdd"), true);
    assert.match(await page.innerText("#modeChip"), /Edit draft/);
    await page.keyboard.type("Panel Kid"); await page.keyboard.press("Enter"); await sleep(500);
    assert.match(await page.innerText("#pname"), /Panel Kid/);
  });

  test("what you drew is submitted as a valid request and applies cleanly to the stored tree", async () => {
    await page.click("#finishBtn"); await sleep(300);
    await page.click("#modalSave"); await sleep(1000);
    const [, row] = [...app.env.DB.requests.entries()][0];
    const proposal = JSON.parse(row.proposal_json);
    assert.deepEqual(proposal.payload.changes.map((c) => c.type), ["ADD_PERSON", "ADD_PARENT_CHILD"]);
    const graph = JSON.parse(JSON.stringify(app.gh.graph));
    applyProposal(graph, { operation: "BATCH_UPDATE", payload: { changes: proposal.payload.changes } });
    assert.deepEqual(integrityIssues(graph), []);
    assert.deepEqual(app.errors.filter((e) => !/409|descendant/.test(e)), []);
  });
});

describe("living / deceased without exact dates", () => {
  let app, page;
  before(async () => { app = await startApp({ graph: bigFamily(2, 1) }); page = app.page; await app.open("/index.html"); await sleep(1200); });
  after(() => app.close());

  test("the person form has a Living/Deceased choice; death fields appear only for Deceased; a year is enough", async () => {
    const id = await page.evaluate(() => data.persons[1].id);
    await page.evaluate((id) => { setEditMode(true); show(byId(id)); }, id);
    assert.equal(await page.isVisible("#dod"), false, "no death date field for a person of unknown status");
    await page.selectOption("#lifeStatus", "living");
    assert.equal(await page.isVisible("#dod"), false);
    await page.fill("#dob", "1980");
    await page.selectOption("#lifeStatus", "deceased");
    assert.equal(await page.isVisible("#dod"), true);
    assert.equal(await page.isVisible("#deathPlace"), true);
    await page.fill("#dod", "2021");
    await page.click("#applyPerson"); await sleep(400);
    const p = await page.evaluate((id) => byId(id), id);
    assert.equal(p.dateOfBirth, "1980"); assert.equal(p.dateOfDeath, "2021"); assert.equal(p.lifeStatus, "deceased");
    assert.match(await page.evaluate((id) => cy.getElementById(id).data("label"), id), /1980–2021/);
    // deceased but nobody knows when
    await page.fill("#dod", ""); await page.click("#applyPerson"); await sleep(300);
    const q = await page.evaluate((id) => byId(id), id);
    assert.equal(q.lifeStatus, "deceased"); assert.ok(!q.dateOfDeath);
    assert.match(await page.evaluate((id) => cy.getElementById(id).data("label"), id), /1980–\?/);
    // back to living: the death details are cleared
    await page.fill("#deathPlace", "Somewhere");
    await page.selectOption("#lifeStatus", "living"); await page.click("#applyPerson"); await sleep(300);
    const r = await page.evaluate((id) => byId(id), id);
    assert.equal(r.lifeStatus, "living"); assert.ok(!r.dateOfDeath); assert.equal(r.deathPlace, "");
    assert.equal(await page.isVisible("#dod"), false);
  });

  test("typing a death date flips the status to Deceased; MM/YYYY and bad dates are handled", async () => {
    const id = await page.evaluate(() => data.persons[2].id);
    await page.evaluate((id) => { setEditMode(true); show(byId(id)); }, id);
    await page.selectOption("#lifeStatus", "deceased");
    await page.fill("#dod", "07/1999");
    await page.click("#applyPerson"); await sleep(300);
    assert.equal((await page.evaluate((id) => byId(id), id)).dateOfDeath, "1999-07");
    await page.fill("#dob", "31/02/1950"); await page.click("#applyPerson"); await sleep(200);
    assert.match(await app.toastText(), /Born must be/);
    await page.fill("#dob", "2000"); await page.click("#applyPerson"); await sleep(200);
    assert.match(await app.toastText(), /cannot be before/);
  });

  test("quick-add can record Living or Deceased (no date needed); the request validates", async () => {
    const src = await page.evaluate(() => data.persons[0].id);
    await page.evaluate((src) => openQuickAdd("child", src, { x: 300, y: 200 }), src);
    await page.fill("#qaFirst", "Ancestor");
    assert.equal(await page.isVisible("#qaDod"), false);
    await page.selectOption("#qaLife", "deceased");
    assert.equal(await page.isVisible("#qaDod"), true);
    await page.fill("#qaDod", "1901");
    await page.keyboard.press("Enter"); await sleep(500);
    const added = await page.evaluate(() => data.persons.find((p) => p.firstName === "Ancestor"));
    assert.equal(added.lifeStatus, "deceased"); assert.equal(added.dateOfDeath, "1901");
    const proposal = await page.evaluate(() => buildProposal());
    const g = bigFamily(2, 1);
    assert.doesNotThrow(() => applyProposal(g, proposal));
    assert.deepEqual(integrityIssues(g), []);
    assert.equal(g.persons.find((p) => p.firstName === "Ancestor").lifeStatus, "deceased");
  });
});

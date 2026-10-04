import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, bigFamily, sleep, PASSWORD } from "../helpers/app.mjs";

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe("public tree (desktop)", () => {
  let app, page, family;
  before(async () => {
    family = bigFamily(4, 3);
    app = await startApp({ graph: family });
    page = app.page;
    await app.open("/index.html");
    await sleep(1200);
  });
  after(() => app.close());

  test("draws everyone in a readable generational layout (no overlaps, children below parents)", async () => {
    assert.equal(await page.evaluate(() => cy.nodes().length), family.persons.length);
    const r = await page.evaluate(() => {
      const ns = cy.nodes().map((n) => ({ id: n.id(), x: n.position("x"), y: n.position("y") }));
      let overlaps = 0;
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) if (Math.abs(ns[i].y - ns[j].y) < 40 && Math.abs(ns[i].x - ns[j].x) < 140) overlaps++;
      const pos = Object.fromEntries(ns.map((n) => [n.id, n]));
      let wrong = 0;
      cy.edges().forEach((e) => { if (!e.hasClass("spouse") && pos[e.target().id()].y <= pos[e.source().id()].y) wrong++; });
      return { overlaps, wrong };
    });
    assert.deepEqual(r, { overlaps: 0, wrong: 0 });
    assert.deepEqual(app.errors, []);
  });

  test("the people list names everyone and selecting from it opens the profile; ← Everyone goes back", async () => {
    assert.equal(await page.locator("#people .person-row").count(), family.persons.length);
    assert.match(await page.innerText("#peopleTitle"), new RegExp("Everyone \\(" + family.persons.length + "\\)"));
    await page.click('#people .person-row:has-text("Arjun Rao")');
    await sleep(300);
    assert.equal(await page.isVisible("#profile"), true);
    assert.match(await page.innerText("#pname"), /Arjun Rao/);
    await page.click("#backToList");
    assert.equal(await page.isVisible("#profile"), false);
    assert.equal(await page.isVisible("#empty"), true);
  });

  test("selecting someone highlights their family line and dims the rest; the toggle turns it off", async () => {
    const pick = family.persons.find((p) => p.displayName.startsWith("Child2_0_0"));
    await page.evaluate((id) => cy.getElementById(id).emit("tap"), pick.id);
    await sleep(200);
    const dimmed = await page.evaluate(() => cy.nodes(".dim").length);
    const total = await page.evaluate(() => cy.nodes().length);
    assert.ok(dimmed > 0 && dimmed < total - 3, "some, but not all, people are dimmed: " + dimmed + "/" + total);
    assert.equal(await page.evaluate((id) => cy.getElementById(id).hasClass("dim"), pick.id), false);
    await page.click("#lineageBtn");
    assert.equal(await page.evaluate(() => cy.nodes(".dim").length), 0);
    await page.click("#lineageBtn");
    await page.click("#backToList");
  });

  test("search filters the tree and the list", async () => {
    await page.fill("#search", "Spouse1_0_0");
    await sleep(500);
    assert.equal(await page.evaluate(() => cy.nodes().length), 1);
    assert.equal(await page.locator("#people .person-row").count(), 1);
    await page.click("#clearSearch");
    await sleep(400);
    assert.equal(await page.evaluate(() => cy.nodes().length), family.persons.length);
  });

  test("GEDCOM export is well-formed and consistent with the tree", async () => {
    const ged = await page.evaluate(() => buildGedcom(liveData));
    const lines = ged.trim().split("\r\n");
    assert.equal(lines[0], "0 HEAD"); assert.equal(lines.at(-1), "0 TRLR");
    for (const l of lines) assert.match(l, /^\d+ (@[A-Z0-9]+@ )?[A-Z]+( .*)?$/, "valid GEDCOM line: " + l);
    const indi = lines.filter((l) => /^0 @I\d+@ INDI$/.test(l)).length;
    assert.equal(indi, family.persons.length);
    const couples = family.relationships.spouses.length;
    const fam = lines.filter((l) => /^0 @F\d+@ FAM$/.test(l)).length;
    assert.ok(fam >= couples, "a family record per couple (" + fam + " >= " + couples + ")");
    // every FAMC/FAMS reference points at a family that lists the person back
    const text = ged;
    for (const m of text.matchAll(/0 (@I\d+@) INDI([\s\S]*?)(?=\r\n0 )/g)) {
      for (const f of m[2].matchAll(/1 FAMC (@F\d+@)/g)) assert.ok(new RegExp("0 " + f[1] + " FAM[\\s\\S]*?1 CHIL " + m[1]).test(text), "child listed in its family");
    }
    assert.match(ged, /1 SEX M/); assert.match(ged, /2 DATE 1 JAN 1950/);
  });

  test("Export dialog offers JSON, GEDCOM and print; the JSON download is the published tree", async () => {
    await page.click("#exportBtn"); await sleep(200);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#expJson")]);
    assert.equal(dl.suggestedFilename(), "family-tree.json");
    const body = JSON.parse(await (await import("node:fs/promises")).readFile(await dl.path(), "utf8"));
    assert.equal(body.persons.length, family.persons.length);
    await page.keyboard.press("Escape");
  });

  test("Network mode switches to a force layout and back", async () => {
    await page.click("#networkBtn"); await sleep(600);
    assert.equal(await page.evaluate(() => cy.edges().first().style("curve-style")), "bezier");
    await page.click("#treeBtn"); await sleep(400);
    assert.equal(await page.evaluate(() => cy.edges().first().style("curve-style")), "taxi");
  });

  test("dialogs are accessible: labelled, Escape closes, focus returns to the opener", async () => {
    assert.equal(await page.getAttribute("#modal", "role"), "dialog");
    await page.click("#adminBtn"); await sleep(200);
    assert.equal(await page.getAttribute("#adminPw", "type"), "password", "the admin password is masked");
    assert.equal(await page.evaluate(() => document.activeElement.id), "adminPw", "focus moves into the dialog");
    await page.keyboard.press("Escape"); await sleep(200);
    assert.equal(await page.isVisible("#modal"), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "adminBtn", "focus returns to the button");
  });

  test("light theme keeps the active tab and chips readable", async () => {
    await page.click("#themeBtn"); await sleep(300);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    if (theme !== "light") await page.click("#themeBtn");
    const colours = await page.evaluate(() => {
      const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const el = document.querySelector("#personTab"), cs = getComputedStyle(el);
      return { fg: rgb(cs.color), bg: rgb(cs.backgroundColor) };
    });
    assert.ok(contrast(colours.fg, colours.bg) >= 4.5, "tab contrast " + contrast(colours.fg, colours.bg).toFixed(2));
  });
});

describe("public tree (phone)", () => {
  let app, page;
  before(async () => {
    app = await startApp({ graph: bigFamily(3, 2), viewport: { width: 390, height: 844 } });
    page = app.page;
    await app.open("/index.html");
    await sleep(1200);
  });
  after(() => app.close());

  test("the tree is visible; the panel is a sheet that opens on tap and closes again", async () => {
    assert.equal(await page.isVisible("#sidePanel"), false, "panel hidden by default");
    const box = await page.locator("#tree").boundingBox();
    assert.ok(box.width > 300 && box.height > 400, "tree has room to show");
    await page.evaluate(() => cy.nodes().first().emit("tap")); await sleep(500);
    assert.equal(await page.isVisible("#sidePanel"), true, "tapping a person opens the panel");
    await page.click("#sideClose"); await sleep(400);
    assert.equal(await page.isVisible("#sidePanel"), false);
    await page.click("#panelBtn"); await sleep(400);
    assert.equal(await page.isVisible("#sidePanel"), true, "the Panel button opens it too");
    assert.deepEqual(app.errors, []);
  });
});

describe("suggesting changes and following the request", () => {
  let app, page;
  before(async () => {
    app = await startApp({ graph: bigFamily(3, 2) });
    page = app.page;
    await app.open("/index.html");
    await sleep(1200);
  });
  after(() => app.close());

  test("a visitor adds a person, confirms with optional details, and gets a tracking link", async () => {
    await page.click("#editBtn"); await sleep(200);
    await page.click("#addBtn"); await sleep(300);
    await page.fill("#newFirst", "Baby"); await page.fill("#newFamily", "Rao");
    await page.click("#modalSave"); await sleep(400);
    await page.click("#finishBtn"); await sleep(400);
    assert.match(await page.innerText("#modalTitle"), /Submit your changes for review/);
    assert.match(await page.innerText("#modalBody"), /Baby Rao/);
    assert.equal(app.env.DB.requests.size, 0, "nothing is sent before confirming");
    await page.fill("#cName", "Priya"); await page.fill("#cMsg", "From the family Bible");
    await page.click("#modalSave"); await sleep(1000);
    assert.equal(app.env.DB.requests.size, 1);
    const [id, row] = [...app.env.DB.requests.entries()][0];
    const stored = JSON.parse(row.proposal_json);
    assert.deepEqual(stored.meta, { name: "Priya", message: "From the family Bible" });
    assert.equal(stored.payload.changes[0].type, "ADD_PERSON");
    assert.match(await page.innerText("#modalTitle"), /request sent/i);
    const link = await page.inputValue("#trackLink");
    assert.ok(link.includes("?request=" + id));
    assert.deepEqual(app.errors, []);

    // The contributor can see the status, and later the reviewer's decision.
    await page.click("#modalCancel"); await sleep(200);
    await page.click("#changesTab"); await sleep(700);
    assert.match(await page.innerText("#mine"), /Waiting for review/);
    app.env.DB.requests.get(id).status = "rejected"; app.env.DB.requests.get(id).note = "Please add a date of birth";
    await page.goto(link); await sleep(1200);
    assert.match(await page.innerText("#modalBody"), /Not applied/);
    assert.match(await page.innerText("#modalBody"), /Please add a date of birth/);
  });

  test("server-side validation errors are shown clearly, not as a generic failure", async () => {
    await page.reload(); await sleep(1000);
    await page.evaluate(() => { record("ADD_PERSON", { person: { id: "P000777", displayName: "x".repeat(300), recordStatus: "active" } }, "Added a very long name"); });
    await page.click("#changesTab"); await page.click("#submitChanges"); await sleep(300);
    await page.click("#modalSave"); await sleep(800);
    assert.match(await app.toastText(), /too long/i);
  });
});

describe("administrator sign-in on the public page", () => {
  let app, page;
  before(async () => {
    app = await startApp({ graph: bigFamily(3, 2) });
    page = app.page;
    await app.open("/index.html");
    await sleep(1200);
  });
  after(() => app.close());

  test("wrong password is explained inline; the right one enables admin mode with a session token only", async () => {
    await page.click("#adminBtn"); await sleep(200);
    await page.fill("#adminPw", "wrong-password-xx"); await page.click("#modalSave"); await sleep(600);
    assert.match(await page.innerText("#adminPwStatus"), /Incorrect/);
    await page.fill("#adminPw", PASSWORD); await page.click("#modalSave"); await sleep(900);
    assert.equal(await page.isVisible("#modal"), false);
    assert.match(await page.innerText("#modeChip"), /Admin edit/);
    assert.equal(await page.isVisible("#requestsLink"), true);
    const stored = await page.evaluate(() => sessionStorage.getItem("familyGraphAdminSession"));
    assert.ok(stored && !stored.includes(PASSWORD));
    assert.deepEqual(app.errors.filter((e) => !/401/.test(e)), []);
  });

  test("reloading restores admin mode from the token", async () => {
    await page.reload(); await sleep(1500);
    assert.match(await page.innerText("#modeChip"), /Admin edit/);
  });
});

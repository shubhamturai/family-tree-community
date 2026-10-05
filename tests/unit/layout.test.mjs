import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// tree-layout.js is a plain browser script; load it the way a page would.
const { treeLayout, NODE_W, NODE_H } = new Function(fs.readFileSync(new URL("../../tree-layout.js", import.meta.url), "utf8") + ";return {treeLayout,NODE_W,NODE_H}")();

const ids = (n) => Array.from({ length: n }, (_, i) => "P" + String(i + 1).padStart(6, "0"));
const noOverlap = (pos) => {
  const p = Object.values(pos);
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (Math.abs(p[i].y - p[j].y) < NODE_H && Math.abs(p[i].x - p[j].x) < NODE_W) return false;
  return true;
};

test("an empty or single-person tree lays out without errors", () => {
  assert.deepEqual(treeLayout([], [], []), {});
  assert.deepEqual(Object.keys(treeLayout(["a"], [], [])), ["a"]);
});

test("children sit a generation below their parents; spouses share a row and are adjacent", () => {
  const pos = treeLayout(["a", "b", "c", "d"], [{ parentId: "a", childId: "c" }, { parentId: "b", childId: "c" }, { parentId: "c", childId: "d" }], [{ personAId: "a", personBId: "b" }]);
  assert.equal(pos.a.y, pos.b.y);
  assert.ok(pos.c.y > pos.a.y && pos.d.y > pos.c.y);
  assert.ok(Math.abs(pos.a.x - pos.b.x) < NODE_W * 1.5, "spouses are neighbours");
  assert.ok(Math.abs(pos.c.x - (pos.a.x + pos.b.x) / 2) < 1, "the child is centred under the couple");
  assert.ok(noOverlap(pos));
});

test("a married-in spouse is placed on the partner's generation", () => {
  const pos = treeLayout(["root", "kid", "inlaw", "grandkid"], [{ parentId: "root", childId: "kid" }, { parentId: "kid", childId: "grandkid" }], [{ personAId: "kid", personBId: "inlaw" }]);
  assert.equal(pos.kid.y, pos.inlaw.y);
  assert.ok(pos.grandkid.y > pos.kid.y);
});

test("large random families never overlap, always put children below parents, and are deterministic", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (const n of [40, 150, 400]) {
    const people = ids(n), pcs = [], sps = [];
    for (let i = 1; i < n; i++) {
      const parent = people[Math.floor(rnd() * i)];
      pcs.push({ parentId: parent, childId: people[i] });
      if (rnd() < 0.5) pcs.push({ parentId: people[Math.floor(rnd() * i)], childId: people[i] });
      if (rnd() < 0.3 && i > 2) sps.push({ personAId: people[i], personBId: people[Math.floor(rnd() * i)] });
    }
    const cleanPcs = pcs.filter((r) => r.parentId !== r.childId), pos = treeLayout(people, cleanPcs, []);
    assert.ok(noOverlap(pos), n + " people: no overlaps");
    for (const r of cleanPcs) assert.ok(pos[r.childId].y > pos[r.parentId].y, "child below parent");
    assert.deepEqual(treeLayout(people, cleanPcs, []), pos, "same input, same layout");
    assert.ok(Object.values(sps.length ? treeLayout(people, cleanPcs, sps) : pos).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
});

test("bad data (cycles, links to missing people) does not hang or crash", () => {
  const pos = treeLayout(["a", "b"], [{ parentId: "a", childId: "b" }, { parentId: "b", childId: "a" }, { parentId: "a", childId: "ghost" }], [{ personAId: "a", personBId: "a" }]);
  assert.equal(Object.keys(pos).length, 2);
});

const { branchView } = new Function(fs.readFileSync(new URL("../../tree-layout.js", import.meta.url), "utf8") + ";return {branchView}")();

test("collapsing a person hides their descendants and married-in partners, never an unrelated family", () => {
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
  // a+b → c,d ; c+e(married in, parentless) → f ; g+h is an unrelated family
  const pcs = [["a", "c"], ["b", "c"], ["a", "d"], ["b", "d"], ["c", "f"], ["e", "f"]].map(([parentId, childId]) => ({ parentId, childId }));
  const sps = [["a", "b"], ["c", "e"], ["g", "h"]].map(([personAId, personBId]) => ({ personAId, personBId }));
  const vis = (c) => [...branchView(all, pcs, sps, new Set(c)).visible].sort().join("");
  assert.equal(vis([]), "abcdefgh");
  assert.equal(vis(["a"]), "abgh", "the couple stays, everyone below (and c's married-in partner) folds away");
  assert.equal(vis(["b"]), "abgh", "collapsing either parent folds the couple's shared children");
  assert.equal(vis(["c"]), "abcdegh", "c's own branch folds but c's partner e stays beside them");
  assert.equal(vis(["g"]), "abcdefgh", "g has no children to fold");
  const v = branchView(all, pcs, sps, new Set(["a"]));
  assert.equal(v.hidden.a, 4);
  assert.deepEqual([...v.canCollapse].sort(), ["a", "b", "c", "e"]);
  assert.equal(vis(["a", "c"]), "abgh", "a collapse inside an already folded branch changes nothing visible");
});

test("a child stays visible while any non-collapsed parent shows them", () => {
  const all = ["a", "b", "c", "x"];
  const pcs = [{ parentId: "a", childId: "c" }, { parentId: "x", childId: "c" }];     // a and x are not partners
  const v = branchView(all, pcs, [], new Set(["a"]));
  assert.equal(v.visible.has("c"), false, "the other parent being collapsed blocks the shared child");
  assert.equal(branchView(all, [{ parentId: "a", childId: "c" }], [], new Set(["x"])).visible.has("c"), true, "x has no children here, so it cannot hide c");
});

test("unfold opens the nearest folds first and leaves unrelated folds alone", () => {
  const { unfold } = new Function(fs.readFileSync(new URL("../../tree-layout.js", import.meta.url), "utf8") + ";return {unfold}")();
  const all = ["a", "b", "c", "d", "e", "x", "y", "z"];
  // a → b → c → d ; a → e ; x → y → z (an unrelated line, also folded)
  const pcs = [["a", "b"], ["b", "c"], ["c", "d"], ["a", "e"], ["x", "y"], ["y", "z"]].map(([parentId, childId]) => ({ parentId, childId }));
  const open = unfold(all, pcs, [], new Set(["a", "c", "x"]), "d");
  assert.deepEqual([...open].sort(), ["x"], "d sits under two folds (a and c): both open, the unrelated fold on x stays");
  assert.deepEqual([...unfold(all, pcs, [], new Set(["c", "x"]), "e")].sort(), ["c", "x"], "e is already visible: nothing changes");
});

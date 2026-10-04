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

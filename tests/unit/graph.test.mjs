import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProposal, integrityIssues, assertNoNewIssues } from "../../backend/src/graph.js";
import { sampleGraph } from "../helpers/fakes.mjs";

test("a sound graph has no integrity issues", () => assert.deepEqual(integrityIssues(sampleGraph()), []));

test("detects duplicates, dangling links, self links and loops", () => {
  const g = sampleGraph();
  g.persons.push({ ...g.persons[0] });
  g.relationships.parentChild.push({ parentId: "P000099", childId: "P000001" }, { parentId: "P000003", childId: "P000003" }, { parentId: "P000003", childId: "P000001" });
  g.relationships.spouses.push({ personAId: "P000001", personBId: "P000002" });
  const issues = integrityIssues(g).join(" | ");
  for (const re of [/Duplicate person/, /missing person/, /own parent/, /loop/, /Duplicate spouse/]) assert.match(issues, re);
});

test("only newly introduced problems block a change (existing damage does not freeze the tree)", () => {
  const before = ["Duplicate person ID P000001"];
  assert.doesNotThrow(() => assertNoNewIssues(before, ["Duplicate person ID P000001"]));
  assert.throws(() => assertNoNewIssues(before, [...before, "loop"]), /damage/);
});

test("applyProposal supports the legacy flat ADD_PERSON shape and updates, archives and links", () => {
  const g = sampleGraph();
  applyProposal(g, { operation: "BATCH_UPDATE", payload: { changes: [
    { type: "ADD_PERSON", payload: { id: "P000004", displayName: "New One", dateOfBirth: "2000-02-03" } },
    { type: "UPDATE_PERSON", payload: { personId: "P000004", occupation: "Teacher" } },
    { type: "ADD_SPOUSE", payload: { personAId: "P000003", personBId: "P000004", marriageDate: "2024-05-05" } },
    { type: "DELETE_PERSON", payload: { personId: "P000002", reason: "duplicate" } },
  ] } });
  assert.equal(g.persons.find((p) => p.id === "P000004").occupation, "Teacher");
  assert.equal(g.persons.find((p) => p.id === "P000002").recordStatus, "deleted");
  assert.equal(g.relationships.spouses.length, 2);
  assert.notEqual(g.lastUpdated, "2026-01-01T00:00:00.000Z");
});

test("invalid references are refused", () => {
  const g = sampleGraph();
  for (const change of [
    { type: "UPDATE_PERSON", payload: { personId: "P000099", occupation: "x" } },
    { type: "ADD_PARENT_CHILD", payload: { parentId: "P000001", childId: "P000003" } },
    { type: "ADD_SPOUSE", payload: { personAId: "P000001", personBId: "P000002" } },
  ]) assert.throws(() => applyProposal(g, { operation: "BATCH_UPDATE", payload: { changes: [change] } }));
});

test("dates may be partial (year or month only) and life status is tracked without any date", async () => {
  const { validDate, dateBefore, samplePerson } = await import("../../backend/src/validate.js");
  for (const ok of ["1950", "1950-07", "1950-07-04"]) assert.equal(validDate(ok), true, ok);
  for (const bad of ["", "50", "1950-13", "1950-02-30", "1950-7", "07/1950", "abcd"]) assert.equal(validDate(bad), false, bad);
  assert.equal(dateBefore("1949", "1950-06-01"), true);
  assert.equal(dateBefore("1950", "1950-06-01"), false, "same year: cannot tell, so it is not an error");
  assert.equal(dateBefore("1950-02", "1950-01-20"), false);
  assert.equal(dateBefore("1950-01", "1950-02-20"), true);
  assert.throws(() => samplePerson({ dateOfBirth: "1950-06-01", dateOfDeath: "1949" }), /cannot precede/);
  assert.doesNotThrow(() => samplePerson({ dateOfBirth: "1950-06-01", dateOfDeath: "1950" }));
  assert.equal(samplePerson({ lifeStatus: "alive" }).lifeStatus, "living");
  assert.throws(() => samplePerson({ lifeStatus: "zombie" }), /lifeStatus/);

  const g = sampleGraph();
  applyProposal(g, { operation: "BATCH_UPDATE", payload: { changes: [
    { type: "ADD_PERSON", payload: { id: "P000004", displayName: "Old One", lifeStatus: "deceased" } },
    { type: "ADD_PERSON", payload: { id: "P000005", displayName: "Young One", dateOfBirth: "2001", lifeStatus: "living" } },
    { type: "UPDATE_PERSON", payload: { personId: "P000003", lifeStatus: "living", dateOfDeath: null } },
  ] } });
  const by = (id) => g.persons.find((p) => p.id === id);
  assert.equal(by("P000004").lifeStatus, "deceased", "deceased with no date at all is allowed");
  assert.ok(!by("P000004").dateOfDeath);
  assert.equal(by("P000005").lifeStatus, "living");
  assert.equal(by("P000003").lifeStatus, "living");
  assert.deepEqual(integrityIssues(g), []);
  applyProposal(g, { operation: "BATCH_UPDATE", payload: { changes: [{ type: "UPDATE_PERSON", payload: { personId: "P000005", dateOfDeath: "2020" } }] } });
  assert.equal(by("P000005").lifeStatus, "deceased", "a death date implies deceased");
});

test("SET_CHILD_ORDER reorders under the shared parents only, keeps half-siblings in place, refuses non-siblings, survives an ID remap", async () => {
  const { sanitizeChange } = await import("../../backend/src/validate.js");
  const g = sampleGraph(); // P000001 + P000002 are the parents of P000003
  applyProposal(g, { operation: "BATCH_UPDATE", payload: { changes: [
    { type: "ADD_PERSON", payload: { id: "P000004", displayName: "Second" } }, { type: "ADD_PERSON", payload: { id: "P000005", displayName: "Third" } },
    { type: "ADD_PERSON", payload: { id: "P000006", displayName: "Half sibling" } },
    { type: "ADD_PARENT_CHILD", payload: { parentId: "P000001", childId: "P000004", order: 2 } }, { type: "ADD_PARENT_CHILD", payload: { parentId: "P000002", childId: "P000004", order: 3 } },
    { type: "ADD_PARENT_CHILD", payload: { parentId: "P000001", childId: "P000005", order: 3 } }, { type: "ADD_PARENT_CHILD", payload: { parentId: "P000002", childId: "P000005", order: 4 } },
    { type: "ADD_PARENT_CHILD", payload: { parentId: "P000002", childId: "P000006", order: 2 } }, // only P000002's child
  ] } });
  const under = (pid) => g.relationships.parentChild.filter((r) => r.parentId === pid).sort((a, b) => a.order - b.order).map((r) => r.childId);
  assert.deepEqual(under("P000002"), ["P000003", "P000006", "P000004", "P000005"]);
  applyProposal(g, { operation: "BATCH_UPDATE", payload: { changes: [{ type: "SET_CHILD_ORDER", payload: { childIds: ["P000005", "P000003", "P000004"] } }] } });
  assert.deepEqual(under("P000001"), ["P000005", "P000003", "P000004"]);
  assert.deepEqual(under("P000002"), ["P000005", "P000006", "P000003", "P000004"], "the half-sibling keeps its slot; no duplicate numbers");
  assert.deepEqual(g.relationships.parentChild.filter((r) => r.parentId === "P000002").map((r) => r.order).sort(), [1, 2, 3, 4]);
  assert.throws(() => sanitizeChange({ type: "SET_CHILD_ORDER", payload: { childIds: ["P000003"] } }), /2 to 50/);
  assert.throws(() => sanitizeChange({ type: "SET_CHILD_ORDER", payload: { childIds: ["P000003", "P000003"] } }), /twice/);
  assert.throws(() => applyProposal(sampleGraph(), { operation: "BATCH_UPDATE", payload: { changes: [{ type: "SET_CHILD_ORDER", payload: { childIds: ["P000003", "P000777"] } }] } }), /Unknown person/);
  assert.throws(() => applyProposal(g, { operation: "BATCH_UPDATE", payload: { changes: [{ type: "SET_CHILD_ORDER", payload: { childIds: ["P000003", "P000001"] } }] } }), /share no parent/, "people who are not siblings are refused");
  // a new person whose ID collides gets a fresh ID and the order list follows it
  const h = sampleGraph();
  applyProposal(h, { operation: "BATCH_UPDATE", payload: { changes: [
    { type: "ADD_PERSON", payload: { id: "P000001", displayName: "Clashing" } },
    { type: "ADD_PARENT_CHILD", payload: { parentId: "P000002", childId: "P000001" } },
    { type: "SET_CHILD_ORDER", payload: { childIds: ["P000001", "P000003"] } },
  ] } });
  assert.equal(integrityIssues(h).length, 0);
});


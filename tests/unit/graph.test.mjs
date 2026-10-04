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

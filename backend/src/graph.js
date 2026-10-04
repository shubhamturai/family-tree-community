import { HttpError, clean } from "./util.js";
import { validId, validDate } from "./validate.js";

const UPDATABLE = [
  "firstName", "middleName", "familyName", "displayName", "nickname", "maidenName", "gender", "dateOfBirth", "dateOfDeath",
  "birthPlace", "birthRegion", "birthCountry", "deathPlace", "currentLocation", "occupation", "notes", "maritalStatus",
];
const REF_KEYS = ["personId", "parentId", "childId", "personAId", "personBId"];

export const nextId = (d) => "P" + String(Math.max(0, ...d.persons.map((p) => Number(String(p.id).slice(1)) || 0)) + 1).padStart(6, "0");
export const normalise = (d) => {
  d.persons ||= [];
  d.relationships ||= {};
  d.relationships.parentChild ||= [];
  d.relationships.spouses ||= [];
  return d;
};

const sameCouple = (r, a, b) => new Set([r.personAId, r.personBId]).size === 2 && [r.personAId, r.personBId].includes(a) && [r.personAId, r.personBId].includes(b);

/** Apply a single change to the graph `d` in place. */
function applyOne(d, type, x) {
  normalise(d);
  const person = (id) => d.persons.find((q) => q.id === id);
  if (type === "ADD_PERSON") {
    const display = clean(x.displayName) || [x.firstName, x.middleName, x.familyName].filter(Boolean).join(" ");
    if (!display) throw new HttpError(400, "Name is required");
    const id = x.id || nextId(d);
    if (!validId(id) || person(id)) throw new HttpError(409, "Person ID conflict. Reload and submit again.");
    d.persons.push({
      id, firstName: clean(x.firstName) || display, middleName: clean(x.middleName), familyName: clean(x.familyName), displayName: display,
      nickname: clean(x.nickname), maidenName: clean(x.maidenName), gender: clean(x.gender), dateOfBirth: clean(x.dateOfBirth), dateOfDeath: clean(x.dateOfDeath),
      lifeStatus: x.dateOfDeath ? "deceased" : clean(x.lifeStatus) || "unknown", birthPlace: clean(x.birthPlace), birthRegion: clean(x.birthRegion),
      birthCountry: clean(x.birthCountry), deathPlace: clean(x.deathPlace), currentLocation: clean(x.currentLocation), occupation: clean(x.occupation) || "",
      notes: clean(x.notes) || "", maritalStatus: clean(x.maritalStatus) || "unknown", isMarried: Boolean(x.isMarried), recordStatus: "active",
    });
  } else if (type === "UPDATE_PERSON") {
    const q = validId(x.personId) && person(x.personId);
    if (!q || q.recordStatus === "deleted") throw new HttpError(409, "Unknown or archived person ID");
    for (const k of UPDATABLE) if (k in x) q[k] = clean(x[k]);
    if (q.dateOfDeath && q.dateOfBirth && q.dateOfDeath < q.dateOfBirth) throw new HttpError(400, "Death date cannot precede birth date");
    q.lifeStatus = q.dateOfDeath ? "deceased" : clean(x.lifeStatus) || q.lifeStatus || "unknown";
    if ("isMarried" in x) q.isMarried = Boolean(x.isMarried);
  } else if (type === "DELETE_PERSON") {
    const q = validId(x.personId) && person(x.personId);
    if (!q) throw new HttpError(409, "Unknown person ID");
    q.recordStatus = "deleted";
    q.archivedAt = new Date().toISOString();
    q.archiveReason = clean(x.reason) || "Approved archive";
  } else if (type === "ADD_PARENT_CHILD") {
    if (!validId(x.parentId) || !validId(x.childId) || x.parentId === x.childId || !person(x.parentId) || !person(x.childId)) throw new HttpError(409, "Invalid parent/child IDs");
    if (d.relationships.parentChild.some((r) => r.parentId === x.parentId && r.childId === x.childId)) throw new HttpError(409, "Relationship already exists");
    d.relationships.parentChild.push({ parentId: x.parentId, childId: x.childId, role: clean(x.role) || "parent", order: Number(x.order) || 1 });
  } else if (type === "ADD_SPOUSE") {
    if (!validId(x.personAId) || !validId(x.personBId) || x.personAId === x.personBId || !person(x.personAId) || !person(x.personBId)) throw new HttpError(409, "Invalid spouse IDs");
    if (d.relationships.spouses.some((r) => sameCouple(r, x.personAId, x.personBId))) throw new HttpError(409, "Relationship already exists");
    d.relationships.spouses.push({
      personAId: x.personAId, personBId: x.personBId, order: Number(x.order) || 1, marriageDate: clean(x.marriageDate), marriagePlace: clean(x.marriagePlace),
      status: clean(x.status) || "married", divorceDate: clean(x.divorceDate),
    });
  } else {
    throw new HttpError(400, "Unsupported operation: " + type);
  }
}

/**
 * Apply a BATCH_UPDATE proposal to `d`. A new person whose ID is already taken (typical for requests made
 * on an older tree) receives a fresh ID, and later changes in the batch are re-pointed at it.
 */
export function applyProposal(d, proposal) {
  normalise(d);
  if (proposal?.operation !== "BATCH_UPDATE") throw new HttpError(400, "Only BATCH_UPDATE proposals are accepted.");
  const q = proposal.payload || {};
  if (q.baseLastUpdated && q.baseLastUpdated !== d.lastUpdated) throw new HttpError(409, "Stale request: reload and submit again.");
  const list = Array.isArray(q.changes) ? q.changes : [];
  if (!list.length) throw new HttpError(400, "Batch contains no changes");
  const idMap = {};
  const remap = (o) => {
    const r = { ...o };
    for (const k of REF_KEYS) if (typeof r[k] === "string" && idMap[r[k]]) r[k] = idMap[r[k]];
    return r;
  };
  for (const c of list) {
    if (!c?.type) throw new HttpError(400, "Invalid batch change");
    let payload = c.payload || {};
    if (c.type === "ADD_PERSON") {
      const nested = payload.person && typeof payload.person === "object";
      const x = nested ? payload.person : payload;
      if (x.id && (!validId(x.id) || d.persons.some((p) => p.id === x.id))) {
        const fresh = nextId(d);
        idMap[x.id] = fresh;
        payload = nested ? { ...payload, person: { ...x, id: fresh } } : { ...x, id: fresh };
      }
      applyOne(d, c.type, nested ? payload.person : payload);
    } else {
      applyOne(d, c.type, remap(payload));
    }
  }
  d.lastUpdated = new Date().toISOString();
  return d;
}

/** Structural problems in a graph, as short human-readable strings (empty when the graph is sound). */
export function integrityIssues(d) {
  normalise(d);
  const issues = [], ids = new Set();
  for (const p of d.persons) {
    if (!validId(p.id)) issues.push("Invalid person ID " + p.id);
    else if (ids.has(p.id)) issues.push("Duplicate person ID " + p.id);
    ids.add(p.id);
    for (const k of ["dateOfBirth", "dateOfDeath"]) if (p[k] && !validDate(p[k])) issues.push(p.id + ": " + k + " is not a valid date");
    if (p.dateOfBirth && p.dateOfDeath && p.dateOfDeath < p.dateOfBirth) issues.push(p.id + ": death precedes birth");
  }
  const seenPc = new Set(), children = new Map();
  for (const r of d.relationships.parentChild) {
    if (!ids.has(r.parentId) || !ids.has(r.childId)) issues.push("Parent link " + r.parentId + "→" + r.childId + " points at a missing person");
    if (r.parentId === r.childId) issues.push(r.parentId + " is their own parent");
    const key = r.parentId + ">" + r.childId;
    if (seenPc.has(key)) issues.push("Duplicate parent link " + key);
    seenPc.add(key);
    (children.get(r.parentId) || children.set(r.parentId, []).get(r.parentId)).push(r.childId);
  }
  const seenSp = new Set();
  for (const r of d.relationships.spouses) {
    if (!ids.has(r.personAId) || !ids.has(r.personBId)) issues.push("Spouse link " + r.personAId + "↔" + r.personBId + " points at a missing person");
    if (r.personAId === r.personBId) issues.push(r.personAId + " is married to themselves");
    const key = [r.personAId, r.personBId].sort().join("~");
    if (seenSp.has(key)) issues.push("Duplicate spouse link " + key);
    seenSp.add(key);
  }
  // A person cannot be their own ancestor.
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const c of children.get(id) || []) if (visit(c)) return true;
    state.set(id, 2);
    return false;
  };
  for (const id of ids) if (visit(id)) { issues.push("The parent/child links form a loop (someone is their own ancestor)"); break; }
  return issues;
}

/** Throw if applying changes introduced integrity problems that were not already present. */
export function assertNoNewIssues(before, after) {
  const known = new Set(before);
  const added = after.filter((i) => !known.has(i));
  if (added.length) throw new HttpError(422, "These changes would damage the family tree: " + added.slice(0, 3).join("; ") + (added.length > 3 ? " …" : ""));
}

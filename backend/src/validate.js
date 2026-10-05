import { HttpError } from "./util.js";

export const ID_RE = /^P\d{6}$/;
export const validId = (x) => typeof x === "string" && ID_RE.test(x);
export const ROLES = ["parent", "father", "mother", "adoptive_father", "adoptive_mother", "step_father", "step_mother"];
export const MAX_CHANGES = 100;

const GENDERS = ["", "male", "female", "other", "unknown"];
/** Text fields a contributor may set on a person, with their maximum lengths. */
const PERSON_TEXT = {
  firstName: 80, middleName: 80, familyName: 80, displayName: 160, nickname: 80, maidenName: 80,
  birthPlace: 160, birthRegion: 160, birthCountry: 160, deathPlace: 160, currentLocation: 160, occupation: 160,
  notes: 4000, maritalStatus: 20,
};
const DATE_FIELDS = ["dateOfBirth", "dateOfDeath"];

/** Dates may be partial, because families rarely know exact days: YYYY, YYYY-MM or YYYY-MM-DD. */
export function validDate(s) {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s || "");
  if (!m || +m[1] < 1000) return false;
  const [y, mo, d] = [+m[1], m[2] ? +m[2] : 1, m[3] ? +m[3] : 1], dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** True only when `a` is certainly earlier than `b`; partial dates are compared at the precision both share. */
export function dateBefore(a, b) {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) < b.slice(0, n);
}

export const LIFE_STATUSES = ["unknown", "living", "deceased"];
/** Normalise a stored/submitted life status ("alive" is accepted as an alias for "living"). */
export function lifeStatusOf(v) {
  const t = String(v || "").trim().toLowerCase();
  return t === "alive" ? "living" : LIFE_STATUSES.includes(t) ? t : "unknown";
}

function text(v, max, label) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") throw new HttpError(400, label + " must be text.");
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, label + " is too long (max " + max + " characters).");
  return t;
}
function dateOrNull(v, label) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !validDate(v)) throw new HttpError(400, label + " must be a valid date (YYYY-MM-DD, YYYY-MM or YYYY).");
  return v;
}
function id(v, label) {
  if (!validId(v)) throw new HttpError(400, label + " is not a valid person ID.");
  return v;
}
function order(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 1;
}

/** Keep only known person fields, validated and trimmed. Only keys present in `src` are returned. */
export function samplePerson(src) {
  const out = {};
  for (const [k, max] of Object.entries(PERSON_TEXT)) if (k in src) out[k] = text(src[k], max, k);
  for (const k of DATE_FIELDS) if (k in src) out[k] = dateOrNull(src[k], k);
  if ("gender" in src) {
    const g = text(src.gender, 20, "gender").toLowerCase();
    if (!GENDERS.includes(g)) throw new HttpError(400, "gender is not recognised.");
    out.gender = g;
  }
  if ("isMarried" in src) out.isMarried = Boolean(src.isMarried);
  if ("lifeStatus" in src) {
    const t = text(src.lifeStatus, 20, "lifeStatus").toLowerCase();
    if (t && t !== "alive" && !LIFE_STATUSES.includes(t)) throw new HttpError(400, "lifeStatus is not recognised.");
    out.lifeStatus = lifeStatusOf(t);
  }
  if (dateBefore(out.dateOfDeath, out.dateOfBirth)) throw new HttpError(400, "Death date cannot precede birth date.");
  return out;
}

/** Validate and normalise one change. Unknown fields are dropped; malformed ones are rejected. */
export function sanitizeChange(c) {
  if (!c || typeof c !== "object") throw new HttpError(400, "Invalid change.");
  const p = c.payload && typeof c.payload === "object" ? c.payload : {};
  switch (c.type) {
    case "ADD_PERSON": {
      const src = p.person && typeof p.person === "object" ? p.person : p;
      const person = samplePerson(src);
      if (!person.displayName && ![person.firstName, person.middleName, person.familyName].some(Boolean)) throw new HttpError(400, "A new person needs a name.");
      if (validId(src.id)) person.id = src.id;
      return { type: c.type, payload: { person } };
    }
    case "UPDATE_PERSON": {
      const fields = samplePerson(p);
      if (!Object.keys(fields).length) throw new HttpError(400, "An edit must change at least one field.");
      return { type: c.type, payload: { personId: id(p.personId, "personId"), ...fields } };
    }
    case "DELETE_PERSON":
      return { type: c.type, payload: { personId: id(p.personId, "personId"), reason: text(p.reason, 200, "reason") } };
    case "ADD_PARENT_CHILD": {
      const parentId = id(p.parentId, "parentId"), childId = id(p.childId, "childId");
      if (parentId === childId) throw new HttpError(400, "A person cannot be their own parent.");
      return { type: c.type, payload: { parentId, childId, role: ROLES.includes(p.role) ? p.role : "parent", order: order(p.order) } };
    }
    case "ADD_SPOUSE": {
      const personAId = id(p.personAId, "personAId"), personBId = id(p.personBId, "personBId");
      if (personAId === personBId) throw new HttpError(400, "A person cannot be their own spouse.");
      return {
        type: c.type,
        payload: {
          personAId, personBId, order: order(p.order), marriageDate: dateOrNull(p.marriageDate, "marriageDate"), marriagePlace: text(p.marriagePlace, 160, "marriagePlace"),
          status: text(p.status, 20, "status") || "married", divorceDate: dateOrNull(p.divorceDate, "divorceDate"),
        },
      };
    }
    default:
      throw new HttpError(400, "Unsupported change type: " + String(c.type).slice(0, 40));
  }
}

/**
 * Validate a whole proposal (public submission or admin approval) and return a clean copy.
 * Only BATCH_UPDATE is accepted; `meta` carries optional contributor details.
 */
export function sanitizeProposal(p) {
  if (!p || typeof p !== "object" || p.operation !== "BATCH_UPDATE") throw new HttpError(400, "Only BATCH_UPDATE proposals are accepted.");
  const q = p.payload && typeof p.payload === "object" ? p.payload : {};
  const list = Array.isArray(q.changes) ? q.changes : [];
  if (!list.length) throw new HttpError(400, "Batch contains no changes.");
  if (list.length > MAX_CHANGES) throw new HttpError(400, "A request may contain at most " + MAX_CHANGES + " changes.");
  const payload = { changes: list.map(sanitizeChange) };
  if (typeof q.baseLastUpdated === "string" && q.baseLastUpdated.length <= 40) payload.baseLastUpdated = q.baseLastUpdated;
  const out = { operation: "BATCH_UPDATE", payload };
  const meta = sanitizeMeta(p.meta);
  if (meta) out.meta = meta;
  return out;
}

export function sanitizeMeta(m) {
  if (!m || typeof m !== "object") return null;
  const name = text(m.name, 80, "name"), message = text(m.message, 1000, "message");
  return name || message ? { ...(name && { name }), ...(message && { message }) } : null;
}

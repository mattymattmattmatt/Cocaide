// The shorthands a feature may be written with (by the AI, or by hand), put
// into the document's one form as the feature goes in, so everything that
// reads the document (the property panel, the kernel, the drawing) sees one
// shape: a plane by name ("Right") or unwrapped ({ "datum": "Right" }) is
// { "type": "ref", "ref": { "datum": "Right" } }; an axis by name ("+Z") is
// [0, 0, 1]; a circular pattern's axis given as the reference itself is
// { "ref": ... }; a linear pattern's direction given as a reference is
// "along". Validation accepts the same shorthands. Pure.

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const REF_KEYS = ["datum", "face", "edge", "sketch", "point"];
const isRef = (v: unknown): v is Raw => isObject(v) && v.type === undefined && v.origin === undefined && v.direction === undefined && REF_KEYS.some((k) => k in v);

/** "+Z", "-x", "Y" as a vector; anything else as it is. */
function axisVector(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const m = /^\s*([+-]?)\s*([XYZ])\s*$/i.exec(v);
  if (!m) return v;
  const axis = "XYZ".indexOf(m[2].toUpperCase());
  return [0, 1, 2].map((i) => (i === axis ? (m[1] === "-" ? -1 : 1) : 0));
}

/** A plane by name or unwrapped reference, as { type: "ref", ref }. */
function plane(v: unknown): unknown {
  if (typeof v === "string" && v.trim() && !/^\s*[+-]?[XYZ]\s*$/i.test(v)) return { type: "ref", ref: { datum: v.trim() } };
  if (isRef(v)) {
    const { offset, flip, xDir, ...ref } = v;
    return { type: "ref", ref, ...(offset !== undefined ? { offset } : {}), ...(flip !== undefined ? { flip } : {}), ...(xDir !== undefined ? { xDir } : {}) };
  }
  return v;
}

/** Face and edge selectors anywhere in a value: a normal or direction given by axis name, as a vector. */
function selectors(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(selectors);
  if (!isObject(v)) return v;
  const out: Raw = {};
  for (const [k, x] of Object.entries(v)) out[k] = (k === "normal" || k === "direction") && typeof x === "string" ? axisVector(x) : selectors(x);
  return out;
}

/** The feature in the document's one form (a copy; the input is not changed). */
export function expandShorthands(f: Raw): Raw {
  const out: Raw = { ...f };
  for (const key of ["plane"]) if (key in out) out[key] = selectors(plane(out[key]));
  for (const key of ["direction", "direction2"]) if (typeof out[key] === "string") out[key] = axisVector(out[key]);
  if (out.op === "linearPattern") {
    if (isRef(out.direction) && out.along === undefined) {
      out.along = out.direction;
      delete out.direction;
    }
    if (isRef(out.direction2) && out.along2 === undefined) {
      out.along2 = out.direction2;
      delete out.direction2;
    }
  }
  if (out.op === "circularPattern" && isRef(out.axis)) out.axis = { ref: out.axis };
  // Selectors: faces, edges, a face, edges' onFace and between — wherever they sit.
  for (const key of ["face", "faces", "edges", "sets", "neutral", "refs", "upTo"]) if (key in out) out[key] = selectors(out[key]);
  return out;
}

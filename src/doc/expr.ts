// The expression language of every "=expr" number in a document, and of the
// sketcher's Modify box: what SOLIDWORKS's equations take, written plainly.
//
//   numbers        12, 2.5, .5, 1e3
//   units          25.4mm, 2.5cm, 0.1m, 1in, 2ft (lengths, to mm); 30deg, 30°, 1.2rad (angles, to degrees)
//   names          plate_t (a parameter), sketch_1.width (a sketch's dimension, by its name)
//   arithmetic     + - * / and parentheses, unary minus
//   comparisons    < <= > >= == != (1 when true, 0 when false), && and ||
//   functions      sqrt abs sin cos tan (degrees) asin acos atan atan2 (to degrees) min max round floor ceil
//                  pow hypot pi, if(condition, then, else)
//
// Nothing else is evaluated: no JavaScript, no property access. Pure, so
// Vitest tests it directly and every layer (document, kernel, UI) shares it.

/** What a name stands for: its number, nothing (unknown), or why it can't be worked out (a cycle, a bad expression). */
export type NameValue = number | undefined | { error: string };
export type Lookup = (name: string) => NameValue;

export type Evaluation = { ok: true; value: number } | { ok: false; error: string };

/** Lengths convert to millimetres, angles to degrees: the document's units. */
export const LENGTH_UNITS: Readonly<Record<string, number>> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
export const ANGLE_UNITS: Readonly<Record<string, number>> = { deg: 1, rad: 180 / Math.PI };
const UNITS: Readonly<Record<string, number>> = { ...LENGTH_UNITS, ...ANGLE_UNITS };
const isUnit = (s: string) => Object.prototype.hasOwnProperty.call(UNITS, s);

/** A name: letters, digits and _, starting with a letter or _; a dimension's has its sketch's id before a dot. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
const NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;

type Node =
  | { k: "num"; v: number }
  | { k: "ref"; name: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

class ExpressionError extends Error {}

const DEG = Math.PI / 180;

/** Each function: how many arguments it takes ([min, max]) and what it does. `if` is lazy, so it is handled apart. */
const FUNCTIONS: Record<string, { args: [number, number]; f(xs: number[]): number }> = {
  sqrt: {
    args: [1, 1],
    f: ([x]) => {
      if (x < 0) throw new ExpressionError(`sqrt of a negative number (${fmt(x)})`);
      return Math.sqrt(x);
    },
  },
  abs: { args: [1, 1], f: ([x]) => Math.abs(x) },
  sin: { args: [1, 1], f: ([x]) => Math.sin(x * DEG) },
  cos: { args: [1, 1], f: ([x]) => Math.cos(x * DEG) },
  tan: {
    args: [1, 1],
    f: ([x]) => {
      if (Math.abs(Math.cos(x * DEG)) < 1e-12) throw new ExpressionError(`tan(${fmt(x)}) is infinite`);
      return Math.tan(x * DEG);
    },
  },
  asin: { args: [1, 1], f: ([x]) => inverse("asin", x, Math.asin) },
  acos: { args: [1, 1], f: ([x]) => inverse("acos", x, Math.acos) },
  atan: { args: [1, 1], f: ([x]) => Math.atan(x) / DEG },
  atan2: { args: [2, 2], f: ([y, x]) => Math.atan2(y, x) / DEG },
  min: { args: [1, Infinity], f: (xs) => Math.min(...xs) },
  max: { args: [1, Infinity], f: (xs) => Math.max(...xs) },
  round: {
    args: [1, 2],
    f: ([x, digits = 0]) => {
      const k = Math.pow(10, Math.round(digits));
      return Math.round(x * k) / k;
    },
  },
  floor: { args: [1, 1], f: ([x]) => Math.floor(x) },
  ceil: { args: [1, 1], f: ([x]) => Math.ceil(x) },
  pow: { args: [2, 2], f: ([x, y]) => Math.pow(x, y) },
  hypot: { args: [1, Infinity], f: (xs) => Math.hypot(...xs) },
  pi: { args: [0, 0], f: () => Math.PI },
};

/** The functions an expression may call, for help text and messages. */
export const FUNCTION_NAMES: readonly string[] = [...Object.keys(FUNCTIONS), "if"].sort();
const hasFunction = (name: string) => Object.prototype.hasOwnProperty.call(FUNCTIONS, name);

function inverse(name: string, x: number, f: (x: number) => number): number {
  if (x < -1 - 1e-12 || x > 1 + 1e-12) throw new ExpressionError(`${name} needs a value from -1 to 1 (got ${fmt(x)})`);
  return f(Math.max(-1, Math.min(1, x))) / DEG;
}

function fmt(x: number): string {
  return String(Math.round(x * 1e6) / 1e6);
}

/** Parses an expression (with or without its leading "="). Throws ExpressionError. */
function parse(src: string): Node {
  let i = 0;
  const fail = (message: string): never => {
    throw new ExpressionError(message);
  };
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const peek = (s: string) => src.startsWith(s, i);
  const or = (): Node => {
    let a = and();
    for (;;) {
      ws();
      if (peek("||")) {
        i += 2;
        a = { k: "bin", op: "||", a, b: and() };
      } else return a;
    }
  };
  const and = (): Node => {
    let a = cmp();
    for (;;) {
      ws();
      if (peek("&&")) {
        i += 2;
        a = { k: "bin", op: "&&", a, b: cmp() };
      } else return a;
    }
  };
  const cmp = (): Node => {
    const a = add();
    ws();
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      if (peek(op)) {
        i += op.length;
        return { k: "bin", op, a, b: add() };
      }
    }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    for (;;) {
      ws();
      const ch = src[i];
      if (ch === "+" || ch === "-") {
        i++;
        a = { k: "bin", op: ch, a, b: mul() };
      } else return a;
    }
  };
  const mul = (): Node => {
    let a = unary();
    for (;;) {
      ws();
      const ch = src[i];
      if (ch === "*" || ch === "/") {
        i++;
        a = { k: "bin", op: ch, a, b: unary() };
      } else return a;
    }
  };
  const unary = (): Node => {
    ws();
    if (src[i] === "-") {
      i++;
      return { k: "neg", a: unary() };
    }
    if (src[i] === "+") {
      i++;
      return unary();
    }
    return primary();
  };
  const primary = (): Node => {
    ws();
    const ch = src[i];
    if (ch === "(") {
      i++;
      const v = or();
      ws();
      if (src[i] !== ")") fail("missing )");
      i++;
      return v;
    }
    const num = NUMBER.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      let v = Number(num[0]);
      // A unit right after the number: 25.4mm, 1 in, 30°.
      const save = i;
      ws();
      if (src[i] === "°") {
        i++;
      } else {
        const unit = /^[A-Za-z]+/.exec(src.slice(i));
        if (unit && isUnit(unit[0]) && !/[A-Za-z0-9_.(]/.test(src[i + unit[0].length] ?? "")) {
          i += unit[0].length;
          v *= UNITS[unit[0]];
        } else i = save;
      }
      return { k: "num", v };
    }
    const name = NAME.exec(src.slice(i));
    if (name) {
      i += name[0].length;
      const save = i;
      ws();
      if (src[i] !== "(") {
        i = save;
        return { k: "ref", name: name[0] };
      }
      i++;
      const args: Node[] = [];
      ws();
      if (src[i] === ")") i++;
      else
        for (;;) {
          args.push(or());
          ws();
          if (src[i] === ",") {
            i++;
            continue;
          }
          if (src[i] === ")") {
            i++;
            break;
          }
          fail(i >= src.length ? "missing )" : `unexpected "${src[i]}"`);
        }
      return { k: "call", name: name[0], args };
    }
    return fail(i >= src.length ? "unexpected end" : `unexpected "${ch}"`);
  };
  const tree = or();
  ws();
  if (i < src.length) fail(`unexpected "${src[i]}"`);
  return tree;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function run(n: Node, lookup: Lookup): number {
  switch (n.k) {
    case "num":
      return n.v;
    case "neg":
      return -run(n.a, lookup);
    case "ref": {
      const v = lookup(n.name);
      if (typeof v === "number") return v;
      if (v && typeof v === "object") throw new ExpressionError(v.error);
      if (n.name === "pi") return Math.PI;
      if (n.name.includes(".")) throw new ExpressionError(`unknown dimension "${n.name}" (a dimension is <sketch id>.<its name>, such as sketch_1.d1)`);
      if (hasFunction(n.name) || n.name === "if") throw new ExpressionError(`${n.name} is a function: write ${n.name}(…)`);
      throw new ExpressionError(`unknown parameter "${n.name}"`);
    }
    case "bin": {
      if (n.op === "&&") return run(n.a, lookup) !== 0 && run(n.b, lookup) !== 0 ? 1 : 0;
      if (n.op === "||") return run(n.a, lookup) !== 0 || run(n.b, lookup) !== 0 ? 1 : 0;
      const a = run(n.a, lookup);
      const b = run(n.b, lookup);
      switch (n.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0) throw new ExpressionError("division by zero");
          return a / b;
        case "<":
          return a < b && !near(a, b) ? 1 : 0;
        case ">":
          return a > b && !near(a, b) ? 1 : 0;
        case "<=":
          return a <= b || near(a, b) ? 1 : 0;
        case ">=":
          return a >= b || near(a, b) ? 1 : 0;
        case "==":
          return near(a, b) ? 1 : 0;
        case "!=":
          return near(a, b) ? 0 : 1;
      }
      throw new ExpressionError(`unknown operator ${n.op}`);
    }
    case "call": {
      if (n.name === "if") {
        if (n.args.length !== 3) throw new ExpressionError(`if takes 3 arguments, if(condition, then, else) (got ${n.args.length})`);
        return run(n.args[0], lookup) !== 0 ? run(n.args[1], lookup) : run(n.args[2], lookup);
      }
      const f = hasFunction(n.name) ? FUNCTIONS[n.name] : undefined;
      if (!f) throw new ExpressionError(`unknown function "${n.name}" (functions: ${FUNCTION_NAMES.join(", ")})`);
      const [lo, hi] = f.args;
      if (n.args.length < lo || n.args.length > hi) {
        const want = lo === hi ? `${lo} argument${lo === 1 ? "" : "s"}` : hi === Infinity ? `at least ${lo}` : `${lo} or ${hi} arguments`;
        throw new ExpressionError(`${n.name} takes ${want} (got ${n.args.length})`);
      }
      return f.f(n.args.map((a) => run(a, lookup)));
    }
  }
}

/** A lookup over a plain record of names (own keys only: "constructor" is no parameter). */
export function recordLookup(values: Readonly<Record<string, number>>): Lookup {
  return (name) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined);
}

/** Evaluates "=a * 2 + 1", "=sqrt(2) * 10", "=1in", against a lookup for the names. */
export function evaluateWith(expression: string, lookup: Lookup): Evaluation {
  const src = expression.startsWith("=") ? expression.slice(1) : expression;
  try {
    const value = run(parse(src), lookup);
    if (!Number.isFinite(value)) throw new ExpressionError("result is not a finite number");
    return { ok: true, value };
  } catch (e) {
    if (e instanceof ExpressionError) return { ok: false, error: `${e.message} in "${expression}"` };
    throw e;
  }
}

/** The names an expression reads (parameters and dimensions; not functions or units). A malformed one: the names it seems to use. */
export function namesIn(expression: string): string[] {
  const src = expression.startsWith("=") ? expression.slice(1) : expression;
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.k === "ref" && !out.includes(n.name)) out.push(n.name);
    if (n.k === "neg") walk(n.a);
    if (n.k === "bin") (walk(n.a), walk(n.b));
    if (n.k === "call") n.args.forEach(walk);
  };
  try {
    walk(parse(src));
  } catch {
    const re = new RegExp(NAME.source.slice(1), "g");
    for (const m of src.matchAll(re)) {
      const before = src[m.index! - 1];
      const after = src.slice(m.index! + m[0].length).trimStart()[0];
      if ((before !== undefined && /[0-9.]/.test(before)) || after === "(") continue;
      if (!out.includes(m[0])) out.push(m[0]);
    }
  }
  return out;
}

/**
 * The expression with names replaced (a renamed dimension or sketch): each
 * name token `rename` maps is rewritten, the rest of the text is kept as typed.
 */
export function renameIn(expression: string, rename: (name: string) => string | undefined): string {
  const head = expression.startsWith("=") ? "=" : "";
  const src = head ? expression.slice(1) : expression;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const num = NUMBER.exec(src.slice(i));
    // A number and the unit stuck to it are not names.
    if (num && (i === 0 || !/[A-Za-z0-9_.]/.test(src[i - 1]))) {
      out += num[0];
      i += num[0].length;
      const unit = /^[A-Za-z]+/.exec(src.slice(i));
      if (unit && isUnit(unit[0])) {
        out += unit[0];
        i += unit[0].length;
      }
      continue;
    }
    const name = /[A-Za-z_]/.test(src[i]) ? NAME.exec(src.slice(i)) : null;
    if (name) {
      const after = src.slice(i + name[0].length).trimStart()[0];
      out += after === "(" ? name[0] : (rename(name[0]) ?? name[0]);
      i += name[0].length;
      continue;
    }
    out += src[i++];
  }
  return head + out;
}

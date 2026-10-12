// The expression language (src/doc/expr.ts): precedence, functions, units,
// comparisons and conditionals, errors, names and renames.

import { describe, expect, it } from "vitest";
import { evaluateWith, FUNCTION_NAMES, namesIn, recordLookup, renameIn } from "../src/doc/expr";
import { evaluate } from "../src/doc/parameters";

const val = (e: string, p: Record<string, number> = {}) => {
  const r = evaluate(e, p);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const err = (e: string, p: Record<string, number> = {}) => {
  const r = evaluate(e, p);
  if (r.ok) throw new Error(`${e} gave ${r.value}`);
  return r.error;
};

describe("arithmetic and precedence", () => {
  it("binds * and / tighter than + and -, left to right", () => {
    expect(val("=2 + 3 * 4")).toBe(14);
    expect(val("=(2 + 3) * 4")).toBe(20);
    expect(val("=10 - 4 - 3")).toBe(3);
    expect(val("=24 / 4 / 2")).toBe(3);
    expect(val("=-2 * -3")).toBe(6);
    expect(val("=-(1 + 2) * 2")).toBe(-6);
    expect(val("=+5")).toBe(5);
  });

  it("puts comparisons below arithmetic, && below them, || lowest", () => {
    expect(val("=1 + 1 == 2")).toBe(1);
    expect(val("=2 * 3 > 5")).toBe(1);
    expect(val("=2 < 1")).toBe(0);
    expect(val("=1 < 2 && 3 < 2")).toBe(0);
    expect(val("=1 < 2 && 3 < 2 || 1")).toBe(1);
    expect(val("=0.1 + 0.2 == 0.3")).toBe(1); // within a billionth
    expect(val("=3 != 3")).toBe(0);
    expect(val("=3 <= 3")).toBe(1);
    expect(val("=3 >= 4")).toBe(0);
  });
});

describe("functions", () => {
  it("works out each function, trig in degrees", () => {
    expect(val("=sqrt(2) * 10")).toBeCloseTo(14.142135623730951, 12);
    expect(val("=sin(30)")).toBeCloseTo(0.5, 12);
    expect(val("=cos(60)")).toBeCloseTo(0.5, 12);
    expect(val("=tan(45)")).toBeCloseTo(1, 12);
    expect(val("=asin(0.5)")).toBeCloseTo(30, 10);
    expect(val("=acos(0)")).toBeCloseTo(90, 10);
    expect(val("=atan(1)")).toBeCloseTo(45, 10);
    expect(val("=atan2(1, -1)")).toBeCloseTo(135, 10);
    expect(val("=abs(-4.5)")).toBe(4.5);
    expect(val("=min(3, 1, 2)")).toBe(1);
    expect(val("=max(3, 1, 2)")).toBe(3);
    expect(val("=round(2.5)")).toBe(3);
    expect(val("=round(3.14159, 2)")).toBe(3.14);
    expect(val("=floor(-1.5)")).toBe(-2);
    expect(val("=ceil(1.2)")).toBe(2);
    expect(val("=pow(2, 10)")).toBe(1024);
    expect(val("=hypot(3, 4)")).toBe(5);
    expect(val("=pi")).toBe(Math.PI);
    expect(val("=pi() * 2")).toBe(2 * Math.PI);
    expect(FUNCTION_NAMES).toContain("if");
  });

  it("if(condition, then, else) takes only the branch it needs", () => {
    expect(val("=if(w > 50, 10, 5)", { w: 60 })).toBe(10);
    expect(val("=if(w > 50, 10, 5)", { w: 40 })).toBe(5);
    // The branch not taken may not even be computable.
    expect(val("=if(w == 0, 1, 10 / w)", { w: 0 })).toBe(1);
  });

  it("parameters named like a constant win over it", () => {
    expect(val("=pi", { pi: 3 })).toBe(3);
  });
});

describe("units", () => {
  it("converts lengths to mm and angles to degrees", () => {
    expect(val("=1in")).toBe(25.4);
    expect(val("=1 in")).toBe(25.4);
    expect(val("=2ft")).toBeCloseTo(609.6, 10);
    expect(val("=2.5cm")).toBe(25);
    expect(val("=0.1m")).toBe(100);
    expect(val("=25.4mm + 3")).toBe(28.4);
    expect(val("=30deg")).toBe(30);
    expect(val("=30°")).toBe(30);
    expect(val("=1rad")).toBeCloseTo(57.29577951308232, 12);
    expect(val("=pi * 1rad")).toBeCloseTo(180, 10);
    expect(val("=sin(pi / 6 * 1rad)")).toBeCloseTo(0.5, 12);
    expect(val("=1in * 2")).toBe(50.8);
    expect(val("=2 * 1in")).toBe(50.8);
  });

  it("a parameter named like a unit is still read after an operator", () => {
    expect(val("=m * 2", { m: 3 })).toBe(6);
  });
});

describe("errors", () => {
  it("says what is wrong and where", () => {
    expect(err("=sqrt(-4)")).toBe('sqrt of a negative number (-4) in "=sqrt(-4)"');
    expect(err("=asin(2)")).toBe('asin needs a value from -1 to 1 (got 2) in "=asin(2)"');
    expect(err("=foo(1)")).toMatch(/^unknown function "foo" \(functions: abs, acos, .*\) in "=foo\(1\)"$/);
    expect(err("=sin(1, 2)")).toBe('sin takes 1 argument (got 2) in "=sin(1, 2)"');
    expect(err("=min()")).toBe('min takes at least 1 (got 0) in "=min()"');
    expect(err("=if(1, 2)")).toBe('if takes 3 arguments, if(condition, then, else) (got 2) in "=if(1, 2)"');
    expect(err("=sqrt")).toBe('sqrt is a function: write sqrt(…) in "=sqrt"');
    expect(err("=sketch_1.d9")).toBe('unknown dimension "sketch_1.d9" (a dimension is <sketch id>.<its name>, such as sketch_1.d1) in "=sketch_1.d9"');
    expect(err("=tan(90)")).toBe('tan(90) is infinite in "=tan(90)"');
    expect(err("=1 / (2 - 2)")).toBe('division by zero in "=1 / (2 - 2)"');
    expect(err("=sqrt(2")).toBe('missing ) in "=sqrt(2"');
    expect(err("=2mm2")).toBe('unexpected "m" in "=2mm2"');
    expect(err("=constructor")).toBe('unknown parameter "constructor" in "=constructor"');
    expect(err("=1 +")).toBe('unexpected end in "=1 +"');
  });
});

describe("names", () => {
  it("reads dimensions by <sketch>.<name> and parameters by name", () => {
    const look = recordLookup({ "sketch_1.width": 40, t: 2 });
    expect(evaluateWith("=sketch_1.width * 2 + t", look)).toEqual({ ok: true, value: 82 });
  });

  it("lists the names an expression reads, not its functions or units", () => {
    expect(namesIn("=sqrt(a) + sketch_1.d2 * 2in + if(b > 1, c, 0)")).toEqual(["a", "sketch_1.d2", "b", "c"]);
    expect(namesIn("=2e3 * k")).toEqual(["k"]);
    // A malformed one still names what it seems to use.
    expect(namesIn("=a * (b")).toEqual(["a", "b"]);
  });

  it("renames name tokens only, keeping the rest as typed", () => {
    const r = (n: string) => (n === "sketch_1.d1" ? "base.width" : n === "t" ? "thickness" : undefined);
    expect(renameIn("=sketch_1.d1/2 + t*2in + sqrt(t) + sketch_1.d10", r)).toBe("=base.width/2 + thickness*2in + sqrt(thickness) + sketch_1.d10");
    expect(renameIn("=2e3 + 1in + tt", r)).toBe("=2e3 + 1in + tt");
  });
});

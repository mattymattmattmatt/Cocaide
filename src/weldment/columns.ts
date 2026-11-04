// The cut list's columns (Phase Q): one catalogue for the panel, the CSV and
// XLSX exports and the drawing's cut list table, so a column reads the same
// everywhere. A custom property is a column too: "prop:Supplier".

import { angleText } from "./endCuts";
import type { CutItem } from "./items";

export interface CutColumn {
  key: string;
  /** In the panel and the CSV header. */
  label: string;
  /** On a drawing: capitals, short. */
  header: string;
  numeric: boolean;
  /** Decimal places a number is shown to. */
  digits?: number;
  /** The cell's value: a number stays a number in CSV and XLSX. */
  value(i: CutItem): string | number;
  /** In the column catalogue's own words: what it is. */
  help: string;
}

const relation = (i: CutItem): string => {
  const c = i.cuts;
  if (!c) return "";
  if (c.relation === "square") return "square";
  if (c.relation === "oneEnd") return "one end";
  if (c.relation === "twisted") return `twisted ${c.twist}°`;
  return c.shape ? `same plane, ${c.shape}` : "same plane";
};

const flags = (i: CutItem): string => {
  const c = i.cuts;
  if (!c) return "";
  return [c.mitre ? "mitre" : "", c.cope ? "cope" : "", c.notch ? "notch" : ""].filter(Boolean).join(", ");
};

export const CUT_COLUMNS: CutColumn[] = [
  { key: "item", label: "Item", header: "ITEM", numeric: true, digits: 0, value: (i) => i.item, help: "the item number (balloons show it)" },
  { key: "quantity", label: "Qty", header: "QTY", numeric: true, digits: 0, value: (i) => i.quantity, help: "how many" },
  { key: "description", label: "Description", header: "DESCRIPTION", numeric: false, value: (i) => i.description, help: "the typed description, else the size" },
  { key: "profile", label: "Profile", header: "PROFILE", numeric: false, value: (i) => i.profile, help: "the profile family (SHS), PL for a plate" },
  { key: "designation", label: "Size", header: "SIZE", numeric: false, value: (i) => i.designation, help: "the designation (SHS 40x40x3, PL 6)" },
  { key: "standard", label: "Standard", header: "STANDARD", numeric: false, value: (i) => i.standard, help: "the standard the section is from" },
  { key: "material", label: "Material", header: "MATERIAL", numeric: false, value: (i) => i.material, help: "the material" },
  { key: "grade", label: "Grade", header: "GRADE", numeric: false, value: (i) => i.grade, help: "the material's grade" },
  { key: "length", label: "Length (mm)", header: "LENGTH", numeric: true, digits: 1, value: (i) => i.length, help: "the cut length, long point to long point (a plate: its length)" },
  { key: "width", label: "Width (mm)", header: "WIDTH", numeric: true, digits: 1, value: (i) => i.width ?? "", help: "a plate's width" },
  { key: "thickness", label: "Thickness (mm)", header: "THK", numeric: true, digits: 1, value: (i) => i.thickness ?? "", help: "a plate's thickness" },
  { key: "angle1", label: "Angle 1", header: "ANGLE 1", numeric: false, value: (i) => (i.cuts ? angleText(i.cuts.ends[0].angle) : ""), help: "the first end's cut from square" },
  { key: "angle2", label: "Angle 2", header: "ANGLE 2", numeric: false, value: (i) => (i.cuts ? angleText(i.cuts.ends[1].angle) : ""), help: "the second end's cut from square" },
  { key: "orientation", label: "Orientation", header: "ORIENTATION", numeric: false, value: relation, help: "the two cuts in one plane (trapezoid or parallelogram) or twisted" },
  { key: "face", label: "Angle seen on", header: "ANGLE ON", numeric: false, value: (i) => [...new Set(i.faces.filter(Boolean))].join(" / "), help: "which face of the section shows the angle" },
  { key: "ends", label: "Ends", header: "ENDS", numeric: false, value: (i) => i.endsText, help: "the end cuts in words" },
  { key: "cuts", label: "Cuts", header: "CUTS", numeric: false, value: flags, help: "mitre, cope, notch" },
  { key: "massEach", label: "kg each", header: "KG EA", numeric: true, digits: 2, value: (i) => i.massEach, help: "mass of one" },
  { key: "massTotal", label: "kg total", header: "KG", numeric: true, digits: 2, value: (i) => i.massTotal, help: "mass of all" },
  { key: "areaEach", label: "Surface each (m²)", header: "M² EA", numeric: true, digits: 3, value: (i) => i.areaEach / 1e6, help: "surface of one, for painting" },
  { key: "areaTotal", label: "Paint area (m²)", header: "PAINT M²", numeric: true, digits: 3, value: (i) => i.areaTotal / 1e6, help: "surface of all, for painting" },
  { key: "plateArea", label: "Plate area (m²)", header: "PL AREA M²", numeric: true, digits: 4, value: (i) => (i.plateArea !== undefined ? (i.plateArea * i.quantity) / 1e6 : ""), help: "a plate's plan area, all pieces" },
  { key: "finish", label: "Finish", header: "FINISH", numeric: false, value: (i) => i.finish, help: "the finish (default: the part's)" },
  { key: "weldPrep", label: "Weld prep", header: "WELD PREP", numeric: false, value: (i) => i.weldPrep, help: "bevels and preparation" },
  { key: "group", label: "Group", header: "GROUP", numeric: false, value: (i) => i.group, help: "the member group" },
  { key: "notes", label: "Notes", header: "NOTES", numeric: false, value: (i) => i.notes, help: "notes" },
  { key: "members", label: "Members", header: "MEMBERS", numeric: false, value: (i) => i.members.join(" "), help: "the members or bodies on the item" },
];

export const CUT_COLUMN_KEYS = CUT_COLUMNS.map((c) => c.key);

/** The panel's and the exports' columns unless chosen otherwise. */
export const DEFAULT_CUT_COLUMNS = ["item", "quantity", "description", "designation", "material", "length", "angle1", "angle2", "orientation", "massEach", "massTotal", "areaTotal", "finish", "notes"];

/** A drawing table's: fewer, so it fits above a title block. */
export const DEFAULT_SHEET_CUT_COLUMNS = ["item", "quantity", "description", "material", "length", "angle1", "angle2", "massTotal"];

/** A column by key; "prop:<name>" is a custom property column. Null for an unknown key. */
export function cutColumn(key: string): CutColumn | null {
  if (key.startsWith("prop:")) {
    const name = key.slice(5);
    if (!name) return null;
    return { key, label: name, header: name.toUpperCase(), numeric: false, value: (i) => i.properties[name] ?? "", help: `the custom property "${name}"` };
  }
  return CUT_COLUMNS.find((c) => c.key === key) ?? null;
}

/** A value as text, to the column's digits. */
export function cellText(c: CutColumn, v: string | number): string {
  if (typeof v === "number") return c.digits === undefined ? String(v) : v.toFixed(c.digits);
  return v;
}

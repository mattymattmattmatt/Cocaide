// The profile card's suggestions (Phase K): from a section's measured
// properties, the model suggests a family name, a designation for each size,
// tags and the anchor. It suggests and never decides: the card fills its
// fields, the user can change any of them, and nothing about the geometry or
// the sizes changes.

import { z } from "zod";
import type { AskModel } from "./model";

export const ProfileSuggestion = z.object({
  /** The family's usual name: "SHS", "RHS", "CHS", "EA". */
  name: z.string(),
  /** One per size, in the order given. */
  designations: z.array(z.string()),
  tags: z.array(z.string()),
  anchor: z.enum(["centroid", "origin"]),
  /** One sentence: why these. */
  why: z.string(),
});
export type ProfileSuggestion = z.infer<typeof ProfileSuggestion>;

/** What the card knows about the section, measured; the model sees this and nothing else. */
export interface ProfileFacts {
  /** The size parameters, by name, and what the sketch draws ("2 rect", "6 line"). */
  parameters: string[];
  drawn: string;
  sizes: {
    values: Record<string, number>;
    area: number;
    envelope: [number, number];
    centroid: [number, number];
    ix: number;
    iy: number;
    hollow: boolean;
    open: boolean;
    round: boolean;
  }[];
  /** Where the sketch origin is on the first size's envelope: "centre", "lower left corner", ... */
  origin: string;
  /** Names already in the section library. */
  taken: string[];
  /** What the user has typed so far, if anything. */
  current: { name: string; designations: string[] };
}

export const PROFILE_SYSTEM = `You name weldment profiles for the section library of Cocaide, a parametric CAD program. A profile is a cross-section a structural member is swept from; one profile is a family of sizes.

From the measured facts, suggest:
- name: the family as a fabricator writes it. SHS (square hollow section), RHS (rectangular hollow), CHS (circular hollow), EA (equal angle), UA (unequal angle), PFC (parallel flange channel), FB (flat bar), SB (square bar), RB (round bar), or a short plain name for anything else. If that name is already taken, add a short qualifier ("SHS heavy").
- designations: one per size, in the order given, the way the size is written in a steel catalogue, using that size's own values: an SHS of outside 40 and wall 3 is "SHS 40x40x3"; a CHS of outside diameter 48.3 and wall 3.2 is "CHS 48.3x3.2"; a flat bar 50 wide and 6 thick is "FB 50x6". Never change a number.
- tags: three to six short lowercase words to search by (shape, hollow or solid or open, the material if the user's name gives it).
- anchor: "centroid" for a section symmetric about both axes or round; "origin" when the sketch origin sits on a meaningful point (an angle's heel, a channel's back) and the member's line should run there.
- why: one sentence.
Suggest only words; the sizes and the geometry are the user's.`;

/** Asks the model for a name, designations, tags and anchor. Code keeps only what fits the card. */
export async function suggestProfile(model: AskModel, facts: ProfileFacts, signal?: AbortSignal): Promise<ProfileSuggestion> {
  const raw = await model.readIntent({ system: PROFILE_SYSTEM, content: [{ type: "text", text: factsText(facts) }], schema: "profile" }, signal);
  const parsed = ProfileSuggestion.safeParse(raw);
  if (!parsed.success) throw new Error(`the suggestion did not fit: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const s = parsed.data;
  const tags = [...new Set(s.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  // One designation per size, or none: a list that doesn't line up with the sizes is dropped.
  const designations = s.designations.length === facts.sizes.length ? s.designations.map((d) => d.trim()) : [];
  return { name: s.name.trim(), designations, tags, anchor: s.anchor, why: s.why.trim() };
}

function factsText(f: ProfileFacts): string {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const lines = [
    `Drawn as: ${f.drawn}. Size parameters: ${f.parameters.join(", ") || "none (one size)"}.`,
    `The sketch origin is at the ${f.origin} of the section.`,
    ...f.sizes.map(
      (s, i) =>
        `Size ${i + 1}: ${Object.entries(s.values).map(([k, v]) => `${k} = ${r(v)}`).join(", ") || "as drawn"}; envelope ${r(s.envelope[0])} × ${r(s.envelope[1])} mm; area ${r(s.area)} mm²; centroid (${r(s.centroid[0])}, ${r(s.centroid[1])}); Ix ${r(s.ix)} mm⁴, Iy ${r(s.iy)} mm⁴; ${s.hollow ? "hollow" : s.open ? "open" : "solid"}${s.round ? ", round" : ""}.`,
    ),
    `Names already in the library: ${f.taken.join(", ") || "none"}.`,
    f.current.name || f.current.designations.some(Boolean) ? `The user has typed: name "${f.current.name}", designations ${JSON.stringify(f.current.designations)}.` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

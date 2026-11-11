/**
 * Draw/GPU state checks: state changed by a call must be restored on every
 * code path before the end of the script (or function), and begin/end pairs
 * must be balanced. All checks share one analysis per file (see engine.ts).
 *
 * The "restore default" checks (GM2000, GM2019, GM2026, GM2048-GM2056,
 * GM2062, GM2063) accept an option:
 *
 *   rules: { GM2063: ["warning", { allowInEvents: ["Draw GUI Begin", "Draw_72"] }] }
 *
 * `allowInEvents` lists object events where changing the state without
 * restoring it is intentional (e.g. a Draw Begin event that sets up state for
 * the events that follow). Entries match an event's display name
 * ("Draw GUI Begin"), its file name ("Draw_74") or its type ("Draw" = every
 * draw event), case-insensitively. Default: [] (Feather's behaviour).
 */

import { defineCheck, FEATHER_DOCS, type Check, type CheckContext } from "../api.js";
import { PAIRS, SETTERS, stateFindings, type PairFamily, type PairName } from "./engine.js";

const docs = (code: string) => `${FEATHER_DOCS}#:~:text=${code}`;

function eventAllowed(ctx: CheckContext): boolean {
  const list = ctx.options["allowInEvents"];
  const ev = ctx.file.gml?.event;
  if (!ev || !Array.isArray(list) || list.length === 0) return false;
  const names = [ev.displayName, ev.fileName, ev.type].map((s) => String(s).toLowerCase());
  return list.some((x) => typeof x === "string" && names.includes(x.toLowerCase()));
}

function stateCheck(code: string, name: string, description: string, opts: { allowInEvents?: boolean } = {}): Check {
  return defineCheck({
    meta: {
      code,
      name,
      description,
      category: "state",
      feather: true,
      docs: docs(code),
    },
    create(ctx) {
      if (opts.allowInEvents && eventAllowed(ctx)) return {};
      return {
        Program() {
          for (const f of stateFindings(ctx).get(code) ?? []) ctx.report({ range: f.range, message: f.message });
        },
      };
    },
  });
}

const setter = (code: string) => {
  const s = SETTERS.find((x) => x.code === code)!;
  return stateCheck(code, s.name, `Not all code paths call ${s.reset} before the end of the script.`, { allowInEvents: true });
};
const pair = (p: PairName) => PAIRS.find((x) => x.pair === p)!;

// Restore-to-default setters
export const GM2000 = setter("GM2000");
export const GM2019 = setter("GM2019");
export const GM2026 = setter("GM2026");
export const GM2048 = setter("GM2048");
export const GM2049 = setter("GM2049");
export const GM2050 = setter("GM2050");
export const GM2051 = setter("GM2051");
export const GM2052 = setter("GM2052");
export const GM2053 = setter("GM2053");
export const GM2054 = setter("GM2054");
export const GM2055 = setter("GM2055");
export const GM2056 = setter("GM2056");
export const GM2062 = setter("GM2062");
export const GM2063 = setter("GM2063");

// Unclosed pairs
const unclosed = (p: PairFamily) => stateCheck(p.unclosed.code, p.unclosed.name, p.unclosed.message);
export const GM2003 = unclosed(pair("shader"));
export const GM2005 = unclosed(pair("surface"));
export const GM2011 = unclosed(pair("vertex"));
export const GM2015 = unclosed(pair("vformat"));
export const GM2030 = unclosed(pair("prim"));
export const GM2034 = unclosed(pair("ffind"));
export const GM2035 = unclosed(pair("gpu"));

// Ordering
const nested = (p: PairFamily) => stateCheck(p.nested!.code, p.nested!.name, p.nested!.message);
const unopened = (p: PairFamily) => stateCheck(p.unopened!.code, p.unopened!.name, p.unopened!.message);
const outside = (p: PairFamily) =>
  stateCheck(p.outside!.code, p.outside!.name, `The function '{0}' cannot be called outside of a ${p.outside!.block} block.`);
export const GM2008 = nested(pair("vertex"));
export const GM2009 = unopened(pair("vertex"));
export const GM2010 = outside(pair("vertex"));
export const GM2012 = nested(pair("vformat"));
export const GM2013 = unopened(pair("vformat"));
export const GM2014 = outside(pair("vformat"));
export const GM2027 = nested(pair("prim"));
export const GM2028 = unopened(pair("prim"));
export const GM2029 = outside(pair("prim"));
export const GM2031 = nested(pair("ffind"));
export const GM2032 = unopened(pair("ffind"));
export const GM2033 = outside(pair("ffind"));

// Stack depth consistency
const depth = (p: PairFamily) => stateCheck(p.depth!.code, p.depth!.name, p.depth!.message);
export const GM2042 = depth(pair("gpu"));
export const GM2046 = depth(pair("surface"));

export const stateChecks: Check[] = [
  GM2000, GM2003, GM2005, GM2008, GM2009, GM2010, GM2011, GM2012, GM2013, GM2014, GM2015, GM2019, GM2026, GM2027, GM2028, GM2029,
  GM2030, GM2031, GM2032, GM2033, GM2034, GM2035, GM2042, GM2046, GM2048, GM2049, GM2050, GM2051, GM2052, GM2053, GM2054, GM2055,
  GM2056, GM2062, GM2063,
];

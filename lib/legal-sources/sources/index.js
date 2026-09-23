import { rmfyalkAdapter } from "./rmfyalk.js";
import { mfaTreatyAdapter } from "./mfa-treaty.js";
import { govRulesAdapter } from "./gov-rules.js";
import { partyRegulationAdapter } from "./party-regulation.js";
import { ccdiSupervisoryAdapter } from "./ccdi-supervisory.js";

export const SOURCE_ADAPTERS = new Map([
  ["rmfyalk-case-library", rmfyalkAdapter],
  ["mfa-treaty-library", mfaTreatyAdapter],
  ["gov-rules-library", govRulesAdapter],
  ["party-regulation-library", partyRegulationAdapter],
  ["ccdi-supervisory-regulations", ccdiSupervisoryAdapter],
]);

export function getSourceAdapter(source) {
  const adapter = SOURCE_ADAPTERS.get(source);
  if (!adapter) {
    throw new Error(`unknown legal source: ${source}; known: ${[...SOURCE_ADAPTERS.keys()].join(", ")}`);
  }
  return adapter;
}

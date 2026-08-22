// peer-contract-enforcer dispatch validator
// Implements HR4 (payload-self-contained) Day 4.

const VALID_REFERENCE_TYPES = new Set(["session", "file", "card", "memory", "url"]);

/**
 * Validate HR4: payload-self-contained.
 * - references must have valid structure
 * - payload_completeness must be self_contained or need_lookup
 * - need_lookup requires references to be non-empty
 * @param {Object} cp - context_payload
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validatePayloadSelfContained(cp) {
  if (typeof cp !== "object" || cp === null || Array.isArray(cp)) {
    return { ok: false, reason: "context_payload must be an object literal" };
  }
  
  // payload_completeness
  if (cp.payload_completeness !== undefined) {
    if (!["self_contained", "need_lookup"].includes(cp.payload_completeness)) {
      return { ok: false, reason: `payload_completeness must be 'self_contained' or 'need_lookup', got '${cp.payload_completeness}'` };
    }
  }
  
  // references structure validation
  if (cp.references !== undefined) {
    if (!Array.isArray(cp.references)) {
      return { ok: false, reason: "context_payload.references must be an array" };
    }
    
    for (let i = 0; i < cp.references.length; i++) {
      const ref = cp.references[i];
      if (typeof ref !== "object" || ref === null) {
        return { ok: false, reason: `references[${i}] must be an object` };
      }
      if (!ref.type || !VALID_REFERENCE_TYPES.has(ref.type)) {
        return { ok: false, reason: `references[${i}].type must be one of [${[...VALID_REFERENCE_TYPES].join(", ")}], got '${ref.type}'` };
      }
      if (!ref.locator) {
        return { ok: false, reason: `references[${i}].locator required` };
      }
      // type-specific locator validation
      if (ref.type === "session" && typeof ref.locator !== "string") {
        return { ok: false, reason: `references[${i}] (type=session) locator must be a sessionKey string` };
      }
      if (ref.type === "url" && !/^https?:\/\//.test(ref.locator)) {
        return { ok: false, reason: `references[${i}] (type=url) locator must be http(s) URL` };
      }
    }
  }
  
  // need_lookup requires references to be non-empty
  if (cp.payload_completeness === "need_lookup") {
    if (!cp.references || cp.references.length === 0) {
      return { ok: false, reason: "payload_completeness='need_lookup' requires non-empty references" };
    }
  }
  
  return { ok: true };
}

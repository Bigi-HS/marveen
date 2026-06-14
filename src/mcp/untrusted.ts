// SEC-AC1: every piece of text that arrives from googleapis.com (email body,
// message snippet, thread message bodies) MUST enter Claudia's context wrapped
// in the fleet's untrusted-data envelope, so it is read and reported as DATA and
// never executed as an instruction (STRIDE S1/S2). This module is the single
// wrapper used by every gmail read handler.
//
// Hardening: the payload itself is attacker-controlled (a sender chooses the
// email body), so it could try to break OUT of the wrapper by embedding a
// literal `</untrusted>` and then injecting its own pseudo-instructions. We
// neutralize any untrusted-tag sequence inside the payload (open OR close) by
// stripping its angle brackets, so the wrapper boundary cannot be forged from
// within. The wrapper Claudia sees is therefore always exactly one enclosing
// pair we emit.

export type UntrustedSource = 'gmail'

// Remove the angle brackets from any literal <untrusted ...> / </untrusted>
// sequence in the payload so it cannot close or re-open the wrapper.
function neutralizeWrapperTags(text: string): string {
  // eslint-disable-next-line no-useless-escape
  return text.replace(/<\/?\s*untrusted\b[^>]*>/gi, (m) => m.replace(/[<>]/g, ''))
}

// Wrap external/untrusted text. `source` is a fixed enum (currently only
// 'gmail') so the attribute value is never attacker-influenced.
export function wrapUntrusted(text: string, source: UntrustedSource = 'gmail'): string {
  return `<untrusted source="${source}">${neutralizeWrapperTags(text)}</untrusted>`
}

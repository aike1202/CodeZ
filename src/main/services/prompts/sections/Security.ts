// src/main/services/prompts/sections/Security.ts
export const SECURITY_SECTION = `IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.`

export function buildSecurity(): string {
  return SECURITY_SECTION
}

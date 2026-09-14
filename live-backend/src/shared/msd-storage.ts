// LN structure is an offline diagnostic, not part of a cached difficulty.
// Preserve every other field (including native/vibro evidence and LN scalar).
// Accept old text cells so copying a legacy artifact cannot restore its preview.
export function compactMsdForStorage(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  let artifact: Record<string, unknown>;
  try {
    artifact = JSON.parse(text);
  } catch {
    return text;
  }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return text;
  const skill = artifact.lnSkill;
  if (!skill || typeof skill !== "object" || Array.isArray(skill) || !("structure" in skill)) return text;
  const { structure: _structure, ...scalar } = skill;
  return JSON.stringify({ ...artifact, lnSkill: scalar });
}

const PI_MAX_NAME_LENGTH = 60 // Pi allows 64; leave room for dedup suffix like -2
const PI_MANAGED_NAME_LIMIT = 64

export function normalizePiSkillName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "item"

  const normalized = trimmed
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[:_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PI_MAX_NAME_LENGTH)
    .replace(/-+$/, "")

  return normalized || "item"
}

export function uniquePiSkillName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }

  let index = 2
  while (true) {
    const suffix = `-${index}`
    const trimmedBase = base.slice(0, Math.max(1, PI_MANAGED_NAME_LIMIT - suffix.length)).replace(/-+$/, "") || "item"
    const candidate = `${trimmedBase}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
    index += 1
  }
}

export function buildPiSameRunQualifiedNameMap(
  activeNameMap: Record<string, string>,
  namespace = "claude-home",
): Record<string, string> {
  const qualifiedNameMap: Record<string, string> = {}

  for (const [sourceName, emittedName] of Object.entries(activeNameMap)) {
    if (!sourceName || sourceName.startsWith(`${namespace}:`)) continue
    qualifiedNameMap[`${namespace}:${sourceName}`] = emittedName
  }

  return qualifiedNameMap
}

export function isFirstPartyQualifiedPiName(value: string): boolean {
  const trimmed = value.trim()
  const rootNamespace = trimmed.split(":").filter(Boolean)[0] ?? ""
  return trimmed.includes(":") && ["compound-engineering", "claude-home"].includes(rootNamespace)
}

import { dump } from "js-yaml"
import { parseFrontmatter } from "./frontmatter"
import { isFirstPartyQualifiedPiName, normalizePiSkillName } from "./pi-name-normalization"
import type { PiNameMaps } from "../types/pi"

export const PI_CE_SUBAGENT_TOOL = "ce_subagent"

export type PiTransformOptions = {
  preserveUnknownQualifiedRefs?: boolean
  rejectUnknownQualifiedTaskRefs?: boolean
  preserveUnresolvedFirstPartyQualifiedSkillRefs?: boolean
  rejectUnresolvedFirstPartyQualifiedRefs?: boolean
}

export function collectPiSameRunDependencies(content: string): {
  skills: string[]
  prompts: string[]
} {
  const lines = String(content || "").split(/\r?\n/)
  const skills = new Set<string>()
  const prompts = new Set<string>()
  let activeFence: { char: "`" | "~"; length: number } | null = null
  let inIndentedCodeBlock = false
  let previousBlankLine = true
  let inBlockquote = false

  for (const line of lines) {
    const fence = readMarkdownFence(line)
    const blankLine = line.trim().length === 0

    if (activeFence) {
      if (fence && fence.closingOnly && fence.char === activeFence.char && fence.length >= activeFence.length) {
        activeFence = null
      }
      continue
    }

    if (inIndentedCodeBlock) {
      if (blankLine) {
        previousBlankLine = true
        continue
      }

      if (isIndentedCodeBlockLine(line)) {
        previousBlankLine = false
        continue
      }

      inIndentedCodeBlock = false
    }

    if (fence) {
      activeFence = fence
      previousBlankLine = false
      continue
    }

    if (inBlockquote) {
      if (blankLine) {
        inBlockquote = false
        previousBlankLine = true
        continue
      }

      if (/^\s*>/.test(line) || !isMarkdownBlockStarter(line)) {
        previousBlankLine = false
        continue
      }

      inBlockquote = false
    }

    if (/^\s*>/.test(line)) {
      inBlockquote = true
      previousBlankLine = false
      continue
    }

    if (previousBlankLine && isIndentedCodeBlockLine(line) && !isIndentedTaskBulletLine(line)) {
      inIndentedCodeBlock = true
      previousBlankLine = false
      continue
    }

    collectPiMarkdownLineDependencies(line, skills, prompts)
    previousBlankLine = blankLine
  }

  return {
    skills: [...skills].sort(),
    prompts: [...prompts].sort(),
  }
}

export function transformPiBodyContent(body: string, nameMaps?: PiNameMaps, options?: PiTransformOptions): string {
  const lineBreak = body.includes("\r\n") ? "\r\n" : "\n"
  const lines = body.split(/\r?\n/)
  const transformed: string[] = []
  let activeFence: { char: "`" | "~"; length: number } | null = null
  let inIndentedCodeBlock = false
  let previousBlankLine = true
  let inBlockquote = false

  for (const line of lines) {
    const fence = readMarkdownFence(line)
    const blankLine = line.trim().length === 0

    if (activeFence) {
      transformed.push(line)
      if (fence && fence.closingOnly && fence.char === activeFence.char && fence.length >= activeFence.length) {
        activeFence = null
      }
      continue
    }

    if (inIndentedCodeBlock) {
      if (blankLine) {
        transformed.push(line)
        previousBlankLine = true
        continue
      }

      if (isIndentedCodeBlockLine(line)) {
        transformed.push(line)
        previousBlankLine = false
        continue
      }

      inIndentedCodeBlock = false
    }

    if (fence) {
      activeFence = fence
      transformed.push(line)
      previousBlankLine = false
      continue
    }

    if (inBlockquote) {
      if (blankLine) {
        inBlockquote = false
        transformed.push(line)
        previousBlankLine = true
        continue
      }

      if (/^\s*>/.test(line) || !isMarkdownBlockStarter(line)) {
        transformed.push(line)
        previousBlankLine = false
        continue
      }

      inBlockquote = false
    }

    if (/^\s*>/.test(line)) {
      inBlockquote = true
      transformed.push(line)
      previousBlankLine = false
      continue
    }

    if (previousBlankLine && isIndentedCodeBlockLine(line) && !isIndentedTaskBulletLine(line)) {
      inIndentedCodeBlock = true
      transformed.push(line)
      previousBlankLine = false
      continue
    }

    transformed.push(transformPiMarkdownLine(line, nameMaps, options))
    previousBlankLine = blankLine
  }

  return transformed.join(lineBreak)
}

export function renderPiSkillContent(
  raw: string,
  targetName: string,
  nameMaps?: PiNameMaps,
  sourceLabel?: string,
  options?: PiTransformOptions,
): string {
  try {
    const parsed = parseFrontmatter(raw)
    if (Object.keys(parsed.data).length === 0 && parsed.body === raw) {
      return transformPiBodyContent(raw, nameMaps, options)
    }

    return formatPiFrontmatter(
      { ...parsed.data, name: targetName },
      transformPiBodyContent(parsed.body, nameMaps, options),
    )
  } catch (error) {
    console.warn(`Pi sync: failed to parse frontmatter in ${sourceLabel ?? "<inline content>"}:`, (error as Error).message)
    const split = splitRawAtFrontmatterEnd(raw)
    const body = split ? split.body : raw
    const rewrittenBody = transformPiBodyContent(body, nameMaps, options)
    return formatPiFrontmatter({ name: targetName }, rewrittenBody)
  }
}

export { appendCompatibilityNoteIfNeeded }

const PI_MCPORTER_SENTINEL = "<!-- PI_MCPORTER_NOTE -->"

function appendCompatibilityNoteIfNeeded(body: string): string {
  if (!/\bmcp\b/i.test(body)) return body
  if (body.includes(PI_MCPORTER_SENTINEL)) return body

  const note = [
    "",
    PI_MCPORTER_SENTINEL,
    "## Pi + MCPorter note",
    "For MCP access in Pi, use MCPorter via the generated tools:",
    "- `mcporter_list` to inspect available MCP tools",
    "- `mcporter_call` to invoke a tool",
    "",
  ].join("\n")

  return body + note
}

export function collectPiMarkdownLineDependencies(line: string, skills: Set<string>, prompts: Set<string>): void {
  const literals: string[] = []
  const protectedLine = line.replace(/(`+)([^`]*?)\1/g, (match) => {
    const index = literals.push(match) - 1
    return `@@PI_LITERAL_${index}@@`
  })

  const taskPattern = /^(\s*(?:(?:[-*])\s+|\d+\.\s+)?)Task\s+([a-z][a-z0-9:_-]*)\(([^)]*)\)/
  const taskMatch = protectedLine.match(taskPattern)
  if (taskMatch?.[2]) {
    const skillDependency = extractPiSameRunSkillDependency(taskMatch[2])
    if (skillDependency) skills.add(skillDependency)
  }

  for (const match of protectedLine.matchAll(/\bRun (?:subagent|ce_subagent) with agent=["']([^"']+)["']/g)) {
    const skillDependency = extractPiSameRunSkillDependency(match[1] ?? "")
    if (skillDependency) skills.add(skillDependency)
  }

  const slashCommandPattern = /(?<![:\/\w])\/([a-z][a-z0-9_:-]*?)(?=[\s,."')\]}`]|$)/gi
  for (const match of protectedLine.matchAll(slashCommandPattern)) {
    const commandName = match[1]
    if (!commandName || commandName.includes("/")) continue
    if (["dev", "tmp", "etc", "usr", "var", "bin", "home"].includes(commandName)) continue

    if (commandName.startsWith("skill:")) {
      const skillDependency = extractPiSameRunSkillDependency(commandName.slice("skill:".length))
      if (skillDependency) skills.add(skillDependency)
      continue
    }

    if (commandName.startsWith("prompt:")) {
      const promptDependency = extractPiSameRunPromptDependency(commandName.slice("prompt:".length))
      if (promptDependency) prompts.add(promptDependency)
      continue
    }

    if (commandName.startsWith("prompts:")) {
      const promptDependency = extractPiSameRunPromptDependency(commandName.slice("prompts:".length))
      if (promptDependency) prompts.add(promptDependency)
    }
  }
}

export function normalizePiTaskAgentName(value: string, nameMaps?: PiNameMaps, options?: PiTransformOptions): string {
  const trimmed = value.trim()
  if (options?.rejectUnresolvedFirstPartyQualifiedRefs && trimmed.startsWith("claude-home:")) {
    const leafName = trimmed.split(":").filter(Boolean).pop() ?? trimmed
    const hasMappedTarget = Boolean(
      nameMaps?.agents?.[trimmed]
      || nameMaps?.skills?.[trimmed]
      || nameMaps?.agents?.[leafName]
      || nameMaps?.skills?.[leafName],
    )

    if (!hasMappedTarget) {
      throw new Error(`Unsupported unresolved first-party qualified ref for Pi sync: ${trimmed}`)
    }
  }

  return resolvePiMappedName(value, {
    primary: nameMaps?.agents,
    secondary: nameMaps?.skills,
    fallback: "leaf",
    preserveUnknownQualifiedRefs: options?.preserveUnknownQualifiedRefs,
    unresolvedFirstPartyQualifiedPolicy: options?.rejectUnresolvedFirstPartyQualifiedRefs ? "reject" : undefined,
  })
}

export function normalizePiSkillReferenceName(value: string, nameMaps?: PiNameMaps, options?: PiTransformOptions): string {
  return resolvePiMappedName(value, {
    primary: nameMaps?.skills,
    secondary: nameMaps?.agents,
    fallback: "full",
    preserveUnknownQualifiedRefs: options?.preserveUnknownQualifiedRefs,
    unresolvedFirstPartyQualifiedPolicy: options?.preserveUnresolvedFirstPartyQualifiedSkillRefs === false ? "reject" : "preserve",
  })
}

export function normalizePiPromptReferenceName(value: string, nameMaps?: PiNameMaps, options?: PiTransformOptions): string {
  const trimmed = value.trim()
  const isFirstPartyQualified = isFirstPartyQualifiedPiName(trimmed)
  const leafName = trimmed.split(":").filter(Boolean).pop() ?? trimmed
  if (isFirstPartyQualified && options?.rejectUnresolvedFirstPartyQualifiedRefs) {
    if (!nameMaps?.prompts?.[trimmed] && !nameMaps?.prompts?.[leafName]) {
      throw new Error(`Unsupported unresolved first-party qualified ref for Pi sync: ${trimmed}`)
    }
  }

  return resolvePiMappedName(value, {
    primary: nameMaps?.prompts,
    fallback: "full",
    preserveUnknownQualifiedRefs: options?.preserveUnknownQualifiedRefs,
    unresolvedFirstPartyQualifiedPolicy: options?.rejectUnresolvedFirstPartyQualifiedRefs ? "reject" : undefined,
  })
}

export function resolvePiMappedName(
  value: string,
  options: {
    primary?: Record<string, string>
    secondary?: Record<string, string>
    fallback: "full" | "leaf"
    preserveUnknownQualifiedRefs?: boolean
    unresolvedFirstPartyQualifiedPolicy?: "preserve" | "reject"
  },
): string {
  const trimmed = value.trim()
  const leafName = trimmed.split(":").filter(Boolean).pop() ?? trimmed
  const isQualified = trimmed.includes(":")
  const rootNamespace = trimmed.split(":").filter(Boolean)[0] ?? ""

  const exactPrimary = options.primary?.[trimmed]
  if (exactPrimary) return exactPrimary

  const exactSecondary = options.secondary?.[trimmed]
  if (exactSecondary) return exactSecondary

  if (
    options.preserveUnknownQualifiedRefs
    && isQualified
    && !["compound-engineering", "claude-home"].includes(rootNamespace)
  ) {
    return trimmed
  }

  const leafPrimary = options.primary?.[leafName]
  const isFirstPartyQualified = isQualified && ["compound-engineering", "claude-home"].includes(rootNamespace)
  if (isFirstPartyQualified && leafPrimary && options.unresolvedFirstPartyQualifiedPolicy === "preserve") {
    return trimmed
  }
  if (isFirstPartyQualified && leafPrimary && options.unresolvedFirstPartyQualifiedPolicy === "reject") {
    throw new Error(`Unsupported unresolved first-party qualified ref for Pi sync: ${trimmed}`)
  }
  if (leafPrimary) return leafPrimary

  const leafSecondary = options.secondary?.[leafName]
  if (isFirstPartyQualified && leafSecondary && options.unresolvedFirstPartyQualifiedPolicy === "preserve") {
    return trimmed
  }
  if (isFirstPartyQualified && leafSecondary && options.unresolvedFirstPartyQualifiedPolicy === "reject") {
    throw new Error(`Unsupported unresolved first-party qualified ref for Pi sync: ${trimmed}`)
  }
  if (leafSecondary) return leafSecondary

  if (isFirstPartyQualified && rootNamespace === "claude-home" && options.unresolvedFirstPartyQualifiedPolicy === "preserve") {
    return trimmed
  }

  return options.fallback === "full"
    ? normalizePiSkillName(trimmed)
    : normalizePiSkillName(leafName)
}

function transformPiMarkdownLine(line: string, nameMaps?: PiNameMaps, options?: PiTransformOptions): string {
  const literals: string[] = []
  const protectedLine = line.replace(/(`+)([^`]*?)\1/g, (match) => {
    const index = literals.push(match) - 1
    return `@@PI_LITERAL_${index}@@`
  })

  const taskPattern = /^(\s*(?:(?:[-*])\s+|\d+\.\s+)?)Task\s+([a-z][a-z0-9:_-]*)\(([^)]*)\)/
  let result = protectedLine.replace(taskPattern, (_match, prefix: string, agentName: string, args: string) => {
    const normalizedAgent = normalizePiTaskAgentName(agentName, nameMaps, options)
    if (normalizedAgent === agentName && normalizedAgent.includes(":") && options?.preserveUnknownQualifiedRefs) {
      if (options.rejectUnknownQualifiedTaskRefs) {
        throw new Error(`Unsupported foreign qualified Task ref for Pi sync: ${agentName}`)
      }
      return _match
    }
    const trimmedArgs = args.trim().replace(/\s+/g, " ").replace(/^["']|["']$/g, "")
    return trimmedArgs
      ? `${prefix}Run ${PI_CE_SUBAGENT_TOOL} with agent="${normalizedAgent}" and task="${trimmedArgs}".`
      : `${prefix}Run ${PI_CE_SUBAGENT_TOOL} with agent="${normalizedAgent}".`
  })

  result = result.replace(/\bRun (?:subagent|ce_subagent) with agent=["']([^"']+)["']/g, (_match, agentName: string) => {
    const normalizedAgent = normalizePiTaskAgentName(agentName, nameMaps, options)
    return `Run ${PI_CE_SUBAGENT_TOOL} with agent="${normalizedAgent}"`
  })
  result = result.replace(/\bAskUserQuestion\b/g, "ask_user_question")
  result = result.replace(/\bTodoWrite\b/g, "file-based todos (todos/ + /skill:todo-create)")
  result = result.replace(/\bTodoRead\b/g, "file-based todos (todos/ + /skill:todo-create)")

  const slashCommandPattern = /(?<![:\/\w])\/([a-z][a-z0-9_:-]*?)(?=[\s,."')\]}`]|$)/gi
  result = result.replace(slashCommandPattern, (match, commandName: string) => {
    if (commandName.includes("/")) return match
    if (["dev", "tmp", "etc", "usr", "var", "bin", "home"].includes(commandName)) {
      return match
    }

    if (commandName.startsWith("skill:")) {
      const skillName = commandName.slice("skill:".length)
      return `/skill:${normalizePiSkillReferenceName(skillName, nameMaps, options)}`
    }

    if (commandName.startsWith("prompt:") || commandName.startsWith("prompts:")) {
      const isPluralPromptRef = commandName.startsWith("prompts:")
      const promptName = isPluralPromptRef
        ? commandName.slice("prompts:".length)
        : commandName.slice("prompt:".length)
      const normalizedPrompt = normalizePiPromptReferenceName(promptName, nameMaps, options)
      if (normalizedPrompt === promptName && normalizedPrompt.includes(":")) {
        return match
      }
      return isPluralPromptRef ? `/${normalizedPrompt}` : `/prompt:${normalizedPrompt}`
    }

    return `/${nameMaps?.prompts?.[commandName] ?? normalizePiSkillName(commandName)}`
  })

  return result.replace(/@@PI_LITERAL_(\d+)@@/g, (_match, index: string) => literals[Number(index)] ?? _match)
}

function extractPiSameRunSkillDependency(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("claude-home:")) return trimmed.slice("claude-home:".length)
  const segments = trimmed.split(":").filter(Boolean)
  if (!trimmed.includes(":")) return trimmed
  if (isFirstPartyQualifiedPiName(trimmed)) return null
  return segments.length <= 2 ? trimmed : null
}

function extractPiSameRunPromptDependency(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("claude-home:")) return trimmed.slice("claude-home:".length)
  const segments = trimmed.split(":").filter(Boolean)
  if (!trimmed.includes(":")) return trimmed
  if (isFirstPartyQualifiedPiName(trimmed)) return null
  return segments.length <= 2 ? trimmed : null
}

export function formatPiFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = dump(data, { lineWidth: -1, noRefs: true }).trimEnd()
  if (yaml.length === 0) {
    return body
  }

  return ["---", yaml, "---", "", body].join("\n")
}

export function splitRawAtFrontmatterEnd(raw: string): { frontmatter: string; body: string } | null {
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return {
        frontmatter: lines.slice(0, i + 1).join("\n") + "\n",
        body: lines.slice(i + 1).join("\n"),
      }
    }
  }
  return null
}

function readMarkdownFence(line: string): { char: "`" | "~"; length: number; closingOnly: boolean } | null {
  const trimmed = line.trimStart()
  const match = trimmed.match(/^(`{3,}|~{3,})/)
  if (!match) return null
  const rest = trimmed.slice(match[1].length)
  return {
    char: match[1][0] as "`" | "~",
    length: match[1].length,
    closingOnly: rest.trim().length === 0,
  }
}

function isIndentedCodeBlockLine(line: string): boolean {
  return /^(?: {4}|\t)/.test(line)
}

function isIndentedTaskBulletLine(line: string): boolean {
  return /^\s+(?:[-*]\s+|\d+\.\s+)Task\s+[a-z][a-z0-9:_-]*\(/.test(line)
}

function isMarkdownBlockStarter(line: string): boolean {
  const trimmed = line.trimStart()
  if (trimmed.length === 0) return false
  return /^(?:[-*+]\s+|\d+\.\s+|#{1,6}\s|```|~~~|>)/.test(trimmed)
}

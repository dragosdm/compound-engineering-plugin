import path from "path"
import os from "os"
import type { ClaudeHomeConfig } from "../parsers/claude-home"
import type { ClaudeMcpServer } from "../types/claude"
import { promises as fs } from "fs"
import { ensureDir, ensureManagedDir, pathExists, readJson, readText, removeFileIfExists, removeManagedPathIfExists, sanitizePathName, writeTextIfChanged } from "../utils/files"
import { PiRollbackContext } from "../utils/pi-rollback"
import { buildPiSameRunQualifiedNameMap, normalizePiSkillName, uniquePiSkillName, type PiNameMaps } from "../utils/pi-skills"
import { PI_COMPAT_EXTENSION_SOURCE } from "../templates/pi/compat-extension"
import type { PiManagedArtifact, PiSyncHooks } from "../types/pi"
import { buildPiAgentsBlock, ensurePiAgentsBlock, upsertBlock } from "../targets/pi"
import { syncPiCommands, type PiSyncArtifactStatus, type SyncPiCommandResult } from "./commands"
import { mergeJsonConfigAtKey } from "./json-config"
import { collectSyncablePiSkills, syncPiSkills, type SyncPiSkillResult } from "./pi-skills"
import {
  canUseTrustedNameMaps,
  canUseVerifiedCleanup,
  collectLegacyArtifactCandidates,
  createManagedArtifact,
  createPiManagedSection,
  filterPiManagedStateForVerifiedSections,
  getPiManagedTrustInfo,
  getReservedPiTargetNames,
  mergePiNameMaps,
  removeLegacyArtifactCandidates,
  removeStaleManagedArtifacts,
  resolveManagedArtifactPath,
  replacePiManagedSection,
  writePiManagedState,
} from "../utils/pi-managed"
import { resolvePiLayout } from "../utils/pi-layout"
import { getPiPolicyFingerprint } from "../utils/pi-policy"
import { derivePiSharedResourceContract } from "../utils/pi-trust-contract"

const PI_COMPAT_EXTENSION_NAME = "compound-engineering-compat.ts"

type McporterServer = {
  baseUrl?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

type McporterConfig = {
  mcpServers: Record<string, McporterServer>
}

type LegacySyncBootstrap = {
  preserveCompatExtension: boolean
  warnings: string[]
}

type ExistingJsonState = "missing" | "valid" | "invalid"

type GlobalFallbackPolicy = {
  install: boolean
  sync: boolean
}

function resolveUserHome(): string {
  return process.env.HOME || os.homedir()
}

export async function syncToPi(
  config: ClaudeHomeConfig,
  outputRoot: string,
  hooks?: PiSyncHooks,
): Promise<void> {
  const policyFingerprint = getPiPolicyFingerprint(hooks?.policyFingerprintOverride)
  const layout = resolvePiLayout(outputRoot, "sync")
  const trustInfo = await getPiManagedTrustInfo(layout, hooks?.policyFingerprintOverride)
  const previousState = trustInfo.state
  const syncCleanupVerified = canUseVerifiedCleanup(trustInfo, "sync")
  const trustedLocalInstallNameMaps = await loadTrustedLocalInstallNameMaps(outputRoot, trustInfo, hooks?.policyFingerprintOverride)
  const fallbackPolicy = await resolveGlobalFallbackPolicy(outputRoot, hooks?.policyFingerprintOverride)
  const trustedGlobalInstallNameMaps = fallbackPolicy.install ? await loadTrustedGlobalInstallNameMaps(layout.root, hooks?.policyFingerprintOverride) : undefined
  const trustedGlobalSyncNameMaps = fallbackPolicy.sync ? await loadTrustedGlobalSyncNameMaps(layout.root, hooks?.policyFingerprintOverride) : undefined
  const reservedNames = getReservedPiTargetNames(previousState ? {
    ...previousState,
    install: canUseTrustedNameMaps(trustInfo, "install") ? previousState.install : createPiManagedSection(),
    sync: createPiManagedSection(),
    nameMaps: canUseTrustedNameMaps(trustInfo, "install")
      ? previousState.install.nameMaps
      : createPiManagedSection().nameMaps,
  } : null)

  const commands = [...(config.commands ?? [])]
    .filter((command) => !command.disableModelInvocation)
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const syncableSkills = await collectSyncablePiSkills(config.skills)
  const promptNames = new Set<string>(reservedNames.prompts)
  const promptMap: Record<string, string> = {}
  const skillNames = new Set<string>(reservedNames.skills)
  const localSkillMap: Record<string, string> = {}
  reservePiManagedNames(promptNames, trustedLocalInstallNameMaps?.prompts)
  reservePiManagedNames(promptNames, trustedGlobalInstallNameMaps?.prompts)
  reservePiManagedNames(promptNames, trustedGlobalSyncNameMaps?.prompts)
  reservePiManagedNames(skillNames, trustedLocalInstallNameMaps?.skills)
  reservePiManagedNames(skillNames, trustedLocalInstallNameMaps?.agents)
  reservePiManagedNames(skillNames, trustedGlobalInstallNameMaps?.skills)
  reservePiManagedNames(skillNames, trustedGlobalInstallNameMaps?.agents)
  reservePiManagedNames(skillNames, trustedGlobalSyncNameMaps?.skills)
  reservePiManagedNames(skillNames, trustedGlobalSyncNameMaps?.agents)
  const previousPromptMap = canUseTrustedNameMaps(trustInfo, "sync")
    ? previousState?.sync.nameMaps.prompts ?? {}
    : {}
  const previousSkillMap = canUseTrustedNameMaps(trustInfo, "sync")
    ? previousState?.sync.nameMaps.skills ?? {}
    : {}
  for (const command of commands) {
    const targetName = reservePreviousOrUniqueName(command.name, previousPromptMap, promptNames)
    promptMap[command.name] = targetName
    promptMap[`claude-home:${command.name}`] = targetName
  }

  const syncSkillMap: Record<string, string> = {}
  for (const skill of syncableSkills) {
    const targetName = reservePreviousOrUniqueName(skill.name, previousSkillMap, skillNames)
    localSkillMap[skill.name] = targetName
    localSkillMap[`claude-home:${skill.name}`] = targetName
    syncSkillMap[skill.name] = targetName
  }

  const trustedInstallLayers = mergePiNameMaps(trustedGlobalInstallNameMaps, trustedLocalInstallNameMaps)
  const trustedBaseNameMaps = mergePiNameMaps(trustedInstallLayers, filterQualifiedPiNameMaps(trustedGlobalSyncNameMaps))

  await ensureManagedDir(layout.root)
  const ancestorCache = new Map<string, true>()
  const rollback = new PiRollbackContext({ ancestorCache })

  const aggregatedSkillResults = new Map<string, SyncPiSkillResult>()
  const aggregatedPromptResults = new Map<string, SyncPiCommandResult>()
  const currentRunArtifacts = new Map<string, PiManagedArtifact>()
  const finalWarnings = new Map<string, string>()
  try {
    let activeCommands = commands
    let activeSkills = syncableSkills
    let activePromptMap = promptMap
    let activeSkillMap = syncSkillMap
    let passNumber = 0
    const maxPasses = (syncableSkills.length) + (commands.length) + 2

    while (true) {
      passNumber += 1
      if (passNumber > maxPasses) {
        throw new Error(`Pi sync convergence did not stabilize after ${passNumber - 1} passes — possible circular dependency among: ${activeSkills.map((s) => s.name).concat(activeCommands.map((c) => c.name)).join(", ")}`)
      }
      await hooks?.onPass?.({
        passNumber,
        activeCommandNames: activeCommands.map((command) => command.name),
        activeSkillNames: activeSkills.map((skill) => skill.name),
      })
      const sameRunSkillMap = {
        ...activeSkillMap,
        ...buildPiSameRunQualifiedNameMap(activeSkillMap),
      }
      const commandNameMaps = mergePiNameMaps(trustedBaseNameMaps, { skills: sameRunSkillMap, prompts: activePromptMap })
      const skillNameMaps = mergePiNameMaps(trustedBaseNameMaps, { prompts: activePromptMap, skills: sameRunSkillMap })

      const skillResults = await syncPiSkills(activeSkills, layout.skillsDir, activeSkillMap, skillNameMaps, {
        onBeforeMutate: async (_skillName, targetPath, mode) => {
          await rollback.capture(targetPath)
        },
      }, ancestorCache, hooks)
      const promptResults = await syncPiCommands(
        { ...config, commands: activeCommands },
        outputRoot,
        commandNameMaps,
        {
          onBeforeMutate: async (targetPath) => {
            await rollback.capture(targetPath)
          },
        },
        hooks,
      )

      for (const artifact of promptResults.filter(isPublishedPromptResult).map((result) => result.artifact)) {
        currentRunArtifacts.set(`${artifact.kind}:${artifact.relativePath}`, artifact)
      }
      for (const skill of skillResults.filter(isPublishedSkillResult)) {
        const artifact = createManagedArtifact(layout, "synced-skill", skill.sourceName, skill.emittedName)
        currentRunArtifacts.set(`${artifact.kind}:${artifact.relativePath}`, artifact)
      }

      const stableResults = stabilizeSameRunQualifiedDependencies(skillResults, promptResults, activeSkillMap, activePromptMap)
      const stableSkillResults = stableResults.skills
      const stablePromptResults = stableResults.prompts

      for (const result of stableSkillResults) {
        aggregatedSkillResults.set(result.sourceName, result)
      }
      for (const result of stablePromptResults) {
        aggregatedPromptResults.set(result.sourceName, result)
      }

      const publishedSkills = stableSkillResults.filter(isPublishedSkillResult)
      const publishedPrompts = stablePromptResults.filter(isPublishedPromptResult).map((result) => result.artifact)
      const materializedSkillArtifacts = publishedSkills.map((skill) =>
        createManagedArtifact(layout, "synced-skill", skill.sourceName, skill.emittedName))
      for (const artifact of [...publishedPrompts, ...materializedSkillArtifacts]) {
        currentRunArtifacts.set(`${artifact.kind}:${artifact.relativePath}`, artifact)
      }

      const aggregatePublishedPromptMap = filterPublishedPromptMap(
        activePromptMap,
        [...aggregatedPromptResults.values()].filter(isPublishedPromptResult).map((result) => result.artifact),
      )
      const aggregatePublishedSkillMap = filterPublishedSkillMap(
        activeSkillMap,
        [...aggregatedSkillResults.values()].filter(isPublishedSkillResult),
      )

      const retryablePromptNames = new Set(stablePromptResults.filter((result) => result.status === "retryable").map((result) => result.sourceName))
      const retryableSkillNames = new Set(stableSkillResults.filter((result) => result.status === "retryable").map((result) => result.sourceName))
      const nextActivePromptMap = filterActivePromptMap(activePromptMap, aggregatePublishedPromptMap, retryablePromptNames)
      const nextActiveSkillMap = filterActiveSkillMap(activeSkillMap, aggregatePublishedSkillMap, retryableSkillNames)

      for (const result of [...stablePromptResults, ...stableSkillResults]) {
        const key = `${result.sourceName}:${result.emittedName}`
        if (result.status === "published") {
          finalWarnings.delete(key)
        } else if (result.warning) {
          finalWarnings.set(key, result.warning)
        }
      }

      if (samePiNameMapEntries(activePromptMap, nextActivePromptMap) && samePiNameMapEntries(activeSkillMap, nextActiveSkillMap)) {
        break
      }

      activePromptMap = nextActivePromptMap
      activeSkillMap = nextActiveSkillMap
      if ((hooks?.rerunMode ?? "narrow") === "full") {
        activeCommands = activeCommands.filter((command) => Boolean(activePromptMap[command.name]))
        activeSkills = activeSkills.filter((skill) => Boolean(activeSkillMap[skill.name]))
        continue
      }

      activeCommands = commands.filter((command) => retryablePromptNames.has(command.name) && Boolean(activePromptMap[command.name]))
      activeSkills = syncableSkills.filter((skill) => retryableSkillNames.has(skill.name) && Boolean(activeSkillMap[skill.name]))
    }
  } catch (error) {
    await rollback.restore()
    throw error
  }
  const skillResults = [...aggregatedSkillResults.values()]
  const promptResults = [...aggregatedPromptResults.values()]
  const publishedSkills = skillResults.filter(isPublishedSkillResult)
  const prompts = promptResults.filter(isPublishedPromptResult).map((result) => result.artifact)
  const materializedSkillNames = new Set(publishedSkills.map((skill) => skill.sourceName))

  const nextSyncArtifacts = [
    ...publishedSkills.map((skill) => createManagedArtifact(layout, "synced-skill", skill.sourceName, skill.emittedName)),
    ...prompts,
  ]
  const verifiedPreviousSyncArtifacts = syncCleanupVerified ? previousState?.sync.artifacts ?? [] : []
  const legacySyncCandidates = [
    ...collectLegacyArtifactCandidates(layout, nextSyncArtifacts),
    ...await collectLegacySkillDirectoryCandidates(layout, nextSyncArtifacts, verifiedPreviousSyncArtifacts),
  ]
  const verifiedInstallKeepsCompat = Boolean(canUseVerifiedCleanup(trustInfo, "install") && previousState?.install.sharedResources.compatExtension === true)
  const verifiedSections = {
    install: canUseVerifiedCleanup(trustInfo, "install"),
    sync: syncCleanupVerified,
  }
  const installKeepsCompat = verifiedInstallKeepsCompat
  const incomingSyncMcpServers = Object.keys(config.mcpServers)
  const convertedSyncMcpServers = convertMcpToMcporter(config.mcpServers)
  const emittedSyncMcpServerNames = Object.keys(convertedSyncMcpServers.mcpServers).sort()
  const preserveUnverifiedMalformedMcporter = incomingSyncMcpServers.length > 0
    && !syncCleanupVerified
    && await inspectJsonObjectState(layout.mcporterConfigPath) === "invalid"
  const legacyBootstrap = await deriveLegacySyncBootstrap({
    layout,
    trustInfo,
    installArtifacts: canUseVerifiedCleanup(trustInfo, "install") ? previousState?.install.artifacts ?? [] : [],
    ignoredLegacyPaths: new Set(legacySyncCandidates.map((candidate) => path.resolve(candidate.path))),
    nextSyncArtifacts,
    nextSyncMcpServers: incomingSyncMcpServers,
    nextNeedsCompatExtension: needsPiCompatExtension(config),
    installKeepsCompat,
  })
  const publishedPromptMap = filterPublishedPromptMap(promptMap, prompts)
  const publishedSkillMap = filterPublishedSkillMap(localSkillMap, publishedSkills)

  const nextState = replacePiManagedSection(previousState, "sync", createPiManagedSection({
    nameMaps: {
      skills: publishedSkillMap,
      prompts: publishedPromptMap,
    },
    artifacts: nextSyncArtifacts,
    mcpServers: preserveUnverifiedMalformedMcporter ? [] : emittedSyncMcpServerNames,
    sharedResources: {
      compatExtension: materializedSkillNames.size > 0 || prompts.length > 0 || emittedSyncMcpServerNames.length > 0,
      mcporterConfig: preserveUnverifiedMalformedMcporter ? false : emittedSyncMcpServerNames.length > 0,
    },
  }), previousState?.pluginName)
  nextState.policyFingerprint = policyFingerprint
  const nextCompatContract = derivePiSharedResourceContract({
    nextOwns: nextState.sync.sharedResources.compatExtension,
    otherVerifiedOwner: verifiedInstallKeepsCompat,
    preserveUntrusted: legacyBootstrap.preserveCompatExtension,
  })
  const removeTrackedFileIfExists = async (filePath: string): Promise<void> => {
    await rollback.capture(filePath)
    await removeFileIfExists(filePath)
  }
  const removeTrackedSkillDirectoryIfExists = async (dirPath: string): Promise<void> => {
    await rollback.capture(dirPath)
    await removePiManagedSkillDirectory(dirPath)
  }

  const retainedArtifactPaths = new Set<string>()
  for (const artifact of nextSyncArtifacts) {
    const artifactPath = resolveManagedArtifactPath(layout, artifact)
    if (artifactPath) retainedArtifactPaths.add(path.resolve(artifactPath))
  }

  const staleCurrentRunArtifacts = [...currentRunArtifacts.values()].filter((artifact) => {
    const artifactPath = resolveManagedArtifactPath(layout, artifact)
    return artifactPath ? !retainedArtifactPaths.has(path.resolve(artifactPath)) : false
  })

  for (const warning of legacyBootstrap.warnings) {
    console.warn(warning)
  }
  for (const warning of finalWarnings.values()) {
    console.warn(warning)
  }

  try {
    for (const artifact of staleCurrentRunArtifacts) {
      const artifactPath = resolveManagedArtifactPath(layout, artifact)
      if (!artifactPath) continue
      if (artifact.kind === "prompt") {
        await removeTrackedFileIfExists(artifactPath)
      } else {
        await removeTrackedSkillDirectoryIfExists(artifactPath)
      }
    }

    if (nextCompatContract.retain) {
      await ensureManagedDir(layout.extensionsDir)
      const compatPath = path.join(layout.extensionsDir, PI_COMPAT_EXTENSION_NAME)
      if (nextCompatContract.state === "active") {
        const existingCompat = await readText(compatPath).catch(() => null)
        const nextCompat = PI_COMPAT_EXTENSION_SOURCE + "\n"
        try {
          if (existingCompat !== nextCompat) {
            await rollback.capture(compatPath)
          }
          await writeTextIfChanged(compatPath, nextCompat, { existingContent: existingCompat })
        } catch (error) {
          throw error
        }
      }
    } else {
      await rollback.capture(path.join(layout.extensionsDir, PI_COMPAT_EXTENSION_NAME))
      await removeFileIfExists(path.join(layout.extensionsDir, PI_COMPAT_EXTENSION_NAME))
    }

    const agentsBefore = await readText(layout.agentsPath).catch(() => null)
    const shouldAdvertiseCompatTools = nextCompatContract.advertise
    const agentsBlock = buildPiAgentsBlock(shouldAdvertiseCompatTools)
    const nextAgents = agentsBefore === null ? agentsBlock + "\n" : upsertBlock(agentsBefore, agentsBlock)
    if (nextAgents !== agentsBefore) {
      await rollback.capture(layout.agentsPath)
    }
    await ensurePiAgentsBlock(layout.agentsPath, shouldAdvertiseCompatTools)

    if (incomingSyncMcpServers.length > 0) {
      await ensureManagedDir(path.dirname(layout.mcporterConfigPath))
      if (preserveUnverifiedMalformedMcporter) {
        console.warn(`Warning: found malformed legacy mcporter.json at ${layout.mcporterConfigPath}; leaving it untouched because sync ownership cannot be proven.`)
      } else {
        await rollback.capture(layout.mcporterConfigPath)
        await mergeJsonConfigAtKey({
          configPath: layout.mcporterConfigPath,
          key: "mcpServers",
          incoming: convertedSyncMcpServers.mcpServers,
          replaceKeys: syncCleanupVerified ? previousState?.sync.mcpServers ?? [] : [],
          snapshotOnWrite: false,
        })
      }
    } else if (syncCleanupVerified && (previousState?.sync.mcpServers.length ?? 0) > 0) {
      await rollback.capture(layout.mcporterConfigPath)
      const result = await mergeJsonConfigAtKey({
        configPath: layout.mcporterConfigPath,
        key: "mcpServers",
        incoming: {},
        replaceKeys: previousState?.sync.mcpServers ?? [],
        snapshotOnWrite: false,
      })

      if (result.didWrite && result.isEmpty) {
        await removeFileIfExists(layout.mcporterConfigPath)
      }
    }

    await removeStaleManagedArtifacts(
      layout,
      filterPiManagedStateForVerifiedSections(previousState, { sync: canUseVerifiedCleanup(trustInfo, "sync") }),
      nextState,
      removeTrackedFileIfExists,
      removeTrackedSkillDirectoryIfExists,
    )
    if (syncCleanupVerified) {
      await removeLegacyArtifactCandidates(legacySyncCandidates, removeTrackedFileIfExists, removeTrackedSkillDirectoryIfExists)
    } else {
      await warnAboutUnverifiedLegacyArtifactCandidates(legacySyncCandidates)
    }

    const didWriteManagedState = await writePiManagedState(layout, nextState, {
      install: canUseVerifiedCleanup(trustInfo, "install"),
      sync: true,
    }, hooks?.policyFingerprintOverride)
  } catch (error) {
    await rollback.restore()
    throw error
  }
  await rollback.cleanup()
}

async function inspectJsonObjectState(configPath: string): Promise<ExistingJsonState> {
  if (!(await pathExists(configPath))) {
    return "missing"
  }

  try {
    const parsed = await readJson<unknown>(configPath)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return "valid"
    }
  } catch {
    return "invalid"
  }

  return "invalid"
}

function needsPiCompatExtension(config: ClaudeHomeConfig): boolean {
  return config.skills.length > 0 || (config.commands?.length ?? 0) > 0 || Object.keys(config.mcpServers).length > 0
}

async function resolveGlobalFallbackPolicy(currentRoot: string, policyFingerprintOverride?: string | null): Promise<GlobalFallbackPolicy> {
  return {
    install: await shouldAllowGlobalFallbackForSection(currentRoot, "install", policyFingerprintOverride),
    sync: await shouldAllowGlobalFallbackForSection(currentRoot, "sync", policyFingerprintOverride),
  }
}

async function shouldAllowGlobalFallbackForSection(currentRoot: string, sectionName: "install" | "sync", policyFingerprintOverride?: string | null): Promise<boolean> {
  for (const candidateRoot of walkUpPaths(path.resolve(currentRoot))) {
    const directManifestPath = path.join(candidateRoot, "compound-engineering", "compound-engineering-managed.json")
    const nestedInstallManifestPath = path.join(candidateRoot, ".pi", "compound-engineering", "compound-engineering-managed.json")

    const hasDirectManifest = await pathExists(directManifestPath)
    const hasNestedManifest = await pathExists(nestedInstallManifestPath)
    if (!hasDirectManifest && !hasNestedManifest) {
      continue
    }

    const candidates = await Promise.all([
      hasDirectManifest ? getPiManagedTrustInfo(resolvePiLayout(candidateRoot, "sync"), policyFingerprintOverride) : Promise.resolve(null),
      hasNestedManifest ? getPiManagedTrustInfo(resolvePiLayout(candidateRoot, "install"), policyFingerprintOverride) : Promise.resolve(null),
    ])

    return !candidates.some((candidate) => hasPiManagedSectionData(candidate?.state?.[sectionName]))
  }

  return true
}

function walkUpPaths(start: string): string[] {
  const paths: string[] = []
  let current = start

  while (true) {
    paths.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return paths
}

function hasPiManagedSectionData(section: Awaited<ReturnType<typeof getPiManagedTrustInfo>>["state"] extends infer T
  ? T extends { install: infer S; sync: infer S } ? S | undefined : never
  : never): boolean {
  if (!section) return false
  return Boolean(
    Object.keys(section.nameMaps?.agents ?? {}).length
    || Object.keys(section.nameMaps?.skills ?? {}).length
    || Object.keys(section.nameMaps?.prompts ?? {}).length
    || section.artifacts.length > 0
    || section.mcpServers.length > 0
    || section.sharedResources.compatExtension
    || section.sharedResources.mcporterConfig,
  )
}

function filterPublishedPromptMap(promptMap: Record<string, string>, prompts: PiManagedArtifact[]): Record<string, string> {
  const publishedPromptNames = new Set(prompts.map((prompt) => prompt.sourceName ?? prompt.emittedName))
  return Object.fromEntries(
    Object.entries(promptMap).filter(([sourceName]) => {
      if (sourceName.startsWith("claude-home:")) {
        return publishedPromptNames.has(sourceName.slice("claude-home:".length))
      }
      return publishedPromptNames.has(sourceName)
    }),
  )
}

function filterPublishedSkillMap(skillMap: Record<string, string>, materializedSkills: SyncPiSkillResult[]): Record<string, string> {
  const publishedSkillNames = new Set(materializedSkills.map((skill) => skill.sourceName))
  return Object.fromEntries(
    Object.entries(skillMap).filter(([sourceName]) => {
      if (sourceName.startsWith("claude-home:")) {
        return publishedSkillNames.has(sourceName.slice("claude-home:".length))
      }
      return publishedSkillNames.has(sourceName)
    }),
  )
}

function filterActivePromptMap(
  activePromptMap: Record<string, string>,
  publishedPromptMap: Record<string, string>,
  retryablePromptNames: Set<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(activePromptMap).filter(([sourceName, emittedName]) => {
      if (publishedPromptMap[sourceName] === emittedName) return true
      const baseSource = sourceName.startsWith("claude-home:")
        ? sourceName.slice("claude-home:".length)
        : sourceName
      return retryablePromptNames.has(baseSource)
    }),
  )
}

function filterActiveSkillMap(
  activeSkillMap: Record<string, string>,
  publishedSkillMap: Record<string, string>,
  retryableSkillNames: Set<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(activeSkillMap).filter(([sourceName, emittedName]) => {
      if (publishedSkillMap[sourceName] === emittedName) return true
      const baseSource = sourceName.startsWith("claude-home:")
        ? sourceName.slice("claude-home:".length)
        : sourceName
      return retryableSkillNames.has(baseSource)
    }),
  )
}

function isPublishedPromptResult(result: SyncPiCommandResult): result is SyncPiCommandResult & { status: "published"; artifact: PiManagedArtifact } {
  return result.status === "published" && Boolean(result.artifact)
}

function isPublishedSkillResult(result: SyncPiSkillResult): result is SyncPiSkillResult & { status: "published" } {
  return result.status === "published"
}

function stabilizeSameRunQualifiedDependencies(
  skillResults: SyncPiSkillResult[],
  promptResults: SyncPiCommandResult[],
  activeSkillMap: Record<string, string>,
  activePromptMap: Record<string, string>,
): {
  skills: SyncPiSkillResult[]
  prompts: SyncPiCommandResult[]
} {
  let stableSkills = skillResults
  let stablePrompts = promptResults
  const maxRounds = stableSkills.length + stablePrompts.length + 1
  let round = 0

  while (true) {
    round += 1
    if (round > maxRounds) {
      throw new Error(`Pi sync same-run stabilization did not converge after ${round - 1} rounds`)
    }
    const publishedSkills = new Set(stableSkills.filter((result) => result.status === "published").map((result) => result.sourceName))
    const publishedPrompts = new Set(stablePrompts.filter((result) => result.status === "published").map((result) => result.sourceName))
    const skillStatuses = new Map(stableSkills.map((result) => [result.sourceName, result.status]))
    const promptStatuses = new Map(stablePrompts.map((result) => [result.sourceName, result.status]))
    const nextSkills = demoteBlockedSameRunDependencies(stableSkills, publishedSkills, publishedPrompts, activeSkillMap, activePromptMap, skillStatuses, promptStatuses)
    const nextPrompts = demoteBlockedSameRunDependencies(stablePrompts, publishedSkills, publishedPrompts, activeSkillMap, activePromptMap, skillStatuses, promptStatuses)

    if (sameResultStatuses(stableSkills, nextSkills) && sameResultStatuses(stablePrompts, nextPrompts)) {
      return { skills: nextSkills, prompts: nextPrompts }
    }

    stableSkills = nextSkills
    stablePrompts = nextPrompts
  }
}

function demoteBlockedSameRunDependencies<T extends {
  sourceName: string
  status: PiSyncArtifactStatus
  warning?: string
  sameRunDependencies?: { skills: string[]; prompts: string[] }
}>(
  results: T[],
  publishedSkills: Set<string>,
  publishedPrompts: Set<string>,
  activeSkillMap: Record<string, string>,
  activePromptMap: Record<string, string>,
  skillStatuses: Map<string, PiSyncArtifactStatus>,
  promptStatuses: Map<string, PiSyncArtifactStatus>,
): T[] {
  return results.map((result) => {
    if (result.status !== "published") return result

    const blockedSkillStatuses = (result.sameRunDependencies?.skills ?? [])
      .filter((dependency) => Boolean(activeSkillMap[dependency]) && !publishedSkills.has(dependency))
      .map((dependency) => skillStatuses.get(dependency) ?? "retryable")
    const blockedPromptStatuses = (result.sameRunDependencies?.prompts ?? [])
      .filter((dependency) => Boolean(activePromptMap[dependency]) && !publishedPrompts.has(dependency))
      .map((dependency) => promptStatuses.get(dependency) ?? "retryable")
    const blockedStatuses = [...blockedSkillStatuses, ...blockedPromptStatuses]

    if (blockedStatuses.length === 0) {
      return result
    }

    const nextStatus = blockedStatuses.some((status) => status === "blocked-by-policy")
      ? "blocked-by-policy"
      : blockedStatuses.some((status) => status === "unsupported-final")
        ? "unsupported-final"
        : "retryable"

    return {
      ...result,
      status: nextStatus,
      warning: undefined,
    }
  })
}

function sameResultStatuses<T extends { sourceName: string; emittedName: string; status: PiSyncArtifactStatus }>(left: T[], right: T[]): boolean {
  if (left.length !== right.length) return false

  const leftStatuses = left.map((result) => `${result.sourceName}:${result.emittedName}:${result.status}`).sort()
  const rightStatuses = right.map((result) => `${result.sourceName}:${result.emittedName}:${result.status}`).sort()
  return JSON.stringify(leftStatuses) === JSON.stringify(rightStatuses)
}

async function collectLegacySkillDirectoryCandidates(
  layout: ReturnType<typeof resolvePiLayout>,
  nextSyncArtifacts: PiManagedArtifact[],
  previousSyncArtifacts: PiManagedArtifact[],
): Promise<Array<{ expectedKind: "directory"; path: string }>> {
  if (!(await pathExists(layout.skillsDir))) {
    return []
  }

  const retainedPaths = new Set<string>()
  for (const artifact of nextSyncArtifacts) {
    const artifactPath = resolveManagedArtifactPath(layout, artifact)
    if (artifactPath) retainedPaths.add(path.resolve(artifactPath))
  }

  const legacyNames = new Set<string>()
  for (const artifact of [...previousSyncArtifacts, ...nextSyncArtifacts]) {
    if (artifact.kind !== "synced-skill") continue
    legacyNames.add(artifact.emittedName)
    legacyNames.add(sanitizePathName(artifact.sourceName))
  }

  const candidates: Array<{ expectedKind: "directory"; path: string }> = []
  for (const entry of await fs.readdir(layout.skillsDir, { withFileTypes: true })) {
    if (!legacyNames.has(entry.name)) continue
    const candidatePath = path.resolve(path.join(layout.skillsDir, entry.name))
    if (retainedPaths.has(candidatePath)) continue
    candidates.push({ expectedKind: "directory", path: candidatePath })
  }

  return candidates
}

function samePiNameMapEntries(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

function filterQualifiedPiNameMaps(nameMaps?: PiNameMaps): PiNameMaps | undefined {
  if (!nameMaps) return undefined

  return {
    agents: Object.fromEntries(Object.entries(nameMaps.agents ?? {}).filter(([key]) => key.includes(":"))),
    skills: Object.fromEntries(Object.entries(nameMaps.skills ?? {}).filter(([key]) => key.includes(":"))),
    prompts: Object.fromEntries(Object.entries(nameMaps.prompts ?? {}).filter(([key]) => key.includes(":"))),
  }
}

async function loadTrustedGlobalSyncNameMaps(currentRoot: string, policyFingerprintOverride?: string | null): Promise<PiNameMaps | undefined> {
  const globalRoot = path.join(resolveUserHome(), ".pi", "agent")
  if (path.resolve(globalRoot) === path.resolve(currentRoot)) {
    return undefined
  }

  const globalTrust = await getPiManagedTrustInfo(resolvePiLayout(globalRoot, "sync"), policyFingerprintOverride)
  if (!canUseTrustedNameMaps(globalTrust, "sync")) {
    return undefined
  }

  return globalTrust.state?.sync.nameMaps
}

async function loadTrustedLocalInstallNameMaps(
  currentRoot: string,
  currentTrust: Awaited<ReturnType<typeof getPiManagedTrustInfo>>,
  policyFingerprintOverride?: string | null,
): Promise<PiNameMaps | undefined> {
  const nestedInstallLayout = resolvePiLayout(currentRoot, "install")
  if (!path.resolve(nestedInstallLayout.root).startsWith(path.resolve(currentRoot))) {
    return canUseTrustedNameMaps(currentTrust, "install") ? currentTrust.state?.install.nameMaps : undefined
  }

  const nestedTrust = await getPiManagedTrustInfo(nestedInstallLayout, policyFingerprintOverride)
  if (canUseTrustedNameMaps(nestedTrust, "install")) {
    return nestedTrust.state?.install.nameMaps
  }

  return canUseTrustedNameMaps(currentTrust, "install") ? currentTrust.state?.install.nameMaps : undefined
}

async function loadTrustedGlobalInstallNameMaps(currentRoot: string, policyFingerprintOverride?: string | null): Promise<PiNameMaps | undefined> {
  const globalRoot = path.join(resolveUserHome(), ".pi", "agent")
  if (path.resolve(globalRoot) === path.resolve(currentRoot)) {
    return undefined
  }

  const globalTrust = await getPiManagedTrustInfo(resolvePiLayout(globalRoot, "install"), policyFingerprintOverride)
  if (!canUseTrustedNameMaps(globalTrust, "install")) {
    return undefined
  }

  return globalTrust.state?.install.nameMaps
}

async function deriveLegacySyncBootstrap(options: {
  layout: ReturnType<typeof resolvePiLayout>
  trustInfo: Awaited<ReturnType<typeof getPiManagedTrustInfo>>
  installArtifacts: ReturnType<typeof createPiManagedSection>["artifacts"]
  ignoredLegacyPaths: Set<string>
  nextSyncArtifacts: ReturnType<typeof createPiManagedSection>["artifacts"]
  nextSyncMcpServers: string[]
  nextNeedsCompatExtension: boolean
  installKeepsCompat: boolean
}): Promise<LegacySyncBootstrap> {
  if (options.trustInfo.verifiedSections.sync) {
    return { preserveCompatExtension: false, warnings: [] }
  }

  const retainedPaths = new Set<string>()
  for (const artifact of [...options.installArtifacts, ...options.nextSyncArtifacts]) {
    const artifactPath = resolveManagedArtifactPath(options.layout, artifact)
    if (artifactPath) retainedPaths.add(path.resolve(artifactPath))
  }

  const warnings: string[] = []
  const compatPath = path.join(options.layout.extensionsDir, PI_COMPAT_EXTENSION_NAME)
  const compatExists = await pathExists(compatPath)
  const preserveCompatExtension = compatExists && !options.nextNeedsCompatExtension && !options.installKeepsCompat

  if (preserveCompatExtension) {
    warnings.push(`Warning: found ambiguous legacy compat extension at ${compatPath}; removing the live compat extension because sync ownership cannot be proven.`)
  }

  if (await pathExists(options.layout.promptsDir)) {
    const promptEntries = await fs.readdir(options.layout.promptsDir, { withFileTypes: true })
    for (const entry of promptEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const promptPath = path.resolve(path.join(options.layout.promptsDir, entry.name))
      if (retainedPaths.has(promptPath)) continue
      if (options.ignoredLegacyPaths.has(promptPath)) continue
      warnings.push(`Warning: found ambiguous legacy Pi sync artifact at ${promptPath}; leaving it in place because ownership cannot be proven.`)
    }
  }

  if (await pathExists(options.layout.mcporterConfigPath)) {
    try {
      const mcporter = await readJson<{ mcpServers?: Record<string, unknown> }>(options.layout.mcporterConfigPath)
      const legacyServers = Object.keys(mcporter.mcpServers ?? {})
      if (legacyServers.length > 0 && options.nextSyncMcpServers.length === 0) {
        warnings.push(`Warning: found ambiguous legacy mcporter.json at ${options.layout.mcporterConfigPath}; leaving existing MCP servers in place because ownership cannot be proven.`)
      }
    } catch {
      warnings.push(`Warning: found malformed legacy mcporter.json at ${options.layout.mcporterConfigPath}; leaving it untouched because ownership cannot be proven.`)
    }
  }

  return {
    preserveCompatExtension,
    warnings,
  }
}

async function warnAboutUnverifiedLegacyArtifactCandidates(candidates: Array<{ path: string }>): Promise<void> {
  const warned = new Set<string>()

  for (const candidate of candidates) {
    const resolvedPath = path.resolve(candidate.path)
    if (warned.has(resolvedPath)) continue
    warned.add(resolvedPath)

    try {
      await fs.lstat(resolvedPath)
      console.warn(`Warning: found ambiguous legacy Pi sync artifact at ${resolvedPath}; leaving it in place because ownership cannot be proven.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
  }
}

function reservePreviousOrUniqueName(
  sourceName: string,
  previousMap: Record<string, string>,
  usedNames: Set<string>,
): string {
  const previousName = previousMap[sourceName] ?? previousMap[`claude-home:${sourceName}`]
  if (previousName && !usedNames.has(previousName)) {
    usedNames.add(previousName)
    return previousName
  }

  return uniquePiSkillName(normalizePiSkillName(sourceName), usedNames)
}

function reservePiManagedNames(usedNames: Set<string>, nameMap?: Record<string, string>): void {
  for (const value of Object.values(nameMap ?? {})) {
    usedNames.add(value)
  }
}

function isValidMappedSkill(skillName: string, skillMap: Record<string, string>): boolean {
  return Boolean(skillMap[skillName])
}

async function removePiManagedSkillDirectory(dirPath: string): Promise<void> {
  await removeManagedPathIfExists(dirPath)
}

function convertMcpToMcporter(servers: Record<string, ClaudeMcpServer>): McporterConfig {
  const mcpServers: Record<string, McporterServer> = {}

  for (const [name, server] of Object.entries(servers)) {
    if (server.command) {
      mcpServers[name] = {
        command: server.command,
        args: server.args,
        env: server.env,
        headers: server.headers,
      }
      continue
    }

    if (server.url) {
      mcpServers[name] = {
        baseUrl: server.url,
        headers: server.headers,
      }
    }
  }

  return { mcpServers }
}

import { createHash } from "crypto"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { assertNoSymlinkAncestors, ensureManagedDir, ensureManagedParentDir, readText, writeFileAtomicIfChanged, writeTextAtomicIfChanged } from "./files"
import { renderPiSkillContent, type PiTransformOptions } from "./pi-content-transform"
import {
  copyDirForPiMaterialization,
  fileContentsMatch,
  preparePiSkillTargetForReplacement,
  removePiMaterializedPath,
  resolvePiMaterializedEntry,
  rewriteSkillFileForPi,
  validatePiSkillSourceForPi,
  cyclicPiSkillSymlinkError,
  type PiMaterializationOptions,
  type PiMaterializedEntry,
  type PiSkillMutationHooks,
} from "./pi-skill-materialization"
import { getPiPolicyFingerprint } from "./pi-policy"
import { PiRollbackContext } from "./pi-rollback"
import type { PiNameMaps, PiSyncHooks } from "../types/pi"

type PiMaterializedTreeNode =
  | {
    kind: "directory"
    children: Map<string, PiMaterializedTreeNode>
  }
  | {
    kind: "file"
    sourcePath: string
    mode: number
    renderedContent?: string
  }

type PiMaterializedTreeAnalysis = {
  tree: PiMaterializedTreeNode
  fingerprint: string
  metadataSignature: string
}

type PiMaterializedMetadataNode = {
  kind: "directory" | "file"
  name: string
  sourcePath: string
  mode?: number
  metadataSignature?: string
  children?: PiMaterializedMetadataNode[]
}

type PiMaterializedMetadataSummary = {
  metadataSignature: string
  root: PiMaterializedMetadataNode
}

type PiTargetTreeNode = {
  kind: "directory" | "file" | "symlink" | "other"
  children?: Map<string, PiTargetTreeNode>
}

type PiTargetTreeAnalysis = {
  tree: PiTargetTreeNode
  metadataSignature: string
}

type PiIncrementalOp =
  | {
    type: "createDir"
    relativePath: string
  }
  | {
    type: "writeFile"
    relativePath: string
    sourcePath?: string
    mode?: number
    renderedContent?: string
  }
  | {
    type: "remove"
    relativePath: string
    targetKind: "directory" | "file"
  }

type PiSkillFastPathRecord = {
  version: 4
  policyFingerprint: string
  renderSignature: string
  sourceMetadataSignature: string
  sourceFingerprint: string
  targetMetadataSignature: string
}

export async function copySkillDirForPi(
  sourceDir: string,
  targetDir: string,
  targetName: string,
  nameMaps?: PiNameMaps,
  options?: PiMaterializationOptions,
  transformOptions?: PiTransformOptions,
  hooks?: PiSkillMutationHooks,
  ancestorCache?: Map<string, true>,
  piSyncHooks?: PiSyncHooks,
): Promise<void> {
  await validatePiSkillSourceForPi(sourceDir, targetName, nameMaps, transformOptions)
  const planningResult = await planPiSkillDirUpdate(
    sourceDir,
    targetDir,
    targetName,
    nameMaps,
    options,
    transformOptions,
    piSyncHooks,
  )

  if (planningResult.result === "nochange") {
    await writePiSkillFastPathRecord(targetDir, planningResult.renderSignature, planningResult.sourceMetadataSignature, planningResult.sourceFingerprint, planningResult.targetMetadataSignature, piSyncHooks?.policyFingerprintOverride)
    return
  }

  if (planningResult.result === "apply") {
    await hooks?.onBeforeMutate?.("incremental")
    await applyPiIncrementalOps(targetDir, planningResult.ops, ancestorCache)
    await writePiSkillFastPathRecord(
      targetDir,
      planningResult.renderSignature,
      planningResult.sourceMetadataSignature,
      planningResult.sourceFingerprint,
      await buildPiTargetMetadataSignature(targetDir),
      piSyncHooks?.policyFingerprintOverride,
    )
    return
  }

  await hooks?.onBeforeMutate?.("replace")
  await preparePiSkillTargetForReplacement(targetDir, ancestorCache)
  await copyDirForPiMaterialization(sourceDir, targetDir, new Set<string>(), options, ancestorCache)
  await rewriteSkillFileForPi(path.join(targetDir, "SKILL.md"), targetName, nameMaps, transformOptions, ancestorCache)

  const sourceSummary = await buildPiMaterializedTreeMetadataSummary(sourceDir, options)
  const sourceAnalysis = await analyzePiMaterializedTree(sourceSummary.root, targetName, nameMaps, transformOptions)
  await writePiSkillFastPathRecord(
    targetDir,
    buildPiSkillRenderSignature(targetName, nameMaps, transformOptions),
    sourceSummary.metadataSignature,
    sourceAnalysis.fingerprint,
    await buildPiTargetMetadataSignature(targetDir),
    piSyncHooks?.policyFingerprintOverride,
  )
}

async function planPiSkillDirUpdate(
  sourceDir: string,
  targetDir: string,
  targetName: string,
  nameMaps?: PiNameMaps,
  options?: PiMaterializationOptions,
  transformOptions?: PiTransformOptions,
  piSyncHooks?: PiSyncHooks,
): Promise<
  | { result: "nochange"; renderSignature: string; sourceMetadataSignature: string; sourceFingerprint: string; targetMetadataSignature: string }
  | { result: "apply"; ops: PiIncrementalOp[]; renderSignature: string; sourceMetadataSignature: string; sourceFingerprint: string }
  | { result: "fallback" }
> {
  const targetStats = await fs.lstat(targetDir).catch(() => null)
  if (!targetStats) {
    return { result: "fallback" }
  }

  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    return { result: "fallback" }
  }

  const sourceMetadataSummary = await buildPiMaterializedTreeMetadataSummary(sourceDir, options)
  const sourceMetadataSignature = sourceMetadataSummary.metadataSignature
  const renderSignature = buildPiSkillRenderSignature(targetName, nameMaps, transformOptions)
  const targetAnalysis = await buildPiTargetTree(targetDir)
  const targetMetadataSignature = targetAnalysis.metadataSignature
  const cachedFastPath = await readPiSkillFastPathRecord(targetDir)
  if (cachedFastPath
    && cachedFastPath.policyFingerprint === getPiPolicyFingerprint(piSyncHooks?.policyFingerprintOverride)
    && cachedFastPath.renderSignature === renderSignature
    && cachedFastPath.sourceMetadataSignature === sourceMetadataSignature
    && cachedFastPath.targetMetadataSignature === targetMetadataSignature) {
    return { result: "nochange", renderSignature, sourceMetadataSignature, sourceFingerprint: cachedFastPath.sourceFingerprint, targetMetadataSignature }
  }

  await piSyncHooks?.onSourceFingerprint?.(sourceDir)

  await piSyncHooks?.onSourceAnalysis?.(sourceDir)
  const sourceAnalysis = await analyzePiMaterializedTree(sourceMetadataSummary.root, targetName, nameMaps, transformOptions)

  await piSyncHooks?.onFullCompare?.(targetDir)

  const comparison = await planPiIncrementalOps(sourceAnalysis.tree, targetAnalysis.tree, targetDir)

  if (comparison.result === "nochange") {
    return {
      result: "nochange",
      renderSignature,
      sourceMetadataSignature,
      sourceFingerprint: sourceAnalysis.fingerprint,
      targetMetadataSignature,
    }
  }

  if (comparison.result === "fallback") {
    return { result: "fallback" }
  }

  return {
    result: "apply",
    ops: comparison.ops,
    renderSignature,
    sourceMetadataSignature: sourceAnalysis.metadataSignature,
    sourceFingerprint: sourceAnalysis.fingerprint,
  }
}

function buildPiSkillRenderSignature(
  targetName: string,
  nameMaps?: PiNameMaps,
  transformOptions?: PiTransformOptions,
): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeJsonValue({
    targetName,
    nameMaps: nameMaps ?? null,
    transformOptions: transformOptions ?? null,
  }))).digest("hex")
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue)
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, canonicalizeJsonValue(entryValue)]),
    )
  }

  return value
}

async function analyzePiMaterializedTree(
  summary: PiMaterializedMetadataNode,
  targetName: string,
  nameMaps?: PiNameMaps,
  transformOptions?: PiTransformOptions,
): Promise<PiMaterializedTreeAnalysis> {
  if (summary.kind !== "directory") {
    throw new Error(`Expected Pi materialized directory summary for ${summary.sourcePath}`)
  }

  const node: PiMaterializedTreeNode = { kind: "directory", children: new Map() }
  const fingerprintHash = createHash("sha256")

  for (const child of summary.children ?? []) {
    fingerprintHash.update(child.kind)
    fingerprintHash.update("\0")
    fingerprintHash.update(child.name)
    fingerprintHash.update("\0")

    if (child.kind === "directory") {
      const childAnalysis = await analyzePiMaterializedTree(child, targetName, nameMaps, transformOptions)
      node.children.set(child.name, childAnalysis.tree)
      fingerprintHash.update(childAnalysis.fingerprint)
      continue
    }

    if (child.name === "SKILL.md") {
      const raw = await readText(child.sourcePath)
      const renderedContent = renderPiSkillContent(raw, targetName, nameMaps, child.sourcePath, transformOptions)
      node.children.set(child.name, {
        kind: "file",
        sourcePath: child.sourcePath,
        mode: child.mode ?? 0o644,
        renderedContent,
      })
      fingerprintHash.update(renderedContent)
      continue
    }

    node.children.set(child.name, {
      kind: "file",
      sourcePath: child.sourcePath,
      mode: child.mode ?? 0o644,
    })
    fingerprintHash.update(await fs.readFile(child.sourcePath))
  }

  return {
    tree: node,
    fingerprint: fingerprintHash.digest("hex"),
    metadataSignature: summary.metadataSignature ?? "",
  }
}

async function buildPiMaterializedTreeMetadataSummary(
  sourceDir: string,
  options?: PiMaterializationOptions,
  activeRealDirs = new Set<string>(),
): Promise<PiMaterializedMetadataSummary> {
  const realSourceDir = await fs.realpath(sourceDir)
  if (activeRealDirs.has(realSourceDir)) {
    throw cyclicPiSkillSymlinkError(sourceDir)
  }

  activeRealDirs.add(realSourceDir)

  try {
    const hash = createHash("sha256")
    const root: PiMaterializedMetadataNode = {
      kind: "directory",
      name: path.basename(sourceDir),
      sourcePath: sourceDir,
      children: [],
    }
    const entries = await fs.readdir(sourceDir, { withFileTypes: true })

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const sourcePath = path.join(sourceDir, entry.name)
      const resolvedEntry = await resolvePiMaterializedEntry(sourcePath, entry, undefined, options)
      if (!resolvedEntry || resolvedEntry.kind === "skip") continue

      const stats = await fs.lstat(resolvedEntry.sourcePath)
      hash.update(resolvedEntry.kind)
      hash.update("\0")
      hash.update(resolvedEntry.name)
      hash.update("\0")
      hash.update(String(stats.size))
      hash.update(":")
      hash.update(String(stats.mtimeMs))
      hash.update("\0")
      hash.update(String(stats.mode & 0o777))
      hash.update("\0")

      if (resolvedEntry.kind === "directory") {
        const childSummary = await buildPiMaterializedTreeMetadataSummary(resolvedEntry.sourcePath, options, activeRealDirs)
        root.children!.push({
          kind: "directory",
          name: resolvedEntry.name,
          sourcePath: resolvedEntry.sourcePath,
          metadataSignature: childSummary.metadataSignature,
          children: childSummary.root.children,
        })
        hash.update(childSummary.metadataSignature)
        continue
      }

      root.children!.push({
        kind: "file",
        name: resolvedEntry.name,
        sourcePath: resolvedEntry.sourcePath,
        mode: stats.mode & 0o777,
      })
    }

    const metadataSignature = hash.digest("hex")
    root.metadataSignature = metadataSignature
    return { metadataSignature, root }
  } finally {
    activeRealDirs.delete(realSourceDir)
  }
}

async function buildPiTargetTree(targetDir: string): Promise<PiTargetTreeAnalysis> {
  const hash = createHash("sha256")
  const tree = await buildPiTargetTreeNode(targetDir, hash, "")
  return {
    tree,
    metadataSignature: hash.digest("hex"),
  }
}

async function buildPiTargetMetadataSignature(targetDir: string): Promise<string> {
  return (await buildPiTargetTree(targetDir)).metadataSignature
}

async function buildPiTargetTreeNode(targetDir: string, hash: ReturnType<typeof createHash>, relativeDir: string): Promise<PiTargetTreeNode> {
  const entries = await fs.readdir(targetDir, { withFileTypes: true })
  const children = new Map<string, PiTargetTreeNode>()

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const targetPath = path.join(targetDir, entry.name)
    const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name
    const stats = await fs.lstat(targetPath)
    const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"
    hash.update(kind)
    hash.update("\0")
    hash.update(relativePath)
    hash.update("\0")
    hash.update(String(stats.size))
    hash.update(":")
    hash.update(String(stats.mtimeMs))
    hash.update("\0")

    if (entry.isDirectory()) {
      children.set(entry.name, await buildPiTargetTreeNode(targetPath, hash, relativePath))
      continue
    }

    if (entry.isFile()) {
      hash.update(String(stats.mode & 0o777))
      hash.update("\0")
      children.set(entry.name, { kind: "file" })
      continue
    }

    if (entry.isSymbolicLink()) {
      children.set(entry.name, { kind: "symlink" })
      continue
    }

    children.set(entry.name, { kind: "other" })
  }

  return { kind: "directory", children }
}

async function planPiIncrementalOps(
  sourceTree: PiMaterializedTreeNode,
  targetTree: PiTargetTreeNode,
  targetDir: string,
): Promise<
  | { result: "nochange" }
  | { result: "fallback" }
  | { result: "apply"; ops: PiIncrementalOp[] }
> {
  const ops: PiIncrementalOp[] = []
  const comparison = await comparePiDirectoryNodes(sourceTree, targetTree, targetDir, "", ops)

  if (comparison === "fallback") {
    return { result: "fallback" }
  }

  if (ops.length === 0) {
    return { result: "nochange" }
  }

  return { result: "apply", ops }
}

async function comparePiDirectoryNodes(
  sourceNode: PiMaterializedTreeNode,
  targetNode: PiTargetTreeNode,
  targetDir: string,
  relativeDir: string,
  ops: PiIncrementalOp[],
): Promise<"ok" | "fallback"> {
  if (sourceNode.kind !== "directory" || targetNode.kind !== "directory") {
    return "fallback"
  }

  const sourceChildren = sourceNode.children
  const targetChildren = targetNode.children ?? new Map<string, PiTargetTreeNode>()
  const names = [...new Set([...sourceChildren.keys(), ...targetChildren.keys()])].sort()

  for (const name of names) {
    const sourceChild = sourceChildren.get(name)
    const targetChild = targetChildren.get(name)
    const relativePath = relativeDir ? path.join(relativeDir, name) : name

    if (!sourceChild && targetChild) {
      if (targetChild.kind === "symlink" || targetChild.kind === "other") {
        throw new Error(`Refusing to mutate unsafe Pi skill path ${path.join(targetDir, relativePath)}`)
      }

      ops.push({
        type: "remove",
        relativePath,
        targetKind: targetChild.kind,
      })
      continue
    }

    if (sourceChild && !targetChild) {
      appendPiCreateOps(sourceChild, relativePath, ops)
      continue
    }

    if (!sourceChild || !targetChild) {
      continue
    }

    if (targetChild.kind === "symlink" || targetChild.kind === "other") {
      throw new Error(`Refusing to mutate unsafe Pi skill path ${path.join(targetDir, relativePath)}`)
    }

    if (sourceChild.kind !== targetChild.kind) {
      return "fallback"
    }

    if (sourceChild.kind === "directory") {
      const nested = await comparePiDirectoryNodes(sourceChild, targetChild, targetDir, relativePath, ops)
      if (nested === "fallback") {
        return "fallback"
      }
      continue
    }

    const matches = await materializedFileNodeMatchesTarget(sourceChild, path.join(targetDir, relativePath))
    if (!matches) {
      ops.push({
        type: "writeFile",
        relativePath,
        sourcePath: sourceChild.sourcePath,
        mode: sourceChild.mode,
        renderedContent: sourceChild.renderedContent,
      })
    }
  }

  return "ok"
}

function appendPiCreateOps(node: PiMaterializedTreeNode, relativePath: string, ops: PiIncrementalOp[]): void {
  if (node.kind === "directory") {
    ops.push({ type: "createDir", relativePath })
    for (const [name, child] of [...node.children.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      appendPiCreateOps(child, path.join(relativePath, name), ops)
    }
    return
  }

  ops.push({
    type: "writeFile",
    relativePath,
    sourcePath: node.sourcePath,
    mode: node.mode,
    renderedContent: node.renderedContent,
  })
}

async function materializedFileNodeMatchesTarget(node: Extract<PiMaterializedTreeNode, { kind: "file" }>, targetPath: string): Promise<boolean> {
  const targetStats = await fs.stat(targetPath)
  if ((targetStats.mode & 0o777) !== node.mode) {
    return false
  }

  if (node.renderedContent !== undefined) {
    const targetRaw = await readText(targetPath)
    return node.renderedContent === targetRaw
  }

  return fileContentsMatch(node.sourcePath, targetPath)
}

async function readPiSkillFastPathRecord(targetDir: string): Promise<PiSkillFastPathRecord | null> {
  const recordPath = resolvePiSkillFastPathRecordPath(targetDir)
  try {
    const parsed = JSON.parse(await readText(recordPath)) as PiSkillFastPathRecord
    if (parsed.version !== 4) return null
    if (!parsed.policyFingerprint || !parsed.renderSignature || !parsed.sourceMetadataSignature || !parsed.sourceFingerprint || !parsed.targetMetadataSignature) return null
    return parsed
  } catch {
    return null
  }
}

async function writePiSkillFastPathRecord(
  targetDir: string,
  renderSignature: string,
  sourceMetadataSignature: string,
  sourceFingerprint: string,
  targetMetadataSignature: string,
  policyFingerprintOverride?: string | null,
): Promise<void> {
  const recordPath = resolvePiSkillFastPathRecordPath(targetDir)
  const record: PiSkillFastPathRecord = {
    version: 4,
    policyFingerprint: getPiPolicyFingerprint(policyFingerprintOverride),
    renderSignature,
    sourceMetadataSignature,
    sourceFingerprint,
    targetMetadataSignature,
  }

  await fs.mkdir(path.dirname(recordPath), { recursive: true })
  await writeTextAtomicIfChanged({
    filePath: recordPath,
    content: JSON.stringify(record, null, 2) + "\n",
  })
}

function resolvePiSkillFastPathRecordPath(targetDir: string): string {
  const stateHome = process.env.COMPOUND_ENGINEERING_HOME || os.homedir()
  const identity = createHash("sha256").update(path.resolve(targetDir)).digest("hex")
  return path.join(stateHome, ".compound-engineering", "pi-skill-fingerprints", `${identity}.json`)
}

export async function applyPiIncrementalOps(targetDir: string, ops: PiIncrementalOp[], ancestorCache?: Map<string, true>): Promise<void> {
  const rollback = new PiRollbackContext({ ancestorCache })

  try {
    for (const op of ops) {
      const targetPath = path.join(targetDir, op.relativePath)
      await rollback.capture(targetPath)
      await applyPiIncrementalOp(targetDir, op, ancestorCache)
    }
  } catch (error) {
    await rollback.restore()
    throw error
  }
  await rollback.cleanup()
}

async function applyPiIncrementalOp(targetDir: string, op: PiIncrementalOp, ancestorCache?: Map<string, true>): Promise<void> {
  const targetPath = path.join(targetDir, op.relativePath)

  if (op.type === "createDir") {
    await ensureSafePiMutationTarget(targetPath, "missing", ancestorCache)
    await ensureManagedDir(targetPath, ancestorCache)
    await assertNoSymlinkAncestors(targetPath, ancestorCache)
    return
  }

  if (op.type === "remove") {
    await removePiMaterializedPath(targetPath, op.targetKind, ancestorCache)
    return
  }

  await ensureManagedParentDir(targetPath, ancestorCache)
  await ensureSafePiMutationTarget(targetPath, "file", ancestorCache)

  if (op.renderedContent !== undefined) {
    await writeTextAtomicIfChanged({ filePath: targetPath, content: op.renderedContent, mode: op.mode, ancestorCache })
    return
  }

  if (!op.sourcePath) {
    throw new Error(`Missing Pi materialized source for ${targetPath}`)
  }

  const sourceBuffer = await fs.readFile(op.sourcePath)
  await writeFileAtomicIfChanged({ filePath: targetPath, content: sourceBuffer, mode: op.mode, ancestorCache })
}

export async function ensureSafePiMutationTarget(targetPath: string, expected: "missing" | "file", ancestorCache?: Map<string, true>): Promise<void> {
  await assertNoSymlinkAncestors(targetPath, ancestorCache)
  const stats = await fs.lstat(targetPath).catch(() => null)
  if (!stats) return
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to mutate unsafe Pi skill path ${targetPath}`)
  }
  if (expected === "missing") {
    if (stats.isDirectory()) return
    throw new Error(`Refusing to replace unexpected Pi skill path ${targetPath}`)
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing to replace unexpected Pi skill path ${targetPath}`)
  }
}

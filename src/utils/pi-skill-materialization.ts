import type { Dirent } from "fs"
import { promises as fs } from "fs"
import path from "path"
import { assertNoSymlinkAncestors, pathExists, readText, writeFileAtomicIfChanged, writeTextAtomicIfChanged } from "./files"
import { parseFrontmatter } from "./frontmatter"
import { renderPiSkillContent, transformPiBodyContent, type PiTransformOptions } from "./pi-content-transform"
import type { PiNameMaps } from "../types/pi"

export type PiMaterializationOptions = {
  trustedRoot?: string
}

export type PiSkillMutationHooks = {
  onBeforeMutate?: (mode: "incremental" | "replace") => void | Promise<void>
}

export type PiMaterializedEntry = {
  kind: "directory" | "file"
  name: string
  sourcePath: string
}

export async function skillFileMatchesPiTarget(
  skillPath: string,
  targetName: string,
  nameMaps?: PiNameMaps,
  options?: PiTransformOptions,
): Promise<boolean> {
  if (!(await pathExists(skillPath))) {
    return false
  }

  const raw = await readText(skillPath)

  try {
    const parsed = parseFrontmatter(raw)
    if (Object.keys(parsed.data).length === 0 && parsed.body === raw) {
      return transformPiBodyContent(raw, nameMaps, options) === raw
    }

    if (parsed.data.name !== targetName) {
      return false
    }

    return transformPiBodyContent(parsed.body, nameMaps, options) === parsed.body
  } catch (error) {
    console.warn(`Pi sync: failed to parse frontmatter in ${skillPath}:`, (error as Error).message)
    const rewritten = renderPiSkillContent(raw, targetName, nameMaps, skillPath, options)
    return rewritten === raw
  }
}

export async function piSkillTargetMatchesMaterializedSource(
  sourceDir: string,
  targetDir: string,
  targetName: string,
  nameMaps?: PiNameMaps,
  options?: PiMaterializationOptions,
  transformOptions?: PiTransformOptions,
): Promise<boolean> {
  const targetStats = await fs.lstat(targetDir).catch(() => null)
  if (!targetStats || targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    return false
  }

  return materializedDirMatches(sourceDir, targetDir, targetName, nameMaps, new Set<string>(), options, transformOptions)
}

export async function materializedDirMatches(
  sourceDir: string,
  targetDir: string,
  targetName: string,
  nameMaps?: PiNameMaps,
  activeRealDirs = new Set<string>(),
  options?: PiMaterializationOptions,
  transformOptions?: PiTransformOptions,
): Promise<boolean> {
  const realSourceDir = await fs.realpath(sourceDir)
  if (activeRealDirs.has(realSourceDir)) {
    throw cyclicPiSkillSymlinkError(sourceDir)
  }

  activeRealDirs.add(realSourceDir)

  try {
    const [sourceEntries, targetEntries] = await Promise.all([
      fs.readdir(sourceDir, { withFileTypes: true }),
      fs.readdir(targetDir, { withFileTypes: true }),
    ])

    const comparableSourceEntries = (await Promise.all(
      sourceEntries.map(async (entry) => resolvePiMaterializedEntry(path.join(sourceDir, entry.name), entry, undefined, options)),
    )).filter((entry): entry is PiMaterializedEntry => entry !== null && entry.kind !== "skip")

    const sourceNames = comparableSourceEntries.map((entry) => entry.name).sort()
    const targetNames = targetEntries.map((entry) => entry.name).sort()
    if (sourceNames.length !== targetNames.length) {
      return false
    }
    for (let i = 0; i < sourceNames.length; i += 1) {
      if (sourceNames[i] !== targetNames[i]) return false
    }

    for (const entry of comparableSourceEntries) {
      const sourcePath = entry.sourcePath
      const targetPath = path.join(targetDir, entry.name)
      const targetStats = await fs.lstat(targetPath).catch(() => null)
      if (!targetStats || targetStats.isSymbolicLink()) {
        return false
      }

      if (entry.kind === "directory") {
        if (!targetStats.isDirectory()) return false
        const matches = await materializedDirMatches(sourcePath, targetPath, targetName, nameMaps, activeRealDirs, options, transformOptions)
        if (!matches) return false
        continue
      }

      if (entry.kind === "file") {
        if (!targetStats.isFile()) return false
        if (entry.name === "SKILL.md") {
          const rewrittenMatches = await materializedSkillFileMatches(sourcePath, targetPath, targetName, nameMaps, transformOptions)
          if (!rewrittenMatches) return false
          continue
        }
        const matches = await fileContentsMatch(sourcePath, targetPath)
        if (!matches) return false
        continue
      }

      return false
    }

    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes("cyclic directory symlink")) {
      throw error
    }
    return false
  } finally {
    activeRealDirs.delete(realSourceDir)
  }
}

export async function preparePiSkillTargetForReplacement(targetDir: string, ancestorCache?: Map<string, true>): Promise<void> {
  await assertNoSymlinkAncestors(targetDir, ancestorCache)
  const existingStats = await fs.lstat(targetDir).catch(() => null)
  if (!existingStats) return

  if (existingStats.isSymbolicLink()) {
    const rechecked = await fs.lstat(targetDir).catch(() => null)
    if (!rechecked) return
    if (!rechecked.isSymbolicLink()) {
      throw new Error(`Refusing to replace unexpected Pi skill path ${targetDir}`)
    }
    await fs.unlink(targetDir)
    return
  }

  const parentDir = path.dirname(targetDir)
  const baseName = path.basename(targetDir)
  const existingBackups = (await fs.readdir(parentDir))
    .filter((entry) => entry.startsWith(`${baseName}.bak.`))

  for (const oldBackup of existingBackups.sort().slice(0, -1)) {
    const backupPath = path.join(parentDir, oldBackup)
    await assertNoSymlinkAncestors(backupPath, ancestorCache)
    const backupStats = await fs.lstat(backupPath)
    if (backupStats.isSymbolicLink()) continue
    await fs.rm(backupPath, { recursive: true, force: true })
  }

  const backupPath = `${targetDir}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`
  await assertNoSymlinkAncestors(targetDir, ancestorCache)
  await fs.rename(targetDir, backupPath)
  console.warn(`Backed up existing Pi skill directory to ${backupPath}`)
}

export async function copyDirForPiMaterialization(
  sourceDir: string,
  targetDir: string,
  activeRealDirs = new Set<string>(),
  options?: PiMaterializationOptions,
  ancestorCache?: Map<string, true>,
): Promise<void> {
  const realSourceDir = await fs.realpath(sourceDir)
  if (activeRealDirs.has(realSourceDir)) {
    throw cyclicPiSkillSymlinkError(sourceDir)
  }

  activeRealDirs.add(realSourceDir)

  try {
    await assertNoSymlinkAncestors(targetDir, ancestorCache)
    await fs.mkdir(targetDir, { recursive: true })
    const entries = await fs.readdir(sourceDir, { withFileTypes: true })

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name)
      const targetPath = path.join(targetDir, entry.name)
      const resolvedEntry = await resolvePiMaterializedEntry(sourcePath, entry, { logSkippedDanglingSymlinks: true }, options)

      if (!resolvedEntry || resolvedEntry.kind === "skip") {
        continue
      }

      const materializedSourcePath = resolvedEntry.sourcePath

      if (resolvedEntry.kind === "directory") {
        await copyDirForPiMaterialization(materializedSourcePath, targetPath, activeRealDirs, options, ancestorCache)
        continue
      }

      if (resolvedEntry.kind === "file") {
        const sourceStats = await fs.lstat(materializedSourcePath)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await writeFileAtomicIfChanged({
          filePath: targetPath,
          content: await fs.readFile(materializedSourcePath),
          mode: sourceStats.mode & 0o777,
          ancestorCache,
        })
        continue
      }
    }
  } finally {
    activeRealDirs.delete(realSourceDir)
  }
}

export async function rewriteSkillFileForPi(
  skillPath: string,
  targetName: string,
  nameMaps?: PiNameMaps,
  options?: PiTransformOptions,
  ancestorCache?: Map<string, true>,
): Promise<void> {
  if (!(await pathExists(skillPath))) {
    return
  }

  const raw = await readText(skillPath)
  const updated = renderPiSkillContent(raw, targetName, nameMaps, skillPath, options)
  const sourceStats = await fs.stat(skillPath)
  const sourceMode = sourceStats.mode & 0o777

  if (updated !== raw) {
    await writeTextAtomicIfChanged({ filePath: skillPath, content: updated, mode: sourceMode, ancestorCache })
  }
}

export async function materializedSkillFileMatches(
  sourcePath: string,
  targetPath: string,
  targetName: string,
  nameMaps?: PiNameMaps,
  options?: PiTransformOptions,
): Promise<boolean> {
  const [sourceRaw, targetRaw, sourceStats, targetStats] = await Promise.all([
    readText(sourcePath),
    readText(targetPath),
    fs.stat(sourcePath),
    fs.stat(targetPath),
  ])
  return renderPiSkillContent(sourceRaw, targetName, nameMaps, sourcePath, options) === targetRaw
    && (sourceStats.mode & 0o777) === (targetStats.mode & 0o777)
}

export async function fileContentsMatch(sourcePath: string, targetPath: string): Promise<boolean> {
  const [sourceBuffer, targetBuffer] = await Promise.all([
    fs.readFile(sourcePath),
    fs.readFile(targetPath),
  ])

  return sourceBuffer.equals(targetBuffer)
}

export async function removePiMaterializedPath(targetPath: string, expectedKind: "directory" | "file", ancestorCache?: Map<string, true>): Promise<void> {
  await assertNoSymlinkAncestors(targetPath, ancestorCache)
  const stats = await fs.lstat(targetPath).catch(() => null)
  if (!stats) return
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to remove unsafe Pi skill path ${targetPath}`)
  }

  if (expectedKind === "directory") {
    if (!stats.isDirectory()) {
      throw new Error(`Refusing to remove unexpected Pi skill path ${targetPath}`)
    }
    const rechecked = await fs.lstat(targetPath)
    if (!rechecked.isDirectory() || rechecked.isSymbolicLink()) {
      throw new Error(`Refusing to remove unexpected Pi skill path ${targetPath}`)
    }
    await fs.rm(targetPath, { recursive: true, force: true })
    return
  }

  if (!stats.isFile()) {
    throw new Error(`Refusing to remove unexpected Pi skill path ${targetPath}`)
  }
  const rechecked = await fs.lstat(targetPath)
  if (!rechecked.isFile() || rechecked.isSymbolicLink()) {
    throw new Error(`Refusing to remove unexpected Pi skill path ${targetPath}`)
  }
  await fs.unlink(targetPath)
}

export function cyclicPiSkillSymlinkError(sourcePath: string): Error {
  return new Error(`Pi skill materialization detected a cyclic directory symlink at ${sourcePath}`)
}

export async function validatePiSkillSourceForPi(
  sourceDir: string,
  targetName: string,
  nameMaps?: PiNameMaps,
  options?: PiTransformOptions,
): Promise<void> {
  const skillPath = path.join(sourceDir, "SKILL.md")
  if (!(await pathExists(skillPath))) {
    return
  }

  const raw = await readText(skillPath)
  void renderPiSkillContent(raw, targetName, nameMaps, skillPath, options)
}

export async function resolvePiMaterializedEntry(
  sourcePath: string,
  entry: Dirent,
  options?: { logSkippedDanglingSymlinks?: boolean },
  materialization?: PiMaterializationOptions,
): Promise<PiMaterializedEntry | { kind: "skip" } | null> {
  if (entry.isDirectory()) {
    return { kind: "directory", name: entry.name, sourcePath }
  }

  if (entry.isFile()) {
    return { kind: "file", name: entry.name, sourcePath }
  }

  if (!entry.isSymbolicLink()) {
    return null
  }

  try {
    const [stats, resolvedPath] = await Promise.all([
      fs.stat(sourcePath),
      fs.realpath(sourcePath),
    ])

    if (materialization?.trustedRoot) {
      const trustedRoot = path.resolve(materialization.trustedRoot)
      const withinTrustedRoot = resolvedPath === trustedRoot || resolvedPath.startsWith(trustedRoot + path.sep)
      if (!withinTrustedRoot) {
        console.warn(`Pi sync: skipping symlink outside trusted root ${sourcePath} -> ${resolvedPath}`)
        return { kind: "skip" }
      }
    }

    if (stats.isDirectory()) {
      return { kind: "directory", name: entry.name, sourcePath: resolvedPath }
    }

    if (stats.isFile()) {
      return { kind: "file", name: entry.name, sourcePath: resolvedPath }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (options?.logSkippedDanglingSymlinks) {
        console.warn(`Pi sync: skipping dangling symlink ${sourcePath}`)
      }
      return { kind: "skip" }
    }
    throw error
  }

  return null
}

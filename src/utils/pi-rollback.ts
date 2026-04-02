import { promises as fs, realpathSync } from "fs"
import os from "os"
import path from "path"
import {
  assertNoSymlinkAncestors,
  ensureDir,
  ensureManagedParentDir,
  getManagedPathSnapshotHookForTests,
} from "./files"

export type RollbackSnapshot = {
  targetPath: string
  existed: boolean
  kind?: "file" | "directory" | "symlink"
  tempPath?: string
  linkTarget?: string
  mode?: number
}

/**
 * Unified snapshot/rollback context for Pi publication operations.
 *
 * Replaces the three near-identical snapshot/rollback systems that existed
 * independently in pi.ts (writer), sync/pi.ts, and pi-skills.ts. All follow
 * the same pattern: lazily create a snapshot root, capture targets before
 * mutation, restore on error, and clean up on success.
 *
 * Key improvement over the previous implementations: `copyDirectoryWithModes`
 * preserves per-file modes when snapshotting and restoring directories.
 */
export class PiRollbackContext {
  private snapshotRoot: string | null = null
  private snapshots = new Map<string, RollbackSnapshot>()
  private ancestorCache?: Map<string, true>
  private snapshotHook?: (targetPath: string) => void | Promise<void>

  constructor(options?: {
    ancestorCache?: Map<string, true>
    snapshotHook?: (targetPath: string) => void | Promise<void>
  }) {
    this.ancestorCache = options?.ancestorCache
    this.snapshotHook = options?.snapshotHook
  }

  /** Capture the current state of a target path for later rollback. */
  async capture(targetPath: string): Promise<void> {
    if (this.snapshots.has(targetPath)) return

    const testHook = getManagedPathSnapshotHookForTests()
    if (testHook) {
      await testHook(targetPath)
    }
    if (this.snapshotHook) {
      await this.snapshotHook(targetPath)
    }

    await assertNoSymlinkAncestors(targetPath, this.ancestorCache)
    const stats = await fs.lstat(targetPath).catch(() => null)

    if (!stats) {
      this.snapshots.set(targetPath, { targetPath, existed: false })
      return
    }

    if (stats.isSymbolicLink()) {
      this.snapshots.set(targetPath, {
        targetPath,
        existed: true,
        kind: "symlink",
        linkTarget: await fs.readlink(targetPath),
      })
      return
    }

    const tempPath = path.join(
      await this.ensureSnapshotRoot(),
      `${this.snapshots.size}`,
    )
    const mode = stats.mode & 0o777

    if (stats.isDirectory()) {
      await this.copyDirectoryWithModes(targetPath, tempPath)
      this.snapshots.set(targetPath, {
        targetPath,
        existed: true,
        kind: "directory",
        tempPath,
        mode,
      })
      return
    }

    if (!stats.isFile()) {
      throw new Error(`Refusing to snapshot non-file target ${targetPath}`)
    }

    await ensureManagedParentDir(tempPath, this.ancestorCache)
    await fs.copyFile(targetPath, tempPath)
    this.snapshots.set(targetPath, {
      targetPath,
      existed: true,
      kind: "file",
      tempPath,
      mode,
    })
  }

  /** Restore all captured snapshots in reverse order (deepest paths first). */
  async restore(): Promise<void> {
    const ordered = [...this.snapshots.values()].sort(
      (a, b) => b.targetPath.length - a.targetPath.length,
    )

    for (const snapshot of ordered) {
      if (!snapshot.existed) {
        await this.safeRemove(snapshot.targetPath)
        continue
      }

      if (snapshot.kind === "symlink" && snapshot.linkTarget) {
        await this.safeRemove(snapshot.targetPath)
        await assertNoSymlinkAncestors(snapshot.targetPath, this.ancestorCache)
        await ensureDir(path.dirname(snapshot.targetPath))
        await fs.symlink(snapshot.linkTarget, snapshot.targetPath)
        continue
      }

      if (snapshot.kind === "directory" && snapshot.tempPath) {
        await this.safeRemove(snapshot.targetPath)
        await assertNoSymlinkAncestors(snapshot.targetPath, this.ancestorCache)
        await this.copyDirectoryWithModes(snapshot.tempPath, snapshot.targetPath)
        if (snapshot.mode !== undefined) {
          await fs.chmod(snapshot.targetPath, snapshot.mode)
        }
        continue
      }

      if (snapshot.kind === "file" && snapshot.tempPath) {
        await this.safeRemove(snapshot.targetPath)
        await assertNoSymlinkAncestors(snapshot.targetPath, this.ancestorCache)
        await ensureManagedParentDir(snapshot.targetPath, this.ancestorCache)
        await fs.copyFile(snapshot.tempPath, snapshot.targetPath)
        if (snapshot.mode !== undefined) {
          await fs.chmod(snapshot.targetPath, snapshot.mode)
        }
      }
    }

    await this.cleanup()
  }

  /** Remove the temporary snapshot root directory. */
  async cleanup(): Promise<void> {
    if (this.snapshotRoot) {
      await fs
        .rm(this.snapshotRoot, { recursive: true, force: true })
        .catch(() => undefined)
      this.snapshotRoot = null
    }
  }

  private async ensureSnapshotRoot(): Promise<string> {
    if (!this.snapshotRoot) {
      this.snapshotRoot = await fs.mkdtemp(
        path.join(realpathSync(os.tmpdir()), "pi-rollback-"),
      )
    }
    return this.snapshotRoot
  }

  /**
   * Recursively copy a directory, preserving per-file and per-directory modes.
   *
   * This is the key improvement over the previous `copyManagedSnapshotDirectory`
   * and `copyPiSnapshotDirectory` implementations, which did NOT preserve file
   * modes during copy.
   */
  private async copyDirectoryWithModes(
    src: string,
    dest: string,
  ): Promise<void> {
    const srcStats = await fs.stat(src)
    await fs.mkdir(dest, { recursive: true })
    await fs.chmod(dest, srcStats.mode & 0o777)

    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)

      if (entry.isDirectory()) {
        await this.copyDirectoryWithModes(srcPath, destPath)
        continue
      }

      if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath)
        const fileMode = (await fs.stat(srcPath)).mode & 0o777
        await fs.chmod(destPath, fileMode)
        continue
      }

      throw new Error(
        `Refusing to snapshot unexpected target ${srcPath}`,
      )
    }
  }

  private async safeRemove(targetPath: string): Promise<void> {
    await assertNoSymlinkAncestors(targetPath, this.ancestorCache)
    const stats = await fs.lstat(targetPath).catch(() => null)
    if (!stats) return

    if (stats.isSymbolicLink()) {
      const rechecked = await fs.lstat(targetPath)
      if (!rechecked.isSymbolicLink()) {
        throw new Error(
          `Refusing to restore unexpected target ${targetPath}`,
        )
      }
      await fs.unlink(targetPath)
      return
    }

    if (stats.isDirectory()) {
      const rechecked = await fs.lstat(targetPath)
      if (!rechecked.isDirectory() || rechecked.isSymbolicLink()) {
        throw new Error(
          `Refusing to restore unexpected target ${targetPath}`,
        )
      }
      await fs.rm(targetPath, { recursive: true, force: true })
      return
    }

    if (stats.isFile()) {
      const rechecked = await fs.lstat(targetPath)
      if (!rechecked.isFile() || rechecked.isSymbolicLink()) {
        throw new Error(
          `Refusing to restore unexpected target ${targetPath}`,
        )
      }
      await fs.unlink(targetPath)
      return
    }

    throw new Error(
      `Refusing to restore unexpected target ${targetPath}`,
    )
  }
}

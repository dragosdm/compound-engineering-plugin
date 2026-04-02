import { describe, expect, test } from "bun:test"
import { promises as fs, realpathSync } from "fs"
import os from "os"
import path from "path"
import {
  assertSafePathComponent,
  backupFile,
  captureManagedPathSnapshot,
  removeFileIfExists,
  removeManagedPathIfExists,
  restoreManagedPathSnapshot,
  writeFileAtomicIfChanged,
  writeText,
  writeTextAtomicIfChanged,
} from "../src/utils/files"

const tmpdir = realpathSync(os.tmpdir())

describe("managed file mutations", () => {
  test("rejects unsafe path components before path joins", () => {
    expect(() => assertSafePathComponent("prompt-one", "prompt name")).not.toThrow()
    expect(() => assertSafePathComponent("../escape", "prompt name")).toThrow("Unsafe prompt name")
    expect(() => assertSafePathComponent("nested/path", "prompt name")).toThrow("Unsafe prompt name")
  })

  test("rejects binary writes through symlinked ancestor directories", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir, "files-write-ancestor-symlink-"))
    const externalRoot = path.join(tempRoot, "external")
    const managedRoot = path.join(tempRoot, "managed")
    const symlinkedDir = path.join(managedRoot, "compound-engineering")
    const targetPath = path.join(symlinkedDir, "mcporter.json")

    await fs.mkdir(externalRoot, { recursive: true })
    await fs.mkdir(managedRoot, { recursive: true })
    await fs.symlink(externalRoot, symlinkedDir)

    await expect(writeFileAtomicIfChanged({
      filePath: targetPath,
      content: Buffer.from("hello\n"),
    })).rejects.toThrow("symlinked ancestor")

    await expect(fs.access(path.join(externalRoot, "mcporter.json"))).rejects.toBeDefined()
  })

  test("rejects managed deletes through symlinked ancestor directories", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir, "files-delete-ancestor-symlink-"))
    const externalRoot = path.join(tempRoot, "external")
    const managedRoot = path.join(tempRoot, "managed")
    const symlinkedDir = path.join(managedRoot, "compound-engineering")
    const targetPath = path.join(symlinkedDir, "mcporter.json")

    await fs.mkdir(externalRoot, { recursive: true })
    await fs.mkdir(managedRoot, { recursive: true })
    await fs.writeFile(path.join(externalRoot, "mcporter.json"), "external\n")
    await fs.symlink(externalRoot, symlinkedDir)

    await expect(removeManagedPathIfExists(targetPath)).rejects.toThrow("symlinked ancestor")

    expect(await fs.readFile(path.join(externalRoot, "mcporter.json"), "utf8")).toBe("external\n")
  })

  test("rejects plain file deletes through symlinked ancestor directories", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir, "files-plain-delete-ancestor-symlink-"))
    const externalRoot = path.join(tempRoot, "external")
    const managedRoot = path.join(tempRoot, "managed")
    const symlinkedDir = path.join(managedRoot, "compound-engineering")
    const targetPath = path.join(symlinkedDir, "mcporter.json")

    await fs.mkdir(externalRoot, { recursive: true })
    await fs.mkdir(managedRoot, { recursive: true })
    await fs.writeFile(path.join(externalRoot, "mcporter.json"), "external\n")
    await fs.symlink(externalRoot, symlinkedDir)

    await expect(removeFileIfExists(targetPath)).rejects.toThrow("symlinked ancestor")

    expect(await fs.readFile(path.join(externalRoot, "mcporter.json"), "utf8")).toBe("external\n")
  })

  test("preserves source permissions when creating backups", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir, "files-backup-perms-"))
    const sourcePath = path.join(tempRoot, "mcporter.json")

    await fs.writeFile(sourcePath, "{}\n", { mode: 0o600 })
    await fs.chmod(sourcePath, 0o600)

    const backupPath = await backupFile(sourcePath)
    expect(backupPath).toBeDefined()

    const stats = await fs.stat(backupPath!)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  test("updates file mode even when atomic binary content is unchanged", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir, "files-atomic-mode-only-update-"))
    const targetPath = path.join(tempRoot, "script.sh")

    await writeFileAtomicIfChanged({
      filePath: targetPath,
      content: Buffer.from("#!/bin/sh\necho hi\n"),
      mode: 0o644,
    })

    await writeFileAtomicIfChanged({
      filePath: targetPath,
      content: Buffer.from("#!/bin/sh\necho hi\n"),
      mode: 0o755,
    })

    expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755)
  })

  test("updates file mode even when atomic text content is unchanged", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir, "files-atomic-text-mode-only-update-"))
    const targetPath = path.join(tempRoot, "skill.md")

    await writeTextAtomicIfChanged({
      filePath: targetPath,
      content: "Body\n",
      mode: 0o644,
    })

    await writeTextAtomicIfChanged({
      filePath: targetPath,
      content: "Body\n",
      mode: 0o755,
    })

    expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755)
  })

  test("allows generic text writes through symlinked parent directories", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir, "files-write-text-symlink-parent-"))
    const realRoot = path.join(tempRoot, "real-root")
    const symlinkRoot = path.join(tempRoot, "symlink-root")
    const targetPath = path.join(symlinkRoot, "nested", "note.txt")

    await fs.mkdir(realRoot, { recursive: true })
    await fs.symlink(realRoot, symlinkRoot)

    await writeText(targetPath, "hello\n")

    expect(await fs.readFile(path.join(realRoot, "nested", "note.txt"), "utf8")).toBe("hello\n")
  })

  test("rejects removal when target path is a symlink", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir, "files-remove-symlink-target-"))
    const realFile = path.join(tempRoot, "real-file.txt")
    const symlinkPath = path.join(tempRoot, "link-to-file.txt")

    await fs.writeFile(realFile, "original content\n")
    await fs.symlink(realFile, symlinkPath)

    await expect(removeFileIfExists(symlinkPath)).rejects.toThrow("Refusing to remove symlink target")

    // Both the symlink and original file remain intact
    expect(await fs.readFile(realFile, "utf8")).toBe("original content\n")
    const linkStat = await fs.lstat(symlinkPath)
    expect(linkStat.isSymbolicLink()).toBe(true)
  })

  test("rejects snapshot restore through symlinked ancestor directories", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir, "files-restore-ancestor-symlink-"))
    const managedRoot = path.join(tempRoot, "managed")
    const safeParent = path.join(managedRoot, "prompts")
    const targetPath = path.join(safeParent, "plan-review.md")
    const snapshotRoot = path.join(tempRoot, "snapshots")
    const externalRoot = path.join(tempRoot, "external")

    await fs.mkdir(safeParent, { recursive: true })
    await fs.mkdir(snapshotRoot, { recursive: true })
    await fs.mkdir(externalRoot, { recursive: true })
    await fs.writeFile(targetPath, "original\n")

    const snapshot = await captureManagedPathSnapshot(targetPath, snapshotRoot)

    await fs.rename(safeParent, `${safeParent}-bak`)
    await fs.symlink(externalRoot, safeParent)

    await expect(restoreManagedPathSnapshot(snapshot)).rejects.toThrow("symlinked ancestor")

    await expect(fs.access(path.join(externalRoot, "plan-review.md"))).rejects.toBeDefined()
  })
})

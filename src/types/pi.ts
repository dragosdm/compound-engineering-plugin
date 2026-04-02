export type PiNameMaps = {
  agents?: Record<string, string>
  skills?: Record<string, string>
  prompts?: Record<string, string>
}

export type PiPrompt = {
  name: string
  content: string
  sourceName?: string
}

export type PiSkillDir = {
  name: string
  sourceDir: string
  sourceName?: string
}

export type PiGeneratedSkill = {
  name: string
  content: string
  sourceName?: string
}

export type PiExtensionFile = {
  name: string
  content: string
}

export type PiMcporterServer = {
  description?: string
  baseUrl?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

export type PiMcporterConfig = {
  mcpServers: Record<string, PiMcporterServer>
}

export type PiBundle = {
  pluginName?: string
  prompts: PiPrompt[]
  skillDirs: PiSkillDir[]
  generatedSkills: PiGeneratedSkill[]
  extensions: PiExtensionFile[]
  mcporterConfig?: PiMcporterConfig
  nameMaps?: PiNameMaps
}

export type PiManagedArtifact = {
  kind: "prompt" | "generated-skill" | "skill-dir" | "synced-skill" | "copied-skill"
  sourceName: string
  emittedName: string
  relativePath: string
}

export type PiManagedLegacyArtifact = {
  sourceName: string
  outputPath: string
}

export type PiManagedSection = {
  nameMaps?: PiNameMaps
  artifacts?: PiManagedArtifact[]
  mcpServers?: string[]
  sharedResources?: {
    compatExtension?: boolean
    mcporterConfig?: boolean
  }
}

export type PiManagedManifest = {
  version: number
  pluginName?: string
  policyFingerprint?: string
  nameMaps?: PiNameMaps
  install?: PiManagedSection
  sync?: PiManagedSection
  installPrompts?: PiManagedLegacyArtifact[]
  syncPrompts?: PiManagedLegacyArtifact[]
  generatedSkills?: PiManagedLegacyArtifact[]
}

export type PiManagedVerificationStatus =
  | "verified"
  | "tampered"
  | "missing"
  | "invalid"
  | "legacy"
  | "stale"

export interface PiSyncHooks {
  rerunMode?: "narrow" | "full"
  onPass?: (payload: { passNumber: number; activeCommandNames: string[]; activeSkillNames: string[] }) => void | Promise<void>
  onCommandConversion?: () => void | Promise<void>
  onFullCompare?: (targetDir: string) => void | Promise<void>
  onSourceFingerprint?: (sourceDir: string) => void | Promise<void>
  onSourceAnalysis?: (sourceDir: string) => void | Promise<void>
  policyFingerprintOverride?: string
}

export type PiManagedVerificationRecord = {
  version?: number
  root?: string
  manifestPath?: string
  policyFingerprint?: string
  install?: {
    hash?: string
  }
  sync?: {
    hash?: string
  }
}

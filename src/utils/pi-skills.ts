// Barrel re-exports for backward compatibility.
// The implementation has been split into focused modules:
//   - pi-name-normalization.ts: skill name normalization and uniqueness
//   - pi-content-transform.ts: markdown body transformation and reference rewriting
//   - pi-skill-materialization.ts: file/directory materialization with symlink safety
//   - pi-skill-incremental.ts: incremental diff planning, atomic application, and fast-path caching

export type { PiNameMaps } from "../types/pi"

export { normalizePiSkillName, uniquePiSkillName, buildPiSameRunQualifiedNameMap } from "./pi-name-normalization"

export {
  PI_CE_SUBAGENT_TOOL,
  type PiTransformOptions,
  collectPiSameRunDependencies,
  transformPiBodyContent,
  renderPiSkillContent,
  appendCompatibilityNoteIfNeeded,
  collectPiMarkdownLineDependencies,
  normalizePiTaskAgentName,
  normalizePiSkillReferenceName,
  normalizePiPromptReferenceName,
  resolvePiMappedName,
  formatPiFrontmatter,
  splitRawAtFrontmatterEnd,
} from "./pi-content-transform"

export {
  type PiMaterializationOptions,
  type PiSkillMutationHooks,
  skillFileMatchesPiTarget,
  piSkillTargetMatchesMaterializedSource,
  preparePiSkillTargetForReplacement,
  copyDirForPiMaterialization,
  rewriteSkillFileForPi,
  materializedDirMatches,
  materializedSkillFileMatches,
  fileContentsMatch,
  removePiMaterializedPath,
  resolvePiMaterializedEntry,
  cyclicPiSkillSymlinkError,
  validatePiSkillSourceForPi,
} from "./pi-skill-materialization"

export {
  copySkillDirForPi,
  applyPiIncrementalOps,
  ensureSafePiMutationTarget,
} from "./pi-skill-incremental"

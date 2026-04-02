import { createHash } from "crypto"

const PI_FOREIGN_TASK_POLICY_VERSION = "foreign-qualified-default-deny-v1"
const PI_POLICY_FINGERPRINT_ENV = "COMPOUND_ENGINEERING_PI_POLICY_FINGERPRINT"

export function getPiPolicyFingerprint(override?: string | null): string {
  if (override) return override
  const envOverride = process.env[PI_POLICY_FINGERPRINT_ENV]?.trim()
  if (envOverride) return envOverride
  return createHash("sha256").update(PI_FOREIGN_TASK_POLICY_VERSION).digest("hex")
}

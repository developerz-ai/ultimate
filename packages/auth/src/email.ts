// Single responsibility: the ONE normalisation an email address gets before anything uses it as an
// identity key — a user lookup, a user insert, or the lockout bucket that has to key the same way
// those two do. It lives above the `AuthAdapter` seam because an adapter that normalises hides a
// caller that forgot to: `MemoryAdapter` did and `BuiltinAdapter` did not, so "does this account
// exist" had two answers, one under `x dev` and another in production.

/**
 * Trim, then lowercase. Nothing else, deliberately: stripping a `+tag` or a gmail dot would MERGE
 * two addresses a person kept apart on purpose, which is an account takeover between colleagues at
 * one domain rather than a convenience. RFC 5321 makes the local part case-sensitive in theory and
 * no mail provider in practice treats it that way, so folding case is what stops one human holding
 * two accounts at one address — and `x_users.email` is a plain `text ... unique`, whose uniqueness
 * is exactly this string.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

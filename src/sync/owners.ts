/**
 * Accounts allowed to sync.
 *
 * The real enforcement is in `firestore.rules` — this list only exists so a
 * wrong account gets told what happened instead of a bare PERMISSION_DENIED.
 * Keep the two in step: adding someone here without redeploying the rules
 * gets them a friendly UI and no data.
 */
export const OWNER_EMAILS = ['ratna.teja06@gmail.com'] as const

export function isOwner(email: string | null | undefined): boolean {
  if (!email) return false
  return OWNER_EMAILS.some((allowed) => allowed.toLowerCase() === email.toLowerCase())
}

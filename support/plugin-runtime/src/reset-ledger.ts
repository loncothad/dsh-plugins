/** Bound retries to the originally checked entitlement without inventing another redemption. */
export class ResetLedger {
  private readonly entries = new Map<string, { account: string; reset: string; expires: number }>()
  authorize(request: string, account: string, reset: string, available: boolean): void {
    const now = Date.now()
    for (const [key, value] of this.entries) if (value.expires <= now) this.entries.delete(key)
    const previous = this.entries.get(request)
    if (previous) {
      if (previous.account !== account || previous.reset !== reset)
        throw new Error('A reset request ID cannot target another account or entitlement')
      return
    }
    if (!available) throw new Error('That reset is no longer available. Refresh status.')
    if (this.entries.size >= 128)
      throw new Error('Too many recent reset operations. Try again later.')
    this.entries.set(request, { account, reset, expires: now + 15 * 60000 })
  }
}

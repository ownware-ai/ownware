/**
 * ChannelCredentialResolver (CC3) — the narrow seam between channel
 * procedures and wherever channel-provider credentials actually live.
 *
 * OWNER DECISION PENDING (board §9.2): engine-provisioned channel tokens in
 * the gateway vault vs the shuttle channel store. Procedures depend only on
 * this interface, so that decision changes the WIRING, not the procedures.
 * Today `ownware serve` wires it to the shuttle channel store (the BYO path
 * — the dev put the credentials there with `ownware channel add`).
 *
 * Resolved values ARE secrets. They may be used inside procedure step code
 * (provider calls) and must never be written to job params/state/gates/
 * work lines/receipts — the store's secret-key tripwire backstops this.
 */

export interface ChannelCredentialResolver {
  /** Credentials for a stored channel, or null when the channel is unknown. */
  resolve(channelId: string): Promise<Readonly<Record<string, string>> | null>
}

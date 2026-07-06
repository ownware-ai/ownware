/**
 * @ownware/shuttle/channels — connect/manage channels + run them from a store.
 *
 *   ownware channel add telegram --profile acme --token 123:abc
 *   ownware channel start
 *
 * Or programmatically:
 *   const store = new FileChannelStore({ dir: '~/.ownware/channels' })
 *   await channelAdd(store, { channel: 'telegram', profileId: 'acme', credentials: { token } })
 *   const runner = new ChannelRunner(store, { gatewayUrl: 'http://127.0.0.1:3011' })
 *   await runner.start()
 */

export type { ChannelKind, ChannelConfig } from './config.js'
export { REQUIRED_CREDENTIALS, CHANNEL_KINDS, isChannelKind, validateChannelConfig } from './config.js'

export type { ChannelStore, FileChannelStoreOptions } from './store.js'
export { InMemoryChannelStore, FileChannelStore } from './store.js'

export type { RunnableShuttle, ShuttleFactory, ShuttleFactoryDeps, ChannelRunnerOptions } from './runner.js'
export { ChannelRunner, defaultShuttleFactory } from './runner.js'

export type { AddChannelArgs, ChannelCliDeps } from './cli.js'
export { channelAdd, channelList, channelRemove, runChannelCli } from './cli.js'

export type { PairingStore, FilePairingStoreOptions } from '../pairing.js'
export { FilePairingStore, InMemoryPairingStore, PairingRateLimitError } from '../pairing.js'

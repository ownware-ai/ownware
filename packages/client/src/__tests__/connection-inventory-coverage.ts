import type { OwnwareClient } from '../client.js'

export const PCC05_CONNECTION_INVENTORY = {
  operationId: 'listConnections',
  capabilityId: 'connections.list',
  capabilityVersion: 1,
  sdkMethod: 'connections' as keyof OwnwareClient,
  proofFile: 'packages/cortex/tests/framework/contracts/connection-inventory.contract.ts',
  proofTitle: 'returns only latest safe states and never implies that connection grants access',
} as const

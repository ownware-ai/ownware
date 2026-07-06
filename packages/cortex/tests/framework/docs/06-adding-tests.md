# Adding Tests — Contribution Guide

## When to Add Tests

| Event | What to Add |
|-------|------------|
| New endpoint added | Contract test for the endpoint |
| New response type in types.ts | Zod schema in schema-validator.ts |
| New SSE event type | Case in run.contract.ts |
| New client screen | Journey test for the screen's flow |
| New user-facing feature | Journey test for the happy path + error cases |
| Performance concern | Stress test |

## How to Add a Contract Test

1. Open the contract file for the domain (e.g., `contracts/threads.contract.ts`)

2. Add a Zod schema in `harness/schema-validator.ts` if the response type
   doesn't have one yet:
   ```typescript
   export const MyNewTypeSchema = z.object({
     id: z.string(),
     name: z.string(),
     // ... every field from types.ts
   })
   ```

3. Add the test:
   ```typescript
   it('GET /api/v1/my-endpoint returns correct shape', async () => {
     const { status, body } = await gw.client.get(
       '/api/v1/my-endpoint',
       MyNewTypeSchema,  // Auto-validates
     )
     expect(status).toBe(200)
     // Additional assertions...
   })
   ```

4. Add error cases:
   ```typescript
   it('returns 404 for non-existent ID', async () => {
     const { status, body } = await gw.client.get(
       '/api/v1/my-endpoint/nonexistent',
       ApiErrorSchema,
     )
     expect(status).toBe(404)
     expect(body.error).toBeDefined()
     expect(body.message).toBeDefined()
   })
   ```

## How to Add a Journey Test

1. Create a new file: `journeys/NN-descriptive-name.journey.ts`

2. Use the shared harness:
   ```typescript
   import { createTestGateway, type TestGateway } from '../harness/gateway.js'

   describe('Journey: Descriptive Name', () => {
     let gw: TestGateway

     beforeAll(async () => {
       gw = await createTestGateway({
         profiles: [{ name: 'my-profile', model: '...' }],
       })
     })

     afterAll(async () => {
       await gw.stop()
     })

     it('step 1: setup', async () => { ... })
     it('step 2: action', async () => { ... })
     it('step 3: verify', async () => { ... })
   })
   ```

3. Steps should be sequential (each depends on prior state).
   Use `let` variables to pass IDs between steps.

4. For LLM calls, use `describe.skipIf(!process.env.ANTHROPIC_API_KEY)`.

## How to Add a Stress Test

1. Create: `stress/descriptive-name.stress.ts`

2. Use larger data volumes or concurrent operations.

3. Always verify data integrity after the stress operation
   (no corrupt rows, no lost data, no duplicates).

## Naming Conventions

- Contract files: `domain.contract.ts`
- Journey files: `NN-descriptive-name.journey.ts` (numbered for order)
- Stress files: `descriptive-name.stress.ts`
- Schemas: `TypeNameSchema` matching the interface name in types.ts
- Test names: descriptive, action-oriented ("creates thread with workspace")

## Fixture Recording

When you add a new contract test for a response type the frontend
will consume, add fixture recording:

```typescript
it('GET /api/v1/threads returns thread list', async () => {
  const response = await gw.client.get('/api/v1/threads', PaginatedThreadsSchema)
  gw.recorder.record('threads-list', response)
  // ... assertions
})
```

Run `RECORD_FIXTURES=1 npx vitest run tests/framework/contracts/`
to generate the fixture files.

## Checklist Before Submitting

- [ ] New types have Zod schemas in schema-validator.ts
- [ ] New endpoints have contract tests (happy path + error cases)
- [ ] New flows have journey tests
- [ ] All tests pass: `npx vitest run tests/framework/`
- [ ] No hardcoded ports or paths (use harness)
- [ ] No mocks (real gateway, real DB)
- [ ] LLM tests gated behind API key check

# @ownware/shuttle

## 0.4.0

### Minor Changes

- 98fa75d: Make the production WhatsApp Cloud API text flow restart-safe: durably own and
  deduplicate inbound WAMIDs before webhook acknowledgement, preserve customer
  thread bindings, fence Gateway runs, journal per-chunk outbound attempts,
  reconcile Meta delivery statuses, preserve unknown send outcomes without blind
  resend, and add explicit operator-controlled human handoff commands.

### Patch Changes

- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
- Updated dependencies [98fa75d]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
  - @ownware/client@0.4.0

## 0.3.0

### Minor Changes

- Webhook channels get an HTTP host: `ChannelWebhookHost` mounts stored
  WhatsApp/SMS channels at per-channel paths (`/webhooks/whatsapp/<id>`,
  `/webhooks/sms/<id>`), handles the Meta GET verification handshake, verifies
  provider signatures on the raw body before anything else, answers 200 fast and
  drives the agent asynchronously, dedups re-delivered provider message ids, and
  drops payloads addressed to a different phone_number_id. `ownware serve` and
  `ownware-channel start` start it automatically when an enabled webhook channel
  exists (loopback bind by default — put a tunnel or reverse proxy in front;
  `OWNWARE_WEBHOOK_PORT`/`OWNWARE_WEBHOOK_HOST`/`OWNWARE_WEBHOOK_PUBLIC_URL`).
  Previously the WhatsApp/SMS adapters were library-only: nothing mounted them.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @ownware/client@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies
  - @ownware/client@0.2.0

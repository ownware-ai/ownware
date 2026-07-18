# @ownware/shuttle

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

# `@ownware/cli`

Chat with an Ownware agent from the terminal.

The CLI is a client of the public Ownware HTTP and SSE contract. It can start
a loopback gateway for local use or attach to an existing gateway.

## Install

```bash
npm install --global @ownware/cli
```

Node.js 22 or newer is required.

## Start locally

```bash
cd your-project
ownware-cli
```

No cloud key is required when you use a local Ollama model:

```bash
ollama pull llama3.2
ownware-cli --model ollama:llama3.2
```

State is stored under `~/.ownware` by default. Override it with
`--data-dir` or `OWNWARE_DATA_DIR`.

## Attach to a gateway

```bash
ownware-cli attach https://gateway.example \
  --token "$OWNWARE_GATEWAY_TOKEN" \
  --profile assistant
```

## Use from scripts

```bash
ownware-cli exec \
  --profile assistant \
  --prompt "Summarize the release notes" \
  --output json
```

Headless execution denies approval requests rather than guessing consent.
Interactive chat displays approval cards and accepts an explicit `y` or `n`.

Run `ownware-cli --help` for profile, model, resume, gateway, debugging, and
plain-renderer options.

See the [Ownware repository](https://github.com/ownware-ai/ownware) for the
gateway, profile format, security model, and Apache-2.0 license.

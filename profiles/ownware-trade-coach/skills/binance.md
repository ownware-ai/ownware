---
name: binance
description: Use binance-cli for Binance Spot, Futures (USD-S / COIN-M), Options, Convert, Margin, Earn, Staking, Wallet, and 17 more product surfaces. Requires auth.
trigger: /binance
allowedTools:
  - shell_execute
  - readFile
  - glob
---

<!-- cortex:source https://github.com/binance/binance-skills-hub/blob/main/skills/binance/binance/SKILL.md -->
<!-- Adapted: frontmatter rewritten for the Cortex/Loom skill loader. Body and references preserved verbatim. -->

# Binance

Use `binance-cli` for Binance Spot, Futures (USD-S), and Convert. Requires auth.

> **PREREQUISITE:** Read [`auth.md`](./references/binance/auth.md) for auth, global flags, and security rules.

## Helper Commands

| Command | Description |
|---------|-------------|
| [`algo`](./references/binance/algo.md) | Algo Trading |
| [`alpha`](./references/binance/alpha.md) | Alpha |
| [`c2c`](./references/binance/c2c.md) | C2C |
| [`convert`](./references/binance/convert.md) | Convert |
| [`copy-trading`](./references/binance/copy-trading.md) | Copy Trading |
| [`crypto-loan`](./references/binance/crypto-loan.md) | Crypto Loan |
| [`derivatives-options`](./references/binance/derivatives-options.md) | Derivatives Trading (Options) |
| [`derivatives-portfolio-margin`](./references/binance/derivatives-portfolio-margin.md) | Derivatives Trading (Portfolio Margin) |
| [`derivatives-portfolio-margin-pro`](./references/binance/derivatives-portfolio-margin-pro.md) | Derivatives Trading (Portfolio Margin Pro) |
| [`dual-investment`](./references/binance/dual-investment.md) | Dual Investment |
| [`fiat`](./references/binance/fiat.md) | Fiat |
| [`futures-coin`](./references/binance/futures-coin.md) | Derivatives Trading (COIN-M Futures) |
| [`futures-usds`](./references/binance/futures-usds.md) | Derivatives Trading (USDS-M Futures) |
| [`gift-card`](./references/binance/gift-card.md) | Gift Card |
| [`margin-trading`](./references/binance/margin-trading.md) | Margin Trading |
| [`mining`](./references/binance/mining.md) | Mining |
| [`pay`](./references/binance/pay.md) | Pay |
| [`rebate`](./references/binance/rebate.md) | Rebate |
| [`simple-earn`](./references/binance/simple-earn.md) | Simple Earn |
| [`spot`](./references/binance/spot.md) | Spot Trading |
| [`staking`](./references/binance/staking.md) | Staking |
| [`sub-account`](./references/binance/sub-account.md) | Sub Account |
| [`vip-loan`](./references/binance/vip-loan.md) | VIP Loan |
| [`wallet`](./references/binance/wallet.md) | Wallet |

## Setup

If `binance-cli` is not installed, install it once:

```bash
npm install -g @binance/binance-cli
```

Then authenticate (choose one):

```bash
# Option A — environment variables
export BINANCE_API_KEY=<your_api_key>
export BINANCE_SECRET_KEY=<your_api_secret>

# Option B — managed profile (preferred for multiple accounts / testnet)
binance-cli profile create --name cortex --api-key <your_api_key> --api-secret <your_api_secret> --env testnet
binance-cli profile select --name cortex
```

Default to `--env testnet` while you trial. Switch to `prod` only when the trader explicitly asks for live execution.

## Notes

- ⚠️ **Prod transactions** — always ask user to type `CONFIRM` before executing. Read the command back to them character-for-character first; this is the same gate the Coach enforces in SOUL.md.
- Append `--profile <name>` to any command to use a non-active profile.
- All authenticated endpoints accept optional `--recvWindow <ms>` (max 60 000).
- Timestamps (`startTime`, `endTime`) are Unix ms.
- For endpoints not listed in the skill, use `binance-cli request (GET|POST|PUT...) <url> [--signed]`. Any parameters can be added to the request (e.g: `--param1 value --param2 value`).

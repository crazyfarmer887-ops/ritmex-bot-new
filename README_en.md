# ritmex-bot

A Bun-powered multi-exchange perpetuals workstation that ships an SMA30 trend engine, a Guardian stop sentinel, and two market-making modes. It offers instant restarts, realtime market data, structured logging, and an Ink-based CLI dashboard.

* [Aster referral (30% fee discount)](https://www.asterdex.com/en/referral/4665f3)
* [Binance referral link](https://www.binance.com/join?ref=KNKCA9XC)
* [GRVT referral link](https://grvt.io/exchange/sign-up?ref=sea)
* [Backpack referral link](https://backpack.exchange/join/ritmex)
* [edgex referral link](https://pro.edgex.exchange/referral/BULL)
* [Paradex referral link](https://paradex.io/ref/xingxingjun)
* [Apex referral link](https://join.omni.apex.exchange/RITHMEX)

## Documentation Map
- [中文 README](README.md)
- [Beginner-friendly Quick Start](simple-readme.md)

## Highlights
- **Live data & risk sync** via websockets with REST fallbacks and full reconciliation on restart.
- **Trend strategy** featuring SMA30 entries, fixed stop loss, trailing stop, Bollinger bandwidth gate, and profit-lock stepping.
- **Guardian strategy** that never opens trades but mirrors your live exposure, ensuring every position has a synced stop loss and trailing stop.
- **Market-making loop** with dual-sided quote chasing, loss caps, and automatic order healing.
- **Modular architecture** decoupling engines, exchange adapters, and the Ink CLI for easy venue or strategy extensions.

## Supported Exchanges
| Exchange | Contract Type | Required Environment Variables | Notes |
| --- | --- | --- | --- |
| Aster | USDT perpetuals | `ASTER_API_KEY`, `ASTER_API_SECRET` | Default venue; works with the bootstrap script |
| GRVT | USDT perpetuals | `GRVT_API_KEY`, `GRVT_API_SECRET`, `GRVT_SUB_ACCOUNT_ID` | Switch `GRVT_ENV` between `prod` and `testnet` |
| Lighter | zkLighter perpetuals | `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_PRIVATE_KEY` | Defaults to `LIGHTER_ENV=testnet` |
| Backpack | USDC perpetuals | `BACKPACK_API_KEY`, `BACKPACK_API_SECRET`, `BACKPACK_PASSWORD` | Set `BACKPACK_SANDBOX=true` for the sandbox |
| Paradex | StarkEx perpetuals | `PARADEX_PRIVATE_KEY`, `PARADEX_WALLET_ADDRESS` | Toggle `PARADEX_SANDBOX=true` for the testnet |

## Requirements
- Bun ≥ 1.2 (both `bun` and `bunx` on PATH)
- macOS, Linux, or Windows via WSL (native Windows works but WSL is recommended)
- Node.js is optional unless your tooling requires it

## Quick Start
### One-line bootstrap (macOS / Linux / WSL)
```bash
curl -fsSL https://github.com/discountry/ritmex-bot/raw/refs/heads/main/setup.sh | bash
```
The script installs Bun, project dependencies, collects Aster API credentials, generates `.env`, and launches the CLI. Prepare the relevant exchange API keys before running it.

### Manual installation
1. **Clone the repository**
   ```bash
   git clone https://github.com/discountry/ritmex-bot.git
   cd ritmex-bot
   ```
   Alternatively, download the ZIP from GitHub and extract it manually.
2. **Install Bun**
   - macOS / Linux: `curl -fsSL https://bun.sh/install | bash`
   - Windows PowerShell: `powershell -c "irm bun.sh/install.ps1 | iex"`
   Re-open the terminal and verify `bun -v` prints a version.
3. **Install dependencies**
   ```bash
   bun install
   ```
4. **Create your environment file**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with the exchange credentials and overrides you plan to use.
5. **Launch the CLI**
   ```bash
   bun run index.ts
   ```
   Use the arrow keys to pick a strategy, `Enter` to start, `Esc` to go back, and `Ctrl+C` to exit.

## Shared Configuration
`.env.example` captures all defaults; the most common settings are summarised below.

| Variable | Purpose |
| --- | --- |
| `EXCHANGE` | Choose the venue (`aster` / `grvt` / `lighter` / `backpack` / `paradex`) |
| `TRADE_SYMBOL` | Contract symbol (defaults to `BTCUSDT`) |
| `TRADE_AMOUNT` | Order size in base asset units |
| `LOSS_LIMIT` | Max per-trade loss in USDT before forced close |
| `TRAILING_PROFIT` / `TRAILING_CALLBACK_RATE` | Trailing stop trigger (USDT) and pullback percentage |
| `PROFIT_LOCK_TRIGGER_USD` / `PROFIT_LOCK_OFFSET_USD` | Profit lock trigger and offset thresholds |
| `BOLLINGER_*` | Bollinger bandwidth filters for the trend engine |
| `PRICE_TICK` / `QTY_STEP` | Exchange precision filters for price and quantity |
| `POLL_INTERVAL_MS` | Trend engine polling cadence in milliseconds |
| `MAX_CLOSE_SLIPPAGE_PCT` | Allowed deviation vs mark price when closing |
| `MAKER_*` | Maker-specific knobs (quote offsets, refresh cadence, slippage guard, etc.) |

> CLI flags override environment variables at runtime:
> ```bash
> bun run index.ts --exchange grvt --strategy maker
> bun run index.ts -e lighter -s offset-maker --silent
> ```

## Exchange Setup Guides
### Aster
1. Keep `EXCHANGE=aster` (default value).
2. Supply `ASTER_API_KEY` and `ASTER_API_SECRET`.
3. Adjust `TRADE_SYMBOL`, `PRICE_TICK`, and `QTY_STEP` to match the requested market.
4. The bootstrap script auto-populates these variables; manual installs must maintain them.

### GRVT
1. Set `EXCHANGE=grvt` inside `.env`.
2. Fill `GRVT_API_KEY`, `GRVT_API_SECRET`, and `GRVT_SUB_ACCOUNT_ID`.
3. Use `GRVT_ENV=testnet` when targeting the test environment, and align `GRVT_INSTRUMENT` / `GRVT_SYMBOL`.
4. Optional: provide `GRVT_COOKIE` or a custom `GRVT_SIGNER_PATH` when reusing an existing session.

### Lighter
1. Set `EXCHANGE=lighter`.
2. Provide `LIGHTER_ACCOUNT_INDEX` and `LIGHTER_API_PRIVATE_KEY` (40-byte hex private key).
3. Switch `LIGHTER_ENV` to `mainnet`, `staging`, or `dev` when necessary; override `LIGHTER_BASE_URL` if endpoints differ.
4. `LIGHTER_SYMBOL` defaults to `BTCUSDT`; override price/size decimals when markets differ.

### Backpack
1. Set `EXCHANGE=backpack`.
2. Populate `BACKPACK_API_KEY`, `BACKPACK_API_SECRET`, and `BACKPACK_PASSWORD`; add `BACKPACK_SUBACCOUNT` if you trade from a subaccount.
3. Toggle `BACKPACK_SANDBOX=true` for the sandbox environment and verify `BACKPACK_SYMBOL` matches the contract (defaults to `BTC_USD_PERP`).
4. Enable `BACKPACK_DEBUG=true` for verbose adapter logging.

### Paradex
1. Set `EXCHANGE=paradex`.
2. Provide `PARADEX_PRIVATE_KEY` (EVM private key) and `PARADEX_WALLET_ADDRESS`.
3. The adapter connects to mainnet by default; enable `PARADEX_SANDBOX=true` and adjust `PARADEX_SYMBOL` for testnet usage.
4. Advanced tuning: use `PARADEX_USE_PRO`, `PARADEX_RECONNECT_DELAY_MS`, or debug flags as needed.

## GRVT-BingX Hedge Mode
- **Concept**: go long on GRVT and short on BingX with the same size, then arm reduce-only take-profit orders as soon as exposure appears so the spread is captured at a pre-defined ROI (`HEDGE_EXIT_ROI_PERCENT`).
- **Key environment variables**:
  - `HEDGE_ORDER_AMOUNT`: hedge size in base units. Start small (for example `0.001`) and scale gradually once funding and leverage are confirmed.
  - `HEDGE_EXIT_ROI_PERCENT`: ROI target expressed as a percentage. The default `5` translates to +5% on the long leg and -5% on the short leg relative to the blended entry.
  - `HEDGE_AUTO_RESTART`: automatically re-arm the next hedge cycle after both exit orders fill. Defaults to `true`.
  - `HEDGE_GRVT_SYMBOL` / `HEDGE_BINGX_SYMBOL`: override the contract symbols per venue when they differ from global defaults (`GRVT_SYMBOL`, `BINGX_SYMBOL`, or `TRADE_SYMBOL`).
  - Precision overrides (`HEDGE_GRVT_PRICE_TICK`, `HEDGE_GRVT_QTY_STEP`, `HEDGE_BINGX_PRICE_TICK`, `HEDGE_BINGX_QTY_STEP`) should mirror each market’s tick size and lot step.
- **How to run**:
  1. Place GRVT and BingX API credentials in `.env`, ensure one-way mode is enabled, and pre-set leverage on both sides.
  2. Configure the hedge variables listed above.
  3. Launch via `bun run index.ts` and choose `GRVT-BingX Hedge`, or run silently with `bun run index.ts --strategy grvt-bingx-hedge --silent`.
  4. The Ink dashboard shows the current cycle, auto-restart flag, blended entry, projected exit prices, and a live event log.
- **Status reference**:
  - `waiting-market`: synchronising account, order, and depth feeds on both venues.
  - `placing-entry` / `entry-working`: posting limit buys on GRVT and limit sells on BingX at the top of book until both legs fill.
  - `placing-exit`: once exposure is detected, take-profit orders are placed immediately (reduceOnly).
  - `exit-working`: the hedge is active and waiting for ROI targets to fill. When positions flatten the cycle completes and, if `HEDGE_AUTO_RESTART=true`, the engine re-arms automatically.
- **Risk suggestions**: keep healthy margin on both exchanges, pre-set leverage manually, and pause the engine if either leg shows a residual position—the strategy will wait for a flat state before entering again.

## Command Cheatsheet
```bash
bun run index.ts   # Launch the CLI (default entrypoint)
bun run start      # Alias for bun run index.ts
bun run dev        # Development entrypoint
bun x vitest run   # Execute the full Vitest suite
```

## Silent & Background Execution
### Direct silent launch
Skip the Ink menu and start a strategy directly:
```bash
bun run index.ts --strategy trend --silent
bun run index.ts --strategy maker --silent
bun run index.ts --strategy offset-maker --silent
```
Combine with `--exchange/-e` to pin the venue for that run.

### Package scripts
Convenience aliases exposed via `package.json`:
```bash
bun run start:trend:silent
bun run start:maker:silent
bun run start:offset:silent
```

### Daemonising with pm2
Install `pm2` locally (e.g. `bun add -d pm2`) and launch the process:
```bash
bunx pm2 start bun --name ritmex-trend --cwd . --restart-delay 5000 -- run index.ts --strategy trend --silent
```
You can also call the bundled scripts:
```bash
bun run pm2:start:trend
bun run pm2:start:maker
bun run pm2:start:offset
```
Run `pm2 save` afterwards if you want the process list to survive reboots.

## Testing
Powered by Vitest:
```bash
bun run test
bun x vitest --watch
```

## Troubleshooting
- Keep at least 50–100 USDT in the account before deploying a live strategy.
- Configure leverage on the exchange manually (~50x is recommended); the bot will not change it.
- Ensure your server or workstation clock is in sync to avoid signature errors.
- Accounts must run in one-way position mode.
- **Env not loading**: make sure `.env` lives in the repo root and variable names are spelled correctly.
- **Permission rejected**: confirm the API key has perpetual trading scopes enabled.
- **Precision errors**: align `PRICE_TICK`, `QTY_STEP`, and `TRADE_SYMBOL` with the exchange filters.
See [simple-readme.md](simple-readme.md) for more detailed walkthroughs.

## Community & Support
- Telegram: [https://t.me/+4fdo0quY87o4Mjhh](https://t.me/+4fdo0quY87o4Mjhh)
- Issues and PRs are welcome for bug reports and feature requests

## Disclaimer
Algorithmic trading carries risk. Validate strategies with paper trading or small capital first, safeguard your API keys, and only grant the minimum required permissions.

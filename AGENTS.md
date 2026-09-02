# Repository instructions

## bit.onsites.me production safety

These rules apply to every task touching `bit-site/` or the `bit.onsites.me` Worker.

- Treat `/LINKI`, `/VPNAH`, and `/VPNAH/tutorial` as three independently protected routes.
- A request concerning one protected route does not authorize changing either of the others.
- Do not use `wrangler deploy`, `wrangler rollback`, or `wrangler versions deploy` directly for the production Worker.
- Do not deploy `bit-onsites` from a temporary directory, historical checkout, detached HEAD, or uncommitted working tree.
- Production releases must run from the canonical repository using `bit-site/scripts/deploy-production.sh`.
- Only pass a route-specific `--allow-route=...` flag when the user explicitly requested a change to that exact route. There is no blanket approval.
- Unrelated asset uploads must preserve all protected responses and their referenced assets. Prefer the separate `bit-image-host` project for standalone images that do not belong to these pages.
- Never use a whole-Worker rollback to restore one page. Restore the requested source file on the latest `main`, then run the guarded deployment.
- After any production release, verify `/`, `/LINKI`, `/VPNAH`, and `/VPNAH/tutorial`; LINKI must retain its own Insight Tag and VPNAH must contain no LinkedIn tracking.

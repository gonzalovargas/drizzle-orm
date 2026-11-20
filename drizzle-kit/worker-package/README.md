# @dino/drizzle-kit-worker

Minimal package artifact for the Worker-safe Postgres schema diff entry maintained on `codex/cloudflare-worker-api`.

It intentionally excludes the Drizzle Kit CLI. Install normal `drizzle-kit` separately for Node/CLI use and import this package only from a Cloudflare Worker.

The generated artifact is pinned to the source commit that contains it. See `../WORKER_API.md` and `../WORKER_MAINTENANCE.md` in the source repository before upgrading.

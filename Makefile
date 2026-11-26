.PHONY: start dev

start:
	pnpm install --frozen-lockfile
	pnpm build
	pnpm start

dev: SHELL := /bin/bash
dev:
	pnpm install --frozen-lockfile
	@set -m; \
	pnpm dev:server & server=$$!; \
	pnpm dev:web & web=$$!; \
	trap 'kill -- -$$server -$$web 2>/dev/null; wait' EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	while kill -0 $$server 2>/dev/null && kill -0 $$web 2>/dev/null; do sleep 1 & wait $$!; done; \
	if kill -0 $$server 2>/dev/null; then wait $$web; else wait $$server; fi

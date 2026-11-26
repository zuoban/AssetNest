.PHONY: start dev

start:
	pnpm install --frozen-lockfile
	pnpm build
	pnpm start

dev: SHELL := /bin/bash
dev:
	pnpm install --frozen-lockfile
	@set -m; \
	mkdir -p data && socket_dir=$$(mktemp -d data/.dev.XXXXXX) || exit 1; \
	export ASSETNEST_DEV_SOCKET="$$socket_dir/api.sock"; \
	cleanup() { \
		if [ -n "$$server" ]; then kill -- -$$server 2>/dev/null; fi; \
		if [ -n "$$web" ]; then kill -- -$$web 2>/dev/null; fi; \
		wait; \
		rmdir "$$socket_dir" 2>/dev/null || true; \
	}; \
	server= web=; \
	trap cleanup EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	pnpm dev:server & server=$$!; \
	pnpm dev:web $${ASSETNEST_DEV_WEB_PORT:+--port "$$ASSETNEST_DEV_WEB_PORT"} & web=$$!; \
	while kill -0 $$server 2>/dev/null && kill -0 $$web 2>/dev/null; do sleep 1 & wait $$!; done; \
	if kill -0 $$server 2>/dev/null; then wait $$web; else wait $$server; fi

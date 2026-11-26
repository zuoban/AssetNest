.PHONY: start

start:
	pnpm install --frozen-lockfile
	pnpm build
	pnpm start

.PHONY: help setup up down logs ps build dev db-generate db-migrate db-push db-studio seed test lint format typecheck clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Enable pnpm + install deps + generate prisma client
	corepack enable && corepack prepare pnpm@9.12.0 --activate
	pnpm install
	pnpm db:generate

up: ## Start full stack in docker
	docker compose up -d --build

infra: ## Start only postgres + redis + monitoring
	docker compose up -d postgres redis prometheus grafana

down: ## Stop the stack
	docker compose down

logs: ## Tail all container logs
	docker compose logs -f --tail=200

ps: ## Show running containers
	docker compose ps

build: ## Build all apps
	pnpm build

dev: ## Run all apps in dev (parallel)
	pnpm dev

db-generate: ## Generate prisma client
	pnpm db:generate

db-migrate: ## Run prisma migrations
	pnpm db:migrate

db-push: ## Push schema without migration (dev only)
	pnpm db:push

db-studio: ## Open prisma studio
	pnpm db:studio

seed: ## Seed reference data
	pnpm db:seed

test: ## Run tests
	pnpm test

lint: ## Lint
	pnpm lint

format: ## Format
	pnpm format

typecheck: ## Typecheck all packages
	pnpm typecheck

clean: ## Remove build artifacts + node_modules
	rm -rf node_modules dist coverage .next **/dist **/.next **/node_modules

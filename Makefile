# gupiao - Makefile for common development tasks
# ================================================

.PHONY: help docs docs-api docs-changelog docs-architecture install-dev lint test

# Default target
help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Documentation Generation
# ------------------------

docs: ## Generate all documentation (API, Changelog, Architecture)
	@echo "🚀 Generating all documentation..."
	python scripts/generate_docs.py --all

docs-api: ## Generate API reference documentation from OpenAPI spec
	@echo "📝 Generating API documentation..."
	python scripts/generate_api_docs.py

docs-changelog: ## Generate changelog from git history
	@echo "📜 Generating changelog..."
	python scripts/generate_changelog.py

docs-architecture: ## Generate architecture diagrams from codebase
	@echo "🏗️  Generating architecture documentation..."
	python scripts/generate_architecture_diagram.py

# Development Setup
# -----------------

install-dev: ## Install development dependencies
	@echo "Installing backend dependencies..."
	cd backend && bun install
	@echo "Installing web dependencies..."
	cd web && bun install

# Code Formatting
# ---------------

format: ## Format all code (Python with Black/ruff, TS/Vue with Prettier)
	@echo "🎨 Formatting all code..."
	python3 scripts/format_code.py

format-check: ## Check if all code is properly formatted
	@echo "🔍 Checking code formatting..."
	python3 scripts/format_code.py --check

format-server: ## Format Python code only
	@echo "⚠️  RETIRED: server/ is no longer the active backend. Use: make format"

format-web: ## Format TypeScript/Vue code only
	@echo "🌐 Formatting TypeScript/Vue code..."
	cd web && bunx prettier --write .

format-backend: ## Format TypeScript code in backend/ (eslint --fix)
	@echo "🧩 Formatting TypeScript (backend/)..."
	cd backend && bun run lint -- --fix

# Code Quality
# ------------

lint-server: ## Lint Python code
	@echo "⚠️  RETIRED: server/ is no longer the active backend. Use: make lint-backend"

lint-web: ## Lint TypeScript/Vue code
	@echo "Linting web code..."
	cd web && bun run lint || true

lint-backend: ## Lint TypeScript backend code
	@echo "Linting backend code..."
	cd backend && bun run lint

lint: lint-backend lint-web ## Run all linters

# Code Complexity Analysis
# ------------------------

complexity: ## Analyze cyclomatic complexity across codebase
	@echo "📊 Analyzing code complexity..."
	python3 scripts/analyze_complexity.py

complexity-server: ## Analyze Python complexity only
	@echo "⚠️  RETIRED: server/ is no longer the active backend."

complexity-web: ## Analyze TypeScript/Vue complexity only
	@echo "🌐 Analyzing TypeScript/Vue complexity..."
	cd web && bun run lint:complexity || true

test-server: ## Run server tests
	@echo "⚠️  RETIRED: server/ is no longer the active backend. Use: make test-backend"

test-backend: ## Run backend tests
	@echo "Running backend tests..."
	cd backend && bun test

test-web: ## Run web tests
	@echo "Running web tests..."
	cd web && bun test

test: test-backend test-web ## Run all tests

# Database
# --------

migrate: ## Run database migrations
	@echo "Running database migrations..."
	cd backend && bun run prisma:migrate

# Docker
# ------

docker-up: ## Start all Docker services
	docker-compose up -d

docker-down: ## Stop all Docker services
	docker-compose down

docker-logs: ## View Docker service logs
	docker-compose logs -f

# API Server
# ----------

backend-http: ## Start the TypeScript backend HTTP shell
	@echo "Starting backend HTTP shell..."
	cd backend && HOST=127.0.0.1 PORT=8000 bun run dev:http

server: ## (Legacy) Start the old FastAPI development server
	@echo "⚠️  RETIRED: server/ is legacy and no longer the active backend."
	@echo "Use: make backend-http"

# Frontend
# --------

web: ## Start the Vue 3 development server
	@echo "Starting web development server..."
	cd web && bun run dev

# Celery
# ------

worker: ## Start Celery worker
	@echo "⚠️  RETIRED: Celery workers belong to legacy server/."

beat: ## Start Celery beat scheduler
	@echo "⚠️  RETIRED: Celery beat belongs to legacy server/."

# Clean
# -----

clean: ## Clean build artifacts and cache
	@echo "Cleaning build artifacts..."
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .mypy_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true
	@echo "✅ Clean complete"

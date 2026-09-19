.PHONY: setup dev worker-test check supabase-start supabase-reset

setup:
	npm install
	python3 -m venv .venv
	.venv/bin/pip install -e "worker[dev]"
	test -f .env || cp .env.example .env

dev:
	npm run dev

worker-test:
	.venv/bin/python -m unittest discover -s worker/tests -v

check:
	npm run check

supabase-start:
	npx supabase start

supabase-reset:
	npx supabase db reset

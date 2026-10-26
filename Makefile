# Makefile

PORT ?= 8080

default: web-test

# Serve the web app at http://localhost:8080/ (stop with Ctrl+C).
.PHONY: web-test
web-test:
	@echo "Serving the web app at http://localhost:$(PORT)/"
	@python3 -m http.server $(PORT) --bind 127.0.0.1 --directory web

# Unit tests (needs Node.js).
.PHONY: test
test:
	@node --test 'tests/*.test.mjs'

# End-to-end test: make worksheets for the apps in apps/ in headless Chromium and
# save them as PDFs in build/e2e/ (needs Node.js and Chromium).
.PHONY: e2e-test
e2e-test:
	@node tests/e2e.mjs

.PHONY: clean
clean:
	@rm -rf build

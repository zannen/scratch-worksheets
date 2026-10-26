# Makefile

PORT ?= 8080

default: web-test

# Serve the web app at http://localhost:8080/ (stop with Ctrl+C), with a proxy for
# the Scratch API like the real web server's.
.PHONY: web-test
web-test:
	@python3 tools/serve.py --port $(PORT)

# Unit tests (needs Node.js).
.PHONY: test
test:
	@node --test 'tests/*.test.mjs'

# End-to-end tests: make worksheets for the apps in apps/ in headless browsers and
# save them as PDFs in build/e2e/<browser>/ (needs Node.js, Chromium, and Firefox
# with geckodriver).
.PHONY: e2e-test
e2e-test:
	@node tests/e2e.mjs chromium firefox

.PHONY: e2e-chromium e2e-firefox
e2e-chromium e2e-firefox: e2e-%:
	@node tests/e2e.mjs $*

.PHONY: clean
clean:
	@rm -rf build

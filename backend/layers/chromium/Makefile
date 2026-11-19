# Headless Chromium for ScreenshotFunction (template.yaml: ChromiumLayer, built by `sam build`).
# The @sparticuz/chromium npm package only ships x64 binaries; its arm64 build is the layer zip of each GitHub
# release, downloaded here (pinned by checksum) into nodejs/node_modules. puppeteer-core goes into
# nodejs/node22/node_modules: both directories are on Lambda's NODE_PATH, and the two dependency trees stay apart.
# Keep PUPPETEER_VERSION on the release whose Chrome matches CHROMIUM_VERSION's major (puppeteer-core 25.11.0
# drives Chrome 153); see https://pptr.dev/chromium-support. Update CHROMIUM_SHA256 with the version.
CHROMIUM_VERSION := 153.0.0
CHROMIUM_SHA256 := 7d2cb15e6a525da16fce7dc551ca95a5271e1be4edb054585609de72a83d18e9
PUPPETEER_VERSION := 25.11.0
ZIP := chromium-v$(CHROMIUM_VERSION)-layer.arm64.zip

build-ChromiumLayer:
	mkdir -p "$(ARTIFACTS_DIR)/nodejs/node22"
	curl -fsSL -o "$(ARTIFACTS_DIR)/$(ZIP)" "https://github.com/Sparticuz/chromium/releases/download/v$(CHROMIUM_VERSION)/$(ZIP)"
	echo "$(CHROMIUM_SHA256)  $(ARTIFACTS_DIR)/$(ZIP)" | sha256sum -c -
	unzip -q -o "$(ARTIFACTS_DIR)/$(ZIP)" -d "$(ARTIFACTS_DIR)"
	rm -f "$(ARTIFACTS_DIR)/$(ZIP)"
	npm install --prefix "$(ARTIFACTS_DIR)/nodejs/node22" --omit=dev --no-audit --no-fund --no-package-lock puppeteer-core@$(PUPPETEER_VERSION)
	rm -f "$(ARTIFACTS_DIR)/nodejs/node22/package.json"

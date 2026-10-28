.PHONY: extension extension-clean

# Build and package the Chrome extension -> extension/release/*.tar.gz and *.zip
extension:
	cd extension && npm ci --no-fund --no-audit && npm run package

extension-clean:
	rm -rf extension/dist extension/release extension/node_modules

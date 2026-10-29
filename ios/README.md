# Live Karaoke (iOS)

SwiftUI (iOS 17+) client for the Parakeet karaoke flow (`/v1/listen`, `/v1/separate`, `/v1/jobs`, `/v1/translate`, `/v1/info`).
The Chrome extension in `../extension` is the reference implementation (same 0.25 s highlight lead, 503 Retry-After handling).

    brew install xcodegen
    cd ios && xcodegen
    open ParakeetKaraoke.xcodeproj

Default server: `http://192.168.8.226:30800` (change in Settings). Bundles (original, instrumental, vocals transcript,
translations) are stored with SwiftData + files in Application Support.

Deep links (handy for testing with `xcrun simctl openurl booted ...`):
- `parakeetkaraoke://import?url=<http url>&title=<t>&lang=<code>` — create a bundle from a URL
- `parakeetkaraoke://open?index=0&mode=karaoke|original` — open a bundle
- `parakeetkaraoke://settings`

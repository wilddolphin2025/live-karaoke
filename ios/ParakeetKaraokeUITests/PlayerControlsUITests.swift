import XCTest

/// Drives the player controls and saves screenshots. Set SHOTS_DIR (TEST_RUNNER_SHOTS_DIR) to keep them.
final class PlayerControlsUITests: XCTestCase {
    var app: XCUIApplication!
    var tag = "light"

    func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png"); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("fix-\(name)-\(tag).png"))
        }
    }

    func testPlayerControls() throws {
        tag = ProcessInfo.processInfo.environment["SHOT_TAG"] ?? "light"
        app = XCUIApplication()
        app.launchArguments = ["-debugURL", "parakeetkaraoke://open?index=1&mode=karaoke",
                               "-translateTarget", "en"]  // other settings are reset with `simctl spawn defaults write` before the run (launch-arg values would override later writes)
        app.launch()
        let translate = app.buttons["translateButton"].firstMatch
        XCTAssertTrue(translate.waitForExistence(timeout: 10))
        func translationOn() -> Bool { (translate.value as? String)?.hasPrefix("On") == true }
        if translationOn() { translate.tap() }          // start from a known state
        XCTAssertFalse(translationOn())
        shot("start")                                   // 0:00 — first line at the top

        // Playing: menu hidden, translate button works
        XCTAssertFalse(app.buttons["displayOptions"].exists, "menu must be hidden during playback")
        translate.tap()
        XCTAssertTrue(translationOn(), "toolbar button must toggle during playback")
        sleep(8); shot("playing-translate-on")
        sleep(22); shot("mid")

        // Paused: menu visible, each item works
        app.buttons["playPause"].tap()
        let menu = app.buttons["displayOptions"]
        XCTAssertTrue(menu.waitForExistence(timeout: 3), "menu must appear when paused")
        shot("paused")
        menu.tap(); sleep(1); shot("menu-open")
        app.buttons["Larger"].tap(); menu.tap(); app.buttons["Larger"].tap(); sleep(1); shot("larger")
        menu.tap(); app.buttons["Smaller"].tap(); menu.tap(); app.buttons["Smaller"].tap(); sleep(1); shot("smaller")
        menu.tap(); app.switches["Show Translation"].firstMatch.exists
            ? app.switches["Show Translation"].firstMatch.tap()
            : app.buttons["Show Translation"].firstMatch.tap()
        sleep(1); XCTAssertFalse(translationOn(), "menu toggle shares state with the button"); shot("menu-translation-off")
        translate.tap(); sleep(2); XCTAssertTrue(translationOn()); shot("button-translation-on-again")
        app.buttons["playPause"].tap(); sleep(1)
        XCTAssertFalse(app.buttons["displayOptions"].exists, "menu hidden again after resuming")
    }
}

import Cocoa
import Darwin
import UserNotifications
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow?
    var webView: WKWebView?
    private var server: ServerSession?
    var serverBaseURL: URL?
    private var keyMonitor: Any?
    private var quitSignals: [DispatchSourceSignal] = []
    private var savedUnmaximizedFrame: NSRect?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installQuitSignals()
        installMainMenu()
        installPasteKeyMonitor()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        let window = makeWindow()
        self.window = window
        showSplash()
        window.center()
        window.makeKeyAndOrderFront(nil)
        activate()

        let session = ServerSession()
        server = session
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = session.launch()
            DispatchQueue.main.async {
                self?.present(result)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let monitor = keyMonitor {
            NSEvent.removeMonitor(monitor)
            keyMonitor = nil
        }
        server?.stop()
    }

    private func installPasteKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self,
                  event.window == self.window else {
                return event
            }
            let mods = event.modifierFlags.intersection([.command, .control, .option, .shift])
            let isV = event.charactersIgnoringModifiers?.lowercased() == "v" || event.keyCode == 9
            if mods == .command && isV && self.handleNativeImagePaste() {
                return nil
            }
            return event
        }
    }

    /// `kill` delivers SIGTERM. Handle it so the node server is stopped
    /// instead of being reparented to launchd.
    private func installQuitSignals() {
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        for sig in [SIGTERM, SIGINT] {
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            quitSignals.append(source)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    private func present(_ result: Result<URL, LaunchError>) {
        switch result {
        case .success(let url):
            serverBaseURL = url
            showPage(url)
        case .failure(let error):
            showMessage(error.localizedDescription)
        }
    }

    private func makeWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Colab Desk"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 860, height: 640)
        window.isRestorable = false
        window.tabbingMode = .disallowed
        window.backgroundColor = NSColor(srgbRed: 0.08, green: 0.07, blue: 0.11, alpha: 1.0)
        window.delegate = self
        return window
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        webView?.evaluateJavaScript("document.documentElement.classList.add('is-mac-fullscreen');", completionHandler: nil)
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        webView?.evaluateJavaScript("document.documentElement.classList.remove('is-mac-fullscreen');", completionHandler: nil)
        syncMacChromeMetrics()
    }

    func windowWillUseStandardFrame(_ window: NSWindow, defaultFrame newFrame: NSRect) -> NSRect {
        return (window.screen ?? NSScreen.main)?.visibleFrame ?? newFrame
    }

    /// Maximize window to fill the visible screen (below menu bar / above Dock), NOT macOS fullscreen.
    func toggleFillScreen() {
        guard let window else { return }
        if window.styleMask.contains(.fullScreen) { return }
        guard let visible = (window.screen ?? NSScreen.main)?.visibleFrame else { return }
        let cur = window.frame
        let isFilled =
            abs(cur.origin.x - visible.origin.x) <= 6 &&
            abs(cur.origin.y - visible.origin.y) <= 6 &&
            abs(cur.size.width - visible.size.width) <= 6 &&
            abs(cur.size.height - visible.size.height) <= 6
        if isFilled, let prev = savedUnmaximizedFrame {
            savedUnmaximizedFrame = nil
            window.setFrame(prev, display: true, animate: true)
        } else {
            savedUnmaximizedFrame = cur
            window.setFrame(visible, display: true, animate: true)
        }
    }

    private func showMessage(_ message: String) {
        guard let window else { return }
        let container = NSView()
        let field = NSTextField(wrappingLabelWithString: message)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.isSelectable = true
        field.font = NSFont.systemFont(ofSize: 13)
        field.textColor = .labelColor
        field.maximumNumberOfLines = 0
        container.addSubview(field)
        window.contentView = container
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24),
            field.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24),
            field.topAnchor.constraint(equalTo: container.topAnchor, constant: 48),
            field.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor, constant: -24),
        ])
    }

    @objc private func pasteFromMenu(_ sender: Any?) {
        if handleNativeImagePaste() {
            return
        }
        NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: sender)
    }

    @objc private func toggleSidebarFromMenu(_ sender: Any?) {
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('colab-toggle-sidebar'));", completionHandler: nil)
    }

    @objc private func toggleInspectorFromMenu(_ sender: Any?) {
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('colab-toggle-rail'));", completionHandler: nil)
    }

    @objc private func toggleTerminalFromMenu(_ sender: Any?) {
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('colab-toggle-terminal'));", completionHandler: nil)
    }

    @objc private func openNewSessionFromMenu(_ sender: Any?) {
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('colab-new-session'));", completionHandler: nil)
    }

    @objc private func openCommandPaletteFromMenu(_ sender: Any?) {
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('colab-open-palette'));", completionHandler: nil)
    }

    @objc private func toggleFillScreenFromMenu(_ sender: Any?) {
        toggleFillScreen()
    }

    private func activate() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func installMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu(title: "Colab Desk")
        appMenu.addItem(
            withTitle: "New Session…",
            action: #selector(openNewSessionFromMenu(_:)),
            keyEquivalent: "n"
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit Colab Desk",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        let pasteItem = edit.addItem(withTitle: "Paste", action: #selector(pasteFromMenu(_:)), keyEquivalent: "v")
        pasteItem.target = self
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(
            withTitle: "Toggle Sidebar",
            action: #selector(toggleSidebarFromMenu(_:)),
            keyEquivalent: "b"
        )
        viewMenu.addItem(
            withTitle: "Toggle Inspector",
            action: #selector(toggleInspectorFromMenu(_:)),
            keyEquivalent: "."
        )
        viewMenu.addItem(
            withTitle: "Toggle Terminal",
            action: #selector(toggleTerminalFromMenu(_:)),
            keyEquivalent: "j"
        )
        viewMenu.addItem(.separator())
        viewMenu.addItem(
            withTitle: "Command Palette…",
            action: #selector(openCommandPaletteFromMenu(_:)),
            keyEquivalent: "k"
        )
        viewMenu.addItem(.separator())
        let fillItem = NSMenuItem(
            title: "Fill Screen",
            action: #selector(toggleFillScreenFromMenu(_:)),
            keyEquivalent: "m"
        )
        fillItem.keyEquivalentModifierMask = [.command, .option]
        viewMenu.addItem(fillItem)
        viewItem.submenu = viewMenu

        NSApp.mainMenu = main
    }
}

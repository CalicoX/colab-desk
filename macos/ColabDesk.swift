import Cocoa
import Darwin
import UserNotifications
import WebKit

// Finder does not pass a developer PATH. Build one from known install
// locations, then spawn node in its own process group so quit can signal the
// server and any colab children.

private let listenMarker = "colab-desk listening on http://127.0.0.1:"

private enum LaunchError: LocalizedError {
    case serverMissing
    case nodeMissing(path: String)
    case spawn(message: String)
    case timeout(log: String)
    case exited(code: Int32, log: String)

    var errorDescription: String? {
        switch self {
        case .serverMissing:
            return """
            Colab Desk could not start.

            The bundled server is missing (Contents/Resources/server). Rebuild with npm run app.
            """
        case .nodeMissing(let path):
            return """
            Colab Desk could not start.

            node was not found on PATH. Install Node 20 or newer, and a user-installed colab from google-colab-cli.

            PATH:
            \(path)
            """
        case .spawn(let message):
            return """
            Colab Desk could not start.

            Failed to launch node src/server.mjs.
            \(message)
            """
        case .timeout(let log):
            return """
            Colab Desk could not start.

            The local server did not listen within 8 seconds.

            \(clip(log))
            """
        case .exited(let code, let log):
            return """
            Colab Desk could not start.

            The local server exited before it started listening (code \(code)).

            \(clip(log))
            """
        }
    }
}

private struct PosixFailure: Error {
    let message: String
}

private func clip(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "(no output)" }
    if trimmed.count <= 6000 { return trimmed }
    return "…" + trimmed.suffix(6000)
}

/// Finder gives a short PATH. Add the usual install locations without
/// starting a login shell, so shell startup cannot touch the keychain.
/// `COLAB_DESK_PATH` replaces this for a substitute `colab`.
private func resolvedPATH() -> String {
    if let override = ProcessInfo.processInfo.environment["COLAB_DESK_PATH"], !override.isEmpty {
        return override
    }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    var parts = [
        "\(home)/.local/bin",
        "\(home)/.opencode/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    let inherited = ProcessInfo.processInfo.environment["PATH"] ?? ""
    for piece in inherited.split(separator: ":") {
        let item = String(piece)
        if !item.isEmpty && !parts.contains(item) {
            parts.append(item)
        }
    }
    return parts.joined(separator: ":")
}

private func executable(named name: String, path: String) -> String? {
    for dir in path.split(separator: ":") where !dir.isEmpty {
        let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent(name).path
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate, isDirectory: &isDir),
           !isDir.boolValue,
           FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
    }
    return nil
}

private func bundledServerDirectory() -> URL? {
    guard let resources = Bundle.main.resourceURL else { return nil }
    let dir = resources.appendingPathComponent("server", isDirectory: true)
    let entry = dir.appendingPathComponent("src/server.mjs")
    guard FileManager.default.fileExists(atPath: entry.path) else { return nil }
    return dir
}

private func listenURL(in text: String) -> URL? {
    guard let range = text.range(of: listenMarker) else { return nil }
    var end = range.upperBound
    while end < text.endIndex, text[end].isNumber {
        end = text.index(after: end)
    }
    guard end > range.upperBound else { return nil }
    return URL(string: "http://127.0.0.1:" + text[range.upperBound..<end])
}

private func withCStrings<R>(
    _ strings: [String],
    _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> R
) -> R {
    var pointers: [UnsafeMutablePointer<CChar>?] = strings.map { strdup($0) }
    pointers.append(nil)
    defer { pointers.forEach { free($0) } }
    return pointers.withUnsafeMutableBufferPointer { buffer in
        body(buffer.baseAddress!)
    }
}

private func posixCheck(_ rc: Int32, _ what: String) throws {
    if rc != 0 {
        throw PosixFailure(message: "\(what): \(String(cString: strerror(rc)))")
    }
}

private func makePipe() throws -> (read: Int32, write: Int32) {
    var fds = [Int32](repeating: 0, count: 2)
    let rc = fds.withUnsafeMutableBufferPointer { buffer -> Int32 in
        guard let base = buffer.baseAddress else { return -1 }
        return Darwin.pipe(base)
    }
    if rc != 0 {
        throw PosixFailure(message: "pipe: \(String(cString: strerror(errno)))")
    }
    return (fds[0], fds[1])
}

private func setNonblock(_ fd: Int32) {
    let flags = fcntl(fd, F_GETFL)
    if flags >= 0 {
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
    }
}

private func setCloexec(_ fd: Int32) {
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
}

private struct ReadChunk {
    var data = Data()
    var eof = false
}

private func readChunk(_ fd: Int32) -> ReadChunk {
    var chunk = ReadChunk()
    var buffer = [UInt8](repeating: 0, count: 8192)
    while true {
        let n = Darwin.read(fd, &buffer, buffer.count)
        if n > 0 {
            chunk.data.append(buffer, count: n)
            continue
        }
        if n == 0 {
            chunk.eof = true
            break
        }
        if errno == EINTR { continue }
        if errno == EAGAIN || errno == EWOULDBLOCK { break }
        chunk.eof = true
        break
    }
    return chunk
}

private struct Spawned {
    let pid: pid_t
    let stdout: Int32
    let stderr: Int32
}

/// Spawn `node src/server.mjs` as process-group leader. setpgid after exec fails.
private func spawnNode(executable: String, cwd: String, path: String, home: String) throws -> Spawned {
    let out = try makePipe()
    let err = try makePipe()
    let devnull = Darwin.open("/dev/null", O_RDONLY)
    var actions: posix_spawn_file_actions_t? = nil
    var attr: posix_spawnattr_t? = nil
    var pid: pid_t = 0
    var started = false
    defer {
        if devnull >= 0 { Darwin.close(devnull) }
        if started {
            Darwin.close(out.write)
            Darwin.close(err.write)
        } else {
            Darwin.close(out.read)
            Darwin.close(out.write)
            Darwin.close(err.read)
            Darwin.close(err.write)
        }
        if actions != nil { posix_spawn_file_actions_destroy(&actions) }
        if attr != nil { posix_spawnattr_destroy(&attr) }
    }

    try posixCheck(posix_spawn_file_actions_init(&actions), "posix_spawn_file_actions_init")
    try posixCheck(posix_spawnattr_init(&attr), "posix_spawnattr_init")
    let flags = Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)
    try posixCheck(posix_spawnattr_setflags(&attr, flags), "posix_spawnattr_setflags")
    try posixCheck(posix_spawnattr_setpgroup(&attr, 0), "posix_spawnattr_setpgroup")
    try posixCheck(posix_spawn_file_actions_adddup2(&actions, out.write, STDOUT_FILENO), "dup stdout")
    try posixCheck(posix_spawn_file_actions_adddup2(&actions, err.write, STDERR_FILENO), "dup stderr")
    if devnull >= 0 {
        try posixCheck(posix_spawn_file_actions_adddup2(&actions, devnull, STDIN_FILENO), "dup stdin")
        try posixCheck(posix_spawn_file_actions_addclose(&actions, devnull), "close /dev/null")
    }
    try posixCheck(posix_spawn_file_actions_addclose(&actions, out.read), "close stdout read")
    try posixCheck(posix_spawn_file_actions_addclose(&actions, out.write), "close stdout write")
    try posixCheck(posix_spawn_file_actions_addclose(&actions, err.read), "close stderr read")
    try posixCheck(posix_spawn_file_actions_addclose(&actions, err.write), "close stderr write")
    try posixCheck(posix_spawn_file_actions_addchdir_np(&actions, cwd), "chdir")

    var env = ProcessInfo.processInfo.environment
    env["PATH"] = path
    env["PORT"] = "0"
    env["HOME"] = home
    let envList = env.map { "\($0.key)=\($0.value)" }
    let argv = [executable, "src/server.mjs"]
    let rc: Int32 = withCStrings(argv) { cargv in
        withCStrings(envList) { cenv in
            posix_spawn(&pid, executable, &actions, &attr, cargv, cenv)
        }
    }
    try posixCheck(rc, "posix_spawn")
    started = true
    setCloexec(out.read)
    setCloexec(err.read)
    setNonblock(out.read)
    setNonblock(err.read)
    return Spawned(pid: pid, stdout: out.read, stderr: err.read)
}

private func signalProcessGroup(_ pid: pid_t, _ signal: Int32) {
    if pid <= 0 { return }
    if getpgid(pid) == pid {
        _ = Darwin.kill(-pid, signal)
    } else {
        _ = Darwin.kill(pid, signal)
    }
}

private final class SourceHandle {
    private let cancelBody: () -> Void
    init(_ cancel: @escaping () -> Void) { cancelBody = cancel }
    func cancel() { cancelBody() }
}

private final class ServerSession {
    private let queue = DispatchQueue(label: "colab-desk.server")
    private let lock = NSLock()
    private let ready = DispatchSemaphore(value: 0)
    private var pid: pid_t = 0
    private var stdoutFD: Int32 = -1
    private var stderrFD: Int32 = -1
    private var sources: [SourceHandle] = []
    private var didStop = false
    private var signaled = false
    private var outcome: Result<URL, LaunchError>?
    private var captured = ""
    private var log = ""

    func launch() -> Result<URL, LaunchError> {
        let path = resolvedPATH()
        guard let serverDir = bundledServerDirectory() else {
            return .failure(.serverMissing)
        }
        guard let node = executable(named: "node", path: path) else {
            return .failure(.nodeMissing(path: path))
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let spawned: Spawned
        do {
            spawned = try spawnNode(executable: node, cwd: serverDir.path, path: path, home: home)
        } catch let error as PosixFailure {
            return .failure(.spawn(message: error.message))
        } catch {
            return .failure(.spawn(message: error.localizedDescription))
        }
        guard adopt(spawned) else {
            signalProcessGroup(spawned.pid, SIGKILL)
            _ = waitpid(spawned.pid, nil, 0)
            return .failure(.spawn(message: "Colab Desk quit before the server started."))
        }
        let result = waitForListen()
        if case .failure = result {
            stop()
        }
        return result
    }

    func stop() {
        let snapshot: (pid: pid_t, sources: [SourceHandle])? = {
            lock.lock()
            defer { lock.unlock() }
            if didStop { return nil }
            didStop = true
            let snapshot = (pid, sources)
            sources = []
            return snapshot
        }()
        guard let snapshot else { return }
        if snapshot.pid > 0 {
            signalProcessGroup(snapshot.pid, SIGTERM)
            let deadline = Date().addingTimeInterval(0.8)
            while Date() < deadline {
                var status: Int32 = 0
                let rc = waitpid(snapshot.pid, &status, WNOHANG)
                if rc == snapshot.pid || (rc < 0 && errno == ECHILD) {
                    snapshot.sources.forEach { $0.cancel() }
                    return
                }
                Thread.sleep(forTimeInterval: 0.02)
            }
            signalProcessGroup(snapshot.pid, SIGKILL)
            _ = waitpid(snapshot.pid, nil, 0)
        }
        snapshot.sources.forEach { $0.cancel() }
    }

    private func adopt(_ spawned: Spawned) -> Bool {
        lock.lock()
        if didStop {
            lock.unlock()
            Darwin.close(spawned.stdout)
            Darwin.close(spawned.stderr)
            return false
        }
        pid = spawned.pid
        stdoutFD = spawned.stdout
        stderrFD = spawned.stderr
        lock.unlock()

        let outSource = makeReadSource(fd: spawned.stdout)
        let errSource = makeReadSource(fd: spawned.stderr)
        let exitSource = makeExitSource(pid: spawned.pid)

        lock.lock()
        if didStop {
            lock.unlock()
            outSource.cancel()
            errSource.cancel()
            exitSource.cancel()
            return false
        }
        sources = [
            SourceHandle { outSource.cancel() },
            SourceHandle { errSource.cancel() },
            SourceHandle { exitSource.cancel() },
        ]
        lock.unlock()
        return true
    }

    private func makeReadSource(fd: Int32) -> DispatchSourceRead {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self, weak source] in
            guard let self else { return }
            let chunk = readChunk(fd)
            if !chunk.data.isEmpty {
                self.consume(String(decoding: chunk.data, as: UTF8.self))
            }
            if chunk.eof {
                source?.cancel()
            }
        }
        source.setCancelHandler {
            Darwin.close(fd)
        }
        source.resume()
        return source
    }

    private func makeExitSource(pid: pid_t) -> DispatchSourceProcess {
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            self.drainPipes()
            if self.hasListenURL { return }
            var status: Int32 = 0
            let rc = waitpid(pid, &status, WNOHANG)
            let code: Int32
            if rc == pid, status & 0x7f == 0 {
                code = (status >> 8) & 0xff
            } else if rc == pid {
                code = status
            } else {
                code = -1
            }
            self.finish(.failure(.exited(code: code, log: self.currentLog())))
        }
        source.resume()
        return source
    }

    private func drainPipes() {
        for fd in [stdoutFD, stderrFD] where fd >= 0 {
            let chunk = readChunk(fd)
            if !chunk.data.isEmpty {
                consume(String(decoding: chunk.data, as: UTF8.self))
            }
        }
    }

    private func consume(_ text: String) {
        var found: URL?
        lock.lock()
        if log.count < 64 * 1024 {
            log += text
        }
        if outcome == nil {
            captured += text
            if captured.count > 64 * 1024 {
                captured = String(captured.suffix(64 * 1024))
            }
            found = listenURL(in: captured)
        }
        lock.unlock()
        if let found {
            finish(.success(found))
        }
    }

    private var hasListenURL: Bool {
        lock.lock()
        defer { lock.unlock() }
        if case .success = outcome { return true }
        return false
    }

    private func currentLog() -> String {
        lock.lock()
        defer { lock.unlock() }
        return log
    }

    private func finish(_ result: Result<URL, LaunchError>) {
        lock.lock()
        if signaled {
            lock.unlock()
            return
        }
        signaled = true
        outcome = result
        lock.unlock()
        ready.signal()
    }

    private func waitForListen() -> Result<URL, LaunchError> {
        _ = ready.wait(timeout: .now() + 8)
        lock.lock()
        let outcome = self.outcome
        let log = self.log
        lock.unlock()
        if let outcome { return outcome }
        return .failure(.timeout(log: log))
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var server: ServerSession?
    private var quitSignals: [DispatchSourceSignal] = []
    private var savedUnmaximizedFrame: NSRect?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installQuitSignals()
        installMainMenu()
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
        server?.stop()
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

    private func trafficLightMetrics() -> (centerY: CGFloat, rightX: CGFloat) {
        guard let window,
              let closeBtn = window.standardWindowButton(.closeButton),
              let zoomBtn = window.standardWindowButton(.zoomButton) else {
            return (15, 68)
        }
        window.layoutIfNeeded()
        let closeRect = closeBtn.convert(closeBtn.bounds, to: nil)
        let zoomRect = zoomBtn.convert(zoomBtn.bounds, to: nil)
        let centerY = max(13, round(window.frame.height - closeRect.midY))
        let rightX = max(62, round(zoomRect.maxX))
        return (centerY, rightX)
    }

    private func syncMacChromeMetrics() {
        guard let webView else { return }
        let m = trafficLightMetrics()
        let js = """
        document.documentElement.style.setProperty('--mac-tl-center-y', '\(Int(m.centerY))px');
        document.documentElement.style.setProperty('--mac-tl-right', '\(Int(m.rightX))px');
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        syncMacChromeMetrics()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download, preferences)
            return
        }
        decisionHandler(.allow, preferences)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disp = http.value(forHTTPHeaderField: "Content-Disposition"),
           disp.lowercased().contains("attachment") {
            decisionHandler(.download)
            return
        }
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let downloadsDir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads", isDirectory: true)
        let safeName = suggestedFilename.isEmpty ? "colab-download" : (suggestedFilename as NSString).lastPathComponent
        let baseURL = downloadsDir.appendingPathComponent(safeName)
        var target = baseURL
        let ext = target.pathExtension
        let stem = target.deletingPathExtension().lastPathComponent
        var idx = 1
        while FileManager.default.fileExists(atPath: target.path) {
            let nextName = ext.isEmpty ? "\(stem) (\(idx))" : "\(stem) (\(idx)).\(ext)"
            target = downloadsDir.appendingPathComponent(nextName)
            idx += 1
        }
        completionHandler(target)
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        if let window {
            panel.beginSheetModal(for: window) { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
        } else {
            let response = panel.runModal()
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = "Colab Desk"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        if let window {
            alert.beginSheetModal(for: window) { _ in completionHandler() }
        } else {
            alert.runModal()
            completionHandler()
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = "Colab Desk"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        if let window {
            alert.beginSheetModal(for: window) { response in
                completionHandler(response == .alertFirstButtonReturn)
            }
        } else {
            completionHandler(alert.runModal() == .alertFirstButtonReturn)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        if let window {
            alert.beginSheetModal(for: window) { response in
                completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
            }
        } else {
            completionHandler(alert.runModal() == .alertFirstButtonReturn ? input.stringValue : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
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
    private func toggleFillScreen() {
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

    private func ensureWebView() -> WKWebView? {
        guard let window else { return nil }
        if let existing = self.webView {
            if window.contentView !== existing {
                window.contentView = existing
            }
            return existing
        }
        let m = trafficLightMetrics()
        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()
        let bootScript = WKUserScript(
            source: """
            document.documentElement.classList.add('is-mac-app');
            document.documentElement.style.setProperty('--mac-tl-center-y', '\(Int(m.centerY))px');
            document.documentElement.style.setProperty('--mac-tl-right', '\(Int(m.rightX))px');
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(bootScript)
        contentController.add(self, name: "windowDrag")
        contentController.add(self, name: "windowZoom")
        contentController.add(self, name: "notify")
        contentController.add(self, name: "setTheme")
        contentController.add(self, name: "openExternal")
        contentController.add(self, name: "clipboardImage")
        config.userContentController = contentController

        let webView = WKWebView(frame: window.contentView?.bounds ?? .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        self.webView = webView
        window.contentView = webView
        return webView
    }

    private func showSplash() {
        guard let webView = ensureWebView() else { return }
        let splashHTML = """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8" />
        <style>
          html, body {
            height: 100%;
            margin: 0;
            background: #14121b;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            user-select: none;
            -webkit-user-select: none;
          }
          .splash {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            animation: breathe 1.8s ease-in-out infinite;
          }
          .splash svg {
            width: 112px;
            height: auto;
            filter: drop-shadow(0 12px 28px rgba(0, 0, 0, 0.45));
          }
          @keyframes breathe {
            0%, 100% { opacity: 0.92; transform: scale(1); }
            50% { opacity: 1; transform: scale(1.03); }
          }
        </style>
        </head>
        <body>
          <div class="splash">
            <svg width="40" height="37" viewBox="0 0 40 37" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7.30402 7.31916L3.37402 3.39916C5.33122 1.4472 7.92454 0.263335 10.6815 0.0632639C13.4384 -0.136807 16.1755 0.660229 18.394 2.30916L18.564 2.43916L15.714 7.31916C14.592 6.21679 13.082 5.59911 11.509 5.59911C9.93608 5.59911 8.42604 6.21679 7.30402 7.31916Z" fill="#FAAB00"/>
              <path d="M15.714 15.7692L18.624 20.6392L18.434 20.7792C16.2135 22.4403 13.4687 23.2455 10.7027 23.0471C7.93666 22.8487 5.3348 21.6601 3.37402 19.6992L7.26402 15.7692C8.38778 16.8836 9.90635 17.5089 11.489 17.5089C13.0717 17.5089 14.5903 16.8836 15.714 15.7692Z" fill="#FAAB00"/>
              <path d="M16.3399 11.5492C16.3399 8.49265 17.5535 5.56121 19.714 3.39916C20.7846 2.32272 22.0573 1.46832 23.459 0.885005C24.8607 0.301686 26.3637 0.000931294 27.8819 2.15941e-06C29.4002 -0.000926975 30.9036 0.297988 32.306 0.879591C33.7084 1.46119 34.9821 2.31403 36.054 3.38916L32.124 7.31916C30.9685 6.40583 29.5173 5.94948 28.047 6.03701C26.5767 6.12455 25.1899 6.74986 24.1509 7.79384C23.1118 8.83783 22.4931 10.2275 22.4125 11.6982C22.332 13.169 22.7952 14.6179 23.714 15.7692L19.714 19.6992C17.5535 17.5371 16.3399 14.6057 16.3399 11.5492Z" fill="#FAAB00"/>
              <path d="M7.30412 7.31917L3.37412 3.39917C1.21362 5.56122 0 8.49266 0 11.5492C0 14.6057 1.21362 17.5371 3.37412 19.6992L7.30412 15.7692C6.18965 14.6454 5.56433 13.1268 5.56433 11.5442C5.56433 9.9615 6.18965 8.44292 7.30412 7.31917Z" fill="#E87109"/>
              <path d="M36.0541 3.39917L32.1241 7.31917C33.0429 8.47039 33.5062 9.91936 33.4256 11.3901C33.345 12.8608 32.7263 14.2505 31.6873 15.2945C30.6482 16.3385 29.2615 16.9638 27.7912 17.0513C26.3208 17.1388 24.8697 16.6825 23.7141 15.7692L19.7141 19.6992C21.8948 21.7657 24.7959 22.8995 27.8 22.8592C30.804 22.8188 33.6737 21.6075 35.7981 19.4831C37.9225 17.3588 39.1338 14.4891 39.1741 11.485C39.2145 8.481 38.0807 5.57984 36.0141 3.39917H36.0541Z" fill="#E87109"/>
              <path d="M30.864 36.5589V27.1478H32.8216V30.6862H32.8813C32.9671 30.4962 33.0912 30.3032 33.2536 30.1072C33.419 29.9081 33.6334 29.7426 33.8969 29.6109C34.1634 29.4761 34.4943 29.4087 34.8895 29.4087C35.4041 29.4087 35.879 29.5435 36.314 29.8131C36.749 30.0796 37.0967 30.4825 37.3571 31.0216C37.6175 31.5578 37.7477 32.2302 37.7477 33.039C37.7477 33.8263 37.6206 34.4911 37.3663 35.0333C37.1151 35.5725 36.772 35.9815 36.337 36.2603C35.905 36.536 35.421 36.6738 34.8849 36.6738C34.505 36.6738 34.1818 36.611 33.9153 36.4854C33.6518 36.3598 33.4358 36.202 33.2673 36.0121C33.0988 35.8191 32.9702 35.6246 32.8813 35.4285H32.794V36.5589H30.864ZM32.7802 33.0298C32.7802 33.4495 32.8384 33.8156 32.9549 34.128C33.0713 34.4405 33.2398 34.6841 33.4603 34.8587C33.6809 35.0303 33.949 35.116 34.2645 35.116C34.5831 35.116 34.8527 35.0287 35.0733 34.8541C35.2939 34.6764 35.4608 34.4313 35.5742 34.1189C35.6906 33.8033 35.7488 33.4403 35.7488 33.0298C35.7488 32.6223 35.6921 32.2639 35.5788 31.9545C35.4654 31.6451 35.2985 31.403 35.0779 31.2284C34.8573 31.0538 34.5862 30.9665 34.2645 30.9665C33.9459 30.9665 33.6763 31.0507 33.4557 31.2192C33.2382 31.3877 33.0713 31.6267 32.9549 31.9361C32.8384 32.2455 32.7802 32.6101 32.7802 33.0298Z" fill="white"/>
              <path d="M25.3336 36.6922C24.8832 36.6922 24.4819 36.6141 24.1296 36.4578C23.7773 36.2985 23.4985 36.0642 23.2933 35.7548C23.0911 35.4423 22.99 35.0532 22.99 34.5876C22.99 34.1954 23.062 33.8661 23.206 33.5996C23.35 33.3331 23.546 33.1186 23.7942 32.9562C24.0423 32.7939 24.3242 32.6713 24.6397 32.5886C24.9583 32.5059 25.2922 32.4477 25.6415 32.414C26.052 32.3711 26.3828 32.3313 26.634 32.2945C26.8853 32.2547 27.0675 32.1965 27.1809 32.1199C27.2942 32.0433 27.3509 31.93 27.3509 31.7799V31.7523C27.3509 31.4612 27.259 31.2361 27.0752 31.0768C26.8944 30.9175 26.6371 30.8378 26.3032 30.8378C25.9509 30.8378 25.6706 30.9159 25.4622 31.0722C25.2539 31.2254 25.1161 31.4184 25.0487 31.6512L23.2381 31.5041C23.33 31.0752 23.5108 30.7046 23.7804 30.3921C24.05 30.0765 24.3977 29.8345 24.8235 29.666C25.2524 29.4945 25.7487 29.4087 26.3124 29.4087C26.7045 29.4087 27.0798 29.4546 27.4382 29.5465C27.7997 29.6385 28.1198 29.7809 28.3986 29.9739C28.6805 30.1669 28.9026 30.4151 29.0649 30.7183C29.2273 31.0186 29.3085 31.3785 29.3085 31.7982V36.5589H27.452V35.5801H27.3969C27.2835 35.8007 27.1319 35.9952 26.9419 36.1637C26.752 36.3292 26.5238 36.4594 26.2572 36.5543C25.9907 36.6462 25.6828 36.6922 25.3336 36.6922ZM25.8942 35.3412C26.1822 35.3412 26.4364 35.2845 26.657 35.1712C26.8776 35.0548 27.0507 34.8985 27.1763 34.7024C27.3019 34.5064 27.3647 34.2843 27.3647 34.0361V33.2871C27.3034 33.3269 27.2192 33.3637 27.1119 33.3974C27.0078 33.428 26.8898 33.4571 26.7581 33.4847C26.6264 33.5092 26.4947 33.5322 26.3629 33.5536C26.2312 33.572 26.1117 33.5889 26.0045 33.6042C25.7747 33.6379 25.5741 33.6915 25.4025 33.765C25.231 33.8385 25.0977 33.9381 25.0027 34.0637C24.9078 34.1862 24.8603 34.3394 24.8603 34.5232C24.8603 34.7898 24.9568 34.9935 25.1498 35.1344C25.3458 35.2723 25.594 35.3412 25.8942 35.3412Z" fill="white"/>
              <path d="M21.7528 27.1478V36.5589H19.7952V27.1478H21.7528Z" fill="white"/>
              <path d="M15.0482 36.6968C14.3344 36.6968 13.7171 36.5451 13.1964 36.2419C12.6786 35.9355 12.2788 35.5097 11.997 34.9644C11.7151 34.416 11.5742 33.7803 11.5742 33.0573C11.5742 32.3282 11.7151 31.691 11.997 31.1457C12.2788 30.5973 12.6786 30.1715 13.1964 29.8682C13.7171 29.5619 14.3344 29.4087 15.0482 29.4087C15.762 29.4087 16.3778 29.5619 16.8955 29.8682C17.4163 30.1715 17.8177 30.5973 18.0995 31.1457C18.3813 31.691 18.5223 32.3282 18.5223 33.0573C18.5223 33.7803 18.3813 34.416 18.0995 34.9644C17.8177 35.5097 17.4163 35.9355 16.8955 36.2419C16.3778 36.5451 15.762 36.6968 15.0482 36.6968ZM15.0574 35.1804C15.3822 35.1804 15.6533 35.0884 15.8708 34.9046C16.0883 34.7178 16.2522 34.4635 16.3625 34.1418C16.4758 33.8202 16.5325 33.4541 16.5325 33.0436C16.5325 32.633 16.4758 32.267 16.3625 31.9453C16.2522 31.6236 16.0883 31.3693 15.8708 31.1825C15.6533 30.9956 15.3822 30.9022 15.0574 30.9022C14.7296 30.9022 14.4539 30.9956 14.2303 31.1825C14.0097 31.3693 13.8428 31.6236 13.7294 31.9453C13.6191 32.267 13.564 32.633 13.564 33.0436C13.564 33.4541 13.6191 33.8202 13.7294 34.1418C13.8428 34.4635 14.0097 34.7178 14.2303 34.9046C14.4539 35.0884 14.7296 35.1804 15.0574 35.1804Z" fill="white"/>
              <path d="M10.4691 30.4426H8.45636C8.4196 30.1822 8.34454 29.9509 8.23119 29.7488C8.11784 29.5435 7.97232 29.3689 7.79464 29.2249C7.61695 29.0809 7.4117 28.9706 7.17887 28.894C6.94911 28.8174 6.69943 28.7792 6.42984 28.7792C5.94274 28.7792 5.51845 28.9002 5.15695 29.1422C4.79546 29.3811 4.51515 29.7304 4.31602 30.1899C4.11689 30.6464 4.01732 31.2009 4.01732 31.8534C4.01732 32.5243 4.11689 33.088 4.31602 33.5445C4.51821 34.0009 4.80005 34.3456 5.16155 34.5784C5.52304 34.8112 5.94121 34.9276 6.41606 34.9276C6.68258 34.9276 6.9292 34.8924 7.1559 34.8219C7.38566 34.7515 7.58938 34.6488 7.76707 34.5141C7.94475 34.3762 8.0918 34.2092 8.20821 34.0132C8.32769 33.8171 8.41041 33.5935 8.45636 33.3423L10.4691 33.3515C10.417 33.7834 10.2868 34.2 10.0785 34.6014C9.87323 34.9996 9.59599 35.3565 9.24675 35.6721C8.90057 35.9845 8.48699 36.2327 8.00602 36.4165C7.52811 36.5972 6.9874 36.6876 6.38389 36.6876C5.54449 36.6876 4.79393 36.4977 4.13221 36.1178C3.47355 35.7379 2.95275 35.188 2.56981 34.4681C2.18994 33.7482 2 32.8766 2 31.8534C2 30.8271 2.193 29.954 2.579 29.2341C2.96501 28.5142 3.48887 27.9658 4.15059 27.589C4.81231 27.2091 5.55674 27.0192 6.38389 27.0192C6.9292 27.0192 7.43468 27.0958 7.90033 27.2489C8.36905 27.4021 8.78415 27.6257 9.14565 27.9198C9.50714 28.2109 9.80124 28.5678 10.0279 28.9905C10.2577 29.4133 10.4048 29.8973 10.4691 30.4426Z" fill="white"/>
            </svg>
          </div>
        </body>
        </html>
        """
        webView.loadHTMLString(splashHTML, baseURL: nil)
    }

    private func showPage(_ url: URL) {
        guard let webView = ensureWebView() else { return }
        webView.load(URLRequest(url: url))
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if #available(macOS 11.0, *) {
            completionHandler([.banner, .sound])
        } else {
            completionHandler([.alert, .sound])
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "windowZoom" {
            toggleFillScreen()
            return
        }
        if message.name == "windowDrag", let window, let event = NSApp.currentEvent {
            if event.clickCount >= 2 {
                toggleFillScreen()
                return
            }
            window.performDrag(with: event)
            return
        }
        if message.name == "notify", let dict = message.body as? [String: Any] {
            let title = (dict["title"] as? String) ?? "Colab Desk"
            let body = (dict["body"] as? String) ?? ""
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
            return
        }
        if message.name == "setTheme", let mode = message.body as? String, let window {
            switch mode {
            case "light":
                window.appearance = NSAppearance(named: .aqua)
                window.backgroundColor = NSColor(srgbRed: 0.96, green: 0.96, blue: 0.98, alpha: 1.0)
            case "dark":
                window.appearance = NSAppearance(named: .darkAqua)
                window.backgroundColor = NSColor(srgbRed: 0.08, green: 0.07, blue: 0.11, alpha: 1.0)
            default:
                window.appearance = nil
                window.backgroundColor = NSColor.windowBackgroundColor
            }
            return
        }
        if message.name == "openExternal", let raw = message.body as? String, let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
            return
        }
        if message.name == "clipboardImage" {
            let pb = NSPasteboard.general
            var imgData: Data? = nil
            var filename = "image.png"
            var mime = "image/png"

            if let png = pb.data(forType: .png) {
                imgData = png
            } else if let tiff = pb.data(forType: .tiff),
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) {
                imgData = png
            } else if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
                let allowedExts: Set<String> = ["png", "jpg", "jpeg", "webp", "gif", "bmp"]
                if let first = urls.first(where: { allowedExts.contains($0.pathExtension.lowercased()) }),
                   let data = try? Data(contentsOf: first),
                   data.count <= 25_000_000 {
                    imgData = data
                    filename = first.lastPathComponent
                    let ext = first.pathExtension.lowercased()
                    if ext == "jpg" || ext == "jpeg" { mime = "image/jpeg" }
                    else if ext == "webp" { mime = "image/webp" }
                    else if ext == "gif" { mime = "image/gif" }
                    else if ext == "bmp" { mime = "image/bmp" }
                    else { mime = "image/png" }
                }
            }

            if let data = imgData, data.count <= 25_000_000 {
                let payload: [String: String] = [
                    "name": filename,
                    "mimeType": mime,
                    "base64": data.base64EncodedString(),
                ]
                if let jsonData = try? JSONSerialization.data(withJSONObject: payload),
                   let jsonStr = String(data: jsonData, encoding: .utf8) {
                    webView?.evaluateJavaScript(
                        "window.__onNativeClipboardImage && window.__onNativeClipboardImage(\(jsonStr));",
                        completionHandler: nil
                    )
                }
            }
            return
        }
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
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
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

@main
private enum ColabDeskMain {
    static let delegate = AppDelegate()

    static func main() {
        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}

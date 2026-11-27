import Darwin
import Foundation

// Finder does not pass a developer PATH. Build one from known install
// locations, then spawn node in its own process group so quit can signal the
// server and any colab children.

private let listenMarker = "colab-desk listening on http://127.0.0.1:"

enum LaunchError: LocalizedError {
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

final class ServerSession {
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

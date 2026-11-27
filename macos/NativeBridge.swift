import Cocoa
import UserNotifications
import WebKit

private struct ClipboardImageItem {
    let name: String
    let mimeType: String
    let data: Data
}

extension AppDelegate: WKScriptMessageHandler, UNUserNotificationCenterDelegate {
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
        if message.name == "setLanguage", let lang = message.body as? String {
            installMainMenu(isChinese: lang != "en")
            return
        }
        if message.name == "openExternal", let raw = message.body as? String, let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
            return
        }
        if message.name == "clipboardImage" {
            _ = handleNativeImagePaste()
            return
        }
    }

    private func extractClipboardImages() -> [ClipboardImageItem] {
        let pb = NSPasteboard.general
        let allowedExts: Set<String> = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic"]
        var items: [ClipboardImageItem] = []

        // 1. Check copied file URLs first (e.g. Finder ⌘C on image file(s))
        var fileUrls: [URL] = []
        if let rawUrls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !rawUrls.isEmpty {
            fileUrls = rawUrls.map { ($0 as NSURL).filePathURL ?? $0.standardizedFileURL }
        } else if let paths = pb.propertyList(forType: NSPasteboard.PasteboardType("NSFilenamesPboardType")) as? [String],
                  !paths.isEmpty {
            fileUrls = paths.map { URL(fileURLWithPath: $0) }
        }

        if !fileUrls.isEmpty {
            for url in fileUrls.prefix(6) {
                let ext = url.pathExtension.lowercased()
                guard allowedExts.contains(ext), let raw = try? Data(contentsOf: url), raw.count <= 25_000_000 else {
                    continue
                }
                if ext == "tif" || ext == "tiff" || ext == "heic" {
                    if let img = NSImage(data: raw),
                       let tiff = img.tiffRepresentation,
                       let rep = NSBitmapImageRep(data: tiff),
                       let png = rep.representation(using: .png, properties: [:]),
                       png.count <= 25_000_000 {
                        let baseName = url.deletingPathExtension().lastPathComponent
                        items.append(ClipboardImageItem(
                            name: "\(baseName.isEmpty ? "image" : baseName).png",
                            mimeType: "image/png",
                            data: png
                        ))
                    }
                } else {
                    var mime = "image/png"
                    if ext == "jpg" || ext == "jpeg" { mime = "image/jpeg" }
                    else if ext == "webp" { mime = "image/webp" }
                    else if ext == "gif" { mime = "image/gif" }
                    else if ext == "bmp" { mime = "image/bmp" }
                    items.append(ClipboardImageItem(name: url.lastPathComponent, mimeType: mime, data: raw))
                }
            }
            // Do not misread Finder's generic TIFF icon for non-image files as an image.
            return items
        }

        // 2. Check raw clipboard image data (macOS screenshots, Copy Image, Snipaste/WeChat/CleanShot)
        let plain = pb.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let looksLikeRichTextCopy = !plain.isEmpty
            && !plain.hasPrefix("http://")
            && !plain.hasPrefix("https://")
            && pb.data(forType: .rtf) != nil
        if looksLikeRichTextCopy {
            return []
        }

        if let png = pb.data(forType: .png), png.count <= 25_000_000 {
            return [ClipboardImageItem(name: "image.png", mimeType: "image/png", data: png)]
        }
        let jpegType = NSPasteboard.PasteboardType("public.jpeg")
        if let jpg = pb.data(forType: jpegType), jpg.count <= 25_000_000 {
            return [ClipboardImageItem(name: "image.jpg", mimeType: "image/jpeg", data: jpg)]
        }
        if let tiff = pb.data(forType: .tiff),
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]),
           png.count <= 25_000_000 {
            return [ClipboardImageItem(name: "image.png", mimeType: "image/png", data: png)]
        }
        if plain.isEmpty,
           let img = NSImage(pasteboard: pb),
           let tiff = img.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]),
           png.count <= 25_000_000 {
            return [ClipboardImageItem(name: "image.png", mimeType: "image/png", data: png)]
        }
        return []
    }

    @discardableResult
    func handleNativeImagePaste() -> Bool {
        let items = extractClipboardImages()
        guard !items.isEmpty else { return false }

        guard let baseURL = serverBaseURL else {
            let payloads = items.map { item -> [String: String] in
                ["name": item.name, "mimeType": item.mimeType, "base64": item.data.base64EncodedString()]
            }
            if let jsonData = try? JSONSerialization.data(withJSONObject: payloads),
               let jsonStr = String(data: jsonData, encoding: .utf8) {
                webView?.evaluateJavaScript(
                    "window.__onNativeClipboardImages && window.__onNativeClipboardImages(\(jsonStr));",
                    completionHandler: nil
                )
            }
            return true
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var staged: [[String: Any]] = []
            let group = DispatchGroup()
            let lock = NSLock()

            for item in items {
                var comps = URLComponents(url: baseURL.appendingPathComponent("api/stage-file"), resolvingAgainstBaseURL: false)
                comps?.queryItems = [
                    URLQueryItem(name: "name", value: item.name),
                    URLQueryItem(name: "mime", value: item.mimeType),
                ]
                guard let endpoint = comps?.url else { continue }
                var req = URLRequest(url: endpoint)
                req.httpMethod = "POST"
                req.setValue(item.mimeType, forHTTPHeaderField: "Content-Type")
                req.httpBody = item.data

                group.enter()
                URLSession.shared.dataTask(with: req) { data, _, _ in
                    defer { group.leave() }
                    guard let data,
                          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          (obj["ok"] as? Bool) == true else {
                        return
                    }
                    lock.lock()
                    staged.append(obj)
                    lock.unlock()
                }.resume()
            }

            group.wait()
            guard !staged.isEmpty,
                  let jsonData = try? JSONSerialization.data(withJSONObject: staged),
                  let jsonStr = String(data: jsonData, encoding: .utf8) else {
                return
            }
            DispatchQueue.main.async {
                self?.webView?.evaluateJavaScript(
                    "window.__onNativeStagedFiles && window.__onNativeStagedFiles(\(jsonStr));",
                    completionHandler: nil
                )
            }
        }
        return true
    }
}

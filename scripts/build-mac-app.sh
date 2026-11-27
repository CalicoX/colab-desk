#!/bin/bash
# Assemble dist/Colab Desk.app around the local Node server and restart the app.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"
arch="$(uname -m)"
app="$root/dist/Colab Desk.app"
stage="$root/dist/.Colab Desk.app.staging"
server="$stage/Contents/Resources/server"
icon_src="$root/macos/AppIcon.png"
icon_cache="$root/macos/AppIcon.icns"
icon_out="$stage/Contents/Resources/AppIcon.icns"

rm -rf "$stage"
mkdir -p "$stage/Contents/MacOS" "$server"

shopt -s nullglob
swift_sources=("$root"/macos/*.swift)
shopt -u nullglob
if [[ ${#swift_sources[@]} -eq 0 ]]; then
  echo "No Swift source files found under $root/macos" >&2
  exit 1
fi

swiftc -O -parse-as-library \
  -file-prefix-map "$root=." \
  -target "${arch}-apple-macos12.0" \
  -framework Cocoa \
  -framework WebKit \
  -framework UserNotifications \
  "${swift_sources[@]}" \
  -o "$stage/Contents/MacOS/ColabDesk"
strip -x "$stage/Contents/MacOS/ColabDesk" || true

if [[ -f "$icon_src" ]]; then
  if [[ ! -f "$icon_cache" || "$icon_src" -nt "$icon_cache" ]]; then
    tmpdir="$(mktemp -d)"
    trap 'rm -rf "$tmpdir"' EXIT
    shaped="$tmpdir/shaped.png"
    iconset="$tmpdir/AppIcon.iconset"
    mkdir -p "$iconset"

    # Shape full-bleed square artwork to Apple HIG macOS icon proportions (824x824 squircle in 1024x1024).
    swift - "$icon_src" "$shaped" <<'SWIFT'
import Cocoa

let srcPath = CommandLine.arguments[1]
let dstPath = CommandLine.arguments[2]
guard let src = NSImage(contentsOfFile: srcPath) else {
    fputs("Failed to read icon source: \(srcPath)\n", stderr)
    exit(1)
}

let canvas: CGFloat = 1024
let inset: CGFloat = 100
let inner = CGRect(x: inset, y: inset, width: canvas - inset * 2, height: canvas - inset * 2)
let radius: CGFloat = 185

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(canvas),
    pixelsHigh: Int(canvas),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
)!
rep.size = NSSize(width: canvas, height: canvas)

NSGraphicsContext.saveGraphicsState()
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = ctx
ctx.imageInterpolation = .high

let clipPath = NSBezierPath(roundedRect: inner, xRadius: radius, yRadius: radius)

// Subtle macOS Dock drop shadow
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.32)
shadow.shadowBlurRadius = 26
shadow.shadowOffset = NSSize(width: 0, height: -12)
shadow.set()
NSColor.black.setFill()
clipPath.fill()
NSGraphicsContext.restoreGraphicsState()

// Draw clipped artwork
NSGraphicsContext.saveGraphicsState()
clipPath.addClip()
src.draw(in: inner, from: .zero, operation: .sourceOver, fraction: 1.0)
NSGraphicsContext.restoreGraphicsState()

// Crisp inner hairline rim
NSColor.white.withAlphaComponent(0.14).setStroke()
clipPath.lineWidth = 2
clipPath.stroke()

NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
    fputs("Failed to encode shaped icon PNG\n", stderr)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: dstPath))
SWIFT

    for size in 16 32 128 256 512; do
      double=$((size * 2))
      sips -z "$size" "$size" "$shaped" --out "$iconset/icon_${size}x${size}.png" >/dev/null
      sips -z "$double" "$double" "$shaped" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
    done
    iconutil -c icns "$iconset" -o "$icon_cache"
  fi
  cp "$icon_cache" "$icon_out"
fi

cp "$root/macos/Info.plist" "$stage/Contents/Info.plist"
cp -R "$root/src" "$root/public" "$server/"
cp "$root/package.json" "$server/package.json"

chmod +x "$stage/Contents/MacOS/ColabDesk"
chmod +x "$0"

# Gracefully quit any running Colab Desk instance right before atomic bundle swap.
if pgrep -x ColabDesk >/dev/null 2>&1; then
  pkill -TERM -x ColabDesk || true
  for _ in $(seq 1 25); do
    if ! pgrep -x ColabDesk >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  if pgrep -x ColabDesk >/dev/null 2>&1; then
    pkill -KILL -x ColabDesk || true
    sleep 0.1
  fi
fi

rm -rf "$app"
mv "$stage" "$app"
codesign --force --sign - "$app"
touch "$app"

# Package clean distributable zip (no personal paths/state)
zip_out="$root/dist/Colab-Desk-macOS-${arch}.zip"
rm -f "$zip_out"
ditto -c -k --norsrc --keepParent "$app" "$zip_out"

if [[ "${COLAB_DESK_NO_LAUNCH:-0}" != "1" ]]; then
  open "$app"
fi

echo "$app"
echo "$zip_out"

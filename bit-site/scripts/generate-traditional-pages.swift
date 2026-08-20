import Foundation

let sourcePath = "public/index.html"
let pages: [(code: String, outputPath: String, signupBase: String?)] = [
  (code: "DPG78V", outputPath: "public/dpg78v-page.txt", signupBase: nil),
  (code: "USMKT", outputPath: "public/usmkt-page.txt", signupBase: "https://www.bit.com/zh-tw/register"),
]

guard let source = try? String(contentsOfFile: sourcePath, encoding: .utf8) else {
  fputs("Unable to read \(sourcePath)\n", stderr)
  exit(1)
}

guard let converted = source.applyingTransform(
  StringTransform("Simplified-Traditional"),
  reverse: false
) else {
  fputs("Traditional Chinese conversion failed\n", stderr)
  exit(1)
}

for page in pages {
  var traditional = converted
    .replacingOccurrences(of: "<!DOCTYPE html>", with: "<!DOCTYPE html>\n<!-- Generated from public/index.html by scripts/generate-traditional-pages.swift. -->")
    .replacingOccurrences(of: "<html lang=\"zh-CN\">", with: "<html lang=\"zh-Hant\">")
    .replacingOccurrences(of: "https://bit.onsites.me/\"", with: "https://bit.onsites.me/\(page.code)\"")
    .replacingOccurrences(
      of: "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif",
      with: "'PingFang TC','Microsoft JhengHei','Noto Sans TC','PingFang SC','Microsoft YaHei',sans-serif"
    )

  if let signupBase = page.signupBase {
    traditional = traditional.replacingOccurrences(
      of: "https://www.bit.com/zh/register",
      with: signupBase
    )
  }

  do {
    try traditional.write(toFile: page.outputPath, atomically: true, encoding: .utf8)
  } catch {
    fputs("Unable to write \(page.outputPath): \(error)\n", stderr)
    exit(1)
  }
}

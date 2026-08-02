{
  # Both arm64 and x64 are supported build targets. Which one is produced is
  # selected by target_arch (node-gyp defaults it to the host, and
  # `node-gyp rebuild --arch=x64` overrides it), so a source install on an
  # Intel Mac builds the x64 slice and one on Apple Silicon builds arm64.
  #
  # x64 is a target on purpose, not by accident. caps.mm gates its
  # ARM-specific interpretation on a compile-time constant and reports
  # honestly instead of erroring, so an x64 build loads and says "this is not
  # Apple Silicon" with an empty SME block and an unavailable GPU count.
  # package.json lists cpu ["arm64","x64"] to match. A detection library
  # should be the one thing that always installs and always tells the truth,
  # including the truth that there is nothing here to detect.
  "targets": [
    {
      "target_name": "apple_silicon_caps",
      "sources": ["native/src/caps.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": ["NAPI_VERSION=8", "NODE_ADDON_API_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "link_settings": {
            "libraries": [
              "-framework IOKit",
              "-framework Metal",
              "-framework Foundation",
              "-framework CoreFoundation"
            ]
          },
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            # GCC_ENABLE_OBJC_EXCEPTIONS is deliberately not set: gyp's mac
            # generator does not implement it and prints a warning, and clang
            # enables ObjC exceptions for .mm translation units by default.
            "GCC_OPTIMIZATION_LEVEL": "2",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "OTHER_CFLAGS": ["-Wall", "-Wextra"],
            "VALID_ARCHS": ["arm64", "x86_64"]
          },
          "conditions": [
            ["target_arch=='arm64'", {
              "xcode_settings": { "ARCHS": ["arm64"] }
            }],
            ["target_arch=='x64'", {
              "xcode_settings": { "ARCHS": ["x86_64"] }
            }]
          ]
        }]
      ]
    }
  ]
}

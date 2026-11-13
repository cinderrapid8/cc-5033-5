{
  "targets": [
    {
      "target_name": "lcms_native",
      "sources": ["addon/lcms_native.cpp"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "libraries": ["-llcms2"],
      "cflags_cc": ["-fexceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", { "xcode_settings": { "GCC_ENABLE_CPP_EXCEPTIONS": "YES" } }]
      ]
    }
  ]
}

{
  "targets": [
    {
      "target_name": "autotype_win32",
      "sources": ["autotype.cc"],
      "defines": [
        "NAPI_VERSION=8",
        "NODE_GYP_MODULE_NAME=autotype_win32"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/utf-8"]
        }
      }
    }
  ]
}

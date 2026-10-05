import { app } from "../../scripts/app.js";

// Core Comfy.UploadImage only attaches one IMAGEUPLOAD widget, to the first
// required media combo (Image). Add a second for File so video choose-file
// and preview use video_upload instead of the image accept filter.
app.registerExtension({
  name: "Oasis.MetadataUpload",
  async beforeRegisterNodeDef(nodeType, spec) {
    if (spec?.name !== "OasisMetadata") return;
    const req = spec.input?.required;
    const fileSpec = req?.file;
    if (!fileSpec) return;
    const extras = Array.isArray(fileSpec) ? (fileSpec[1] || {}) : {};
    req.upload_video = [
      "IMAGEUPLOAD",
      { ...extras, imageInputName: "file", video_upload: true },
    ];
  },
});

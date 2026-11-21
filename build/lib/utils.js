"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var utils_exports = {};
__export(utils_exports, {
  sanitizeLogMessage: () => sanitizeLogMessage
});
module.exports = __toCommonJS(utils_exports);
function sanitizeLogMessage(value, maxLength = 500) {
  const sanitized = value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, (char) => {
    if (char === "\r") {
      return "\\r";
    }
    if (char === "\n") {
      return "\\n";
    }
    if (char === "	") {
      return "\\t";
    }
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  const chars = Array.from(sanitized);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}\u2026` : sanitized;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  sanitizeLogMessage
});
//# sourceMappingURL=utils.js.map

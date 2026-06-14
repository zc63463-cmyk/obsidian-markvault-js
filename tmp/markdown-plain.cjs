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

// src/core/markdown-plain.ts
var markdown_plain_exports = {};
__export(markdown_plain_exports, {
  markdownToPlainWithMap: () => markdownToPlainWithMap
});
module.exports = __toCommonJS(markdown_plain_exports);
function markdownToPlainWithMap(content) {
  const map = [];
  let plain = "";
  let i = 0;
  const push = (char, srcIndex) => {
    plain += char;
    map.push(srcIndex);
  };
  while (i < content.length) {
    if (content.startsWith("%%", i)) {
      const end = content.indexOf("%%", i + 2);
      i = end === -1 ? i + 2 : end + 2;
      continue;
    }
    if (content.startsWith("$$", i)) {
      const end = content.indexOf("$$", i + 2);
      if (end !== -1) {
        for (let k = i + 2; k < end; k++) {
          push(content[k], k);
        }
        i = end + 2;
        continue;
      }
    }
    if (content[i] === "$") {
      const end = content.indexOf("$", i + 1);
      if (end !== -1) {
        for (let k = i + 1; k < end; k++) {
          push(content[k], k);
        }
        i = end + 1;
        continue;
      }
    }
    if (content.startsWith("```", i)) {
      const lineEnd = content.indexOf("\n", i);
      if (lineEnd !== -1) {
        i = lineEnd + 1;
        const closeFence = content.indexOf("\n```", i);
        if (closeFence !== -1) {
          for (let k = i; k < closeFence; k++) {
            push(content[k], k);
          }
          i = closeFence + 4;
          continue;
        } else {
          for (let k = i; k < content.length; k++) {
            push(content[k], k);
          }
          i = content.length;
          continue;
        }
      }
    }
    if (content[i] === "`") {
      const end = content.indexOf("`", i + 1);
      if (end === -1) {
        push(content[i], i);
        i++;
        continue;
      }
      for (let k = i + 1; k < end; k++) {
        push(content[k], k);
      }
      i = end + 1;
      continue;
    }
    if (content.startsWith("**", i)) {
      const end = content.indexOf("**", i + 2);
      if (end !== -1) {
        i += 2;
        continue;
      }
      push(content[i], i);
      i++;
      continue;
    }
    if (content.startsWith("==", i) || content.startsWith("~~", i)) {
      const marker = content.slice(i, i + 2);
      const end = content.indexOf(marker, i + 2);
      i = end === -1 ? i + 2 : end + 2;
      continue;
    }
    if (content[i] === "#" && (i === 0 || content[i - 1] === "\n")) {
      let j = i;
      while (j < content.length && content[j] === "#") j++;
      if (j < content.length && content[j] === " ") j++;
      i = j;
      continue;
    }
    if ((content[i] === "-" || content[i] === "*" || content[i] === "+") && (i === 0 || content[i - 1] === "\n") && content[i + 1] === " ") {
      i += 2;
      if (content[i] === "[" && (content[i + 1] === " " || content[i + 1] === "x" || content[i + 1] === "X") && content[i + 2] === "]") {
        i += 3;
        if (content[i] === " ") i++;
      }
      continue;
    }
    if (/\d/.test(content[i]) && (i === 0 || content[i - 1] === "\n")) {
      let j = i;
      while (j < content.length && /\d/.test(content[j])) j++;
      if (content[j] === "." && content[j + 1] === " ") {
        i = j + 2;
        continue;
      }
    }
    if (content[i] === "*") {
      const end = content.indexOf("*", i + 1);
      if (end !== -1 && end === i + 1) {
        push(content[i], i);
        i++;
        continue;
      }
      if (end !== -1) {
        i++;
        continue;
      }
      push(content[i], i);
      i++;
      continue;
    }
    if (content.startsWith("[[", i)) {
      const end = content.indexOf("]]", i + 2);
      if (end !== -1) {
        const inner = content.slice(i + 2, end);
        const pipe = inner.indexOf("|");
        const display = pipe !== -1 ? inner.slice(0, pipe) : inner;
        for (let k = 0; k < display.length; k++) {
          push(display[k], i + 2 + k);
        }
        i = end + 2;
        continue;
      }
    }
    if (content[i] === "[") {
      const endText = content.indexOf("]", i);
      if (endText !== -1 && content[endText + 1] === "(") {
        const endUrl = content.indexOf(")", endText + 2);
        if (endUrl !== -1) {
          for (let k = i + 1; k < endText; k++) {
            push(content[k], k);
          }
          i = endUrl + 1;
          continue;
        }
      }
    }
    if (content[i] === "<") {
      const end = content.indexOf(">", i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    if (content[i] === ">" && (i === 0 || content[i - 1] === "\n")) {
      i++;
      if (content[i] === " ") i++;
      continue;
    }
    push(content[i], i);
    i++;
  }
  return { plain, map };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  markdownToPlainWithMap
});

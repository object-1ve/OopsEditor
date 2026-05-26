import { loader } from "@monaco-editor/react";
import "monaco-editor/esm/nls.messages.zh-cn.js";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type MonacoWorkerFactory = {
  getWorker: (_workerId: string, label: string) => Worker;
};

(self as typeof globalThis & { MonacoEnvironment?: MonacoWorkerFactory }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "json") {
      return new jsonWorker();
    }
    if (label === "css" || label === "scss" || label === "less") {
      return new cssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new htmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

// Force monaco-react to use the locally bundled Monaco instead of the default CDN loader.
loader.config({ monaco });
export const monacoReady = loader.init();

export { monaco };

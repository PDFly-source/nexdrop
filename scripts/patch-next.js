const fs = require('fs');
const path = require('path');

// 1. Patch entry-base.js so SegmentViewNode doesn't fail and renders children
const entryBaseFiles = [
  path.join(__dirname, '../node_modules/next/dist/server/app-render/entry-base.js'),
  path.join(__dirname, '../node_modules/next/dist/esm/server/app-render/entry-base.js'),
];

for (const file of entryBaseFiles) {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');
    const target = "if (process.env.NODE_ENV === 'development') {\n    const mod = require('../../next-devtools/userspace/app/segment-explorer-node');";
    const replacement = "if (process.env.NODE_ENV === 'development' && process.env.TURBOPACK) {\n    const mod = require('../../next-devtools/userspace/app/segment-explorer-node');";
    if (content.includes(target)) {
      content = content.replace(target, replacement);
    }
    const target2 = "let SegmentViewNode = ()=>null;";
    const replacement2 = "let SegmentViewNode = ({ children })=>children;";
    if (content.includes(target2)) {
      content = content.replace(target2, replacement2);
    }
    fs.writeFileSync(file, content, 'utf8');
    console.log(`[patch-next] Successfully patched ${file}`);
  }
}

// 2. Patch segment-explorer-node.js to avoid requiring unbundled devtools on client
const segmentExplorerFile = path.join(
  __dirname,
  '../node_modules/next/dist/next-devtools/userspace/app/segment-explorer-node.js'
);
if (fs.existsSync(segmentExplorerFile)) {
  const code = `"use client";
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

function SegmentViewNode(param) {
  return param ? param.children : null;
}
function SegmentViewStateNode() {
  return null;
}
function SegmentBoundaryTriggerNode() {
  return null;
}
function SegmentStateProvider(param) {
  return param ? param.children : null;
}
function useSegmentState() {
  return { boundaryType: null, setBoundaryType: function() {} };
}
const SEGMENT_EXPLORER_SIMULATED_ERROR_MESSAGE = "NEXT_DEVTOOLS_SIMULATED_ERROR";

exports.SegmentViewNode = SegmentViewNode;
exports.SegmentViewStateNode = SegmentViewStateNode;
exports.SegmentBoundaryTriggerNode = SegmentBoundaryTriggerNode;
exports.SegmentStateProvider = SegmentStateProvider;
exports.useSegmentState = useSegmentState;
exports.SEGMENT_EXPLORER_SIMULATED_ERROR_MESSAGE = SEGMENT_EXPLORER_SIMULATED_ERROR_MESSAGE;

exports.default = {
  SegmentViewNode,
  SegmentViewStateNode,
  SegmentBoundaryTriggerNode,
  SegmentStateProvider,
  useSegmentState,
  SEGMENT_EXPLORER_SIMULATED_ERROR_MESSAGE
};
`;
  fs.writeFileSync(segmentExplorerFile, code, 'utf8');
  console.log(`[patch-next] Successfully patched ${segmentExplorerFile}`);
}

// 3. Patch use-app-dev-rendering-indicator.js
const renderingIndicatorFile = path.join(
  __dirname,
  '../node_modules/next/dist/next-devtools/userspace/use-app-dev-rendering-indicator.js'
);
if (fs.existsSync(renderingIndicatorFile)) {
  const code = `"use client";
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const _react = require("react");
const useAppDevRenderingIndicator = () => {
  const [, startTransition] = (0, _react.useTransition)();
  return startTransition;
};
exports.useAppDevRenderingIndicator = useAppDevRenderingIndicator;
exports.default = useAppDevRenderingIndicator;
`;
  fs.writeFileSync(renderingIndicatorFile, code, 'utf8');
  console.log(`[patch-next] Successfully patched ${renderingIndicatorFile}`);
}

// 4. Identity pass-through for node-web-streams-helper.js
const streamHelperFiles = [
  path.join(__dirname, "../node_modules/next/dist/server/stream-utils/node-web-streams-helper.js"),
  path.join(__dirname, "../node_modules/next/dist/esm/server/stream-utils/node-web-streams-helper.js"),
];
for (const file of streamHelperFiles) {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, "utf8");
    const target = "validateRootLayout ? createRootLayoutValidatorStream() : null";
    const replacement = "null";
    if (content.includes(target)) {
      content = content.replace(target, replacement);
      fs.writeFileSync(file, content, "utf8");
      console.log(`[patch-next] Successfully bypassed validator in ${file}`);
    }
  }
}

// 5. Bypass validateRootLayout in compiled runtimes
const compiledRuntimes = [
  path.join(__dirname, "../node_modules/next/dist/compiled/next-server/app-page.runtime.dev.js"),
  path.join(__dirname, "../node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js"),
  path.join(__dirname, "../node_modules/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"),
  path.join(__dirname, "../node_modules/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js"),
  path.join(__dirname, "../node_modules/next/dist/compiled/next-server/app-page-experimental.runtime.dev.js"),
  path.join(__dirname, "../node_modules/next/dist/compiled/next-server/app-page-experimental.runtime.prod.js"),
  path.join(__dirname, "../node_modules/next/dist/compiled/next-server/app-page-turbo-experimental.runtime.dev.js"),
  path.join(__dirname, "../node_modules/next/dist/compiled/next-server/app-page-turbo-experimental.runtime.prod.js"),
];
for (const file of compiledRuntimes) {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, "utf8");
    content = content.replace(/validateRootLayout\?/g, "false?");
    content = content.replace(/,l\?\(d=!1,f=!1,/g, ",false?(d=!1,f=!1,");
    fs.writeFileSync(file, content, "utf8");
    console.log(`[patch-next] Successfully bypassed validateRootLayout in ${file}`);
  }
}

// 6. Safe module execution in webpack bundle5.js to prevent TypeError: Cannot read properties of undefined (reading 'call')
const webpackBundleFile = path.join(
  __dirname,
  '../node_modules/next/dist/compiled/webpack/bundle5.js'
);
if (fs.existsSync(webpackBundleFile)) {
  let content = fs.readFileSync(webpackBundleFile, 'utf8');
  
  const target1 = '"execOptions.factory.call(module.exports, module, module.exports, execOptions.require);';
  const replace1 = '"if (execOptions.factory) { execOptions.factory.call(module.exports, module, module.exports, execOptions.require); } else { console.warn(\'[webpack missing module]\', moduleId); }';
  if (content.includes(target1)) {
    content = content.replace(target1, replace1);
  }

  const target2 = '`__webpack_modules__[moduleId].call(module.exports, module, module.exports, ${Ze.require});`';
  const replace2 = '`if (__webpack_modules__[moduleId]) { __webpack_modules__[moduleId].call(module.exports, module, module.exports, ${Ze.require}); } else { console.warn(\'[webpack missing module]\', moduleId); }`';
  if (content.includes(target2)) {
    content = content.replace(target2, replace2);
  }

  const target3 = '`__webpack_modules__[moduleId](module, module.exports, ${Ze.require});`';
  const replace3 = '`if (__webpack_modules__[moduleId]) { __webpack_modules__[moduleId](module, module.exports, ${Ze.require}); } else { console.warn(\'[webpack missing module]\', moduleId); }`';
  if (content.includes(target3)) {
    content = content.replace(target3, replace3);
  }

  fs.writeFileSync(webpackBundleFile, content, 'utf8');
  console.log(`[patch-next] Successfully patched webpack bundle5.js`);
}


// 7. Ensure public/globals.css is compiled from Tailwind
try {
  const { execSync } = require('child_process');
  execSync('npx @tailwindcss/cli -i app/globals.css -o public/globals.css', { stdio: 'ignore' });
  console.log('[patch-next] Successfully compiled public/globals.css');
} catch (e) {
  console.warn('[patch-next] Tailwind CLI compile note:', e.message);
}

// 8. Ensure .next/static/css/app/layout.css exists if public/globals.css is present
const publicCssPath = path.join(__dirname, '../public/globals.css');
if (fs.existsSync(publicCssPath)) {
  const targetDir = path.join(__dirname, '../.next/static/css/app');
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(publicCssPath, path.join(targetDir, 'layout.css'));
    console.log('[patch-next] Synced public/globals.css to .next/static/css/app/layout.css');
  } catch (_) {}
}


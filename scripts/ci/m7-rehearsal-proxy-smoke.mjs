#!/usr/bin/env node
// Regression: rehearsal browser routes, including WebSocket, must never
// target a concurrently running official UniQuiz server on port 8787.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo=resolve(fileURLToPath(new URL("../..",import.meta.url)));
const webRoot=resolve(repo,"apps/web");
const webRequire=createRequire(resolve(webRoot,"package.json"));
const vite=await import(pathToFileURL(webRequire.resolve("vite")).href);
const configPath=resolve(webRoot,"vite.config.ts");
const key="UNIQUIZ_API_PROXY_TARGET";
const prior=process.env[key];
try {
  process.env[key]="http://127.0.0.1:8788";
  const resolved=await vite.loadConfigFromFile(
    {command:"serve",mode:"development"},configPath,webRoot,"silent");
  assert.ok(resolved,"VITE_REHEARSAL_CONFIG_MISSING");
  const proxy=resolved.config.server?.proxy;
  assert.ok(proxy,"VITE_REHEARSAL_PROXY_MISSING");
  for (const route of ["/health","/api","/socket.io"]) {
    assert.equal(proxy[route]?.target,"http://127.0.0.1:8788",
      "M7_REHEARSAL_CROSS_ENVIRONMENT_PROXY_LEAK: "+route);
  }
  assert.equal(proxy["/socket.io"]?.ws,true,"M7_REHEARSAL_WEBSOCKET_PROXY_DISABLED");
  assert.equal(resolved.config.server?.strictPort,true,"M7_REHEARSAL_PORT_UNSAFE");
  console.log("M7_REHEARSAL_PROXY_ISOLATED_OK");
} finally {
  if(prior===undefined) delete process.env[key];
  else process.env[key]=prior;
}

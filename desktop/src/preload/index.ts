import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import {
  ScreenSourceSchema,
  platformSchema,
  setTokenArgSchema,
  updateInfoSchema,
} from "@tavern/shared";
import type { TavernIpc } from "@tavern/shared";

// Every main→renderer payload is zod-parsed here (§9.8). Raw ipcRenderer is NEVER exposed — only
// the wrapped, typed `window.tavern` surface (checklist #20).
const screenSourcesSchema = ScreenSourceSchema.array();
const booleanSchema = z.boolean();
const tagSchema = z.string();

const api: TavernIpc = {
  platform: platformSchema.parse(process.platform),
  // §10: the e2e harness launches with TAVERN_E2E=1; the renderer reads this static flag (via the
  // platform bridge) to install the test hooks. Sandboxed preloads still expose process.env.
  isE2E: process.env.TAVERN_E2E === "1",
  secrets: {
    async getToken() {
      const value: unknown = await ipcRenderer.invoke("secrets:getToken");
      return setTokenArgSchema.parse(value);
    },
    async setToken(token) {
      await ipcRenderer.invoke("secrets:setToken", token);
    },
  },
  capture: {
    async getScreenSources() {
      const value: unknown = await ipcRenderer.invoke("capture:getScreenSources");
      return screenSourcesSchema.parse(value);
    },
    async selectSource(id) {
      await ipcRenderer.invoke("capture:selectSource", id);
    },
    async loopbackAudioSupported() {
      const value: unknown = await ipcRenderer.invoke("capture:loopbackAudioSupported");
      return booleanSchema.parse(value);
    },
  },
  notifications: {
    async show(payload) {
      await ipcRenderer.invoke("notifications:show", payload);
    },
    onClick(cb) {
      ipcRenderer.on("notifications:clicked", (_event, tag: unknown) => {
        cb(tagSchema.parse(tag));
      });
    },
  },
  updates: {
    onUpdateReady(cb) {
      ipcRenderer.on("update://ready", (_event, info: unknown) => {
        cb(updateInfoSchema.parse(info));
      });
    },
    async restartToUpdate() {
      await ipcRenderer.invoke("updates:restartToUpdate");
    },
  },
  shell: {
    async setBadge(count) {
      await ipcRenderer.invoke("shell:setBadge", count);
    },
    async focusWindow() {
      await ipcRenderer.invoke("shell:focusWindow");
    },
  },
};

contextBridge.exposeInMainWorld("tavern", api);

// Sentinel so importers (tests) can load this side-effecting module as an assigned import.
export const bridgeInstalled = true;

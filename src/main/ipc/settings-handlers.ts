import { ipcMain } from "electron";
import {
  BROWSER_SETTING_STORAGE_KEYS,
  type BrowserSettingName,
  decodeBrowserSettings,
  encodeBrowserSetting,
  parseBrowserSettingsPatch,
} from "../../shared/browser";
import { getAllSettings, getSetting, setSetting } from "../db";

const browserStorageKeys = new Set<string>(
  Object.values(BROWSER_SETTING_STORAGE_KEYS),
);

const readBrowserSettings = () => decodeBrowserSettings(getSetting);

export const registerSettingsHandlers = () => {
  ipcMain.handle("settings:get", async (_event, key: string) => {
    return getSetting(key);
  });

  ipcMain.handle("settings:set", async (_event, key: string, value: string) => {
    if (browserStorageKeys.has(key)) {
      throw new Error(
        "Browser settings must be updated through the typed browser settings API",
      );
    }
    setSetting(key, value);
    return true;
  });

  ipcMain.handle("settings:getAll", async () => {
    return getAllSettings();
  });

  ipcMain.handle("settings:browser:get", async () => readBrowserSettings());

  ipcMain.handle("settings:browser:set", async (_event, value: unknown) => {
    const patch = parseBrowserSettingsPatch(value);
    for (const [rawKey, settingValue] of Object.entries(patch)) {
      const key = rawKey as BrowserSettingName;
      setSetting(
        BROWSER_SETTING_STORAGE_KEYS[key],
        encodeBrowserSetting(key, settingValue),
      );
    }
    return readBrowserSettings();
  });
};

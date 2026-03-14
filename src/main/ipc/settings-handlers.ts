import { ipcMain } from "electron";
import { getAllSettings, getSetting, setSetting } from "../db";

export const registerSettingsHandlers = () => {
  ipcMain.handle("settings:get", async (_event, key: string) => {
    return getSetting(key);
  });

  ipcMain.handle("settings:set", async (_event, key: string, value: string) => {
    setSetting(key, value);
    return true;
  });

  ipcMain.handle("settings:getAll", async () => {
    return getAllSettings();
  });
};

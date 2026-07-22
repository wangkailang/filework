import type { FileWorkAPI } from "../../preload/index";
import type {
  BrowserSettings,
  BrowserSettingsPatch,
} from "../../shared/browser";

type BrowserSettingsBridge = {
  get: () => Promise<BrowserSettings>;
  set: (patch: BrowserSettingsPatch) => Promise<BrowserSettings>;
};

declare global {
  interface Window {
    filework: FileWorkAPI & { readonly browserSettings: BrowserSettingsBridge };
  }
}

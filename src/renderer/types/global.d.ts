import type { FileWorkAPI } from "../../preload/index";

declare global {
  interface Window {
    filework: FileWorkAPI;
  }
}

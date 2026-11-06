import { extraMode } from "tiny-config/extra";
import { currentMode } from "tiny-config";

export const settingsMode = extraMode;
export const activeMode = currentMode();
export const pageTitle = document.title;

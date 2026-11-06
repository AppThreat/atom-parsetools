import { level } from "tiny-logger";
import { extraLevel } from "tiny-logger/extra";
import { badge } from "@ui/badge";

function getState(): { open?: boolean } {
  return {};
}

export const widgetLevel = level;
export const widgetExtraLevel = extraLevel;
export const widgetBadge = badge;
export const widgetFlag = getState().open;

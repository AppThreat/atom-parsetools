import { level } from "tiny-logger";

function getState(): { open?: boolean } {
  return {};
}

export const sharedLevel = level;
export const sharedFlag = getState().open;

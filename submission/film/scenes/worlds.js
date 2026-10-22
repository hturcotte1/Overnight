// Every world the film can draw. Each is one fragment shader that writes linear HDR colour and a
// signed circle of confusion (alpha), scaled by uWeight so layers add up.
import { WRIST } from "./shaders/wrist.js";
import { SKY } from "./shaders/sky.js";
import { LAPTOP, PANEL, PHONE } from "./shaders/device.js";
import { RAYS, ATMOS, PLATE } from "./shaders/light.js";

export const WORLDS = {
  wrist: WRIST,
  sky: SKY,
  laptop: LAPTOP,
  panel: PANEL,
  phone: PHONE,
  rays: RAYS,
  atmos: ATMOS,
  plate: PLATE,
};

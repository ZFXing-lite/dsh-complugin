/**
 * dsh-complugin — the module list.
 *
 * Adding a feature: write `lib/modules/<name>.js` that default-exports
 * `defineModule({...})`, import it here, push it into the array. Order in the
 * panel is decided by each module's `order`, not by this list.
 *
 * @module dsh-complugin/modules
 */
import { defineModules } from "../core/registry.js";
import autoCompact from "./auto-compact.js";
import autoContinue from "./auto-continue.js";
import visionBridge from "./vision-bridge.js";
import reasoningEffort from "./reasoning-effort.js";

/** Every module this build ships, validated and ordered for the panel. */
export default defineModules([autoCompact, autoContinue, visionBridge, reasoningEffort]);

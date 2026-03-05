import { DialogPlayground } from "@stackables/bridge-playground";
// Import playground styles - the docs-site custom.css overrides the base layer
// to prevent it from breaking Starlight layout
import "@stackables/bridge-playground/style.css";

/**
 * A button that opens a modal with MiniPlayground.
 * Used in documentation to provide interactive examples.
 */
export default function MiniPlaygroundModal() {
  return <DialogPlayground />;
}

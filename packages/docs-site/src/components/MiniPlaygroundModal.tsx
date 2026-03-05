import { DialogPlayground } from "@stackables/bridge-playground";
// Import playground styles - the docs-site custom.css overrides the base layer
// to prevent it from breaking Starlight layout
import "@stackables/bridge-playground/style.css";

/**
 * A button that opens a modal with MiniPlayground.
 * Used in documentation to provide interactive examples.
 */
export default function MiniPlaygroundModal() {
  // not-content prevents Starlight's .sl-markdown-content styles (e.g. button
  // height overrides, typography resets) from affecting the playground.
  return (
    <div className="not-content">
      <DialogPlayground />
    </div>
  );
}

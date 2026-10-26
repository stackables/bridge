declare module "virtual:starlight/user-config" {
  import type { StarlightConfig } from "@astrojs/starlight/types";
  const config: StarlightConfig;
  export default config;
}

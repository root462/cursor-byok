import { defineProviderPlugin } from "cursor-byok:plugin";
import { opencodeProvider } from "./provider.ts";
import { credentialImport, presentCredential, RESOURCE_TYPE } from "./resources.ts";

export default defineProviderPlugin({
  providers: [opencodeProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "OpenCode credentials", "zh-CN": "OpenCode 凭证" },
    import: credentialImport,
    present: presentCredential,
  }],
});

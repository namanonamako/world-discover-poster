const fs = require("node:fs");
const path = require("node:path");
const { WeirClient } = require("./weir-client");
const { UrlExpander } = require("./url-expander");
const { WorldIdExtractor } = require("./world-id-extractor");
const { VRChatApiClient, resolveProxyAuthToken } = require("./vrchat-client");
const { loadState, saveState } = require("./state-manager");
const { collectWorldIntroductions } = require("./collector");
const { parseBlackList, sanitizeConsoleText } = require("./utils");

async function main() {
  const weirApiKey = process.env.WEIR_API_KEY || "";
  const proxyUrl = process.env.VRC_PROXY_URL || "";
  const authToken = resolveProxyAuthToken({
    authToken: process.env.VRC_PROXY_AUTH_TOKEN,
    proxyTokensJson: process.env.VRC_PROXY_TOKENS,
  });
  const blackList = parseBlackList(process.env.BLACKLIST);

  const stateInputPath = path.join("work", "posterState.json");
  const stateOutputPath = path.join("work", "nextPosterState.json");
  const posterDataOutputPath = path.join("work", "posterData.json");

  const state = loadState(stateInputPath);
  console.log(
    `Loaded poster state: lastTweetId=${state.lastTweetId ?? "none"}, cachedWorlds=${Object.keys(state.worldCache).length}`
  );

  const weirClient = new WeirClient({ apiKey: weirApiKey });
  const expander = new UrlExpander();
  const extractor = new WorldIdExtractor(expander);
  const vrchatClient = new VRChatApiClient({ proxyUrl, authToken });

  if (!vrchatClient.isConfigured()) {
    console.log("VRChat proxy is not configured; Quest auto-detection will be skipped.");
  }

  const { posterData, nextState, stats } = await collectWorldIntroductions(
    { weirClient, extractor, vrchatClient },
    { state, blackList }
  );

  fs.mkdirSync("work", { recursive: true });
  fs.writeFileSync(posterDataOutputPath, JSON.stringify(posterData, null, 2));
  saveState(stateOutputPath, nextState);

  console.log("Collection completed:", JSON.stringify(stats));
}

main().catch((err) => {
  console.error("Collection failed:", sanitizeConsoleText(err?.message ?? err));
  process.exit(1);
});

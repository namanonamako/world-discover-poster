const { WORLD_ID_REGEX, WORLD_ID_EXACT_REGEX } = require("./utils");

const URL_REGEX = /https?:\/\/[^\s"'<>]+/g;
const MAX_URLS_TO_SCAN = 10;
const MAX_URLS_TO_EXPAND = 3;
const EXTRACT_BUDGET_MS = 8000;

/**
 * テキストから抽出した URL の末尾句読点等を除去する
 * @param {string} rawUrl
 * @returns {string}
 */
function trimTrailingPunctuation(rawUrl) {
  return rawUrl.replace(/[.,!?;:)\]}」』、。]+$/, "");
}

/**
 * ホスト名が VRChat ドメインか検証する
 * @param {string} hostname
 * @returns {boolean}
 */
function isVrchatHostname(hostname) {
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  return lower === "vrchat.com" || lower.endsWith(".vrchat.com");
}

class WorldIdExtractor {
  /**
   * @param {import("./url-expander").UrlExpander} urlExpander
   */
  constructor(urlExpander) {
    this.urlExpander = urlExpander;
  }

  /**
   * 展開済み URL またはテキスト内の URL から VRChat ワールド ID を抽出する
   * @param {object} params
   * @param {string} [params.text=""]
   * @param {string[]} [params.expandedUrls=[]]
   * @returns {Promise<string>}
   */
  async extract({ text = "", expandedUrls = [] } = {}) {
    const validExpandedUrls = (Array.isArray(expandedUrls) ? expandedUrls : [])
      .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u.trim()))
      .map((u) => u.trim())
      .slice(0, MAX_URLS_TO_SCAN);

    // 1. すでに展開済みの URL (Weir API の entities.urls) を最優先でチェック
    for (const url of validExpandedUrls) {
      const worldId = this.parseUrl(url);
      if (worldId) return worldId;
    }

    // 2. テキスト内の URL を走査（直リンク確認 -> 必要時のみ短縮 URL 展開）
    const textUrls = (typeof text === "string" ? text.match(URL_REGEX) || [] : [])
      .map(trimTrailingPunctuation)
      .filter((u) => u.length > 0)
      .slice(0, MAX_URLS_TO_SCAN);

    for (const url of textUrls) {
      const directId = this.parseUrl(url);
      if (directId) return directId;
    }

    // 3. 短縮 URL の展開（時間・件数バジェット付きで DoS を防止）
    const candidates = [...new Set([...validExpandedUrls, ...textUrls])].slice(0, MAX_URLS_TO_EXPAND);
    const deadline = Date.now() + EXTRACT_BUDGET_MS;

    for (const url of candidates) {
      if (Date.now() >= deadline) break;
      try {
        const expandedUrl = await this.urlExpander.expand(url);
        const worldId = this.parseUrl(expandedUrl);
        if (worldId) return worldId;
      } catch {
        // 展開失敗時はスキップして次の URL を試す
      }
    }

    return "";
  }

  /**
   * VRChat ドメインの URL からワールド ID を厳密に抽出する
   * @param {string} rawUrl
   * @returns {string | null}
   */
  parseUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) {
      return null;
    }

    let urlObj;
    try {
      urlObj = new URL(rawUrl.trim());
    } catch {
      return null;
    }

    if (urlObj.protocol !== "https:" && urlObj.protocol !== "http:") {
      return null;
    }
    if (!isVrchatHostname(urlObj.hostname)) {
      return null;
    }

    if (urlObj.pathname.startsWith("/home/world/")) {
      const match = urlObj.pathname.match(WORLD_ID_REGEX);
      return match ? match[0].toLowerCase() : null;
    }

    if (urlObj.pathname === "/home/launch" || urlObj.pathname === "/home/launch/") {
      const worldId = urlObj.searchParams.get("worldId");
      if (worldId && WORLD_ID_EXACT_REGEX.test(worldId)) {
        return worldId.toLowerCase();
      }
    }

    return null;
  }
}

module.exports = {
  WorldIdExtractor,
  isVrchatHostname,
  trimTrailingPunctuation,
};

const net = require("node:net");
const { sanitizeConsoleText } = require("./utils");

const ALLOWED_EMBED_DOMAINS = ["twitter.com", "twimg.com", "x.com"];
const ALLOWED_WIDGET_SCRIPT_SRCS = new Set([
  "https://platform.x.com/widgets.js",
  "https://platform.twitter.com/widgets.js",
]);

const ALLOWED_HTML_TAGS = new Set([
  "blockquote",
  "p",
  "a",
  "br",
  "span",
  "strong",
  "em",
  "script",
]);
const VOID_HTML_TAGS = new Set(["br"]);
const ALLOWED_COMMON_ATTRS = new Set(["class", "lang", "dir"]);
const ALLOWED_A_ATTRS = new Set(["href", "target", "rel"]);
const ALLOWED_SCRIPT_ATTRS = new Set(["async", "charset", "src"]);
const DATA_ATTR_REGEX = /^data-[a-z0-9-]+$/;
const TAG_NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const ATTR_NAME_REGEX = /^[a-z][a-z0-9_-]*$/;

/**
 * Puppeteer のページ内リクエストが許可された X/Twitter 埋め込み用ドメインか検証する
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isAllowedEmbedRequestUrl(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  if (rawUrl === "about:blank") return true;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  if (parsed.port && parsed.port !== "443") {
    return false;
  }

  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!host || net.isIP(host) !== 0) {
    return false;
  }

  return ALLOWED_EMBED_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

/**
 * HTML 文字参照（数値・16進・主要名前付き）をデコードする
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    colon: ":",
    tab: "\t",
    newline: "\n",
  };

  return str.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (full, hex, dec, name) => {
    if (hex || dec) {
      const cp = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
      const isValidUnicodeScalar =
        cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return isValidUnicodeScalar ? String.fromCodePoint(cp) : "\uFFFD";
    }
    if (name) {
      const key = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(named, key)) {
        return named[key];
      }
    }
    return full;
  });
}

/**
 * URL 属性値が安全な http(s) URL か検証する
 * @param {string} rawAttrValue
 * @returns {boolean}
 */
function isSafeHttpAttrUrl(rawAttrValue) {
  if (typeof rawAttrValue !== "string") return false;
  const decoded = decodeHtmlEntities(rawAttrValue);
  // WHATWG URL パーサと同様にスキーム判定前の ASCII 制御文字・空白を除去して検査
  const cleaned = decoded.replace(/[\x00-\x20\x7f]/g, "");
  if (!cleaned) return false;

  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}

/**
 * ASCII 空白文字か判定する
 * @param {string} ch
 * @returns {boolean}
 */
function isAsciiWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * 状態機械ベースで HTML を O(N) パースし、許可されたタグ・属性のみを検証する
 * @param {string} html
 * @returns {boolean}
 */
function isValidOembedHtml(html) {
  if (typeof html !== "string" || html.length === 0) {
    return false;
  }

  let i = 0;
  const len = html.length;
  let hasBlockquote = false;
  let scriptCount = 0;
  let inScript = false;

  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      // 閉じられていない script 内テキストは不正
      if (inScript && html.slice(i).trim().length > 0) return false;
      break;
    }

    if (inScript) {
      // <script> 要素内は空白のみ許可（任意のインラインコードを禁止）
      if (html.slice(i, lt).trim().length > 0) {
        return false;
      }
    }

    i = lt + 1;
    if (i >= len) return false;

    const nextCh = html[i];
    // コメント (<!--), DOCTYPE/CDATA (<!), PI (<?) は拒否
    if (nextCh === "!" || nextCh === "?") {
      return false;
    }

    // 終了タグ </tag>
    if (nextCh === "/") {
      i++;
      const nameStart = i;
      while (i < len && !isAsciiWhitespace(html[i]) && html[i] !== ">") {
        i++;
      }
      const tagName = html.slice(nameStart, i).toLowerCase();
      if (!TAG_NAME_REGEX.test(tagName) || !ALLOWED_HTML_TAGS.has(tagName)) {
        return false;
      }
      while (i < len && isAsciiWhitespace(html[i])) {
        i++;
      }
      if (i >= len || html[i] !== ">") {
        return false;
      }
      i++;

      if (inScript) {
        if (tagName !== "script") return false;
        inScript = false;
      } else if (tagName === "script") {
        return false;
      }
      continue;
    }

    // script 内で </script> 以外のタグ開始が現れたら不正
    if (inScript) {
      return false;
    }

    // 開始タグ名読み取り
    const nameStart = i;
    while (i < len && !isAsciiWhitespace(html[i]) && html[i] !== ">" && html[i] !== "/") {
      i++;
    }
    const tagName = html.slice(nameStart, i).toLowerCase();
    if (!TAG_NAME_REGEX.test(tagName) || !ALLOWED_HTML_TAGS.has(tagName)) {
      return false;
    }

    if (tagName === "blockquote") {
      hasBlockquote = true;
    }

    const attrs = new Map();
    let selfClosing = false;
    let expectSeparator = false;

    // 属性パース（クォート状態・区切り空白を厳密管理）
    while (i < len) {
      let hadSpace = false;
      while (i < len && isAsciiWhitespace(html[i])) {
        hadSpace = true;
        i++;
      }
      if (i >= len) return false;

      if (html[i] === ">") {
        i++;
        break;
      }
      if (html[i] === "/") {
        i++;
        if (i >= len || html[i] !== ">") return false;
        selfClosing = true;
        i++;
        break;
      }

      if (expectSeparator && !hadSpace) {
        // クォート値直後の空白なし属性連結 (src="x"onerror="y") を拒否
        return false;
      }

      const attrStart = i;
      while (
        i < len &&
        !isAsciiWhitespace(html[i]) &&
        html[i] !== "=" &&
        html[i] !== ">" &&
        html[i] !== "/"
      ) {
        i++;
      }
      const attrName = html.slice(attrStart, i).toLowerCase();
      if (!ATTR_NAME_REGEX.test(attrName)) {
        return false;
      }
      if (attrs.has(attrName)) {
        // 重複属性を拒否
        return false;
      }

      let afterName = i;
      while (afterName < len && isAsciiWhitespace(html[afterName])) {
        afterName++;
      }

      let attrValue = "";
      if (afterName < len && html[afterName] === "=") {
        i = afterName + 1;
        while (i < len && isAsciiWhitespace(html[i])) {
          i++;
        }
        if (i >= len) return false;

        const quote = html[i];
        if (quote === '"' || quote === "'") {
          i++;
          const valStart = i;
          const closeIdx = html.indexOf(quote, valStart);
          if (closeIdx === -1) return false; // 未閉鎖クォート拒否
          attrValue = html.slice(valStart, closeIdx);
          i = closeIdx + 1;
          expectSeparator = true;
        } else {
          const valStart = i;
          while (i < len && !isAsciiWhitespace(html[i]) && html[i] !== ">") {
            const c = html[i];
            if (c === "<" || c === '"' || c === "'" || c === "=" || c === "`") {
              return false;
            }
            i++;
          }
          if (i === valStart) return false;
          attrValue = html.slice(valStart, i);
          expectSeparator = true;
        }
      } else {
        expectSeparator = true;
      }

      attrs.set(attrName, attrValue);
    }

    // タグごとの属性ホワイトリスト検証
    if (!validateTagAttributes(tagName, attrs)) {
      return false;
    }

    if (tagName === "script") {
      if (selfClosing) return false; // <script/> は HTML5 で無効な自己閉じのため拒否
      scriptCount++;
      if (scriptCount > 1) return false;
      inScript = true;
    } else if (selfClosing && !VOID_HTML_TAGS.has(tagName)) {
      return false;
    }
  }

  if (inScript) {
    return false;
  }

  return hasBlockquote;
}

/**
 * タグ名ごとの許可属性・属性値を検証する
 * @param {string} tagName
 * @param {Map<string, string>} attrs
 * @returns {boolean}
 */
function validateTagAttributes(tagName, attrs) {
  if (tagName === "script") {
    for (const [attrName, attrVal] of attrs.entries()) {
      if (!ALLOWED_SCRIPT_ATTRS.has(attrName)) {
        return false;
      }
      if (attrName === "src") {
        const decodedSrc = decodeHtmlEntities(attrVal).trim();
        if (!ALLOWED_WIDGET_SCRIPT_SRCS.has(decodedSrc)) {
          return false;
        }
      }
    }
    return attrs.has("src");
  }

  for (const [attrName, attrVal] of attrs.entries()) {
    const isCommon = ALLOWED_COMMON_ATTRS.has(attrName) || DATA_ATTR_REGEX.test(attrName);
    const isAnchor = tagName === "a" && ALLOWED_A_ATTRS.has(attrName);
    if (!isCommon && !isAnchor) {
      return false;
    }
    if (attrName === "href" && !isSafeHttpAttrUrl(attrVal)) {
      return false;
    }
  }

  return true;
}

module.exports = {
  ALLOWED_EMBED_DOMAINS,
  ALLOWED_WIDGET_SCRIPT_SRCS,
  isAllowedEmbedRequestUrl,
  isValidOembedHtml,
  decodeHtmlEntities,
  sanitizeConsoleText,
};

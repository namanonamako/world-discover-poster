const fs = require("fs");//ファイルコントロールシステム
const path = require('path');
const puppeteer = require('puppeteer');
const { loadImage, createCanvas } = require('@napi-rs/canvas');
const {
    WORLD_ID_EXACT_REGEX,
    normalizeTweetUrl,
    parseBlackList,
    sanitizeConsoleText,
} = require("./src/utils");
const { isAllowedEmbedRequestUrl, isValidOembedHtml } = require("./src/embed-guard");

// ブラックリストを環境変数から取得（カンマ区切りで入力されることを想定）
const blackList = parseBlackList(process.env.BLACKLIST);
console.log(`ロードされたブラックリスト件数: ${blackList.length}`);

// タイルのサイズ
const tileWidth = 550;
const tileHeight = 800;
/**
 * 保存したTweet画像をキャンバスに描画する
 * @param {any} context 描画対象のcontext
 * @param {string} imagePath 読み込む画像のパス 
 * @param {number} rowIndex 配置場所
 * @param {number} colIndex 配置場所
 */
async function load_image_and_draw(context, imagePath, rowIndex, colIndex) {
    try {
        var image = await loadImage(imagePath);
        // 配置する画像の幅と高さ
        const imageWidth = tileWidth;
        const imageHeight = Math.min(image.height, tileHeight);
        // 画像をタイルサイズに合わせてクロップして描画
        context.drawImage(
            image,
            0, 0, imageWidth, imageHeight,  // クロップする部分の座標とサイズ
            rowIndex * tileWidth, colIndex * tileHeight, imageWidth, imageHeight  // 描画する座標とサイズ
        );
    } catch (e) {
        console.log(e);
        console.log(`${imagePath} draw failed`);
    } finally {
        image = null;
    }
}

/**
 * 保存した画像をタイル状に並べてmerge画像を作る
 * @param {string} platform_name 対象となるPlatform
 * @param {boolean} isDarkMode ダークモードかどうか
 * @param {number} imageID 保存先ディレクトリにおける何枚目のmerge画像か
 */
async function create_merged_picture(platform_name, isDarkMode, imageID) {
    // タイルの行数と列数
    const rows = 2;
    const cols = 3;

    // 1枚の大きなキャンバスを作成
    var canvas = createCanvas(cols * tileWidth, rows * tileHeight);
    var context = canvas.getContext("2d", { storage: "discardable" });
    //background color
    context.beginPath();
    context.fillStyle = isDarkMode ? 'black' : 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < rows * cols; i++) {
        const filePath = path.join("images", `base_${platform_name}${isDarkMode ? "_d" : ""}_${i + imageID * (rows * cols)}.jpg`);
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
            await load_image_and_draw(context, filePath, i % (rows + 1), Math.floor(i / cols));
        } else {
            console.log(`${filePath}が0バイトか存在しないため配置をスキップします。`);
        }
    }
    const pngData = await canvas.encode('png');
    await fs.promises.writeFile(`images/${platform_name}${isDarkMode ? "_d" : ""}_${imageID}.jpg`, pngData);
}

const MAX_OEMBED_BYTES = 1024 * 1024;
const ALLOWED_OEMBED_HOSTS = new Set(["publish.x.com", "publish.twitter.com"]);

/**
 * oEmbed API から安全に JSON を取得する（最大2リダイレクト、許可ホスト・サイズ上限付き）
 * @param {string} initialUrl
 * @returns {Promise<{ html?: string }>}
 */
async function fetchOembedJson(initialUrl) {
    let currentUrl = initialUrl;
    for (let redirects = 0; redirects <= 2; redirects++) {
        const parsed = new URL(currentUrl);
        if (parsed.protocol !== "https:" || !ALLOWED_OEMBED_HOSTS.has(parsed.hostname.toLowerCase())) {
            throw new Error("Disallowed oEmbed redirect target");
        }

        const response = await fetch(currentUrl, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            await response.body?.cancel?.().catch(() => {});
            if (!location || redirects === 2) {
                throw new Error(`Too many or invalid redirects (HTTP ${response.status})`);
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }

        if (!response.ok) {
            await response.body?.cancel?.().catch(() => {});
            throw new Error(`HTTP ${response.status}`);
        }

        const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
        if (!Number.isNaN(contentLength) && contentLength > MAX_OEMBED_BYTES) {
            await response.body?.cancel?.().catch(() => {});
            throw new Error("oEmbed response too large");
        }

        const text = await response.text();
        if (Buffer.byteLength(text, "utf-8") > MAX_OEMBED_BYTES) {
            throw new Error("oEmbed response exceeds size limit");
        }
        return JSON.parse(text);
    }
    throw new Error("oEmbed redirect loop");
}

/**
 * URLからTweet画像を生成する
 * @param {import('puppeteer').Browser} browser
 * @param {string} tweetUrl 生成元のURL
 * @param {string} filePath 生成した画像の保存先パス
 * @param {boolean} isDarkMode ダークモードかどうか
 */
async function screenshot_tweet_pic(browser, tweetUrl, filePath, isDarkMode) {
    let result = "error";
    const normalizedUrl = normalizeTweetUrl(tweetUrl, "twitter.com");
    if (!normalizedUrl) {
        console.log("不正なツイートURL形式のためスキップします。");
        return "no_media";
    }

    const oembedEndpoint = `https://publish.x.com/oembed?url=${encodeURIComponent(normalizedUrl)}&partner=&hide_thread=false&theme=${isDarkMode ? "dark" : "light"}`;

    try {
        const oembedData = await fetchOembedJson(oembedEndpoint);
        if (!isValidOembedHtml(oembedData?.html)) {
            console.log("oEmbedレスポンスのHTMLが不正または未許可要素を含むためスキップします。");
            return "error";
        }

        let page;
        try {
            page = await browser.newPage();
            await page.emulateTimezone('Asia/Tokyo');
            await page.setViewport({ width: Math.ceil(550), height: Math.ceil(800) });
            await page.setRequestInterception(true);
            page.on('request', req => {
                if (isAllowedEmbedRequestUrl(req.url())) {
                    req.continue().catch(() => {});
                } else {
                    req.abort().catch(() => {});
                }
            });
            if (process.env.DEBUG_PUPPETEER === "true") {
                page.on('console', msg => console.log(sanitizeConsoleText(msg.text())));
            }
            // Twitterの埋め込みリンクを開く (インラインスクリプト等を遮断する CSP を先頭に付与)
            const cspMeta = '<meta http-equiv="Content-Security-Policy" content="script-src https://platform.x.com https://platform.twitter.com https://*.twimg.com; object-src \'none\'; base-uri \'none\';">';
            await page.setContent(`${cspMeta}<body bgcolor="${isDarkMode ? 'black' : 'white'}">${oembedData.html}</body>`, { waitUntil: 'domcontentloaded' });
            const iframeHandle = await page.waitForSelector('#twitter-widget-0');
            const frame = await iframeHandle.contentFrame();
            await frame.waitForNavigation({ waitUntil: 'networkidle0' });

            // 画像または VRChat リンクが含まれているか確認
            const hasMediaOrVrcLink = await frame.evaluate(() => {
                // 1. 画像のチェック (pbs.twimg.com/media/... が含まれる img タグがあるか)
                const imgs = Array.from(document.querySelectorAll('img'));
                const hasImage = imgs.some(img => img.src.includes('pbs.twimg.com/media/'));

                // 2. VRChatリンクのチェック (短縮リンク t.co 対策としてページ全体のテキストとリンク属性をチェック)
                const textContent = document.documentElement.textContent || '';
                let hasLink = textContent.includes('vrchat.com');

                if (!hasLink) {
                    const links = Array.from(document.querySelectorAll('a'));
                    hasLink = links.some(a => {
                        const href = a.href || '';
                        const expanded = a.getAttribute('data-expanded-url') || '';
                        const text = a.innerText || '';
                        return href.includes('vrchat.com') || expanded.includes('vrchat.com') || text.includes('vrchat.com');
                    });
                }

                return hasImage || hasLink;
            });

            if (!hasMediaOrVrcLink) {
                console.log("このツイートには画像もVRChatのリンクも含まれていないため、スキップ対象として判定しました。");
                result = "no_media";
                return result;
            }

            // センシティブボタンが存在するか確認
            const buttonSelector = 'div[role="button"].css-18t94o4';
            const buttonExists = await frame.$(buttonSelector);
            if (buttonExists) {
                // 要素が存在する場合はテキストを取得して"View"が含まれているか確認
                const buttonText = await frame.$eval(buttonSelector, el => el.innerText);

                if (buttonText.includes('View')) {
                    // "View"が含まれている場合はクリック
                    await frame.click(buttonSelector);
                    console.log('Viewボタンがクリックされました。');
                }
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log(`フレームの描画が完了しました。`);

            await page.screenshot({ path: filePath });
            console.log(`キャプチャしました`);
            result = "success";
        } catch (e) {
            console.log(`キャプチャに失敗しました: ${sanitizeConsoleText(e.message)}`);
        } finally {
            if (page && !page.isClosed()) {
                await page.close().catch(() => {});
            }
        }
    } catch (err) {
        console.log(`ツイート情報取得エラー: ${sanitizeConsoleText(err.message)}`);
    }
    return result;
}

const MAX_TWEETPIC_NUM = 36;

/**
 * 自サーバーからDLしたデータを使って各ツイートのキャプチャ画像を作る
 * @param {any} platform_name
 * @param {any} datas
 */
async function create_basepic(platform_name, datas) {
    let pic_count = 0;
    const world_id_array = [];
    console.log(`${platform_name} 対象ツイート件数: ${Array.isArray(datas) ? datas.length : 0}`);
    let browser;
    try {
        const puppeteerOptions = {
            headless: 'new',
            args: ['--disable-gpu', '--incognito', '--no-first-run', '--no-zygote', '--no-sandbox', '--disable-setuid-sandbox']
        };
        // Linux環境でシステムChromeが存在する場合に指定
        if (fs.existsSync('/usr/bin/google-chrome')) {
            puppeteerOptions.executablePath = '/usr/bin/google-chrome';
        }
        browser = await puppeteer.launch(puppeteerOptions);
        for (let i = 0; i < datas.length; i++) {
            try {
                if (pic_count >= MAX_TWEETPIC_NUM) break;
                const itemUrl = typeof datas[i]?.url === "string" ? datas[i].url : "";
                if (!itemUrl) continue;

                const lowerItemUrl = itemUrl.toLowerCase();
                const containsBlacklistWord = blackList.some(blackListID => lowerItemUrl.includes(blackListID.toLowerCase()));
                if (containsBlacklistWord) {
                    console.log("BlackList対象ツイートをスキップしました。");
                } else {
                    let status = "error";
                    const filePath = path.join("images/", `base_${platform_name}_${pic_count}.jpg`);
                    const filePath_d = path.join("images/", `base_${platform_name}_d_${pic_count}.jpg`);
                    for (let retry = 0; retry < 3; retry++) {
                        console.log(`${pic_count + 1}枚目の処理を開始します (Try ${retry + 1})`);
                        const res1 = await screenshot_tweet_pic(browser, itemUrl, filePath, false);

                        if (res1 === "no_media") {
                            status = "no_media";
                            break;
                        }
                        if (res1 !== "success") {
                            console.log(`ライトモードのキャプチャに失敗したため、3秒待機してリトライします...`);
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            continue;
                        }

                        console.log(`${pic_count + 1}枚目ダークモードの処理を開始します (Try ${retry + 1})`);
                        const res2 = await screenshot_tweet_pic(browser, itemUrl, filePath_d, true);

                        if (res2 === "success") {
                            status = "success";
                            break;
                        } else {
                            console.log(`ダークモードのキャプチャに失敗したため、3秒待機してリトライします...`);
                            await new Promise(resolve => setTimeout(resolve, 3000));
                        }
                    }

                    if (status === "success") {
                        console.log(`${pic_count + 1}枚目の出力が完了しました`);
                        // ワールドIDを保存 (v2: worldId / v1: world_id)
                        const rawWorldId = datas[i].worldId || datas[i].world_id || "";
                        const worldId = typeof rawWorldId === "string" && WORLD_ID_EXACT_REGEX.test(rawWorldId)
                            ? rawWorldId.toLowerCase()
                            : "";
                        world_id_array.push(worldId);
                        pic_count += 1;
                    } else {
                        // 片側のみ生成された孤立ファイルを削除
                        await fs.promises.unlink(filePath).catch(() => {});
                        await fs.promises.unlink(filePath_d).catch(() => {});
                        if (status === "no_media") {
                            console.log(`${sanitizeConsoleText(itemUrl)} は画像が含まれていないためスキップします。`);
                        } else {
                            console.log(`${sanitizeConsoleText(itemUrl)} のキャプチャに完全に失敗したためスキップし、次のツイートを処理します。`);
                        }
                    }
                }
            } catch (e) {
                console.log(sanitizeConsoleText(e.message));
                console.log(`${pic_count + 1}枚目の処理中に予期せぬエラーが発生しました。`);
            }
        }
    } finally {
        if (browser) await browser.close();
    }
    console.log(`${platform_name} 抽出ワールドID件数: ${world_id_array.length}`);
    const key = `${platform_name}WorldID`;
    json_data[key] = world_id_array;
    // 前回更新分から足りない画像を移動
    const results = [];
    let moved_count = 0;
    for (let i = pic_count; i < MAX_TWEETPIC_NUM; i++) {
        const old_filePath = path.join("work/", `base_${platform_name}_${moved_count}.jpg`);
        const filePath = path.join("images/", `base_${platform_name}_${i}.jpg`);
        const old_filePath_d = path.join("work/", `base_${platform_name}_d_${moved_count}.jpg`);
        const filePath_d = path.join("images/", `base_${platform_name}_d_${i}.jpg`);
        console.log(`${i + 1}枚目の移動を開始します`);
        results.push((async () => {
            if (fs.existsSync(old_filePath) && fs.statSync(old_filePath).size > 0) {
                try {
                    await fs.promises.copyFile(old_filePath, filePath);
                    console.log(`${i + 1}枚目の移動が完了しました`);
                } catch (err) {
                    console.log(sanitizeConsoleText(err.message));
                }
            }
            if (fs.existsSync(old_filePath_d) && fs.statSync(old_filePath_d).size > 0) {
                try {
                    await fs.promises.copyFile(old_filePath_d, filePath_d);
                    console.log(`${i + 1}枚目ダークモードの移動が完了しました`);
                } catch (err) {
                    console.log(sanitizeConsoleText(err.message));
                }
            }
        })());
        moved_count += 1;
    }
    await Promise.allSettled(results);
}

var json_data = {};

/** ポスターから参照する情報を保持したJsonの作成 */

async function create_poster_info_json() {
    const old_json_file_path = "work/posterInfo.json";
    const json_file_path = "images/posterInfo.json";


    var pc_world_ids_fixed = json_data["PCWorldID"] || [];
    var quest_world_ids_fixed = json_data["QuestWorldID"] || [];

    // 前回処理分の読み込み
    if (fs.existsSync(old_json_file_path)) {
        try {
            const content = await fs.promises.readFile(old_json_file_path, "utf-8");
            const infos = JSON.parse(content);
            if (Array.isArray(infos.PCWorldID)) {
                pc_world_ids_fixed = pc_world_ids_fixed.concat(infos.PCWorldID).slice(0, MAX_TWEETPIC_NUM);
            }
            if (Array.isArray(infos.QuestWorldID)) {
                quest_world_ids_fixed = quest_world_ids_fixed.concat(infos.QuestWorldID).slice(0, MAX_TWEETPIC_NUM);
            }
        } catch (err) {
            console.error("Failed to read generic old json_file:", err.message);
        }
    }

    // 要素数を調整
    const sanitizeWorldId = (id) =>
        typeof id === "string" && WORLD_ID_EXACT_REGEX.test(id) ? id.toLowerCase() : "";
    json_data["PCWorldID"] = Array.from({ length: MAX_TWEETPIC_NUM }, (_value, index) => sanitizeWorldId(pc_world_ids_fixed[index]));
    json_data["QuestWorldID"] = Array.from({ length: MAX_TWEETPIC_NUM }, (_value, index) => sanitizeWorldId(quest_world_ids_fixed[index]));

    json_data["ver"] = "v1.1";
    json_data["message"] = "Tweetを30分毎に取得します\n<color=blue>#VRChat_world紹介</color>\n<color=green>#VRChat_quest_world</color>";
    const payload = JSON.stringify(json_data);
    try {
        await fs.promises.writeFile(json_file_path, payload);
    } catch (err) {
        console.error(err);
    }
}

async function main() {
    const sorce_json_file_path = "work/posterData.json";

    if (fs.existsSync(sorce_json_file_path)) {
        const content = fs.readFileSync(sorce_json_file_path, "utf-8");
        const posterData = JSON.parse(content);
        
        // v2: pcWorlds / v1: PCWorld
        const pcData = Array.isArray(posterData.pcWorlds || posterData.PCWorld)
            ? (posterData.pcWorlds || posterData.PCWorld)
            : [];
        // v2: questWorlds / v1: QuestWorld
        const questData = Array.isArray(posterData.questWorlds || posterData.QuestWorld)
            ? (posterData.questWorlds || posterData.QuestWorld)
            : [];
        
        await create_basepic("PC", pcData);
        await create_basepic("Quest", questData);
    }

    for (let i = 0; i < 6; i++) {
        await create_merged_picture("PC", true, i);
        await create_merged_picture("Quest", true, i);
        await create_merged_picture("PC", false, i);
        await create_merged_picture("Quest", false, i);

    }

    await create_poster_info_json();

    const nextStatePath = path.join("work", "nextPosterState.json");
    if (fs.existsSync(nextStatePath)) {
        await fs.promises.copyFile(nextStatePath, path.join("images", "posterState.json"));
        console.log("posterState.json を images ディレクトリへ出力しました。");
    }
}
// #regiton test



// #endregion

main().catch((err) => {
    console.error("Poster generation failed:", sanitizeConsoleText(err.message));
    process.exit(1);
});




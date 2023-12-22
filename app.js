const fs = require("fs");//ファイルコントロールシステム
const path = require('path');

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
    const { loadImage } = require('@napi-rs/canvas');
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
 * @param {number} imageID 保存先ディレクトリにおける何枚目のmerge画像か
 */
async function create_merged_picture(platform_name, imageID) {
    const { createCanvas } = require('@napi-rs/canvas');
    // タイルの行数と列数
    const rows = 2;
    const cols = 3;

    // 1枚の大きなキャンバスを作成
    var canvas = createCanvas(cols * tileWidth, rows * tileHeight);
    var context = canvas.getContext("2d", { storage: "discardable" });
    //background color
    context.beginPath();
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < rows * cols; i++) {
        const filePath = path.join("images", `base_${platform_name}_${i + imageID * (rows * cols)}.jpg`);
        if (fs.existsSync(filePath)) {
            await load_image_and_draw(context, filePath, i % (rows + 1), Math.floor(i / cols));
        } else {
            console.log(`${filePath}ファイルが見つからないのでスキップします。`);
        }
    }
    const pngData = await canvas.encode('png');
    await fs.promises.writeFile(`images/${platform_name}_${imageID}.jpg`, pngData);
}

/**
 * URLからTweet画像を生成する
 * @param {Browser} browser 生成に使うpuppeteerのブラウザ
 * @param {string} tweetUrl 生成元のURL
 * @param {string} path 生成した画像の保存先パス
 */
async function screenshot_tweet_pic(tweetUrl, path) {
    const axios = require("axios");
    const puppeteer = require('puppeteer');

    await axios.get(`https://publish.twitter.com/oembed?url=${tweetUrl}&partner=&hide_thread=false`).then(async response => {
        let browser;
        try {
            browser = await puppeteer.launch({ headless: 'new', args: ['--disable-gpu', '--no-first-run', '--no-zygote', '--no-sandbox', '--disable-setuid-sandbox'] });
            const page = await browser.newPage();
            // デバッグ用に console.log を nodejs 側に渡す
            page.on('console', msg => console.log(msg.text()));
            // Twitterの埋め込みリンクを開く
            await page.setContent(response.data.html, { waitUntil: 'domcontentloaded' });
            const iframeHandle = await page.waitForSelector('#twitter-widget-0');
            const frame = await iframeHandle.contentFrame();
            await frame.waitForNavigation({ waitUntil: 'networkidle0' });
            console.log(`フレームの描画が完了しました。`);

            await page.setViewport({ width: Math.ceil(550), height: Math.ceil(800) });
            await page.screenshot({ path: path });
            console.log(`キャプチャしました`);
        } catch (e) {
            console.log("キャプチャに失敗しました。");
            throw e;
        } finally {
            await browser.close();
        }
    });
}

const MAX_TWEETPIC_NUM = 12;

/**
 * 自サーバーからDLしたデータを使って各ツイートのキャプチャ画像を作る
 * @param {any} platform_name
 * @param {any} datas
 */
async function create_basepic(platform_name, datas) {
    var pic_count = 0;
    const world_id_array = [];
    console.log(datas);
    for (let i = 0; i < datas.length; i++) {
        try {
            if (pic_count >= MAX_TWEETPIC_NUM) return true;
            const filePath = path.join("images/", `base_${platform_name}_${i}.jpg`);
            console.log(`${pic_count + 1}枚目の処理を開始します`);
            await screenshot_tweet_pic(datas[i].url, filePath);
            console.log(`${pic_count + 1}枚目の出力が完了しました`);
            // ワールドIDを保存
            world_id_array.push(datas[i].world_id);
            pic_count += 1;
        } catch (e) {
            console.log(e.message);
            console.log(`${pic_count + 1}枚目の処理に失敗しました。`);
        }
    };
    console.log(world_id_array);
    const key = `${platform_name}WorldID`;
    json_data[key] = world_id_array;
    // 前回更新分から足りない画像を移動
    const results = [];
    let moved_count = 0;
    for (let i = pic_count; i < MAX_TWEETPIC_NUM; i++) {
        try {
            const old_filePath = path.join("work/", `base_${platform_name}_${moved_count}.jpg`);
            const filePath = path.join("images/", `base_${platform_name}_${i}.jpg`);
            console.log(`${i + 1}枚目の移動を開始します`);
            results.push(new Promise(async (resolve, reject) => {
                if (await fs.existsSync(old_filePath)) {
                    try {
                        await fs.copyFileSync(old_filePath, filePath);
                        console.log(`${i + 1}枚目の移動が完了しました`);
                        resolve();
                    } catch (err) {
                        console.log(err);
                        reject();
                    }
                }
                resolve();
            }));
            moved_count += 1;
        } catch (e) {
            console.log(e.message);
            console.log(`${i + 1}枚目の移動に失敗しました。`);
        }
    }
    await Promise.all(results);
}

var json_data = {};

/** ポスターから参照する情報を保持したJsonの作成 */

async function create_poster_info_json() {
    const old_json_file_path = "work/posterInfo.json";
    const json_file_path = "images/posterInfo.json";


    var pc_world_ids_fixed = json_data["PCWorldID"];
    var quest_world_ids_fixed = json_data["QuestWorldID"];

    // 前回処理分の読み込み
    if (fs.existsSync(json_file_path)) {
        const content = await fs.readFileSync(old_json_file_path, (err) => err && console.error(err));
        const infos = JSON.parse(content);
        pc_world_ids_fixed = pc_world_ids_fixed.concat(infos.PCWorldID).slice(0, MAX_TWEETPIC_NUM);
        quest_world_ids_fixed = quest_world_ids_fixed.concat(infos.QuestWorldID).slice(0, MAX_TWEETPIC_NUM);
    }

    // 要素数を調整
    json_data["PCWorldID"] = Array.from({ length: MAX_TWEETPIC_NUM }, (value, index) => pc_world_ids_fixed[index] || "");
    json_data["QuestWorldID"] = Array.from({ length: MAX_TWEETPIC_NUM }, (value, index) => quest_world_ids_fixed[index] || "");

    json_data["ver"] = "v1.0";
    json_data["message"] = "Tweetを30分毎に取得します\n<color=blue>#VRChat_world紹介</color>\n<color=green>#VRChat_quest_world</color>";
    const payload = JSON.stringify(json_data);
    await fs.writeFile(json_file_path, payload, (err) => err && console.error(err));
}

async function main() {
    const sorce_json_file_path = "work/posterData.json";

    if (fs.existsSync(sorce_json_file_path)) {
        const content = await fs.readFileSync(sorce_json_file_path, (err) => err && console.error(err));
        const posterData = JSON.parse(content);
        await create_basepic("PC", posterData.PCWorld);
        await create_basepic("Quest", posterData.QuestWorld);
    }

    await create_merged_picture("PC", 0);
    await create_merged_picture("PC", 1);
    await create_merged_picture("Quest", 0);
    await create_merged_picture("Quest", 1);
    create_poster_info_json();
}
// #regiton test



// #endregion

main();
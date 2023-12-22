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
 * @param {string} sourceDirectoryPath 元となる画像の保存先ディレクトリpath
 * @param {string} exporetfilePath 完成した画像の保存先
 * @param {number} imageID 保存先ディレクトリにおける何枚目のmerge画像か
 */
async function create_merged_picture(sourceDirectoryPath, exporetfilePath, imageID) {
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
        const filePath = path.join(sourceDirectoryPath, `${i + imageID * (rows * cols)}.jpg`);
        if (fs.existsSync(filePath)) {
            await load_image_and_draw(context, filePath, i % (rows + 1), Math.floor(i / cols));
        } else {
            console.log(`${filePath}ファイルが見つからないのでスキップします。`);
        }
    }
    const pngData = await canvas.encode('png');
    await fs.promises.writeFile(exporetfilePath, pngData);

    // キャンバスの破棄
    context = null;
    canvas = null;
    console.log("FinishJob");
}

const pc_work_dir_path = "work/PCWorldPic/";
const quest_work_dir_path = "work/QuestWorldPic/";
const final_dir_path = "images/";

async function main() {
    await create_merged_picture(pc_work_dir_path, path.join(final_dir_path, "PC_0.jpg"), 0);
    await create_merged_picture(pc_work_dir_path, path.join(final_dir_path, "PC_1.jpg"), 1);
    await create_merged_picture(quest_work_dir_path, path.join(final_dir_path, "Quest_0.jpg"), 0);
    await create_merged_picture(quest_work_dir_path, path.join(final_dir_path, "Quest_1.jpg"), 1);

    test();
}
// #regiton test

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
            console.log(`リンクを開きました。`);
            const iframeHandle = await page.waitForSelector('#twitter-widget-0');
            console.log(`フレームの準備ができました。`);
            const frame = await iframeHandle.contentFrame();
            console.log(`フレームを取得しました。`);
            await frame.waitForNavigation({ waitUntil: 'networkidle0' });
            //await page.waitForTimeout(10000);
            console.log(`フレームの描画が完了しました。`);

            await page.setViewport({ width: Math.ceil(550), height: Math.ceil(800) });
            console.log(`キャプチャ範囲をコンテンツサイズに合わせました`);
            await page.screenshot({ path: path });
            console.log(`キャプチャしました`);
        } catch (e) {
            console.log("キャプチャに失敗しました。");
            // throw e;
        } finally {
            await browser.close();
        }
    });
}
async function test() {
    for (var i = 0; i < 12; i++) {
        await screenshot_tweet_pic("https://twitter.com/medic35351/status/1738140908447731881", path.join(final_dir_path, `testPC_${i}.jpg`));
    }
    for (var i = 0; i < 12; i++) {
        await screenshot_tweet_pic("https://x.com/maybecat101/status/1737773081392033907", path.join(final_dir_path, `testQuest_${i}.jpg`));
    }    
}

// #endregion

main();
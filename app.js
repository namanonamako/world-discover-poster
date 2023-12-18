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
    var image = await loadImage(imagePath);
    console.log(`image:${imagePath}`);
    // 配置する画像の幅と高さ
    const imageWidth = tileWidth;
    const imageHeight = Math.min(image.height, tileHeight);

    // 画像をタイルサイズに合わせてクロップして描画
    context.drawImage(
        image,
        0, 0, imageWidth, imageHeight,  // クロップする部分の座標とサイズ
        rowIndex * tileWidth, colIndex * tileHeight, imageWidth, imageHeight  // 描画する座標とサイズ
    );
    image = null;
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
        console.log(`file${filePath} exists is ${fs.existsSync(filePath)}`);
        if (fs.existsSync(filePath)) {
            await load_image_and_draw(context, filePath, i % (rows + 1), Math.floor(i / cols));
        } else {
            console.log(`${filePath}ファイルが見つからないのでスキップします。`);
        }
    }
    const pngData = await canvas.encode('png');
    await fs.promises.writeFile(exporetfilePath, pngData);

    console.log(`file${exporetfilePath} exists is ${fs.existsSync(exporetfilePath)}`);
    // キャンバスの破棄
    context = null;
    canvas = null;
    console.log("FinishJob");
}

const pc_work_dir_path = "work/PCWorldPic/";
//const quest_work_dir_path = "work/world-recommendation-poster/QuestWorldPic/";
const final_dir_path = "images/world-recommendation-poster/";

async function main() {
    console.log("Start");
    await create_merged_picture(pc_work_dir_path, path.join(final_dir_path, "PC_0.jpg"), 0);
    console.log("Enc");

}

main();
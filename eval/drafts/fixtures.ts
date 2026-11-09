/**
 * #64 图片评测夹具生成器。
 *
 * 这些 PNG 由代码绘制，**只用于打通上传 → 会话 → 草稿链路**，
 * 不代表真实餐食 / 报告 / 药品照片。餐食识别质量验收必须由项目负责人
 * 用虚构的真实照片替换同名文件后重跑，报告里会标注这一点。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

type RGB = [number, number, number];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width: number, height: number, pixels: Buffer): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Buffer;

  constructor(width: number, height: number, background: RGB) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 3);
    this.rect(0, 0, width, height, background);
  }

  private set(x: number, y: number, color: RGB): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 3;
    this.pixels[offset] = color[0];
    this.pixels[offset + 1] = color[1];
    this.pixels[offset + 2] = color[2];
  }

  rect(x: number, y: number, width: number, height: number, color: RGB): void {
    for (let dy = 0; dy < height; dy += 1) {
      for (let dx = 0; dx < width; dx += 1) {
        this.set(Math.round(x + dx), Math.round(y + dy), color);
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: RGB): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
        const nx = (x - cx) / Math.max(1, rx);
        const ny = (y - cy) / Math.max(1, ry);
        if (nx * nx + ny * ny <= 1) this.set(x, y, color);
      }
    }
  }

  circle(cx: number, cy: number, radius: number, color: RGB): void {
    this.ellipse(cx, cy, radius, radius, color);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: RGB, thickness = 3): void {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      this.circle(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, thickness / 2, color);
    }
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.pixels);
  }
}

const W = 480;
const H = 360;

function mealFish(): Buffer {
  const c = new Canvas(W, H, [185, 139, 94]);
  c.ellipse(240, 190, 170, 120, [245, 245, 245]);
  c.ellipse(240, 190, 150, 102, [252, 252, 252]);
  c.ellipse(215, 175, 82, 34, [196, 124, 70]);
  c.ellipse(145, 175, 24, 22, [180, 105, 55]);
  c.line(270, 160, 305, 145, [120, 70, 35], 6);
  c.line(270, 185, 310, 185, [120, 70, 35], 6);
  c.circle(148, 168, 5, [40, 30, 20]);
  c.ellipse(310, 225, 52, 38, [242, 238, 220]);
  for (let i = 0; i < 6; i += 1) c.circle(285 + (i % 3) * 24, 212 + Math.floor(i / 3) * 24, 3, [250, 250, 245]);
  c.circle(145, 245, 18, [72, 150, 80]);
  c.circle(172, 250, 15, [90, 168, 92]);
  c.circle(120, 252, 14, [60, 138, 70]);
  c.line(60, 300, 190, 330, [90, 60, 35], 5);
  c.line(80, 300, 210, 330, [90, 60, 35], 5);
  return c.toPng();
}

function mealNoodles(): Buffer {
  const c = new Canvas(W, H, [214, 196, 172]);
  c.ellipse(240, 210, 160, 128, [250, 250, 248]);
  c.ellipse(240, 210, 140, 108, [232, 196, 120]);
  for (let i = 0; i < 12; i += 1) {
    const y = 130 + i * 13;
    c.line(140, y, 340, y + (i % 2 ? 8 : -8), [246, 222, 140], 4);
  }
  c.ellipse(175, 190, 26, 20, [74, 150, 78]);
  c.ellipse(310, 205, 24, 18, [86, 160, 84]);
  c.ellipse(245, 185, 38, 26, [250, 250, 240]);
  c.circle(245, 185, 15, [240, 190, 60]);
  return c.toPng();
}

function mealBreakfast(): Buffer {
  const c = new Canvas(W, H, [232, 220, 200]);
  c.rect(70, 130, 150, 120, [196, 146, 86]);
  c.rect(82, 142, 126, 96, [226, 190, 130]);
  c.ellipse(320, 185, 78, 54, [252, 252, 250]);
  c.circle(320, 185, 34, [246, 198, 62]);
  c.ellipse(300, 165, 22, 16, [255, 255, 252]);
  c.rect(395, 150, 48, 110, [238, 245, 250]);
  c.rect(400, 140, 38, 12, [255, 255, 255]);
  c.rect(402, 176, 34, 6, [222, 232, 240]);
  c.rect(402, 206, 34, 6, [222, 232, 240]);
  for (let i = 0; i < 4; i += 1) c.circle(110 + i * 24, 290, 8, [210, 90, 70]);
  return c.toPng();
}

function mealHotpot(): Buffer {
  const c = new Canvas(W, H, [92, 86, 88]);
  c.ellipse(240, 200, 175, 135, [70, 70, 74]);
  c.ellipse(240, 200, 156, 116, [190, 64, 48]);
  c.ellipse(240, 200, 142, 102, [206, 78, 54]);
  const items: Array<[number, number, number, RGB]> = [
    [170, 170, 20, [222, 140, 120]],
    [220, 155, 17, [236, 196, 128]],
    [280, 170, 22, [82, 150, 82]],
    [320, 210, 18, [230, 210, 150]],
    [190, 235, 24, [90, 160, 86]],
    [255, 235, 20, [222, 140, 120]],
  ];
  for (const [x, y, r, color] of items) c.circle(x, y, r, color);
  for (let i = 0; i < 4; i += 1) c.line(150 + i * 60, 70, 160 + i * 60, 30, [200, 200, 200], 4);
  return c.toPng();
}

function mealSalad(): Buffer {
  const c = new Canvas(W, H, [226, 218, 206]);
  c.ellipse(240, 205, 160, 120, [250, 250, 248]);
  c.ellipse(240, 205, 142, 102, [242, 244, 238]);
  for (let i = 0; i < 9; i += 1) {
    c.ellipse(150 + (i % 3) * 78, 175 + Math.floor(i / 3) * 48, 32, 20, [84, 158, 78]);
  }
  for (let i = 0; i < 4; i += 1) c.circle(190 + i * 60, 205, 18, [220, 72, 62]);
  for (let i = 0; i < 3; i += 1) c.rect(160 + i * 56, 232, 52, 16, [226, 188, 136]);
  for (let i = 0; i < 7; i += 1) c.circle(180 + i * 28, 165, 4, [246, 236, 170]);
  return c.toPng();
}

function mealTakeout(): Buffer {
  const c = new Canvas(W, H, [170, 166, 160]);
  c.rect(105, 95, 270, 220, [235, 232, 226]);
  c.rect(115, 105, 250, 200, [252, 251, 248]);
  c.rect(115, 105, 250, 10, [220, 216, 208]);
  c.rect(240, 115, 4, 180, [224, 220, 214]);
  c.rect(115, 205, 250, 4, [224, 220, 214]);
  c.ellipse(177, 160, 44, 36, [242, 236, 214]);
  for (let i = 0; i < 8; i += 1) c.circle(150 + (i % 4) * 18, 145 + Math.floor(i / 4) * 24, 4, [250, 248, 238]);
  c.ellipse(360, 160, 44, 36, [196, 120, 72]);
  c.circle(348, 152, 12, [90, 150, 80]);
  c.circle(372, 168, 10, [220, 150, 60]);
  c.ellipse(180, 258, 42, 30, [214, 176, 96]);
  c.circle(170, 250, 9, [230, 200, 120]);
  c.ellipse(355, 258, 48, 32, [196, 132, 62]);
  c.circle(345, 252, 12, [214, 160, 80]);
  c.circle(368, 264, 10, [190, 120, 60]);
  return c.toPng();
}

function reportLab(): Buffer {
  const c = new Canvas(W, H, [214, 220, 226]);
  c.rect(70, 35, 340, 290, [252, 252, 252]);
  c.rect(70, 35, 340, 8, [230, 232, 236]);
  c.rect(95, 65, 120, 14, [90, 100, 112]);
  c.rect(95, 90, 80, 6, [170, 176, 184]);
  for (let i = 0; i < 9; i += 1) {
    c.rect(95, 120 + i * 20, 110 + (i % 3) * 40, 5, [190, 196, 204]);
    c.rect(250, 120 + i * 20, 40, 5, [200, 205, 212]);
    c.rect(315, 120 + i * 20, 55, 5, [205, 210, 216]);
  }
  c.rect(90, 210, 295, 28, [250, 224, 224]);
  c.rect(95, 218, 100, 8, [220, 90, 90]);
  c.rect(250, 218, 40, 8, [220, 120, 120]);
  return c.toPng();
}

function reportChart(): Buffer {
  const c = new Canvas(W, H, [204, 214, 222]);
  c.rect(65, 30, 350, 300, [252, 252, 252]);
  c.rect(90, 60, 150, 16, [80, 92, 104]);
  c.rect(90, 85, 100, 6, [170, 176, 184]);
  c.line(95, 285, 385, 285, [120, 128, 138], 3);
  c.line(95, 285, 95, 120, [120, 128, 138], 3);
  const heights = [60, 95, 45, 120, 80, 140, 70];
  for (let i = 0; i < heights.length; i += 1) {
    c.rect(112 + i * 38, 280 - heights[i]!, 24, heights[i]!, [104, 150, 196]);
  }
  c.line(95, 190, 385, 190, [220, 100, 90], 3);
  c.rect(90, 305, 200, 6, [200, 205, 212]);
  return c.toPng();
}

function medicinePills(): Buffer {
  const c = new Canvas(W, H, [190, 214, 228]);
  c.rect(70, 100, 150, 170, [250, 250, 250]);
  c.rect(70, 100, 150, 26, [212, 78, 72]);
  c.rect(90, 148, 110, 10, [160, 166, 174]);
  c.rect(90, 170, 80, 8, [190, 196, 204]);
  c.ellipse(310, 150, 52, 24, [250, 250, 250]);
  c.ellipse(310, 150, 26, 24, [214, 84, 78]);
  c.ellipse(330, 230, 46, 22, [248, 248, 246]);
  c.ellipse(330, 230, 22, 22, [236, 200, 74]);
  c.circle(230, 270, 24, [250, 250, 250]);
  c.circle(230, 270, 15, [206, 214, 222]);
  c.circle(370, 290, 20, [250, 250, 250]);
  c.line(180, 300, 260, 320, [150, 160, 170], 4);
  return c.toPng();
}

function park(): Buffer {
  const c = new Canvas(W, H, [132, 196, 240]);
  c.rect(0, 230, W, 130, [104, 176, 104]);
  c.circle(390, 70, 42, [248, 214, 82]);
  c.rect(120, 170, 26, 110, [124, 86, 52]);
  c.circle(133, 150, 58, [70, 142, 70]);
  c.circle(100, 180, 38, [86, 156, 78]);
  c.circle(168, 182, 36, [82, 150, 74]);
  c.ellipse(250, 260, 140, 24, [214, 196, 150]);
  for (let i = 0; i < 5; i += 1) c.circle(240 + i * 18, 300 + (i % 2) * 14, 5, [240, 238, 230]);
  return c.toPng();
}

export interface Fixture {
  file: string;
  build: () => Buffer;
}

export const FIXTURES: readonly Fixture[] = [
  { file: 'images/meal-01.png', build: mealFish },
  { file: 'images/meal-02.png', build: mealNoodles },
  { file: 'images/meal-03.png', build: mealBreakfast },
  { file: 'images/meal-04.png', build: mealHotpot },
  { file: 'images/meal-05.png', build: mealSalad },
  { file: 'images/meal-06.png', build: mealTakeout },
  { file: 'images/report-01.png', build: reportLab },
  { file: 'images/report-02.png', build: reportChart },
  { file: 'images/medicine-01.png', build: medicinePills },
  { file: 'images/other-01.png', build: park },
];

/**
 * 生成缺失的夹具；默认不覆盖已有文件，避免冲掉项目负责人替换的真实照片。
 * `force=true` 时全部重绘（仅用于夹具本身的回归）。
 */
export function ensureFixtures(baseDir: string, options: { force?: boolean } = {}): void {
  for (const fixture of FIXTURES) {
    const target = join(baseDir, fixture.file);
    if (!options.force && existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fixture.build());
  }
}

/** 所有图片仍与生成器输出一致时返回 true；被真实照片替换后返回 false */
export function fixturesAreSynthetic(baseDir: string): boolean {
  for (const fixture of FIXTURES) {
    const target = join(baseDir, fixture.file);
    if (!existsSync(target)) return false;
    if (!readFileSync(target).equals(fixture.build())) return false;
  }
  return true;
}

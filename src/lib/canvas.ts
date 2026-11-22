// Canvas helpers shared by the editor UI. Alignment matters because the server
// rescales nothing: keeping the request on the model grid means the annotated
// image is sent at exactly the size the user cropped it to.

export function alignUp(value: number, multiple: number): number {
    if (!Number.isFinite(value) || multiple <= 1) {
        return Math.max(1, Math.round(value));
    }
    return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

export function alignToMultiple(width: number, height: number, multiple: number): { width: number; height: number } {
    return {
        width: alignUp(width, multiple),
        height: alignUp(height, multiple),
    };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

function drawScaled(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("浏览器不支持 2D 画布，无法导出图像");
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error("画布导出失败"));
            }
        }, type);
    });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取导出图像失败"));
        reader.readAsDataURL(blob);
    });
}

export async function canvasToImageDataUrl(source: CanvasImageSource, width: number, height: number): Promise<string> {
    return blobToDataUrl(await canvasToBlob(drawScaled(source, width, height)));
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("底图读取失败"));
        image.src = src;
    });
}

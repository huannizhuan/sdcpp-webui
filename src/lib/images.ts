import type { GenerationForm, ImageEntry, ImageTarget } from "./types";

export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(`failed to read ${file.name}`));
        reader.readAsDataURL(file);
    });
}

// The server decodes uploads with stb_image, which understands PNG, JPEG, GIF,
// BMP, PSD, TGA and HDR. A WebP/AVIF/TIFF/HEIC picked from disk would reach it
// as raw bytes, fail inside stbi_load_from_memory, and abort the whole request
// with "load image from 'memory' failed" plus "invalid input image array".
// Re-encoding in the browser keeps every format that the browser itself can
// render, and it also strips EXIF orientation and drops alpha safely.
const PASSTHROUGH_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/bmp"]);

export function loadImageElementFromSource(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片读取失败，浏览器无法解码该格式"));
        image.src = src;
    });
}

export async function normalizeImageDataUrl(dataUrl: string): Promise<string> {
    const match = /^data:([^;,]+)/i.exec(dataUrl);
    const mime = (match ? match[1] : "").toLowerCase();
    if (PASSTHROUGH_MIME.has(mime)) {
        return dataUrl;
    }
    try {
        const image = await loadImageElementFromSource(dataUrl);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, image.naturalWidth);
        canvas.height = Math.max(1, image.naturalHeight);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return dataUrl;
        }
        ctx.drawImage(image, 0, 0);
        return canvas.toDataURL("image/png");
    } catch {
        // Let the server report the real problem instead of masking it here.
        return dataUrl;
    }
}

export async function readImageFileAsDataUrl(file: File): Promise<string> {
    return normalizeImageDataUrl(await readFileAsDataUrl(file));
}

export async function filesToImageEntries(fileList: FileList | File[]): Promise<ImageEntry[]> {
    const files = Array.from(fileList || []);
    return Promise.all(files.map(async (file) => ({
            name: file.name,
            type: "image/png",
            dataUrl: await readImageFileAsDataUrl(file),
    })));
}

export function assignImageEntries(form: GenerationForm, target: ImageTarget, images: ImageEntry[]): void {
    if (target === "init_image" || target === "control_image" || target === "end_image") {
        form[target] = images[0] || null;
        return;
    }
    if (target === "ref_images" || target === "control_frames") {
        form[target].push(...images);
    }
}

export function clearImageEntries(form: GenerationForm, target: ImageTarget): void {
    if (target === "init_image" || target === "control_image" || target === "end_image") {
        form[target] = null;
        return;
    }
    if (target === "ref_images" || target === "control_frames") {
        form[target].splice(0);
    }
}

export function removeImageEntry(form: GenerationForm, target: ImageTarget, index: number): void {
    if (target === "ref_images" || target === "control_frames") {
        form[target].splice(index, 1);
    }
}

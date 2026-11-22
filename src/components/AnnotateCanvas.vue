<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import InfoTip from "./InfoTip.vue";
import { blobToDataUrl, canvasToBlob, loadImageElement } from "../lib/canvas";

// The official Qwen-Image-2.1 workflow specifies local edits by annotating the
// reference image with circles or painted strokes. The annotated picture is fed
// to the vision encoder, which links the mark to the object under it. This is
// not a binary mask: the whole annotated image is sent as one reference image.

type Ring = { kind: "ellipse"; x: number; y: number; rx: number; ry: number };
type Stroke = { kind: "brush"; color: string; width: number; points: Array<{ x: number; y: number }> };
type Shape = Ring | Stroke;
type Tool = "ring" | "brush";
type BrushSize = "thin" | "medium" | "thick";

const props = defineProps<{
    imageSrc: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{
    (event: "update:shape-count", value: number): void;
}>();

const MAX_EDIT_EDGE = 1536;
// 6 px on a 512 px image is clearly visible to the encoder; scale the stroke so
// the mark reads the same at every resolution.
const STROKE_RATIO = 0.012;
const STROKE_MIN = 4;
const STROKE_MAX = 18;
const RING_COLOR = "#ff0000";
const BRUSH_COLORS = ["#ff0000", "#0066ff", "#00b050"];
const BRUSH_RATIOS: Record<BrushSize, number> = { thin: 0.010, medium: 0.022, thick: 0.045 };

const canvasRef = ref<HTMLCanvasElement | null>(null);
const shapes = ref<Shape[]>([]);
const ready = ref(false);
const errorMessage = ref("");
const hoverIndex = ref(-1);
const tool = ref<Tool>("ring");
const brushColor = ref(BRUSH_COLORS[0]);
const brushSize = ref<BrushSize>("medium");

const imageSize = ref({ width: 0, height: 0 });
let baseImage: HTMLImageElement | null = null;
let inkCanvas: HTMLCanvasElement | null = null;
let drawing = false;
let start: { x: number; y: number } | null = null;
let preview: Ring | null = null;
let activeStroke: Stroke | null = null;

const canvasSize = computed(() => {
    const { width, height } = imageSize.value;
    if (width <= 0 || height <= 0) {
        return { width: 0, height: 0 };
    }
    const scale = Math.min(1, MAX_EDIT_EDGE / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
});

const strokeWidth = computed(() => {
    const edge = Math.min(canvasSize.value.width, canvasSize.value.height) || 512;
    return Math.max(STROKE_MIN, Math.min(STROKE_MAX, Math.round(edge * STROKE_RATIO)));
});

const brushWidthPx = computed(() => {
    const edge = Math.min(canvasSize.value.width, canvasSize.value.height) || 512;
    return Math.max(STROKE_MIN, Math.round(edge * BRUSH_RATIOS[brushSize.value]));
});

const hasShapes = computed(() => shapes.value.length > 0);

function ctxOf(): CanvasRenderingContext2D | null {
    const canvas = canvasRef.value;
    return canvas ? canvas.getContext("2d") : null;
}

function toCanvasPoint(event: PointerEvent): { x: number; y: number } {
    const canvas = canvasRef.value;
    if (!canvas) {
        return { x: 0, y: 0 };
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
    };
}

function drawRing(ctx: CanvasRenderingContext2D, shape: Ring, highlight = false): void {
    ctx.save();
    ctx.strokeStyle = highlight ? "#ff8800" : RING_COLOR;
    ctx.lineWidth = strokeWidth.value * (highlight ? 1.4 : 1);
    ctx.beginPath();
    ctx.ellipse(shape.x, shape.y, Math.max(2, shape.rx), Math.max(2, shape.ry), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, scale = 1): void {
    const points = stroke.points;
    if (!points.length) {
        return;
    }
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = Math.max(2, stroke.width * scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (points.length === 1) {
        ctx.arc(points[0].x * scale, points[0].y * scale, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
    }
    ctx.moveTo(points[0].x * scale, points[0].y * scale);
    for (let index = 1; index < points.length; index += 1) {
        ctx.lineTo(points[index].x * scale, points[index].y * scale);
    }
    ctx.stroke();
    ctx.restore();
}

// Brush paint lives on its own transparent layer so undo can rebuild it from
// the shape list without repainting the photo.
function inkContext(): CanvasRenderingContext2D | null {
    if (!inkCanvas) {
        return null;
    }
    return inkCanvas.getContext("2d");
}

function renderInk(): void {
    const ctx = inkContext();
    if (!ctx || !inkCanvas) {
        return;
    }
    ctx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
    for (const shape of shapes.value) {
        if (shape.kind === "brush") {
            drawStroke(ctx, shape);
        }
    }
}

function redraw(): void {
    const canvas = canvasRef.value;
    const ctx = ctxOf();
    if (!canvas || !ctx || !baseImage) {
        return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
    if (inkCanvas) {
        ctx.drawImage(inkCanvas, 0, 0);
    }
    shapes.value.forEach((shape, index) => {
        if (shape.kind === "ellipse") {
            drawRing(ctx, shape, index === hoverIndex.value);
        }
    });
    if (preview) {
        drawRing(ctx, preview);
    }
}

function updateCount(): void {
    emit("update:shape-count", shapes.value.length);
}

function onPointerDown(event: PointerEvent): void {
    if (props.disabled || !ready.value) {
        return;
    }
    const canvas = canvasRef.value;
    if (!canvas) {
        return;
    }
    event.preventDefault();
    try {
        canvas.setPointerCapture(event.pointerId);
    } catch {
        // Pointer capture is an optimisation; drawing still works without it.
    }
    const point = toCanvasPoint(event);
    drawing = true;
    if (tool.value === "brush") {
        activeStroke = { kind: "brush", color: brushColor.value, width: brushWidthPx.value, points: [point] };
        shapes.value.push(activeStroke);
        updateCount();
        redraw();
        return;
    }
    start = point;
    preview = { kind: "ellipse", x: point.x, y: point.y, rx: 0, ry: 0 };
}

function onPointerMove(event: PointerEvent): void {
    if (!drawing) {
        return;
    }
    const point = toCanvasPoint(event);
    if (activeStroke) {
        const previous = activeStroke.points[activeStroke.points.length - 1];
        activeStroke.points.push(point);
        const ctx = inkContext();
        if (ctx && previous) {
            ctx.save();
            ctx.strokeStyle = activeStroke.color;
            ctx.lineWidth = activeStroke.width;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(previous.x, previous.y);
            ctx.lineTo(point.x, point.y);
            ctx.stroke();
            ctx.restore();
            redraw();
        }
        return;
    }
    if (!start) {
        return;
    }
    preview = {
        kind: "ellipse",
        x: (start.x + point.x) / 2,
        y: (start.y + point.y) / 2,
        rx: Math.abs(point.x - start.x) / 2,
        ry: Math.abs(point.y - start.y) / 2,
    };
    redraw();
}

function finish(): void {
    if (!drawing) {
        return;
    }
    drawing = false;
    if (activeStroke) {
        activeStroke = null;
        renderInk();
        redraw();
        return;
    }
    // Ignore accidental clicks that produced a degenerate ring.
    if (preview && (preview.rx >= 6 || preview.ry >= 6)) {
        shapes.value.push(preview);
        updateCount();
    }
    preview = null;
    start = null;
    redraw();
}

function onPointerCancel(): void {
    drawing = false;
    if (activeStroke) {
        activeStroke = null;
        renderInk();
    }
    preview = null;
    start = null;
    redraw();
}

function undo(): void {
    shapes.value.pop();
    updateCount();
    renderInk();
    redraw();
}

function clearAll(): void {
    shapes.value = [];
    updateCount();
    renderInk();
    redraw();
}

function selectTool(next: Tool): void {
    if (props.disabled) {
        return;
    }
    tool.value = next;
}

async function prepare(): Promise<void> {
    ready.value = false;
    errorMessage.value = "";
    shapes.value = [];
    updateCount();
    baseImage = null;
    inkCanvas = null;
    imageSize.value = { width: 0, height: 0 };
    if (!props.imageSrc) {
        return;
    }
    try {
        const image = await loadImageElement(props.imageSrc);
        baseImage = image;
        imageSize.value = { width: image.naturalWidth, height: image.naturalHeight };
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        const canvas = canvasRef.value;
        if (!canvas) {
            return;
        }
        canvas.width = canvasSize.value.width;
        canvas.height = canvasSize.value.height;
        const ink = document.createElement("canvas");
        ink.width = canvas.width;
        ink.height = canvas.height;
        inkCanvas = ink;
        ready.value = true;
        redraw();
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
    }
}

watch(() => props.imageSrc, () => {
    void prepare();
}, { immediate: true });

onBeforeUnmount(() => {
    baseImage = null;
    inkCanvas = null;
});

// Exports the annotated image at full resolution so the marks stay crisp even
// when the preview was downscaled.
async function exportAnnotated(width: number, height: number): Promise<string> {
    if (!baseImage) {
        throw new Error("请先上传底图");
    }
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(width));
    out.height = Math.max(1, Math.round(height));
    const ctx = out.getContext("2d");
    if (!ctx) {
        throw new Error("浏览器不支持 2D 画布");
    }
    ctx.drawImage(baseImage, 0, 0, out.width, out.height);
    const scaleX = out.width / Math.max(1, canvasSize.value.width);
    const scaleY = out.height / Math.max(1, canvasSize.value.height);
    const edgeScale = Math.min(scaleX, scaleY);
    if (inkCanvas) {
        ctx.drawImage(inkCanvas, 0, 0, out.width, out.height);
    }
    const stroke = Math.max(STROKE_MIN, Math.round(Math.min(out.width, out.height) * STROKE_RATIO));
    for (const shape of shapes.value) {
        if (shape.kind === "brush") {
            drawStroke(ctx, shape, edgeScale);
            continue;
        }
        ctx.save();
        ctx.strokeStyle = RING_COLOR;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.ellipse(shape.x * scaleX, shape.y * scaleY, Math.max(2, shape.rx * scaleX), Math.max(2, shape.ry * scaleY), 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
    return blobToDataUrl(await canvasToBlob(out));
}

defineExpose({ exportAnnotated, clearAll, hasShapes });
</script>

<template>
    <section class="mask-editor">
        <div class="mask-editor__header">
            <div>
                <h3 class="mask-editor__title">
                    标注要修改的区域
                    <InfoTip text="用圈或画笔在底图上标出目标（可以标多处）。带标注的图会作为参考图交给模型，标注盖住的东西就是这次要改的对象。这是官方推荐的局部编辑方式，不需要黑白蒙版。" />
                </h3>
            </div>
            <div class="mask-editor__tools">
                <button class="mask-tool" :class="{ 'mask-tool--active': tool === 'ring' }" type="button" :disabled="disabled" title="拖拽画出圆形或椭圆，圈住要改的对象" @click="selectTool('ring')">圈选</button>
                <button class="mask-tool" :class="{ 'mask-tool--active': tool === 'brush' }" type="button" :disabled="disabled" title="像画笔一样直接涂抹要改的地方" @click="selectTool('brush')">画笔</button>
                <button class="btn-secondary" type="button" :disabled="disabled || !hasShapes" title="撤销上一步标注" @click="undo">撤销</button>
                <button class="btn-secondary" type="button" :disabled="disabled || !hasShapes" title="清空所有标注" @click="clearAll">清空</button>
            </div>
        </div>

        <div v-if="tool === 'brush'" class="mask-editor__tools">
            <button
                v-for="color in BRUSH_COLORS"
                :key="color"
                class="brush-swatch"
                :class="{ 'brush-swatch--active': brushColor === color }"
                type="button"
                :style="{ background: color }"
                :disabled="disabled"
                :title="'画笔颜色 ' + color"
                @click="brushColor = color"
            />
            <span class="mask-editor__brush-divider" />
            <button class="mask-tool" :class="{ 'mask-tool--active': brushSize === 'thin' }" type="button" :disabled="disabled" @click="brushSize = 'thin'">细</button>
            <button class="mask-tool" :class="{ 'mask-tool--active': brushSize === 'medium' }" type="button" :disabled="disabled" @click="brushSize = 'medium'">中</button>
            <button class="mask-tool" :class="{ 'mask-tool--active': brushSize === 'thick' }" type="button" :disabled="disabled" @click="brushSize = 'thick'">粗</button>
        </div>

        <div class="mask-editor__stage">
            <canvas
                v-show="ready"
                ref="canvasRef"
                class="mask-editor__canvas"
                :class="{ 'mask-editor__canvas--disabled': disabled }"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="finish"
                @pointerleave="finish"
                @pointercancel="onPointerCancel"
            />
            <div v-if="!ready" class="mask-editor__placeholder">{{ errorMessage ? "底图载入失败" : "正在载入底图…" }}</div>
        </div>

        <div class="mask-editor__status">
            <span>已标注 <strong>{{ shapes.length }}</strong> 处</span>
            <span class="hint">{{ tool === 'brush' ? '按住左键在目标上涂抹，可换颜色区分多个对象' : '拖拽画出圆形或椭圆；圈得越贴合目标，改动越准' }}</span>
        </div>
        <div v-if="!hasShapes" class="hint">尚未标注。不标注时模型会按指令改整张图。</div>
        <div v-if="errorMessage" class="status-message status-message--error">{{ errorMessage }}</div>
    </section>
</template>

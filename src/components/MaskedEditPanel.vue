<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import AnnotateCanvas from "./AnnotateCanvas.vue";
import InfoTip from "./InfoTip.vue";
import PromptAssistant from "./PromptAssistant.vue";
import { getJob, submitImageJob } from "../lib/api";
import { alignToMultiple, loadImageElement } from "../lib/canvas";
import { readImageFileAsDataUrl } from "../lib/images";
import type { EditDefaults, GenerationForm, Job } from "../lib/types";

type EditMode = "annotate" | "instruction";

const props = defineProps<{
    baseUrl: string;
    modelFamily: string;
    modelMultiple: number;
    editDefaults: EditDefaults | null;
    maxRefImages: number;
    supportsAlpha: boolean;
    defaults: GenerationForm | null;
    supportsNegativePrompt: boolean;
    negativePromptReason: string;
    llmAvailable: boolean;
    llmReason: string;
    // LoRA entries the server found under --lora-model-dir.
    availableLoras: Array<{ name: string; path: string }>;
    // LoRAs already configured on the text-to-image tab, reused as the starting
    // point so an edit does not silently drop them.
    initialLoras: Array<{ path: string; multiplier: number; is_high_noise: boolean }>;
}>();

const emit = defineEmits<{
    (event: "notify", payload: { message: string; tone: string }): void;
}>();

const ALPHA_PREFIX = "This is an RGBA image with transparency. ";
const ALPHA_SUFFIX = " The image has alpha channel and the background is transparent.";

// Editing needs the full text+image conditioning path, which costs far more
// memory than plain text-to-image. Above this many pixels the request reliably
// runs out of memory on an 8 GB card.
const SAFE_EDIT_PIXELS = 768 * 768;

const mode = ref<EditMode>("annotate");
const referenceImages = ref<Array<{ name: string; dataUrl: string }>>([]);
const baseImageSrc = ref("");
const baseImageName = ref("");
const naturalWidth = ref(0);
const naturalHeight = ref(0);
const targetWidth = ref(512);
const targetHeight = ref(512);
const prompt = ref("");
const negativePrompt = ref("");
const busy = ref(false);
const errorMessage = ref("");
const warnings = ref<string[]>([]);
const currentJob = ref<Job | null>(null);
const resultSrc = ref("");
const annotator = ref<InstanceType<typeof AnnotateCanvas> | null>(null);
const markCount = ref(0);
const transparent = ref(false);
const turbo = ref(false);
const loras = ref<Array<{ path: string; multiplier: number; is_high_noise: boolean }>>([]);

const loraSummary = computed(() => (loras.value.length ? `已启用 ${loras.value.length} 个 LoRA` : "未使用 LoRA"));

const startedAtMs = ref(0);
const nowMs = ref(Date.now());
// The progress callback also fires for the VAE decode pass, which reports a
// handful of "steps" and would otherwise overwrite the real sampling schedule.
// Keep the largest schedule seen: that is the denoising pass.
const samplingTotal = ref(0);
const samplingSPerIt = ref(0);

let pollTimer = 0;
let tickTimer = 0;

const multiple = computed(() => Math.max(1, props.modelMultiple || 32));
const defaults = computed(() => props.editDefaults);
const pixelCount = computed(() => targetWidth.value * targetHeight.value);
const alignedTarget = computed(() => alignToMultiple(targetWidth.value, targetHeight.value, multiple.value));
const hasBase = computed(() => Boolean(baseImageSrc.value));
const hasRefs = computed(() => referenceImages.value.length > 0);
const canSubmit = computed(() => {
    if (busy.value || !prompt.value.trim()) {
        return false;
    }
    if (mode.value === "instruction") {
        return hasRefs.value;
    }
    return hasBase.value && markCount.value > 0;
});
const memoryRisk = computed(() => pixelCount.value > SAFE_EDIT_PIXELS);

// Steps are user adjustable. Turbo is the exception: its weights were distilled
// against exactly one sigma table, so the count is whatever that table holds.
const STEPS_MIN = 1;
const STEPS_MAX = 200;
const steps = ref(40);
const stepsTouched = ref(false);
let stepsBeforeTurbo = 0;

const turboSteps = computed(() => {
    const sigmas = props.editDefaults?.turbo_sigmas || [];
    return sigmas.length > 1 ? sigmas.length - 1 : 8;
});
const defaultEditSteps = computed(() => props.editDefaults?.steps || 40);

function clampSteps(value: number): number {
    if (!Number.isFinite(value)) {
        return defaultEditSteps.value;
    }
    return Math.max(STEPS_MIN, Math.min(STEPS_MAX, Math.round(value)));
}

function normalizeSteps(): void {
    steps.value = clampSteps(steps.value);
    stepsTouched.value = steps.value !== defaultEditSteps.value;
}

// What the request will actually use, and what the progress bar counts against.
const effectiveSteps = computed(() => (turbo.value ? turboSteps.value : clampSteps(steps.value)));
const CFG_MIN = 1;
const CFG_MAX = 30;
const cfg = ref(6);
const cfgTouched = ref(false);
let cfgBeforeTurbo = 0;

const defaultEditCfg = computed(() => props.editDefaults?.cfg_scale || 6);

function clampCfg(value: number): number {
    if (!Number.isFinite(value)) {
        return defaultEditCfg.value;
    }
    return Math.max(CFG_MIN, Math.min(CFG_MAX, Math.round(value * 10) / 10));
}

function normalizeCfg(): void {
    cfg.value = clampCfg(cfg.value);
    cfgTouched.value = Math.abs(cfg.value - defaultEditCfg.value) > 1e-6;
}

// Turbo is distilled for cfg 1; anything above that both contradicts the sigma
// schedule and doubles the batch the sampler has to run.
const effectiveCfg = computed(() => (turbo.value ? 1.0 : clampCfg(cfg.value)));
const aspectRatioEntries = computed(() => Object.entries(defaults.value?.aspect_ratios || {}));

watch(turbo, (enabled) => {
    if (enabled) {
        stepsBeforeTurbo = steps.value;
        cfgBeforeTurbo = cfg.value;
        steps.value = turboSteps.value;
        cfg.value = 1.0;
        return;
    }
    steps.value = stepsBeforeTurbo || defaultEditSteps.value;
    cfg.value = cfgBeforeTurbo || defaultEditCfg.value;
    stepsTouched.value = steps.value !== defaultEditSteps.value;
    cfgTouched.value = Math.abs(cfg.value - defaultEditCfg.value) > 1e-6;
});

const alignmentNotice = computed(() => {
    if (alignedTarget.value.width === targetWidth.value && alignedTarget.value.height === targetHeight.value) {
        return "";
    }
    return `${targetWidth.value}×${targetHeight.value} 已对齐到 ${alignedTarget.value.width}×${alignedTarget.value.height}（当前模型要求 ${multiple.value} 的倍数）`;
});

const status = computed(() => currentJob.value?.status || "");
const isRunning = computed(() => status.value === "queued" || status.value === "generating");
const resultImages = computed(() => currentJob.value?.result?.images || []);

// The official prompt requires <image1>, <image2>, ... when several references
// are supplied; natural language like "the first image" is not understood.
const usesImageTags = computed(() => referenceImages.value.length > 1);

const progressStep = computed(() => {
    const progress = currentJob.value?.progress;
    if (!progress || !progress.total || progress.total !== samplingTotal.value) {
        return 0;
    }
    return Math.min(progress.completed ?? 0, progress.total);
});
const progressTotal = computed(() => samplingTotal.value);

const elapsedSeconds = computed(() => {
    const job = currentJob.value;
    if (isRunning.value) {
        return startedAtMs.value ? Math.max(0, (nowMs.value - startedAtMs.value) / 1000) : 0;
    }
    if (job?.started && job?.completed) {
        return Math.max(0, job.completed - job.started);
    }
    return startedAtMs.value ? Math.max(0, (nowMs.value - startedAtMs.value) / 1000) : 0;
});

// The server reports seconds per iteration; anything under a second reads more
// naturally as iterations per second.
const sampleSpeed = computed(() => samplingSPerIt.value);
const speedLabel = computed(() => {
    const seconds = sampleSpeed.value;
    if (Number.isFinite(seconds) && seconds > 0) {
        return seconds < 1 ? `${(1 / seconds).toFixed(2)} it/s` : `${seconds.toFixed(2)} s/it`;
    }
    if (isRunning.value && progressStep.value > 0 && elapsedSeconds.value > 0) {
        return `${(progressStep.value / elapsedSeconds.value).toFixed(2)} it/s`;
    }
    return "—";
});
const averageSpeedLabel = computed(() => {
    const total = progressTotal.value || effectiveSteps.value;
    const seconds = elapsedSeconds.value;
    if (!Number.isFinite(total) || total <= 0 || seconds <= 0) {
        return "—";
    }
    return `${(total / seconds).toFixed(2)} it/s`;
});
const elapsedLabel = computed(() => formatDuration(elapsedSeconds.value));
const etaLabel = computed(() => {
    const total = progressTotal.value;
    const done = progressStep.value;
    if (!isRunning.value || !total || done <= 0 || sampleSpeed.value <= 0) {
        return "";
    }
    return formatDuration(Math.max(0, (total - done) * sampleSpeed.value));
});
const showProgress = computed(() => isRunning.value || samplingTotal.value > 0);

function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return "0.0s";
    }
    if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds - minutes * 60);
    return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

function notify(message: string, tone = ""): void {
    emit("notify", { message, tone });
}

function startTick(): void {
    stopTick();
    nowMs.value = Date.now();
    tickTimer = window.setInterval(() => {
        nowMs.value = Date.now();
    }, 500);
}

function stopTick(): void {
    if (tickTimer) {
        window.clearInterval(tickTimer);
        tickTimer = 0;
    }
}

function applyDefaults(): void {
    const base = props.defaults;
    if (base) {
        negativePrompt.value = base.negative_prompt || "";
    }
    const edit = props.editDefaults;
    if (edit) {
        targetWidth.value = edit.width || 512;
        targetHeight.value = edit.height || 512;
        if (!stepsTouched.value && !turbo.value) {
            steps.value = clampSteps(edit.steps || 40);
        }
        if (!cfgTouched.value && !turbo.value) {
            cfg.value = clampCfg(edit.cfg_scale || 6);
        }
    }
}

watch(() => props.defaults, () => applyDefaults(), { immediate: true });
watch(() => props.editDefaults, () => applyDefaults(), { immediate: true });

watch(() => props.initialLoras, (next) => {
    loras.value = (next || []).map((item) => ({ ...item }));
}, { immediate: true, deep: true });

function addLora(): void {
    const first = props.availableLoras[0];
    if (!first) {
        return;
    }
    loras.value.push({ path: first.path, multiplier: 1, is_high_noise: false });
}

function removeLora(index: number): void {
    loras.value.splice(index, 1);
}

async function onPickReferences(files: FileList | null): Promise<void> {
    if (!files || !files.length) {
        return;
    }
    const limit = Math.max(1, props.maxRefImages || 10);
    const room = limit - referenceImages.value.length;
    if (room <= 0) {
        errorMessage.value = `最多只支持 ${limit} 张参考图`;
        return;
    }
    errorMessage.value = "";
    const picked = Array.from(files).slice(0, room);
    for (const file of picked) {
        const dataUrl = await readImageFileAsDataUrl(file);
        referenceImages.value.push({ name: file.name, dataUrl });
    }
}

function onRefInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    void onPickReferences(input.files);
    input.value = "";
}

function removeReference(index: number): void {
    referenceImages.value.splice(index, 1);
}

async function onPickBase(files: FileList | null): Promise<void> {
    const file = files && files.length ? Array.from(files)[0] : null;
    if (!file) {
        return;
    }
    errorMessage.value = "";
    resultSrc.value = "";
    currentJob.value = null;
    try {
        const dataUrl = await readImageFileAsDataUrl(file);
        const image = await loadImageElement(dataUrl);
        baseImageSrc.value = dataUrl;
        baseImageName.value = file.name;
        naturalWidth.value = image.naturalWidth;
        naturalHeight.value = image.naturalHeight;
        const aligned = alignToMultiple(image.naturalWidth, image.naturalHeight, multiple.value);
        targetWidth.value = aligned.width;
        targetHeight.value = aligned.height;
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
    }
}

function onBaseInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    void onPickBase(input.files);
    input.value = "";
}

function onBaseDrop(event: DragEvent): void {
    event.preventDefault();
    void onPickBase(event.dataTransfer?.files || null);
}

function clearBase(): void {
    baseImageSrc.value = "";
    baseImageName.value = "";
    naturalWidth.value = 0;
    naturalHeight.value = 0;
    markCount.value = 0;
    resultSrc.value = "";
    currentJob.value = null;
}

function applyAspectRatio(ratio: string): void {
    const entry = defaults.value?.aspect_ratios?.[ratio];
    if (!entry) {
        return;
    }
    targetWidth.value = entry[0];
    targetHeight.value = entry[1];
}

function realign(): void {
    const aligned = alignToMultiple(targetWidth.value, targetHeight.value, multiple.value);
    targetWidth.value = aligned.width;
    targetHeight.value = aligned.height;
}

function applyAssistant(payload: { positive: string; negative: string }): void {
    prompt.value = payload.positive;
    if (props.supportsNegativePrompt && !turbo.value) {
        negativePrompt.value = payload.negative;
    }
    notify("提示词已填入编辑面板，确认无误后点击开始编辑。", "success");
}

// The server returns the image inline, so the edit result can be saved straight
// from the data URL without a second request.
function downloadResult(): void {
    if (!resultSrc.value) {
        return;
    }
    const format = currentJob.value?.result?.output_format || "png";
    const link = document.createElement("a");
    link.href = resultSrc.value;
    link.download = `${currentJob.value?.id || "edit"}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function stopPolling(): void {
    if (pollTimer) {
        window.clearTimeout(pollTimer);
        pollTimer = 0;
    }
}

async function pollJob(id: string): Promise<void> {
    try {
        const job = await getJob(props.baseUrl, id);
        currentJob.value = job;
        nowMs.value = Date.now();
        const progress = job.progress;
        // Keep the largest schedule: stage reports also cover the VAE pass.
        if (progress && progress.total && progress.total >= samplingTotal.value) {
            samplingTotal.value = progress.total;
            const completed = progress.completed ?? 0;
            const elapsedSeconds = Number(progress.stage_elapsed_ms ?? 0) / 1000;
            samplingSPerIt.value = completed > 0 && elapsedSeconds > 0 ? elapsedSeconds / completed : 0;
        }
        if (job.status === "queued" || job.status === "generating") {
            pollTimer = window.setTimeout(() => void pollJob(id), 150);
            return;
        }
        busy.value = false;
        stopPolling();
        stopTick();
        if (job.status === "completed") {
            const first = job.result?.images?.[0];
            const format = job.result?.output_format || "png";
            resultSrc.value = first ? `data:image/${format};base64,${first.b64_json}` : "";
            notify(`编辑完成，耗时 ${elapsedLabel.value}。`, "success");
            return;
        }
        if (job.status === "cancelled") {
            notify("任务已取消。", "error");
            return;
        }
        notify(job.error?.message || "编辑失败。", "error");
    } catch (error) {
        busy.value = false;
        stopPolling();
        stopTick();
        errorMessage.value = error instanceof Error ? error.message : String(error);
    }
}

function effectivePrompt(): string {
    const text = prompt.value.trim();
    if (!transparent.value || !props.supportsAlpha) {
        return text;
    }
    // The model decides transparency from the prompt shape, not from a flag.
    if (text.startsWith("This is an RGBA image with transparency.")) {
        return text;
    }
    const body = text.endsWith(".") ? text : text + ".";
    return ALPHA_PREFIX + body + ALPHA_SUFFIX;
}

function buildSampleParams() {
    const base = props.defaults?.sample_params;
    const params: Record<string, unknown> = {
        sample_steps: effectiveSteps.value,
        shifted_timestep: 0,
        custom_sigmas: turbo.value ? [...(props.editDefaults?.turbo_sigmas || [])] : [],
        guidance: {
            txt_cfg: effectiveCfg.value,
            distilled_guidance: base ? Number(base.guidance.distilled_guidance) : 3.5,
            slg: { layers: [], layer_start: 0.01, layer_end: 0.2, scale: 0 },
        },
    };
    if (defaults.value?.sample_method) {
        params.sample_method = defaults.value.sample_method;
    }
    return params;
}

async function run(): Promise<void> {
    if (!canSubmit.value) {
        return;
    }
    errorMessage.value = "";
    warnings.value = [];
    resultSrc.value = "";
    busy.value = true;
    startedAtMs.value = Date.now();
    nowMs.value = startedAtMs.value;
    samplingTotal.value = 0;
    samplingSPerIt.value = 0;
    startTick();
    try {
        const aligned = alignedTarget.value;
        const body: Record<string, unknown> = {
            prompt: effectivePrompt(),
            negative_prompt: props.supportsNegativePrompt && !turbo.value ? negativePrompt.value : "",
            width: aligned.width,
            height: aligned.height,
            strength: 1.0,
            seed: props.defaults ? Number(props.defaults.seed) : -1,
            batch_count: 1,
            clip_skip: props.defaults ? Number(props.defaults.clip_skip) : -1,
            sample_params: buildSampleParams(),
            lora: loras.value
                .filter((item) => String(item.path || "").trim())
                .map((item) => ({
                    path: String(item.path).trim(),
                    multiplier: Number(item.multiplier) || 1,
                    is_high_noise: Boolean(item.is_high_noise),
                })),
            output_format: props.defaults?.output_format || "png",
            output_compression: 100,
            preview: "none",
            preview_interval: 1,
            ref_images: [],
        };

        if (mode.value === "instruction") {
            body.ref_images = referenceImages.value.map((item) => item.dataUrl);
        } else {
            // The annotated picture itself is the reference image; no mask is sent.
            const annotated = await annotator.value?.exportAnnotated(aligned.width, aligned.height);
            if (!annotated) {
                throw new Error("请先在底图上标出要修改的区域");
            }
            body.ref_images = [annotated];
        }

        const job = await submitImageJob(props.baseUrl, body);
        currentJob.value = job;
        const submitWarnings = (job as unknown as { warnings?: string[] }).warnings;
        if (Array.isArray(submitWarnings)) {
            warnings.value = submitWarnings;
        }
        await pollJob(job.id);
    } catch (error) {
        busy.value = false;
        stopTick();
        errorMessage.value = error instanceof Error ? error.message : String(error);
    }
}

onBeforeUnmount(() => {
    stopPolling();
    stopTick();
});
</script>

<template>
    <div class="layout layout--mask">
        <section class="panel control-panel">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title">图像编辑</h2>
                </div>
                <div class="mask-editor__tools">
                    <button class="mask-tool" :class="{ 'mask-tool--active': mode === 'annotate' }" type="button" title="官方推荐：在图上圈选或涂抹标出要改的地方，再用一句话说明改什么" @click="mode = 'annotate'">圈划编辑</button>
                    <button class="mask-tool" :class="{ 'mask-tool--active': mode === 'instruction' }" type="button" title="直接给参考图，不加标注" @click="mode = 'instruction'">指令编辑</button>
                </div>
            </div>

            <div v-if="mode === 'instruction'" class="field--full">
                <label>
                    参考图像
                    <InfoTip :text="'Qwen Image 2.1 通过参考图理解要改什么。最多 ' + (maxRefImages || 10) + ' 张；多张时请在提示词里用 <image1>、<image2> 指代。'" />
                </label>
                <div class="mask-dropzone">
                    <div class="mask-dropzone__body">
                        <span v-if="!hasRefs">拖拽或选择参考图像</span>
                        <span v-else>已选择 {{ referenceImages.length }} 张</span>
                        <div class="ref-grid" v-if="hasRefs">
                            <figure v-for="(item, index) in referenceImages" :key="index" class="ref-grid__item">
                                <img :src="item.dataUrl" :alt="item.name" />
                                <figcaption>&lt;image{{ index + 1 }}&gt;</figcaption>
                                <button class="btn-ghost" type="button" @click="removeReference(index)">移除</button>
                            </figure>
                        </div>
                        <div class="mask-dropzone__actions">
                            <label class="btn-secondary">
                                选择图像
                                <input type="file" accept="image/*" multiple hidden @change="onRefInput" />
                            </label>
                        </div>
                    </div>
                </div>
            </div>

            <template v-else>
                <div class="field--full">
                    <label>底图<InfoTip text="要修改的原图。在上面圈选或涂抹标出目标，带标注的整张图会作为参考图提交。" /></label>
                    <div class="mask-dropzone" :class="{ 'mask-dropzone--filled': hasBase }" @dragover.prevent @drop="onBaseDrop">
                        <img v-if="hasBase" class="mask-dropzone__thumb" :src="baseImageSrc" alt="底图预览" />
                        <div class="mask-dropzone__body">
                            <span v-if="hasBase">{{ baseImageName }} · {{ naturalWidth }}×{{ naturalHeight }}</span>
                            <span v-else>拖拽图片到这里，或点击选择文件</span>
                            <div class="mask-dropzone__actions">
                                <label class="btn-secondary">
                                    选择图片
                                    <input type="file" accept="image/*" hidden @change="onBaseInput" />
                                </label>
                                <button v-if="hasBase" class="btn-ghost" type="button" @click="clearBase">移除</button>
                            </div>
                        </div>
                    </div>
                </div>

                <AnnotateCanvas
                    v-if="hasBase"
                    ref="annotator"
                    class="stack-top"
                    :image-src="baseImageSrc"
                    :disabled="busy"
                    @update:shape-count="markCount = $event"
                />
            </template>

            <div class="fields stack-top">
                <div class="field">
                    <label>宽度<InfoTip text="必须是当前模型空间倍数的整数倍，否则会被自动上对齐。" /></label>
                    <input v-model.number="targetWidth" type="number" min="64" :step="multiple" @blur="realign" />
                </div>
                <div class="field">
                    <label>高度<InfoTip text="必须是当前模型空间倍数的整数倍，否则会被自动上对齐。" /></label>
                    <input v-model.number="targetHeight" type="number" min="64" :step="multiple" @blur="realign" />
                </div>
            </div>

            <div v-if="aspectRatioEntries.length" class="stack-top">
                <label class="hint">官方推荐尺寸（2K，需要大显存）</label>
                <div class="mask-editor__tools">
                    <button v-for="entry in aspectRatioEntries" :key="entry[0]" class="mask-tool" type="button" :title="entry[1][0] + '×' + entry[1][1]" @click="applyAspectRatio(entry[0])">{{ entry[0] }}</button>
                </div>
            </div>

            <div class="fields stack-top">
                <div class="field">
                    <label>步数<InfoTip :text="turbo ? 'Turbo 权重按固定的 sigma 表蒸馏，步数固定为 ' + turboSteps + ' 步，不能改。' : '官方推荐 40 步。步数越多细节越好但越慢；低于 20 步画质会明显下降。'" /></label>
                    <input v-model.number="steps" type="number" :min="STEPS_MIN" :max="STEPS_MAX" step="1" :disabled="turbo" @change="normalizeSteps" @blur="normalizeSteps" />
                </div>
                <div class="field">
                    <label>CFG<InfoTip :text="turbo ? 'Turbo 权重按 cfg 1.0 蒸馏，CFG 固定为 1.0，不能改。' : '官方推荐 6.0。数值越高越贴合提示词，但显存和耗时也越高；大尺寸下容易爆显存。'" /></label>
                    <input v-model.number="cfg" type="number" :min="CFG_MIN" :max="CFG_MAX" step="0.1" :disabled="turbo" @change="normalizeCfg" @blur="normalizeCfg" />
                </div>
            </div>

            <div class="speed-grid stack-top">
                <div class="speed-grid__item">
                    <span class="speed-grid__label">采样速度</span>
                    <strong class="speed-grid__value">{{ speedLabel }}</strong>
                </div>
                <div class="speed-grid__item">
                    <span class="speed-grid__label">平均速度</span>
                    <strong class="speed-grid__value">{{ averageSpeedLabel }}</strong>
                </div>
                <div class="speed-grid__item">
                    <span class="speed-grid__label">已用时</span>
                    <strong class="speed-grid__value">{{ elapsedLabel }}</strong>
                </div>
                <div class="speed-grid__item">
                    <span class="speed-grid__label">预计剩余</span>
                    <strong class="speed-grid__value">{{ etaLabel || "—" }}</strong>
                </div>
            </div>

            <div class="stack-top">
                <label class="hint">LoRA：{{ loraSummary }}</label>
                <div v-if="!availableLoras.length" class="hint">服务器未返回 LoRA；启动时需带 --lora-model-dir。</div>
                <div v-else-if="!loras.length" class="hint">未启用 LoRA。</div>
                <div v-else class="list-editor">
                    <div v-for="(item, index) in loras" :key="index" class="list-row">
                        <select v-model="item.path">
                            <option v-for="entry in availableLoras" :key="entry.path" :value="entry.path">
                                {{ entry.name }} ({{ entry.path }})
                            </option>
                        </select>
                        <input v-model.number="item.multiplier" type="number" step="0.1" title="LoRA 权重，1.0 为原始强度" />
                        <button class="btn-ghost" type="button" @click="removeLora(index)">移除</button>
                    </div>
                </div>
                <button class="btn-ghost" type="button" :disabled="!availableLoras.length" title="为该次编辑启用一个 LoRA" @click="addLora">添加 LoRA</button>
            </div>

            <div class="stack-top">
                <label class="mask-editor__brush">
                    <input v-model="turbo" type="checkbox" />
                    使用 Turbo 8 步调度（需已加载 Turbo 权重）
                </label>
                <label v-if="supportsAlpha" class="mask-editor__brush">
                    <input v-model="transparent" type="checkbox" />
                    输出透明背景（RGBA，仅 PNG/WebP 保留）
                </label>
            </div>

            <div v-if="memoryRisk" class="hint stack-top">当前尺寸 {{ targetWidth }}×{{ targetHeight }} 超过编辑的安全范围，8GB 显存通常会失败。建议先用 512。</div>
            <div v-if="alignmentNotice" class="hint stack-top">{{ alignmentNotice }}</div>
            <div v-if="usesImageTags" class="hint stack-top">提示词里请用 &lt;image1&gt;、&lt;image2&gt; 指代参考图，模型不认识「第一张图」这类说法。</div>

            <PromptAssistant
                class="stack-top"
                task-hint="image_edit"
                :base-url="baseUrl"
                :model-family="modelFamily"
                :supports-negative-prompt="supportsNegativePrompt && !turbo"
                :negative-prompt-reason="turbo ? 'Turbo 使用 cfg 1.0，反向提示词不生效。' : negativePromptReason"
                :llm-available="llmAvailable"
                :llm-reason="llmReason"
                @apply="applyAssistant"
            />

            <div class="prompt-card stack-top">
                <div class="field--full">
                    <label>{{ mode === 'instruction' ? '编辑指令' : '修改描述' }}<InfoTip text="描述要做什么，例如「把天空改成黄昏」。写指令，不要写画面描述。" /></label>
                    <textarea v-model="prompt" placeholder="描述要做的修改" />
                </div>
                <div v-if="supportsNegativePrompt && !turbo" class="field--full stack-top">
                    <label>反向提示词<InfoTip text="不希望出现在结果中的内容。" /></label>
                    <textarea v-model="negativePrompt" placeholder="不想要的内容?" />
                </div>
            </div>

            <div class="output-controls stack-top">
                <button class="btn" type="button" :disabled="!canSubmit" @click="run">
                    {{ busy ? "处理中..." : "开始编辑" }}
                </button>
                <span v-if="!prompt.trim()" class="hint">请填写编辑指令</span>
                <span v-else-if="mode === 'instruction' && !hasRefs" class="hint">请先添加参考图像</span>
                <span v-else-if="mode === 'annotate' && !hasBase" class="hint">请先上传底图</span>
                <span v-else-if="mode === 'annotate' && !markCount" class="hint">请先在底图上圈选或涂抹</span>
            </div>

            <div v-if="errorMessage" class="status-message status-message--error stack-top">{{ errorMessage }}</div>
            <div v-for="(warning, index) in warnings" :key="index" class="hint stack-top">· {{ warning }}</div>
        </section>

        <section class="panel preview-panel">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title">预览</h2>
                </div>
            </div>

            <div class="mask-compare">
                <figure class="mask-compare__item">
                    <figcaption>{{ mode === 'instruction' ? '参考图' : '原图' }}</figcaption>
                    <img v-if="mode === 'instruction' && hasRefs" :src="referenceImages[0].dataUrl" alt="参考图" />
                    <img v-else-if="mode === 'annotate' && hasBase" :src="baseImageSrc" alt="原图" />
                    <div v-else class="hint">尚未选择图像</div>
                </figure>
                <figure class="mask-compare__item">
                    <figcaption>编辑结果</figcaption>
                    <img v-if="resultSrc" :src="resultSrc" alt="编辑结果" />
                    <div v-else class="hint">{{ isRunning ? "正在生成…" : "尚未生成" }}</div>
                </figure>
            </div>

            <div class="actions output-controls stack-top">
                <button class="btn-secondary" type="button" :disabled="!resultSrc" title="下载编辑结果图片" @click="downloadResult">下载结果</button>
                <span v-if="resultSrc" class="hint">结果已随任务保存到服务器的输出目录，也可在「生成历史」里找到。</span>
            </div>

            <div v-if="showProgress" class="generation-progress stack-top">
                <div class="generation-progress__title">采样进度</div>
                <div class="generation-progress__meta">
                    <span>步数 <strong>{{ progressStep }}/{{ progressTotal || effectiveSteps }}</strong></span>
                    <span>速度 <strong>{{ speedLabel }}</strong></span>
                    <span>已用时 <strong>{{ elapsedLabel }}</strong></span>
                    <span v-if="etaLabel">剩余 <strong>{{ etaLabel }}</strong></span>
                </div>
            </div>
            <div v-if="resultImages.length > 1" class="hint stack-top">共生成 {{ resultImages.length }} 张，预览显示第一张。</div>
        </section>
    </div>
</template>

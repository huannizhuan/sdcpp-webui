<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import CollapsibleSection from "./components/CollapsibleSection.vue";
import HistoryPanel from "./components/HistoryPanel.vue";
import MaskedEditPanel from "./components/MaskedEditPanel.vue";
import ImageDropzone from "./components/ImageDropzone.vue";
import ImageSlotPicker, { type ImageSlot } from "./components/ImageSlotPicker.vue";
import InfoTip from "./components/InfoTip.vue";
import PromptAssistant from "./components/PromptAssistant.vue";
import StatusChip from "./components/StatusChip.vue";
import { getModelCapabilities, getPromptLlmStatus, type ModelCapabilitiesResponse, type PromptLlmStatus } from "./lib/prompt";
import { cancelJob, getCapabilities, getJob, listJobs, submitImageJob, submitVideoJob } from "./lib/api";
import { buildRequestBodyForMode, CACHE_MODES, createBlankForm, formFromCapabilities } from "./lib/form";
import { IMAGE_INPUTS, VIDEO_IMAGE_INPUTS } from "./lib/image-inputs";
import { assignImageEntries, clearImageEntries, filesToImageEntries, removeImageEntry } from "./lib/images";
import { createStoredRef, normalizePollIntervalMs } from "./lib/settings";
import type {
    Capabilities,
    GenerationForm,
    GenerationMode,
    ImageEntry,
    ImageTarget,
    Job,
    SampleParams,
} from "./lib/types";

const baseUrl = createStoredRef<string>("sdcpp-webui-base-url", "", (value: unknown) => String(value || ""));
// Survives a page reload so the UI can re-attach to a job the server is still
// running. Cleared once the job reaches a terminal state.
const activeJobId = createStoredRef<string>("sdcpp-webui-active-job", "", (value: unknown) => String(value || ""));
const pollIntervalMs = createStoredRef<number>("sdcpp-webui-poll-interval-ms", 100, normalizePollIntervalMs);
const activeTab = ref<"image" | "video" | "edit" | "history" | "slots" | "settings">("image");
const modelCapabilities = ref<ModelCapabilitiesResponse | null>(null);
const promptLlmStatus = ref<PromptLlmStatus | null>(null);

const supportsNegativePrompt = computed(() => {
    const capability = modelCapabilities.value?.capabilities;
    // Before the capability probe answers, keep the negative prompt visible so
    // users are never silently blocked from a supported field.
    return capability ? capability.negative_prompt : true;
});

const negativePromptReason = computed(() => {
    if (supportsNegativePrompt.value) {
        return "";
    }
    const notes = modelCapabilities.value?.notes || [];
    return notes[0] || "当前模型在蒸馏采样下不使用反向提示词。";
});

// Spatial multiple the backend aligns generation requests to: vae_scale_factor
// times diffusion_model_down_factor. SDXL/UNet families descend by 8 in the VAE
// and another 8 in the UNet; the DiT families keep a down factor of 1 or 2.
// Keeping the request on this grid means the exported mask is never rescaled by
// the backend, so the painted region stays exactly where the user drew it.
const modelMultiple = computed(() => {
    const family = modelCapabilities.value?.model_family || capabilities.value?.model?.family || "";
    if (family === "qwen_image_2_1" || family === "qwen_image") {
        return 32;
    }
    if (family === "z_image") {
        return 16;
    }
    return 64;
});

// Editing is only advertised for the Qwen Image family, and only through its
// native instruction path. The other families have no instruction-driven edit
// support, so the tab stays disabled instead of offering a degraded result.
const editTabSupported = computed(() => {
    const matrix = capabilities.value?.capability_matrix;
    const capability = modelCapabilities.value?.capabilities;
    const editMode = matrix?.edit_mode ?? (capability as { edit_mode?: string } | undefined)?.edit_mode;
    return editMode === "ref_images";
});

const editTabUnsupportedReason = computed(() => {
    const family = modelCapabilities.value?.model_family || capabilities.value?.model?.family || "当前模型";
    return `${family} 不支持指令编辑；仅 Qwen Image 2.1 支持`;
});

const llmAvailable = computed(() => Boolean(promptLlmStatus.value?.available));
const llmReason = computed(() => promptLlmStatus.value?.reason || "");

const imageSlots = computed<ImageSlot[]>(() => {
    const capability = modelCapabilities.value?.capabilities;
    const family = modelCapabilities.value?.model_family || "";
    const referenceSupported = Boolean(capability?.reference_image);
    return [
        {
            id: "character_reference",
            label: "角色参考图",
            description: "提供角色的外观与身份特征。",
            supported: referenceSupported,
            reason: referenceSupported
                ? ""
                : `${family || "当前模型"} 不支持参考图条件；仅 Qwen Image 2.1 在加载视觉编码器后可用。`,
        },
        {
            id: "style_reference",
            label: "风格参考图",
            description: "提供画风参考。",
            supported: false,
            reason: "当前构建没有可用的风格参考编码路径，功能保持禁用。",
        },
        {
            id: "target_image",
            label: "目标画面",
            description: "需要被修改的原图（图生图输入）。",
            supported: Boolean(capability?.img2img),
            reason: capability?.img2img ? "" : "当前模型不支持图生图。",
        },
        {
            id: "edit_region",
            label: "编辑区域",
            description: "指定需要修改的位置。",
            supported: false,
            reason: "局部修改请在「图像编辑」页用圈选或画笔标出目标；这里不再单独上传蒙版。",
        },
        {
            id: "pose_reference",
            label: "姿势参考图",
            description: "提供人物姿势。",
            supported: false,
            reason: "当前构建没有姿势控制模型支持，功能保持禁用。",
        },
        {
            id: "structure_reference",
            label: "结构参考图",
            description: "提供边缘、深度等结构信息。",
            supported: Boolean(capability?.control_net),
            reason: capability?.control_net ? "" : "未加载 ControlNet 模型，结构参考不可用。",
        },
    ];
});
const selectedGenerationTab = ref<"image" | "video">("image");
const generationMode = computed<GenerationMode>(() => selectedGenerationTab.value === "video" ? "video" : "image");
const lightboxOpen = ref(false);
const lightboxImageSrc = ref("");
const lightboxImageAlt = ref("");
const sectionState = reactive<Record<string, boolean>>({
    sample: true,
    sampleAdvanced: false,
    guidance: true,
    guidanceAdvanced: false,
    highNoise: false,
    highNoiseSample: true,
    highNoiseGuidance: true,
    conditioning: false,
    auxiliaryImages: false,
    lora: false,
    vaeTiling: false,
    preview: false,
    cache: false,
});
const loadingCapabilities = ref(false);
const capabilitiesError = ref("");
const serviceOnline = ref(false);
const capabilities = ref<Capabilities | null>(null);
const currentJob = ref<Job | null>(null);
const selectedOutputIndex = ref(0);
const statusMessage = ref("");
const statusTone = ref("");
// Set as soon as the user edits any field, so "刷新服务器信息" knows it must not
// re-apply the server defaults over their work.
const formEdited = ref(false);
const form = reactive<GenerationForm>(createBlankForm());

let pollTimer = 0;
let elapsedTimer = 0;
const nowSeconds = ref(Date.now() / 1000);

const modelName = computed(() => {
    const model = capabilities.value?.model;
    return model?.stem || model?.name || "无模型信息";
});

const supportedModes = computed(() => capabilities.value?.supported_modes || []);
const supportsImageMode = computed(() => {
    return !supportedModes.value.length || supportedModes.value.includes("img_gen");
});
const supportsVideoMode = computed(() => {
    return !supportedModes.value.length || supportedModes.value.includes("vid_gen");
});
const selectedModeKey = computed<"img_gen" | "vid_gen">(() => generationMode.value === "video" ? "vid_gen" : "img_gen");
const currentJobModeKey = computed<"img_gen" | "vid_gen">(() => currentJob.value?.kind || selectedModeKey.value);
const selectedModeFeatures = computed(() => {
    return capabilities.value?.features_by_mode?.[selectedModeKey.value] || {};
});
const currentJobFeatures = computed(() => {
    return capabilities.value?.features_by_mode?.[currentJobModeKey.value] || selectedModeFeatures.value;
});
const imageOutputFormats = computed(() => {
    return capabilities.value?.output_formats_by_mode?.img_gen || ["png", "jpeg"];
});
const videoOutputFormats = computed(() => {
    return capabilities.value?.output_formats_by_mode?.vid_gen || ["webm", "avi"];
});
const outputFormats = computed(() => generationMode.value === "video" ? videoOutputFormats.value : imageOutputFormats.value);
const samplers = computed(() => capabilities.value?.samplers || ["default"]);
const schedulers = computed(() => capabilities.value?.schedulers || ["default"]);
const availableLoras = computed(() => capabilities.value?.loras || []);
const currentImageInputs = computed(() => generationMode.value === "video" ? VIDEO_IMAGE_INPUTS : IMAGE_INPUTS);
const gridImageInputs = computed(() => currentImageInputs.value.filter((input) => input.layout === "grid"));
const fullImageInputs = computed(() => currentImageInputs.value.filter((input) => input.layout === "full"));
const queueLimit = computed(() => capabilities.value?.limits?.max_queue_size ?? "未知");
const canCancelQueued = computed(() => Boolean(currentJobFeatures.value.cancel_queued));
const canCancelGenerating = computed(() => Boolean(currentJobFeatures.value.cancel_generating));
const supportsPreview = computed(() => Boolean(currentJobFeatures.value.preview));
const previewModes = computed(() => capabilities.value?.preview_modes || ["none", "proj", "tae", "vae"]);

const currentStatus = computed(() => currentJob.value?.status || "idle");
const cancelPending = computed(() => Boolean(currentJob.value?.cancel_requested));
// Set when a poll fails while a job was running: the server may be mid-restart,
// so the UI keeps the job and retries instead of freezing on "generating".
const connectionLost = ref(false);
const STATUS_LABELS: Record<string, string> = {
    idle: "空闲",
    queued: "排队中",
    generating: "生成中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
};
const currentStatusLabel = computed(() => {
    if (connectionLost.value) {
        return "连接中断";
    }
    if (cancelPending.value && currentStatus.value === "generating") {
        return "正在取消";
    }
    return STATUS_LABELS[currentStatus.value] || currentStatus.value;
});
const currentJobKind = computed(() => currentJob.value?.kind || null);
const currentImages = computed(() => currentJobKind.value === "img_gen" ? currentJob.value?.result?.images || [] : []);
const selectedImage = computed(() => {
    if (!currentImages.value.length) {
        return null;
    }
    const index = Math.min(selectedOutputIndex.value, currentImages.value.length - 1);
    const image = currentImages.value[index];
    const format = currentJob.value?.result?.output_format || form.output_format || "png";
    return `data:image/${format};base64,${image.b64_json}`;
});
const videoMimeType = computed(() => currentJobKind.value === "vid_gen" ? currentJob.value?.result?.mime_type || "" : "");
const videoFrameCount = computed(() => currentJobKind.value === "vid_gen" ? currentJob.value?.result?.frame_count || 0 : 0);
const videoFps = computed(() => currentJobKind.value === "vid_gen" ? currentJob.value?.result?.fps || 0 : 0);
const videoPreviewSrc = computed(() => {
    if (currentJobKind.value !== "vid_gen" || !currentJob.value?.result?.b64_json) {
        return null;
    }
    if (currentJob.value?.result?.output_format === "avi") {
        return null;
    }
    if (!videoMimeType.value.startsWith("video/")) {
        return null;
    }
    return `data:${videoMimeType.value};base64,${currentJob.value.result.b64_json}`;
});
const animatedVideoImageSrc = computed(() => {
    if (currentJobKind.value !== "vid_gen" || !currentJob.value?.result?.b64_json) {
        return null;
    }
    if (videoMimeType.value !== "image/webp") {
        return null;
    }
    return `data:image/webp;base64,${currentJob.value.result.b64_json}`;
});
const previewImageSrc = computed(() => animatedVideoImageSrc.value || selectedImage.value);
const livePreviewSrc = computed(() => {
    if (currentStatus.value !== "generating" || !currentJob.value?.preview?.b64_json) {
        return null;
    }
    return `data:image/png;base64,${currentJob.value.preview.b64_json}`;
});
const livePreviewPass = computed(() => currentJob.value?.preview?.pass ?? 1);
const livePreviewStep = computed(() => currentJob.value?.preview?.step ?? 0);
const livePreviewTotalSteps = computed(() => currentJob.value?.preview?.total_steps ?? 0);

const progressInfo = computed(() => {
    const progress = currentJob.value?.progress;
    if (progress && progress.total_steps > 0) {
        return progress;
    }
    const preview = currentJob.value?.preview;
    if (preview && preview.total_steps > 0) {
        return {
            pass: preview.pass,
            step: preview.step,
            total_steps: preview.total_steps,
            s_per_it: 0,
        };
    }
    return null;
});
const progressPass = computed(() => progressInfo.value?.pass ?? 0);
const progressStep = computed(() => {
    const info = progressInfo.value;
    if (!info) {
        return 0;
    }
    return Math.min(info.step, info.total_steps);
});
const progressTotalSteps = computed(() => progressInfo.value?.total_steps ?? 0);
const progressSPerIt = computed(() => Number(progressInfo.value?.s_per_it ?? 0));
const progressSpeed = computed(() => {
    const seconds = progressSPerIt.value;
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return "-";
    }
    if (seconds < 1) {
        return `${(1 / seconds).toFixed(2)}it/s`;
    }
    return `${seconds.toFixed(2)}s/it`;
});
const downloadableSrc = computed(() => {
    const result = currentJob.value?.result;
    if (currentJobKind.value === "vid_gen" && result?.b64_json && videoMimeType.value) {
        return `data:${videoMimeType.value};base64,${result.b64_json}`;
    }
    return selectedImage.value;
});

const canCancelCurrentJob = computed(() => {
    if (!currentJob.value || cancelPending.value) {
        return false;
    }
    if (currentStatus.value === "queued") {
        return canCancelQueued.value;
    }
    if (currentStatus.value === "generating") {
        return canCancelGenerating.value;
    }
    return false;
});

const isJobRunning = computed(() => {
    return currentStatus.value === "queued" || currentStatus.value === "generating";
});

function optionLabel(value: string): string {
    return value === "default" ? "默认" : value;
}

function buildSampleSummary(sample: SampleParams): string {
    const scheduler = optionLabel(sample.scheduler || "default");
    const method = optionLabel(sample.sample_method || "default");
    const steps = sample.sample_steps || 0;
    const flowShift = sample.flow_shift === "" || sample.flow_shift == null
        ? "偏移 自动"
        : `偏移 ${sample.flow_shift}`;
    return `${scheduler} · ${flowShift} · ${method} · ${steps} 步`;
}

function buildGuidanceSummary(sample: SampleParams): string {
    const cfg = sample.guidance.txt_cfg;
    const distilled = sample.guidance.distilled_guidance;
    return `CFG ${cfg} · 蒸馏 ${distilled}`;
}

const sampleSummary = computed(() => buildSampleSummary(form.sample_params));
const guidanceSummary = computed(() => buildGuidanceSummary(form.sample_params));
const highNoiseSummary = computed(() => {
    return `MoE ${formatSummaryNumber(form.moe_boundary)} · ${buildSampleSummary(form.high_noise_sample_params)} · ${buildGuidanceSummary(form.high_noise_sample_params)}`;
});
const loraSummary = computed(() => {
    if (!form.lora.length) {
        return "未使用 LoRA";
    }
    return `已配置 ${form.lora.length} 个`;
});
const imageInputsSummary = computed(() => {
    const parts: string[] = [];
    if (form.init_image) parts.push(generationMode.value === "video" ? "起始帧" : "初始图像");
    if (generationMode.value === "image") {
        if (form.control_image) parts.push("控制图");
        if (form.ref_images.length) parts.push(`${form.ref_images.length} 张参考图`);
    } else {
        if (form.end_image) parts.push("结束帧");
        if (form.ref_images.length) parts.push(`${form.ref_images.length} 张参考图`);
        if (form.control_frames.length) parts.push(`${form.control_frames.length} 帧控制帧`);
    }
    return parts.length ? parts.join(" · ") : "未选择图像";
});
const vaeTilingSummary = computed(() => {
    if (!form.vae_tiling_params.enabled) {
        return "已禁用";
    }
    return `${form.vae_tiling_params.tile_size_w}×${form.vae_tiling_params.tile_size_h} · 重叠 ${form.vae_tiling_params.target_overlap}`;
});
const cacheSummary = computed(() => {
    const mode = form.cache.mode || "disabled";
    if (mode === "disabled") {
        return "已禁用";
    }
    const option = String(form.cache.option || "").trim();
    return option ? `${mode} · ${option}` : mode;
});
const conditioningSummary = computed(() => {
    const clipSkip = formatSummaryNumber(form.clip_skip, 0);
    const strength = formatSummaryNumber(form.strength);
    if (generationMode.value === "video") {
        return `CLIP Skip ${clipSkip} · 强度 ${strength} · VACE ${formatSummaryNumber(form.vace_strength)}`;
    }
    const controlStrength = formatSummaryNumber(form.control_strength);
    return `CLIP Skip ${clipSkip} · 图像强度 ${strength} · 控制强度 ${controlStrength}`;
});

function defaultOutputFormatForMode(mode: GenerationMode): string {
    if (mode === "video") {
        return videoOutputFormats.value[0] || "webm";
    }
    return imageOutputFormats.value[0] || "png";
}

function ensureOutputFormatForMode(mode = generationMode.value): void {
    const validFormats = mode === "video" ? videoOutputFormats.value : imageOutputFormats.value;
    if (!validFormats.length) {
        return;
    }
    if (!validFormats.includes(form.output_format)) {
        form.output_format = defaultOutputFormatForMode(mode);
    }
}

function setMessage(message: string, tone = ""): void {
    statusMessage.value = message;
    statusTone.value = tone;
}

function clearMessage(): void {
    setMessage("", "");
}

function deepAssign(target: Record<string, any>, ...sources: Record<string, any>[]): Record<string, any> {
    for (const source of sources) {
        if (!source) continue;
        for (const key of Object.keys(source)) {
            const sv = source[key];
            if (sv !== null && typeof sv === "object" && !Array.isArray(sv) &&
                target[key] !== null && typeof target[key] === "object" && !Array.isArray(target[key])) {
                deepAssign(target[key], sv);
            } else {
                target[key] = sv;
            }
        }
    }
    return target;
}

function applyForm(nextForm: GenerationForm): void {
    const wasEdited = formEdited.value;
    deepAssign(form, createBlankForm(), nextForm);
    // Adopting server defaults is not a user edit; the deep watcher fires async,
    // so re-assert the previous flag after the assignment settles.
    if (!wasEdited) {
        formEdited.value = false;
        window.setTimeout(() => {
            formEdited.value = false;
        }, 0);
    }
}

async function refreshModelCapabilities(): Promise<void> {
    try {
        modelCapabilities.value = await getModelCapabilities(baseUrl.value);
    } catch {
        modelCapabilities.value = null;
    }
}

async function refreshPromptLlmStatus(): Promise<void> {
    try {
        promptLlmStatus.value = await getPromptLlmStatus(baseUrl.value);
    } catch {
        promptLlmStatus.value = null;
    }
}

async function refreshCapabilities(options: { resetTaskState?: boolean } = {}): Promise<void> {
    if (options.resetTaskState) {
        resetTaskState();
    }
    loadingCapabilities.value = true;
    capabilitiesError.value = "";
    try {
        const response = await getCapabilities(baseUrl.value);
        capabilities.value = response;
        serviceOnline.value = true;
        // The refresh button must not wipe the user's work: only adopt the new
        // defaults when the form still holds the previous defaults.
        const nextForm = formFromCapabilities(response);
        if (!formEdited.value) {
            applyForm(nextForm);
        }
        if (selectedGenerationTab.value === "image" && !supportsImageMode.value && supportsVideoMode.value) {
            selectedGenerationTab.value = "video";
        } else if (selectedGenerationTab.value === "video" && !supportsVideoMode.value && supportsImageMode.value) {
            selectedGenerationTab.value = "image";
        }
        if (activeTab.value === "image" && !supportsImageMode.value && supportsVideoMode.value) {
            activeTab.value = "video";
        } else if (activeTab.value === "video" && !supportsVideoMode.value && supportsImageMode.value) {
            activeTab.value = "image";
        }
        ensureOutputFormatForMode();
        await Promise.all([refreshModelCapabilities(), refreshPromptLlmStatus()]);
        clearMessage();
        // The server is authoritative about what is running: re-attach so a job
        // started before a reload (or before a dropped connection) reappears.
        const attached = await restoreActiveJob();
        if (attached) {
            setMessage("已重新接入服务器上正在运行的任务。", "success");
        }
    } catch (error) {
        capabilitiesError.value = error instanceof Error ? error.message : String(error);
        serviceOnline.value = false;
        setMessage(capabilitiesError.value, "error");
    } finally {
        loadingCapabilities.value = false;
    }
}

function resetTaskState(): void {
    stopPolling();
    stopElapsedTimer();
    currentJob.value = null;
    selectedOutputIndex.value = 0;
    activeJobId.value = "";
    connectionLost.value = false;
    nowSeconds.value = Date.now() / 1000;
}

function toggleSection(section: string): void {
    sectionState[section] = !sectionState[section];
}

function applyAssistantPrompt(payload: { positive: string; negative: string }): void {
    form.prompt = payload.positive;
    form.negative_prompt = payload.negative;
    setMessage("提示词已填入生成表单，确认无误后点击生成。", "success");
}

function reuseHistoryEntry(payload: { prompt: string; negative: string; seed: number; width: number; height: number }): void {
    form.prompt = payload.prompt;
    form.negative_prompt = payload.negative;
    if (payload.seed >= 0) {
        form.seed = payload.seed;
    }
    if (payload.width > 0 && payload.height > 0) {
        form.width = payload.width;
        form.height = payload.height;
    }
    activeTab.value = "image";
    setMessage("已复用历史参数，可直接再次生成。", "success");
}

function selectGenerationMode(mode: GenerationMode): void {
    if (mode === "image" && !supportsImageMode.value) {
        setMessage("当前模型仅支持视频生成。", "error");
        return;
    }
    if (mode === "video" && !supportsVideoMode.value) {
        setMessage("当前模型仅支持图像生成。", "error");
        return;
    }
    selectedGenerationTab.value = mode;
    activeTab.value = mode;
    ensureOutputFormatForMode(mode);
}

function stopPolling(): void {
    if (pollTimer) {
        window.clearTimeout(pollTimer);
        pollTimer = 0;
    }
}

function stopElapsedTimer(): void {
    if (elapsedTimer) {
        window.clearInterval(elapsedTimer);
        elapsedTimer = 0;
    }
}

function startElapsedTimer(): void {
    stopElapsedTimer();
    nowSeconds.value = Date.now() / 1000;
    elapsedTimer = window.setInterval(() => {
        nowSeconds.value = Date.now() / 1000;
    }, 100);
}

function isTerminalStatus(status: string): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
}

async function pollJob(id: string): Promise<void> {
    stopPolling();
    try {
        currentJob.value = await getJob(baseUrl.value, id);
        serviceOnline.value = true;
        connectionLost.value = false;
        if (currentStatus.value === "queued" || currentStatus.value === "generating") {
            activeJobId.value = id;
            pollTimer = window.setTimeout(() => pollJob(id), normalizePollIntervalMs(pollIntervalMs.value));
            clearMessage();
            return;
        }
        stopElapsedTimer();
        activeJobId.value = "";
        if (currentStatus.value === "completed") {
            setMessage(currentJob.value?.kind === "vid_gen" ? "视频生成完成。" : "图像生成完成。", "success");
            return;
        }
        if (currentStatus.value === "cancelled") {
            setMessage("任务已取消。", "error");
            return;
        }
        if (currentStatus.value === "failed") {
            setMessage(currentJob.value?.error?.message || "生成失败。", "error");
        }
    } catch (error) {
        // A dead connection is not the end of the job: the server keeps sampling
        // and only the browser lost the socket. Keep the job id, flag the state,
        // and keep retrying so the UI recovers on its own once the server is back.
        serviceOnline.value = false;
        connectionLost.value = true;
        const message = error instanceof Error ? error.message : String(error);
        if (/not found|expired|404|410/i.test(message)) {
            currentJob.value = null;
            activeJobId.value = "";
            stopElapsedTimer();
            setMessage("服务器上找不到该任务，可能已被清理。", "error");
            return;
        }
        setMessage("与服务器的连接中断，正在重试…", "error");
        pollTimer = window.setTimeout(() => pollJob(id), Math.max(1000, normalizePollIntervalMs(pollIntervalMs.value)));
    }
}

// Re-attach to a job after a reload (F5) or a dropped connection. The server is
// the source of truth: the page only stores the id.
async function restoreActiveJob(): Promise<boolean> {
    const storedId = activeJobId.value;
    if (storedId) {
        try {
            const job = await getJob(baseUrl.value, storedId);
            currentJob.value = job;
            serviceOnline.value = true;
            connectionLost.value = false;
            if (!isTerminalStatus(job.status)) {
                startElapsedTimer();
                await pollJob(storedId);
                return true;
            }
            activeJobId.value = "";
            return false;
        } catch {
            activeJobId.value = "";
        }
    }
    try {
        const { jobs } = await listJobs(baseUrl.value);
        const running = jobs.find((job) => !isTerminalStatus(job.status));
        if (!running) {
            return false;
        }
        currentJob.value = running;
        activeJobId.value = running.id;
        serviceOnline.value = true;
        connectionLost.value = false;
        startElapsedTimer();
        await pollJob(running.id);
        return true;
    } catch {
        return false;
    }
}

async function generate(): Promise<void> {
    try {
        const request = buildRequestBodyForMode(generationMode.value, form);
        clearMessage();
        selectedOutputIndex.value = 0;
        startElapsedTimer();
        connectionLost.value = false;
        currentJob.value = generationMode.value === "video"
            ? await submitVideoJob(baseUrl.value, request)
            : await submitImageJob(baseUrl.value, request);
        activeJobId.value = currentJob.value.id;
        await pollJob(currentJob.value.id);
    } catch (error) {
        stopElapsedTimer();
        setMessage(error instanceof Error ? error.message : String(error), "error");
    }
}

async function cancelCurrentJob(): Promise<void> {
    if (!currentJob.value?.id) {
        return;
    }
    const id = currentJob.value.id;
    try {
        currentJob.value = await cancelJob(baseUrl.value, id);
        serviceOnline.value = true;
        if (isTerminalStatus(currentJob.value.status)) {
            stopPolling();
            stopElapsedTimer();
            activeJobId.value = "";
            setMessage("任务已取消。", "error");
            return;
        }
        // Still sampling: the server latched the flag and will stop at the next
        // denoise step. Keep polling so the badge can follow it to "已取消".
        setMessage("已请求取消，正在等待采样停止…", "error");
        if (!pollTimer) {
            await pollJob(id);
        }
    } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error), "error");
    }
}

function addLora(): void {
    form.lora.push({
        path: availableLoras.value[0]?.path || "",
        multiplier: 1,
        is_high_noise: false,
    });
}

function removeLora(index: number): void {
    form.lora.splice(index, 1);
}

async function assignImages(target: ImageTarget, files: FileList): Promise<void> {
    const images = await filesToImageEntries(files);
    if (!images.length) {
        return;
    }
    assignImageEntries(form, target, images);
}

function clearImage(target: ImageTarget): void {
    clearImageEntries(form, target);
}

function getFormImage(target: ImageTarget): ImageEntry | null {
    if (target === "ref_images" || target === "control_frames") return null;
    return form[target];
}

function openImageEntry(image: ImageEntry | null): void {
    openLightbox(image?.dataUrl, image?.name);
}

function removeCollectionImage(target: "ref_images" | "control_frames", index: number): void {
    removeImageEntry(form, target, index);
}

function selectOutput(index: number): void {
    selectedOutputIndex.value = index;
}

function formatUnixTime(seconds: number | undefined): string {
    if (!seconds) {
        return "无任务";
    }
    return new Date(seconds * 1000).toLocaleString();
}

function formatElapsed(started: number | undefined, completed: number | undefined): string {
    if (!started) {
        return "空闲";
    }
    const end = completed || nowSeconds.value;
    const total = Math.max(0, end - started);
    if (total < 60) {
        return `${total.toFixed(1)}秒`;
    }
    const minutes = Math.floor(total / 60);
    const seconds = total - minutes * 60;
    return `${minutes}分 ${seconds.toFixed(1)}秒`;
}

function formatSummaryNumber(value: number, digits = 3): string {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) {
        return "0";
    }
    return Number(numeric.toFixed(digits)).toString();
}

function downloadSelected(): void {
    if (!downloadableSrc.value) {
        return;
    }
    const link = document.createElement("a");
    link.href = downloadableSrc.value;
    link.download = `${currentJob.value?.id || "output"}.${currentJob.value?.result?.output_format || form.output_format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function openLightbox(src: string | null | undefined = previewImageSrc.value, alt = "放大查看"): void {
    if (!src) {
        return;
    }
    lightboxImageSrc.value = src;
    lightboxImageAlt.value = alt;
    lightboxOpen.value = true;
}

function closeLightbox(): void {
    lightboxOpen.value = false;
    lightboxImageSrc.value = "";
    lightboxImageAlt.value = "";
}

async function onPaste(event: ClipboardEvent): Promise<void> {
    if (!event.clipboardData?.files?.length) {
        return;
    }
    await assignImages("init_image", event.clipboardData.files);
    setMessage("已粘贴图像到初始图像。", "success");
}

watch(form, () => {
    formEdited.value = true;
}, { deep: true });

watch(generationMode, (mode) => {
    ensureOutputFormatForMode(mode);
});

watch(imageOutputFormats, () => {
    ensureOutputFormatForMode();
});

watch(videoOutputFormats, () => {
    ensureOutputFormatForMode();
});

onMounted(() => {
    window.addEventListener("paste", onPaste);
    void refreshCapabilities();
});

onBeforeUnmount(() => {
    stopPolling();
    stopElapsedTimer();
    window.removeEventListener("paste", onPaste);
});
</script>

<template>
    <div class="shell">
        <header class="page-header panel">
            <div class="page-header__top">
                <div class="page-header__copy">
                    <div class="breadcrumb">
                        <span class="breadcrumb__org">stable-diffusion.cpp</span>
                        <span class="breadcrumb__slash">/</span>
                        <span>{{ modelName }}</span>
                    </div>
                    <h1 class="page-title">{{ modelName }}</h1>
                    <p class="page-description">
                        本地 `stable-diffusion.cpp` 服务器的原生异步图像和视频生成界面。
                    </p>
                    <div class="model-info">
                        <StatusChip :label="`模型族 ${modelCapabilities?.model_family || '未知'}`" title="当前加载模型的提示词风格与能力分族" />
                        <StatusChip :label="`版本 ${modelCapabilities?.model_version || '-'}`" title="服务器识别出的模型版本" />
                        <StatusChip
                            :status="llmAvailable ? 'online' : 'offline'"
                            :label="llmAvailable ? '提示词助手：智能模式可用' : '提示词助手：仅快速模式'"
                            :title="llmAvailable ? 'Qwen3-VL 可在需要时按需加载' : llmReason || '语言模型不可用，快速模式仍然可用'"
                        />
                    </div>
                </div>
                <div class="page-header__meta">
                    <StatusChip :status="serviceOnline ? 'online' : 'offline'" :label="serviceOnline ? '服务在线' : '服务离线'" title="服务器连接状态" />
                    <StatusChip :label="`队列上限 ${queueLimit}`" title="服务器允许同时排队的任务数量" />
                    <StatusChip :status="currentStatus" :label="currentStatusLabel" :title="connectionLost ? '与服务器的连接已中断，正在自动重试；任务可能仍在服务器上运行' : '当前任务状态'" />
                </div>
            </div>
            <div class="page-tabs">
                <div class="page-tabs__list">
                    <button class="page-tab" :class="{ 'page-tab--active': activeTab === 'image' }" type="button" title="使用扩散模型生成静态图像" @click="selectGenerationMode('image')" :disabled="!supportsImageMode">图像生成</button>
                    <button class="page-tab" :class="{ 'page-tab--active': activeTab === 'video' }" type="button" title="使用视频模型生成视频序列" @click="selectGenerationMode('video')" :disabled="!supportsVideoMode">视频生成</button>
                    <button class="page-tab" :class="{ 'page-tab--active': activeTab === 'edit' }" type="button" :disabled="!editTabSupported" :title="editTabSupported ? '给参考图并用一句话描述要做的修改，或圈选、涂抹局部区域后重绘' : editTabUnsupportedReason" @click="activeTab = 'edit'">图像编辑</button>
                    <button class="page-tab" :class="{ 'page-tab--active': activeTab === 'history' }" type="button" title="查看输出目录中的历史生成结果，并复用其提示词与参数" @click="activeTab = 'history'">生成历史</button>
                    <button class="page-tab" :class="{ 'page-tab--active': activeTab === 'slots' }" type="button" title="按用途命名的图片上传槽位；当前模型不支持的能力保持禁用" @click="activeTab = 'slots'">图片槽位</button>
                    <button class="page-tab" :class="{ 'page-tab--active': activeTab === 'settings' }" type="button" title="配置服务器连接、输出格式和轮询间隔" @click="activeTab = 'settings'">设置</button>
                </div>
                <div class="page-tabs__actions">
                    <button class="btn-secondary" type="button" title="重新读取服务器能力、模型信息和可用选项" @click="refreshCapabilities({ resetTaskState: true })" :disabled="loadingCapabilities">{{ loadingCapabilities ? "刷新中..." : "刷新服务器信息" }}</button>
                </div>
            </div>
            <div v-if="activeTab === 'settings'" class="settings">
                <div class="settings__grid">
                    <div class="field">
                        <label>基础 URL<InfoTip text="服务器地址，例如 http://192.168.1.10:7860；留空表示使用当前页面同源地址。" /></label>
                        <input v-model="baseUrl" placeholder="留空则使用同源地址" />
                    </div>
                    <div class="field">
                        <label>队列限制<InfoTip text="服务器允许同时排队的任务数量上限，由服务器配置决定，只读。" /></label>
                        <input :value="queueLimit" readonly />
                    </div>
                    <div class="field">
                        <label>可用输出格式（{{ generationMode === "video" ? "视频" : "图像" }}）<InfoTip text="当前模型与服务器支持的全部输出格式，只读。" /></label>
                        <input :value="outputFormats.join(', ')" readonly />
                    </div>
                    <div class="field">
                        <label>输出格式<InfoTip text="生成结果使用的文件格式。图像常用 PNG（无损）或 JPEG（体积小）；视频常用 WebM、AVI 或动态 WebP。" /></label>
                        <select v-model="form.output_format">
                            <option v-for="format in outputFormats" :key="format" :value="format">{{ format }}</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>输出压缩质量<InfoTip text="0–100，数值越高画质越好、文件越大；对 PNG 等无损格式通常无效。" /></label>
                        <input v-model.number="form.output_compression" type="number" min="0" max="100" />
                    </div>
                    <div class="field">
                        <label>任务轮询间隔（毫秒）<InfoTip text="查询任务状态的间隔。数值越小界面更新越快，但请求越频繁。" /></label>
                        <input v-model.number="pollIntervalMs" type="number" min="1" step="1" />
                    </div>
                </div>
                <div v-if="capabilitiesError" class="status-message status-message--error">{{ capabilitiesError }}</div>
            </div>
        </header>

        <div v-if="activeTab === 'history'" class="layout layout--single">
            <HistoryPanel ref="historyPanel" :base-url="baseUrl" @reuse="reuseHistoryEntry" />
        </div>

        <MaskedEditPanel
            v-else-if="activeTab === 'edit'"
            :base-url="baseUrl"
            :model-family="modelCapabilities?.model_family || capabilities?.model?.family || ''"
            :model-multiple="modelMultiple"
            :edit-defaults="capabilities?.edit_defaults || null"
            :max-ref-images="capabilities?.capability_matrix?.max_ref_images ?? 10"
            :supports-alpha="Boolean(capabilities?.capability_matrix?.supports_alpha)"
            :defaults="form"
            :supports-negative-prompt="supportsNegativePrompt"
            :negative-prompt-reason="negativePromptReason"
            :llm-available="llmAvailable"
            :llm-reason="llmReason"
            :available-loras="availableLoras"
            :initial-loras="form.lora"
            @notify="setMessage($event.message, $event.tone)"
        />
        <div v-else-if="activeTab === 'slots'" class="layout layout--single">
            <ImageSlotPicker :slots="imageSlots" @pick="() => setMessage('该槽位尚未接入推理路径，暂不可用。', 'error')" />
        </div>

        <div v-else-if="activeTab !== 'settings'" class="layout">
            <section class="panel control-panel">
                <div class="panel-header">
                    <div>
                        <h2 class="panel-title">输入</h2>
                    </div>
                </div>

                <PromptAssistant
                    v-if="activeTab !== 'video'"
                    class="stack-top"
                    :base-url="baseUrl"
                    :model-family="modelCapabilities?.model_family || ''"
                    :supports-negative-prompt="supportsNegativePrompt"
                    :negative-prompt-reason="negativePromptReason"
                    :llm-available="llmAvailable"
                    :llm-reason="llmReason"
                    @apply="applyAssistantPrompt"
                />

                <div class="prompt-card stack-top">
                    <div class="field--full">
                        <label>提示词<InfoTip text="描述想要生成的画面、主体、风格、构图和细节。支持中英文；提示词越具体，结果通常越可控。" /></label>
                        <textarea v-model="form.prompt" :placeholder="generationMode === 'video' ? '描述您想要生成的动作、场景和构图' : '描述您想要生成的图像'" />
                    </div>
                    <div v-if="supportsNegativePrompt" class="field--full stack-top">
                        <label>反向提示词<InfoTip text="不希望出现在结果中的内容，例如模糊、低质量、多余肢体、文字水印等。" /></label>
                        <textarea v-model="form.negative_prompt" placeholder="不想要的内容?" />
                    </div>
                    <div v-else class="hint stack-top">{{ negativePromptReason }}</div>
                </div>

                <div class="fields stack-top">
                    <div class="field"><label>宽度<InfoTip text="输出图像的宽度（像素）。越大细节越多，但生成更慢、占用显存更高。" /></label><input v-model.number="form.width" type="number" min="64" /></div>
                    <div class="field"><label>高度<InfoTip text="输出图像的高度（像素）。建议使用模型训练时常用的分辨率。" /></label><input v-model.number="form.height" type="number" min="64" /></div>
                </div>

                <div v-if="generationMode === 'image'" class="fields stack-top">
                    <div class="field"><label>批次数量<InfoTip text="一次生成多少张图像。数量越多耗时越长，也会增加显存占用。" /></label><input v-model.number="form.batch_count" type="number" min="1" /></div>
                    <div class="field"><label>种子<InfoTip text="随机种子。相同的种子和参数可以复现相同结果；-1 表示每次随机。" /></label><input v-model.number="form.seed" type="number" /></div>
                </div>
                <div v-else class="fields stack-top">
                    <div class="field"><label>视频帧数<InfoTip text="生成视频的总帧数，帧数越多视频越长，同时占用更多显存和时间。" /></label><input v-model.number="form.video_frames" type="number" min="1" /></div>
                    <div class="field"><label>帧率（FPS）<InfoTip text="视频每秒播放的帧数。常见为 8–24；帧率越高播放越流畅。" /></label><input v-model.number="form.fps" type="number" min="1" /></div>
                </div>
                <div v-if="generationMode === 'video'" class="field stack-top">
                    <label>种子<InfoTip text="随机种子。相同的种子和参数可以复现相同视频；-1 表示每次随机。" /></label>
                    <input v-model.number="form.seed" type="number" />
                </div>

                <CollapsibleSection class="stack-top" eyebrow="采样" tip="控制去噪采样算法、步数和时间步偏移；直接影响细节、速度与稳定性。" :summary="sampleSummary" :open="sectionState.sample" variant="module" @toggle="toggleSection('sample')">
                    <div class="fields">
                        <div class="field">
                            <label>调度器<InfoTip text="噪声/时间步的下降策略（discrete、karras、exponential 等）。不同调度器会影响细节与稳定性。" /></label>
                            <select v-model="form.sample_params.scheduler">
                                <option value="default">默认</option>
                                <option v-for="scheduler in schedulers" :key="scheduler" :value="scheduler">{{ scheduler }}</option>
                            </select>
                        </div>
                        <div class="field"><label>Flow Shift（流偏移）<InfoTip text="Flow 模型的时间步偏移。数值越大越偏向低噪声细节；留空使用模型默认值。" /></label><input v-model="form.sample_params.flow_shift" type="number" step="0.01" placeholder="留空 = 默认" /></div>
                        <div class="field">
                            <label>采样方法<InfoTip text="去噪采样算法（euler、euler_a、dpm++2m 等）。影响生成速度、细节和稳定性。" /></label>
                            <select v-model="form.sample_params.sample_method">
                                <option value="default">默认</option>
                                <option v-for="sampler in samplers" :key="sampler" :value="sampler">{{ sampler }}</option>
                            </select>
                        </div>
                        <div class="field"><label>步数<InfoTip text="采样迭代次数。步数越多通常细节越好，但生成更慢。" /></label><input v-model.number="form.sample_params.sample_steps" type="number" /></div>
                    </div>
                    <div class="sample-panel__extras">
                        <button class="module-card__link" type="button" @click="toggleSection('sampleAdvanced')">
                            {{ sectionState.sampleAdvanced ? "隐藏高级" : "显示高级" }}
                        </button>
                    </div>
                    <div v-if="sectionState.sampleAdvanced" class="fields">
                        <div class="field"><label>Eta（随机强度）<InfoTip text="随机采样的噪声强度，仅部分采样器有效。0 更确定，1 更随机。" /></label><input v-model="form.sample_params.eta" type="number" step="0.01" placeholder="留空 = 默认" /></div>
                        <div class="field"><label>时间步偏移<InfoTip text="整体平移采样时间步，用于微调风格和细节；0 表示不偏移。" /></label><input v-model.number="form.sample_params.shifted_timestep" type="number" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="引导" tip="控制文本提示词与图像条件对生成结果的引导强度。" :summary="guidanceSummary" :open="sectionState.guidance" variant="module" @toggle="toggleSection('guidance')">
                    <div class="fields">
                        <div class="field"><label>CFG 引导<InfoTip text="提示词引导强度（CFG Scale）。数值越高越贴合提示词，但过高可能导致过饱和或画面崩坏。" /></label><input v-model.number="form.sample_params.guidance.txt_cfg" type="number" step="0.1" /></div>
                        <div class="field"><label>蒸馏引导<InfoTip text="蒸馏模型（如 FLUX）的引导强度，通常 3.5 左右；具体取决于模型。" /></label><input v-model.number="form.sample_params.guidance.distilled_guidance" type="number" step="0.1" /></div>
                    </div>
                    <div class="sample-panel__extras">
                        <button class="module-card__link" type="button" @click="toggleSection('guidanceAdvanced')">
                            {{ sectionState.guidanceAdvanced ? "隐藏高级" : "显示高级" }}
                        </button>
                    </div>
                    <div v-if="sectionState.guidanceAdvanced" class="fields">
                        <div class="field"><label>图像 CFG<InfoTip text="图生图/编辑时的图像引导强度（Image CFG）；留空则跟随文本 CFG。" /></label><input v-model="form.sample_params.guidance.img_cfg" type="number" step="0.1" placeholder="留空 = 跟随文本 CFG" /></div>
                        <div class="field"><label>SLG 层<InfoTip text="Skip Layer Guidance 使用的层编号，逗号分隔，例如 7,8,9。" /></label><input v-model="form.sample_params.guidance.slg_layers" placeholder="7,8,9" /></div>
                        <div class="field"><label>SLG 层开始<InfoTip text="SLG 开始生效的时间步比例，范围 0–1。" /></label><input v-model.number="form.sample_params.guidance.layer_start" type="number" step="0.01" /></div>
                        <div class="field"><label>SLG 层结束<InfoTip text="SLG 停止生效的时间步比例，范围 0–1。" /></label><input v-model.number="form.sample_params.guidance.layer_end" type="number" step="0.01" /></div>
                        <div class="field"><label>SLG 缩放<InfoTip text="SLG 引导强度；0 表示禁用。" /></label><input v-model.number="form.sample_params.guidance.scale" type="number" step="0.01" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection v-if="generationMode === 'video'" class="stack-top" eyebrow="高噪声通过" tip="Wan2.2 等 MoE 视频模型在高噪声阶段使用的独立采样与引导参数。" :summary="highNoiseSummary" :open="sectionState.highNoise" variant="module" @toggle="toggleSection('highNoise')">
                    <div class="field">
                        <label>MoE 边界<InfoTip text="高噪声与低噪声模型切换的时间步边界，范围 0–1；仅对 MoE 模型有效。" /></label>
                        <input v-model.number="form.moe_boundary" type="number" step="0.001" />
                    </div>
                    <CollapsibleSection eyebrow="采样" tip="高噪声阶段使用的采样算法与步数。" :summary="buildSampleSummary(form.high_noise_sample_params)" :open="sectionState.highNoiseSample" variant="plain" @toggle="toggleSection('highNoiseSample')">
                        <div class="fields">
                            <div class="field">
                                <label>调度器<InfoTip text="高噪声阶段的时间步下降策略。" /></label>
                                <select v-model="form.high_noise_sample_params.scheduler">
                                    <option value="default">默认</option>
                                    <option v-for="scheduler in schedulers" :key="`high-noise-${scheduler}`" :value="scheduler">{{ scheduler }}</option>
                                </select>
                            </div>
                            <div class="field"><label>Flow Shift（流偏移）<InfoTip text="高噪声阶段的 Flow 时间步偏移；留空使用默认值。" /></label><input v-model="form.high_noise_sample_params.flow_shift" type="number" step="0.01" placeholder="留空 = 默认" /></div>
                            <div class="field">
                                <label>采样方法<InfoTip text="高噪声阶段的去噪采样算法。" /></label>
                                <select v-model="form.high_noise_sample_params.sample_method">
                                    <option value="default">默认</option>
                                    <option v-for="sampler in samplers" :key="`high-noise-${sampler}`" :value="sampler">{{ sampler }}</option>
                                </select>
                            </div>
                            <div class="field"><label>步数<InfoTip text="高噪声阶段的采样步数。" /></label><input v-model.number="form.high_noise_sample_params.sample_steps" type="number" /></div>
                            <div class="field"><label>Eta（随机强度）<InfoTip text="高噪声阶段的随机采样强度；留空自动选择。" /></label><input v-model="form.high_noise_sample_params.eta" type="number" step="0.01" placeholder="留空 = 自动" /></div>
                            <div class="field"><label>时间步偏移<InfoTip text="高噪声阶段的时间步平移量。" /></label><input v-model.number="form.high_noise_sample_params.shifted_timestep" type="number" /></div>
                        </div>
                    </CollapsibleSection>
                    <CollapsibleSection class="stack-top" eyebrow="引导" tip="高噪声阶段的文本与图像引导强度。" :summary="buildGuidanceSummary(form.high_noise_sample_params)" :open="sectionState.highNoiseGuidance" variant="plain" @toggle="toggleSection('highNoiseGuidance')">
                        <div class="fields">
                            <div class="field"><label>CFG 引导<InfoTip text="高噪声阶段的提示词引导强度（CFG Scale）。" /></label><input v-model.number="form.high_noise_sample_params.guidance.txt_cfg" type="number" step="0.1" /></div>
                            <div class="field"><label>蒸馏引导<InfoTip text="高噪声阶段的蒸馏引导强度。" /></label><input v-model.number="form.high_noise_sample_params.guidance.distilled_guidance" type="number" step="0.1" /></div>
                            <div class="field"><label>图像 CFG<InfoTip text="高噪声阶段的图像引导强度（Image CFG）；留空跟随文本 CFG。" /></label><input v-model="form.high_noise_sample_params.guidance.img_cfg" type="number" step="0.1" placeholder="留空 = 跟随文本 CFG" /></div>
                            <div class="field"><label>SLG 层<InfoTip text="高噪声阶段 SLG 使用的层编号，逗号分隔。" /></label><input v-model="form.high_noise_sample_params.guidance.slg_layers" placeholder="7,8,9" /></div>
                            <div class="field"><label>SLG 层开始<InfoTip text="高噪声阶段 SLG 开始生效的时间步比例。" /></label><input v-model.number="form.high_noise_sample_params.guidance.layer_start" type="number" step="0.01" /></div>
                            <div class="field"><label>SLG 层结束<InfoTip text="高噪声阶段 SLG 停止生效的时间步比例。" /></label><input v-model.number="form.high_noise_sample_params.guidance.layer_end" type="number" step="0.01" /></div>
                            <div class="field"><label>SLG 缩放<InfoTip text="高噪声阶段的 SLG 引导强度。" /></label><input v-model.number="form.high_noise_sample_params.guidance.scale" type="number" step="0.01" /></div>
                        </div>
                    </CollapsibleSection>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="条件控制" tip="控制 CLIP 跳过层、图生图强度、ControlNet 控制强度与 VACE 视频控制强度。" :summary="conditioningSummary" :open="sectionState.conditioning" @toggle="toggleSection('conditioning')">
                    <div class="fields">
                        <div class="field"><label>CLIP 跳过层<InfoTip text="跳过 CLIP 的最后若干层（CLIP Skip）。1 表示不跳过，2 表示跳过一层；不同模型常用值不同。" /></label><input v-model.number="form.clip_skip" type="number" /></div>
                        <div class="field"><label>强度<InfoTip text="图生图/重绘强度。数值越大，结果与原图差异越明显。" /></label><input v-model.number="form.strength" type="number" step="0.01" /></div>
                        <div v-if="generationMode === 'image'" class="field"><label>控制强度<InfoTip text="ControlNet 等控制模型的影响强度；越高越严格遵循控制图。" /></label><input v-model.number="form.control_strength" type="number" step="0.01" /></div>
                        <div v-if="generationMode === 'video'" class="field"><label>VACE 强度<InfoTip text="VACE 视频控制的影响强度；越高越严格遵循控制序列。" /></label><input v-model.number="form.vace_strength" type="number" step="0.01" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="LoRA" tip="加载并调节 LoRA 适配器；可分别控制权重以及是否只作用于高噪声阶段。" :summary="loraSummary" :open="sectionState.lora" @toggle="toggleSection('lora')">
                    <div v-if="!availableLoras.length" class="hint">服务器未返回 LoRA 条目。</div>
                    <div v-else-if="!form.lora.length" class="hint">未配置 LoRA 覆盖。</div>
                    <div v-else class="list-editor">
                        <div class="list-row list-row--header">
                            <div>LoRA<InfoTip text="选择要应用的 LoRA 模型文件。" :focusable="false" /></div>
                            <div>权重<InfoTip text="LoRA 影响强度，1.0 表示模型原始强度。" :focusable="false" /></div>
                            <div>高噪声<InfoTip text="仅对 Wan2.2 等 MoE 模型有效：勾选后只在高噪声阶段应用该 LoRA。" :focusable="false" /></div>
                            <div></div>
                        </div>
                        <div v-for="(item, index) in form.lora" :key="index" class="list-row">
                            <select v-model="item.path">
                                <option v-for="lora in availableLoras" :key="lora.path" :value="lora.path">
                                    {{ lora.name }} ({{ lora.path }})
                                </option>
                            </select>
                            <input v-model.number="item.multiplier" type="number" step="0.1" title="LoRA 权重，1.0 为原始强度" />
                            <label class="checkbox list-row__checkbox" title="仅在高噪声阶段应用该 LoRA（MoE 模型）">
                                <input v-model="item.is_high_noise" type="checkbox" />
                                <span>{{ item.is_high_noise ? "开" : "关" }}</span>
                            </label>
                            <button class="btn-ghost" type="button" @click="removeLora(index)">移除</button>
                        </div>
                    </div>
                    <div><button class="btn-ghost" type="button" title="添加一个新的 LoRA 配置项" @click="addLora" :disabled="!availableLoras.length">添加 LoRA</button></div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="图像输入" tip="设置初始图、控制图、参考图或视频控制帧，用于图生图、局部重绘和条件生成。" :summary="imageInputsSummary" :open="sectionState.auxiliaryImages" @toggle="toggleSection('auxiliaryImages')">
                    <div class="upload-grid">
                        <ImageDropzone
                            v-for="input in gridImageInputs"
                            :key="input.target"
                            :label="input.label"
                            :description="input.description"
                            :tip="input.tip"
                            :preview="getFormImage(input.target)"
                            @select="assignImages(input.target, $event)"
                            @clear="clearImage(input.target)"
                            @preview="openImageEntry($event)"
                        />
                    </div>
                    <div v-for="input in fullImageInputs" :key="input.target">
                        <ImageDropzone
                            :label="input.label"
                            :description="input.description"
                            :tip="input.tip"
                            :preview="getFormImage(input.target)"
                            @select="assignImages(input.target, $event)"
                            @clear="clearImage(input.target)"
                            @preview="openImageEntry($event)"
                        />
                    </div>

                    <div v-if="generationMode === 'image'" class="group">
                        <label>参考图像<InfoTip text="用于风格/角色参考或 Kontext 等编辑模型；不同模型对参考图数量和支持方式不同。" /></label>
                        <ImageDropzone
                            label="参考图像"
                            description="支持多张参考图像。"
                            tip="可一次选择多张参考图，服务器会保持选择顺序；部分模型仅支持一张。"
                            :items="form.ref_images"
                            multiple
                            @select="assignImages('ref_images', $event)"
                            @clear="clearImage('ref_images')"
                        />
                        <div v-if="!form.ref_images.length" class="hint">未选择文件。</div>
                        <div v-else class="file-list">
                            <div v-for="(item, index) in form.ref_images" :key="item.name + index" class="file-chip file-chip--preview">
                                <button class="file-chip__thumb-button" type="button" @click="openLightbox(item.dataUrl, item.name)">
                                    <img class="file-chip__thumb" :src="item.dataUrl" :alt="item.name" />
                                </button>
                                <span class="file-chip__name">{{ item.name }}</span>
                                <button class="icon-button" type="button" @click="removeCollectionImage('ref_images', index)">移除</button>
                            </div>
                        </div>
                    </div>

                    <div v-else>
                        <div class="group">
                            <label>参考图像（仅 MiniMax-H3 Ref2VA）<InfoTip text="仅 MiniMax-H3 Ref2VA 使用这些参考图像，其他视频模型会忽略；不能与起始帧或结束帧同时使用。" /></label>
                            <ImageDropzone
                                label="参考图像"
                                description="仅 MiniMax-H3 Ref2VA 使用这些图像，其他视频模型会忽略。不能与起始帧或结束帧同时使用。"
                                tip="可一次选择多张参考图，服务器会保持选择顺序。"
                                :items="form.ref_images"
                                multiple
                                @select="assignImages('ref_images', $event)"
                                @clear="clearImage('ref_images')"
                            />
                            <div v-if="!form.ref_images.length" class="hint">未选择文件。</div>
                            <div v-else class="file-list">
                                <div v-for="(item, index) in form.ref_images" :key="item.name + index" class="file-chip file-chip--preview">
                                    <button class="file-chip__thumb-button" type="button" @click="openLightbox(item.dataUrl, item.name)">
                                        <img class="file-chip__thumb" :src="item.dataUrl" :alt="item.name" />
                                    </button>
                                    <span class="file-chip__name">{{ item.name }}</span>
                                    <button class="icon-button" type="button" @click="removeCollectionImage('ref_images', index)">移除</button>
                                </div>
                            </div>
                        </div>
                        <div class="group stack-top">
                            <label>控制帧<InfoTip text="按文件名顺序作为视频条件帧；请确保文件名排序与实际时间顺序一致。" /></label>
                            <ImageDropzone
                                label="控制帧"
                                description="上传有序的条件帧。服务器保持数组顺序。"
                                tip="可一次选择多帧，服务器按选择/文件名顺序使用；用于 VACE 等视频控制。"
                                :items="form.control_frames"
                                multiple
                                @select="assignImages('control_frames', $event)"
                                @clear="clearImage('control_frames')"
                            />
                            <div v-if="!form.control_frames.length" class="hint">未选择文件。</div>
                            <div v-else class="file-list">
                                <div v-for="(item, index) in form.control_frames" :key="item.name + index" class="file-chip file-chip--preview">
                                    <button class="file-chip__thumb-button" type="button" @click="openLightbox(item.dataUrl, item.name)">
                                        <img class="file-chip__thumb" :src="item.dataUrl" :alt="item.name" />
                                    </button>
                                    <span class="file-chip__name">{{ item.name }}</span>
                                    <button class="icon-button" type="button" @click="removeCollectionImage('control_frames', index)">移除</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="VAE 平铺" tip="把 VAE 解码/编码拆成小块以降低显存占用，可能略微变慢；适合高分辨率或显存不足时。" :summary="vaeTilingSummary" :open="sectionState.vaeTiling" @toggle="toggleSection('vaeTiling')">
                    <label class="checkbox" title="启用 VAE 分块处理">
                        <input v-model="form.vae_tiling_params.enabled" type="checkbox" />
                        <span>启用<InfoTip text="开启后 VAE 会分块处理图像，降低峰值显存占用。" :focusable="false" /></span>
                    </label>
                    <div class="fields">
                        <div class="field"><label>平铺宽度（像素）<InfoTip text="每个图块的宽度（像素）；0 表示由服务器自动决定。" /></label><input v-model.number="form.vae_tiling_params.tile_size_w" type="number" /></div>
                        <div class="field"><label>平铺高度（像素）<InfoTip text="每个图块的高度（像素）；0 表示由服务器自动决定。" /></label><input v-model.number="form.vae_tiling_params.tile_size_h" type="number" /></div>
                    </div>
                    <div class="field"><label>目标重叠<InfoTip text="相邻图块的重叠比例，范围 0–1；适当重叠可以减少拼接接缝。" /></label><input v-model.number="form.vae_tiling_params.target_overlap" type="number" step="0.01" /></div>
                    <div class="fields">
                        <div class="field"><label>相对宽度<InfoTip text="以图像比例（<1）或每行图块数（≥1）表示平铺宽度；优先于像素尺寸。" /></label><input v-model.number="form.vae_tiling_params.rel_size_w" type="number" step="0.01" /></div>
                        <div class="field"><label>相对高度<InfoTip text="以图像比例（<1）或每列图块数（≥1）表示平铺高度；优先于像素尺寸。" /></label><input v-model.number="form.vae_tiling_params.rel_size_h" type="number" step="0.01" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection v-if="supportsPreview" class="stack-top" eyebrow="预览" tip="生成过程中显示中间结果；预览会占用额外时间，但便于观察进度。" :summary="form.preview_mode === 'none' ? '已禁用' : form.preview_mode" :open="sectionState.preview" @toggle="toggleSection('preview')">
                    <div class="fields">
                        <div class="field">
                            <label>预览模式<InfoTip text="选择预览解码方式：none 关闭，proj/tae 速度快、质量低，vae 质量最高但更慢。" /></label>
                            <select v-model="form.preview_mode">
                                <option v-for="mode in previewModes" :key="mode" :value="mode">{{ mode }}</option>
                            </select>
                        </div>
                        <div class="field">
                            <label>间隔（步）<InfoTip text="每隔多少采样步刷新一次预览；数值越小越流畅，但开销越大。" /></label>
                            <input v-model.number="form.preview_interval" type="number" min="1" step="1" />
                        </div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection class="stack-top" eyebrow="缓存" tip="跳过部分重复计算以加速生成；缓存越激进速度越快，但可能损失细节。" :summary="cacheSummary" :open="sectionState.cache" @toggle="toggleSection('cache')">
                    <div class="field">
                        <label>模式<InfoTip text="缓存策略：disabled 关闭；easycache/ucache/dbcache/taylorseer/cache-dit/spectrum 为不同的加速算法。" /></label>
                        <select v-model="form.cache.mode">
                            <option v-for="mode in CACHE_MODES" :key="mode" :value="mode">{{ mode }}</option>
                        </select>
                    </div>
                    <div class="field field--full"><label>缓存选项<InfoTip text="对应缓存算法的参数，逗号分隔的 key=value，例如 threshold=0.25,start=0.15,end=0.95。" /></label><input v-model="form.cache.option" placeholder="threshold=0.25,start=0.15,end=0.95" /></div>
                    <div class="field"><label>SCM 掩码<InfoTip text="Cache-DiT 的 SCM 步掩码（SCM Mask），逗号分隔的 0/1：1 表示计算，0 表示允许缓存。" /></label><input v-model="form.cache.scm_mask" /></div>
                    <label class="checkbox" title="根据误差动态调整 SCM 缓存策略">
                        <input v-model="form.cache.scm_policy_dynamic" type="checkbox" />
                        <span>动态 SCM 策略<InfoTip text="根据每步误差动态决定是否复用缓存；关闭后使用固定的静态策略。" :focusable="false" /></span>
                    </label>
                </CollapsibleSection>
            </section>

            <section class="panel output-panel">
                <div class="panel-header">
                    <div>
                        <h2 class="panel-title">输出</h2>
                    </div>
                </div>

                <div v-if="livePreviewSrc" class="hero-frame hero-frame--media hero-frame--preview">
                    <img class="hero-frame__image" :src="livePreviewSrc" alt="实时预览" />
                    <div class="hero-frame__preview-overlay">
                        <span class="hero-frame__preview-label">实时预览</span>
                        <span class="hero-frame__preview-step">第 {{ livePreviewPass }} 轮 · {{ livePreviewStep }} / {{ livePreviewTotalSteps }} 步</span>
                    </div>
                </div>
                <div v-else-if="videoPreviewSrc" class="hero-frame hero-frame--media">
                    <video class="hero-frame__video" :src="videoPreviewSrc" controls autoplay loop muted playsinline />
                </div>
                <button v-else class="hero-frame hero-frame--button" type="button" :disabled="!previewImageSrc" title="点击放大查看生成结果" @click="openLightbox(previewImageSrc, '生成结果')">
                    <img v-if="previewImageSrc" :src="previewImageSrc" alt="生成结果" />
                    <div v-else class="hero-placeholder">
                        <h2>{{ generationMode === "video" ? "生成视频" : "生成图像" }}</h2>
                        <p>
                            {{ generationMode === "video"
                                ? "当前任务完成后，生成的视频或动态 WebP 将显示在此处。"
                                : "当前任务完成后，生成的图像将显示在此处。" }}
                        </p>
                    </div>
                </button>

                <div v-if="currentJobKind === 'vid_gen' && currentJob?.result?.output_format === 'avi'" class="hint stack-top">
                    AVI 播放取决于编解码器支持。如果预览无法播放，请下载文件。
                </div>

                <div class="metrics output-metrics">
                    <div class="metric" title="当前任务的执行状态">
                        <div class="metric__label">状态</div>
                        <div class="metric__value">{{ currentStatusLabel }}</div>
                    </div>
                    <div class="metric" title="当前任务在队列中的位置，0 表示正在生成或已结束">
                        <div class="metric__label">队列</div>
                        <div class="metric__value">{{ currentJob?.queue_position ?? 0 }}</div>
                    </div>
                    <div class="metric" title="任务创建时间">
                        <div class="metric__label">创建时间</div>
                        <div class="metric__value mono">{{ formatUnixTime(currentJob?.created) }}</div>
                    </div>
                    <div class="metric" title="任务从开始到完成（或当前）的耗时">
                        <div class="metric__label">已用时间</div>
                        <div class="metric__value">{{ formatElapsed(currentJob?.started, currentJob?.completed) }}</div>
                    </div>
                    <div v-if="currentJobKind === 'vid_gen'" class="metric" title="生成视频的帧率">
                        <div class="metric__label">帧率</div>
                        <div class="metric__value">{{ videoFps || "-" }}</div>
                    </div>
                    <div v-if="currentJobKind === 'vid_gen'" class="metric" title="生成视频的总帧数">
                        <div class="metric__label">帧数</div>
                        <div class="metric__value">{{ videoFrameCount || "-" }}</div>
                    </div>
                </div>

                <div class="generation-progress" title="当前采样进度和每步耗时">
                    <div class="generation-progress__title">采样进度</div>
                    <div class="generation-progress__meta">
                        <span>步数 <strong>{{ progressTotalSteps > 0 ? `${progressStep}/${progressTotalSteps}` : "-" }}</strong></span>
                        <span>速度 <strong>{{ progressSpeed }}</strong></span>
                        <span v-if="progressPass > 1">第 {{ progressPass }} 轮</span>
                    </div>
                </div>

                <div v-if="statusMessage" class="status-message" :class="statusTone === 'error' ? 'status-message--error' : 'status-message--success'">{{ statusMessage }}</div>
                <div v-else-if="currentJob?.error?.message" class="status-message status-message--error">{{ currentJob.error.message }}</div>

                <div class="output-controls">
                    <button class="btn output-controls__primary" type="button" :disabled="isJobRunning" title="把当前参数提交到服务器开始生成" @click="generate">
                        {{ generationMode === "video" ? "生成视频" : "生成图像" }}
                    </button>
                    <div class="actions output-controls__secondary">
                        <button class="btn-secondary" type="button" :disabled="!downloadableSrc" title="下载当前生成结果" @click="downloadSelected">下载</button>
                        <button class="btn-danger" type="button" :disabled="!canCancelCurrentJob" :title="cancelPending ? '已请求取消，等待采样停止…' : '取消排队中或正在生成的任务'" @click="cancelCurrentJob">{{ cancelPending ? "取消中…" : "取消" }}</button>
                    </div>
                </div>

                <div v-if="currentImages.length > 1" class="thumb-row">
                    <button v-for="(image, index) in currentImages" :key="image.index" class="thumb" :class="{ 'thumb--active': index === selectedOutputIndex }" type="button" @click="selectOutput(index)">
                        <img :src="`data:image/${currentJob?.result?.output_format || 'png'};base64,${image.b64_json}`" :alt="`输出 ${index + 1}`" />
                    </button>
                </div>
            </section>
        </div>
        <div v-if="lightboxOpen && lightboxImageSrc" class="lightbox" @click.self="closeLightbox">
            <button class="lightbox__close" type="button" @click="closeLightbox">关闭</button>
            <img class="lightbox__image" :src="lightboxImageSrc" :alt="lightboxImageAlt" />
        </div>
    </div>
</template>
